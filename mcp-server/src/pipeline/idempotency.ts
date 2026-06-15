// ADR-059 §5 — Replay-protection store.
//
// Two concurrent MCP calls with the same idempotency key should serialize
// (both await the same in-flight work) and, once finished, return the
// cached Result to subsequent calls for a short TTL window.
//
// Single-instance deployments use `InMemoryIdempotencyStore` (this file).
// Multi-instance deployments opt into `RedisIdempotencyStore`
// (`./idempotency-redis.ts`) by setting `AEP_REDIS_URL`. See ADR-059 §5
// "Consequences → Negative" — the Redis backend was deferred in PR5 and is
// delivered in this PR.
//
// Public surface:
//   - `IdempotencyStore` interface — the contract all backends implement.
//   - `InMemoryIdempotencyStore` — single-process map-backed implementation
//     (the original PR5 class, renamed).
//   - `createIdempotencyStore()` — env-driven factory.
//   - `getIdempotencyStore()` — module-level singleton accessor.
//
// Semantics (shared across backends):
//   - `acquire(key, fn)`:
//       * if a prior in-flight OR cached-and-unexpired result exists for
//         `key`, await it and return its Result;
//       * otherwise call `fn()`, cache the promise, install a TTL-bound
//         eviction timer, and return the result.
//   - Failures (rejected `Result` / `{ ok: false }`) are cached just like
//     successes: two concurrent submits with the same key observe the same
//     error (they are the same conceptual request). Callers that want
//     retry-on-error must vary the key.

import { createRequire } from "node:module";
import type { Result } from "../types/action.js";

// --------------------------------------------------------------------------
// Contract
// --------------------------------------------------------------------------

/**
 * Replay-protection store contract (ADR-059 §5).
 *
 * All backends (in-memory, Redis) implement this interface. `acquire`
 * de-duplicates concurrent callers with the same key against a single
 * in-flight invocation of `fn`, then caches the resulting `Result<T>` for
 * a TTL-bounded window.
 */
export interface IdempotencyStore {
  /**
   * Acquire the mutex for `key` and run `fn` if no prior in-flight or
   * cached-and-unexpired result exists. Concurrent callers receive the
   * same Result.
   */
  acquire<T>(key: string, fn: () => Promise<Result<T>>): Promise<Result<T>>;

  /** Drop a specific key from the cache (test / admin hook). */
  invalidate(key: string): void | Promise<void>;

  /** Drop everything (test hook). */
  clear(): void | Promise<void>;
}

// --------------------------------------------------------------------------
// In-memory backend (PR5, renamed — the canonical single-instance path)
// --------------------------------------------------------------------------

/**
 * Cache entry. MCP-310 (cycle-3) clarifies the TTL lifecycle:
 *   - While `fn()` is in-flight: `expiresAt = null` and `timer = null`.
 *     Concurrent acquire piggybacks on `promise`; the entry can NEVER be
 *     evicted mid-execution.
 *   - After `fn()` settles (success or failure): `expiresAt = now + ttlMs`
 *     and `timer` is armed for that deadline. Pre-fix behavior armed
 *     eviction at start time, which could fire during a slow `fn()` and
 *     allow a concurrent caller to spawn a second invocation.
 */
interface Entry {
  promise: Promise<Result<unknown>>;
  /** null while in-flight, set to deadline at settle time. */
  expiresAt: number | null;
  /** null while in-flight, set to active timer at settle time. */
  timer: NodeJS.Timeout | null;
}

export interface InMemoryIdempotencyStoreOptions {
  /** Cache TTL in milliseconds. Defaults to 10 minutes per ADR-059 §5. */
  ttlMs?: number;
  /** Test hook. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly store = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: InMemoryIdempotencyStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  acquire<T>(
    key: string,
    fn: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const existing = this.store.get(key);
    if (existing) {
      // In-flight (expiresAt === null) OR cached-and-unexpired — both
      // piggyback on the same promise. MCP-310: an in-flight entry can
      // NEVER expire because we don't arm the TTL until settle time.
      const stillValid =
        existing.expiresAt === null || existing.expiresAt > this.now();
      if (stillValid) {
        return existing.promise as Promise<Result<T>>;
      }
      // Expired — clean up before installing replacement.
      if (existing.timer) clearTimeout(existing.timer);
      this.store.delete(key);
    }

    // `fn()` may throw synchronously (rare — handlers are `async`, but
    // defensive). Wrap in Promise.resolve().then(() => fn()) so both sync
    // throws and rejected promises land on the same rejection path.
    const promise = Promise.resolve().then(() => fn());

    // MCP-310: store with `expiresAt: null` → in-flight, no eviction yet.
    // A concurrent acquire for the same key sees this entry and piggybacks
    // on `promise`. Pre-fix code armed `setTimeout(... ttlMs)` here, which
    // could evict mid-execution if `fn()` exceeded ttlMs.
    const entry: Entry = { promise, expiresAt: null, timer: null };
    this.store.set(key, entry);

    // Arm TTL eviction at SETTLE time (success or failure). Relative to
    // settle: the spec says "cache the result for 10 minutes" — counting
    // from when there is a result to cache, not from when the call started.
    promise.finally(() => {
      // Re-check the entry hasn't been replaced or invalidated. Another
      // caller may have run invalidate(key) while fn() was in-flight and
      // installed a new entry; we don't want to attach OUR timer to
      // someone else's entry.
      if (this.store.get(key) !== entry) return;
      entry.expiresAt = this.now() + this.ttlMs;
      entry.timer = setTimeout(() => {
        if (this.store.get(key) === entry) this.store.delete(key);
      }, this.ttlMs);
      if (entry.timer && typeof entry.timer.unref === "function") {
        entry.timer.unref();
      }
    });

    return promise as Promise<Result<T>>;
  }

  /** Drop a specific key from the cache (test / admin hook). */
  invalidate(key: string): void {
    const entry = this.store.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    this.store.delete(key);
  }

  /** Drop everything (test hook). */
  clear(): void {
    for (const entry of this.store.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.store.clear();
  }

  /** How many keys are currently cached. Visible for observability / tests. */
  size(): number {
    return this.store.size;
  }
}

// --------------------------------------------------------------------------
// Factory — env-driven backend selection (ADR-059 §5)
// --------------------------------------------------------------------------

/**
 * Build the idempotency store implied by the current process env.
 *
 * - `AEP_REDIS_URL` set → returns a `RedisIdempotencyStore` bound to that
 *   URL (multi-instance replay protection).
 * - Otherwise → returns an `InMemoryIdempotencyStore` (single-instance).
 *
 * Loaded lazily so that in-memory deployments never pay the `ioredis`
 * import cost and test runs without Redis never trip over module-load
 * side effects.
 */
export function createIdempotencyStore(): IdempotencyStore {
  const redisUrl = process.env.AEP_REDIS_URL;
  if (redisUrl && redisUrl.length > 0) {
    // ADR-091: ESM (NodeNext) doesn't expose synchronous `require`. Use
    // `createRequire(import.meta.url)` to load the redis backend lazily
    // without making `createIdempotencyStore` async — preserves the
    // singleton accessor's `function(): IdempotencyStore` shape. The
    // CommonJS-load trick is local and contained; no ripple to callers.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const requireCJS = createRequire(import.meta.url);
    const mod = requireCJS("./idempotency-redis.js") as {
      RedisIdempotencyStore: new (opts: { url: string }) => IdempotencyStore;
    };
    return new mod.RedisIdempotencyStore({ url: redisUrl });
  }
  return new InMemoryIdempotencyStore();
}

/** Returns `"redis"` or `"memory"` — used at startup logging. */
export function activeIdempotencyBackend(): "redis" | "memory" {
  return process.env.AEP_REDIS_URL && process.env.AEP_REDIS_URL.length > 0
    ? "redis"
    : "memory";
}

// --------------------------------------------------------------------------
// Module-level singleton (PR3 — DI comes later, see ADR-059 §5).
// --------------------------------------------------------------------------

let singleton: IdempotencyStore | null = null;

export function getIdempotencyStore(): IdempotencyStore {
  if (!singleton) singleton = createIdempotencyStore();
  return singleton;
}

/** Test hook — fresh singleton with custom options. */
export function __setIdempotencyStoreForTests(
  store: IdempotencyStore | null,
): void {
  singleton = store;
}
