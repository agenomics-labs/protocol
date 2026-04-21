// ADR-059 §5 — Mutex-per-key replay protection, in-memory.
//
// Two concurrent MCP calls with the same idempotency key should serialize
// (both await the same in-flight Promise) and, once finished, return the
// cached Result to subsequent calls for a short TTL window. Redis-backed
// multi-instance mode is explicitly deferred (see ADR-059 §5 / Negative
// Consequences). This module is single-process only.
//
// Semantics:
//   - `acquire(key, fn)`:
//       * if a promise for `key` is currently in-flight OR its cache window
//         has not expired, await the cached promise and return its Result;
//       * otherwise call `fn()`, cache the promise, install a TTL-bound
//         eviction timer, and return the result.
//   - Failures are cached just like successes: two concurrent submits with
//     the same key observe the same error (correct — they are the same
//     conceptual request). Callers that want retry-on-error must vary the
//     key.

import type { Result } from "../types/action.js";

interface Entry {
  promise: Promise<Result<unknown>>;
  expiresAt: number;
  timer: NodeJS.Timeout | null;
}

export interface IdempotencyStoreOptions {
  /** Cache TTL in milliseconds. Defaults to 10 minutes per ADR-059 §5. */
  ttlMs?: number;
  /** Test hook. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class IdempotencyStore {
  private readonly store = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: IdempotencyStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Acquire the mutex for `key` and run `fn` if no prior in-flight or
   * cached-and-unexpired result exists. Concurrent callers receive the same
   * Promise. On completion the Promise remains cached until `ttlMs`
   * elapses, then is evicted by a timer.
   */
  acquire<T>(
    key: string,
    fn: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > this.now()) {
      return existing.promise as Promise<Result<T>>;
    }
    // If we stumbled on an expired entry, clear it so the replacement's
    // timer is the only one left live.
    if (existing?.timer) clearTimeout(existing.timer);
    if (existing) this.store.delete(key);

    // `fn()` may throw synchronously (rare — handlers are `async`, but
    // defensive). Wrap in Promise.resolve().then(() => fn()) so both sync
    // throws and rejected promises land on the same rejection path.
    const promise = Promise.resolve().then(() => fn());

    const expiresAt = this.now() + this.ttlMs;
    // We store the entry BEFORE awaiting completion so that a concurrent
    // acquire for the same key sees the in-flight promise immediately.
    const entry: Entry = { promise, expiresAt, timer: null };
    this.store.set(key, entry);

    // Arm TTL eviction after the promise settles. We arm relative to "now
    // + ttlMs" regardless of how long `fn` takes — the spec says "cache
    // the result for 10 minutes", not "cache the result for 10 minutes
    // after the first call started", but using the start-time makes the
    // invariant `expiresAt === store.get(key).expiresAt` true for all
    // callers. Good enough for in-memory single-instance.
    entry.timer = setTimeout(() => {
      // Only evict if this entry is still the current one — a caller may
      // have forced re-entry via `invalidate` and installed a new entry
      // under the same key.
      if (this.store.get(key) === entry) this.store.delete(key);
    }, this.ttlMs);
    // In Node the timer keeps the event loop alive; for MCP-server-long
    // lifetimes that's fine, but we `unref` so a short-lived test process
    // isn't held open waiting for eviction.
    if (entry.timer && typeof entry.timer.unref === "function") {
      entry.timer.unref();
    }

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
// Module-level singleton (PR3 — DI comes later, see ADR-059 §5).
// --------------------------------------------------------------------------

let singleton: IdempotencyStore | null = null;

export function getIdempotencyStore(): IdempotencyStore {
  if (!singleton) singleton = new IdempotencyStore();
  return singleton;
}

/** Test hook — fresh singleton with custom options. */
export function __setIdempotencyStoreForTests(
  store: IdempotencyStore | null,
): void {
  singleton = store;
}
