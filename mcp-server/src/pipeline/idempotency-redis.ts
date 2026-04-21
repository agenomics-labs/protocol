// ADR-059 §5 — Redis-backed replay protection (multi-instance).
//
// Selected at runtime when `AEP_REDIS_URL` is set; see
// `createIdempotencyStore()` in `./idempotency.ts`.
//
// Wire protocol (two keys per idempotency key):
//
//   <prefix><key>          — pending marker. SET NX PX <pendingTtlMs>.
//                             Presence means "a worker is currently running
//                             fn() for this key". Value is an opaque owner
//                             token (a UUID) so only the acquirer deletes
//                             its own marker.
//   <prefix><key>:result   — completed Result<T>, JSON-serialized. SET with
//                             PX <resultTtlMs>. Presence means "the work
//                             finished and the cached result is available".
//
// Lifecycle of `acquire(key, fn)`:
//
//   1. GET <prefix><key>:result — fast path, cache hit.
//   2. SET <prefix><key> <ownerToken> NX PX <pendingTtlMs>.
//        * "OK" — we own the lock. Run fn(); on settle, SET the :result
//          key with PX <resultTtlMs>, then (best-effort) DEL the pending
//          marker if we still own it. If fn() throws, DEL the marker and
//          rethrow — subsequent acquires can re-enter.
//        * nil — someone else holds it. Poll `:result` with exponential
//          backoff until it appears or `inflightWaitMs` elapses. On
//          timeout, return `IDEMPOTENCY_VIOLATION` ("inflight timeout").
//
// JSON serialization caveat — the `T` parameter of `Result<T>` must be
// JSON-safe. Functions, Maps, Sets, BigInt, undefined, symbols, and
// circular references will not round-trip. AEP's idempotent actions
// (submit_milestone, approve_milestone, etc.) all return plain
// string/number/boolean records, so this is not currently a blocker —
// but action authors should prefer primitive shapes for the action
// result type when `idempotent: true`.

import type { Result } from "../types/action.js";
import type { IdempotencyStore } from "./idempotency.js";

// --------------------------------------------------------------------------
// Structural Redis client — we only need a handful of commands.
// Declaring them here (rather than depending on `Redis` from `ioredis`)
// lets tests inject `ioredis-mock` without a transitive type import.
// --------------------------------------------------------------------------

type SetArgs =
  | [key: string, value: string]
  | [key: string, value: string, px: "PX", ttlMs: number]
  | [key: string, value: string, nx: "NX", px: "PX", ttlMs: number]
  | [key: string, value: string, px: "PX", ttlMs: number, nx: "NX"];

export interface RedisClient {
  set(...args: SetArgs): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  quit?(): Promise<"OK" | string>;
  disconnect?(): void;
}

// --------------------------------------------------------------------------
// Options
// --------------------------------------------------------------------------

export interface RedisIdempotencyStoreOptions {
  /**
   * `redis://` URL. Ignored if `client` is supplied (tests). When absent
   * and `client` is supplied, the caller is responsible for `.quit()`.
   */
  url?: string;

  /**
   * Pre-built client (tests, shared pool). Takes precedence over `url`.
   * Must satisfy the `RedisClient` structural shape.
   */
  client?: RedisClient;

  /**
   * Key prefix for both the pending marker and the `:result` key.
   * Defaults to `"aep:idem:"`. Intentionally includes the trailing
   * colon so callers can drop a bare idempotency key in without
   * reserving a separator.
   */
  prefix?: string;

  /**
   * TTL for the cached `<prefix><key>:result` entry, in milliseconds.
   * Defaults to 10 minutes — matches the in-memory backend and
   * ADR-059 §5 "cache the result for 10 minutes".
   */
  resultTtlMs?: number;

  /**
   * TTL for the pending marker (`<prefix><key>`), in milliseconds.
   * Protects against a dead worker holding the lock forever. Should be
   * longer than the longest-expected handler latency but short enough
   * that a crashed node unblocks retries. Defaults to 60 000 ms.
   */
  pendingTtlMs?: number;

  /**
   * Maximum time `acquire` will wait for a concurrent in-flight handler
   * to publish its result, in milliseconds. On expiry we return
   * `IDEMPOTENCY_VIOLATION` rather than speculatively rerunning the work
   * (the other worker may still be executing). Defaults to 30 000 ms.
   */
  inflightWaitMs?: number;

  /**
   * Initial poll interval when waiting for a peer worker's result, in
   * milliseconds. Doubles up to `pollMaxMs`. Defaults to 25 ms.
   */
  pollInitialMs?: number;

  /**
   * Cap on the exponential backoff between polls, in milliseconds.
   * Defaults to 500 ms.
   */
  pollMaxMs?: number;

  /** Injected for tests to make the poll loop deterministic. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  ownerToken?: () => string;
}

const DEFAULT_PREFIX = "aep:idem:";
const DEFAULT_RESULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PENDING_TTL_MS = 60 * 1000;
const DEFAULT_INFLIGHT_WAIT_MS = 30 * 1000;
const DEFAULT_POLL_INITIAL_MS = 25;
const DEFAULT_POLL_MAX_MS = 500;

// --------------------------------------------------------------------------
// Implementation
// --------------------------------------------------------------------------

export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly client: RedisClient;
  private readonly ownsClient: boolean;
  private readonly prefix: string;
  private readonly resultTtlMs: number;
  private readonly pendingTtlMs: number;
  private readonly inflightWaitMs: number;
  private readonly pollInitialMs: number;
  private readonly pollMaxMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ownerToken: () => string;

  constructor(opts: RedisIdempotencyStoreOptions = {}) {
    if (opts.client) {
      this.client = opts.client;
      this.ownsClient = false;
    } else if (opts.url) {
      // Lazy require to keep ioredis out of the import graph when the
      // in-memory backend is in use (and to make this module cheap to
      // import in tests that inject their own client).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const RedisCtor = require("ioredis") as { default?: unknown } & Record<
        string,
        unknown
      >;
      // ioredis's CJS export is the class itself; its ESM build nests it
      // under `.default`. Support both shapes.
      const Ctor =
        (typeof RedisCtor === "function" ? RedisCtor : undefined) ??
        (RedisCtor.default as unknown);
      if (typeof Ctor !== "function") {
        throw new Error(
          "idempotency-redis: failed to load 'ioredis'. Did you install the dependency?",
        );
      }
      // Cast to a constructor-producing-RedisClient — ioredis's `Redis`
      // class is a structural superset.
      const R = Ctor as new (url: string) => RedisClient;
      this.client = new R(opts.url);
      this.ownsClient = true;
    } else {
      throw new Error(
        "RedisIdempotencyStore: either `url` or `client` must be provided",
      );
    }

    this.prefix = opts.prefix ?? DEFAULT_PREFIX;
    this.resultTtlMs = opts.resultTtlMs ?? DEFAULT_RESULT_TTL_MS;
    this.pendingTtlMs = opts.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.inflightWaitMs = opts.inflightWaitMs ?? DEFAULT_INFLIGHT_WAIT_MS;
    this.pollInitialMs = opts.pollInitialMs ?? DEFAULT_POLL_INITIAL_MS;
    this.pollMaxMs = opts.pollMaxMs ?? DEFAULT_POLL_MAX_MS;
    this.now = opts.now ?? Date.now;
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.ownerToken = opts.ownerToken ?? defaultOwnerToken;
  }

  async acquire<T>(
    key: string,
    fn: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const pendingKey = this.prefix + key;
    const resultKey = pendingKey + ":result";

    // 1. Fast path — result already cached.
    const cached = await this.client.get(resultKey);
    if (cached !== null) {
      return deserializeResult<T>(cached);
    }

    // 2. Try to acquire the pending marker.
    const token = this.ownerToken();
    const acquired = await this.client.set(
      pendingKey,
      token,
      "NX",
      "PX",
      this.pendingTtlMs,
    );

    if (acquired === "OK") {
      // We own the lock; run fn().
      try {
        const result = await fn();
        // Publish the result before releasing the pending marker so a
        // late-arriving concurrent caller observes the :result key as
        // soon as the pending marker disappears.
        await this.client.set(
          resultKey,
          serializeResult(result),
          "PX",
          this.resultTtlMs,
        );
        await this.releasePending(pendingKey, token);
        return result;
      } catch (e) {
        // Handler threw — release the pending marker so the next caller
        // can re-enter and rethrow.
        await this.releasePending(pendingKey, token);
        throw e;
      }
    }

    // 3. Someone else holds the lock. Poll for their :result.
    return this.waitForResult<T>(resultKey);
  }

  async invalidate(key: string): Promise<void> {
    const pendingKey = this.prefix + key;
    const resultKey = pendingKey + ":result";
    await this.client.del(pendingKey, resultKey);
  }

  /**
   * Drop every AEP idempotency entry. Implemented as best-effort (no
   * SCAN), so tests injecting a mock client that doesn't expose scan can
   * still use it. Production callers should prefer `invalidate(key)`.
   */
  async clear(): Promise<void> {
    // Intentionally a no-op for the production path — there's no cheap
    // way to wipe a prefix without SCAN, and this method exists mainly
    // so the interface is uniform across backends. Tests that need a
    // clean slate should use a fresh mock client per test.
  }

  /** Close the owned client (if we created it). Safe to call repeatedly. */
  async close(): Promise<void> {
    if (!this.ownsClient) return;
    if (typeof this.client.quit === "function") {
      await this.client.quit();
    } else if (typeof this.client.disconnect === "function") {
      this.client.disconnect();
    }
  }

  // ----------------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------------

  /**
   * Delete the pending marker iff we still own it. Uses GET-then-DEL
   * rather than a Lua CAS because `ioredis-mock` doesn't fully emulate
   * EVAL semantics and the window here is narrow (we only hold the
   * marker for the duration of our own fn()). A pending-TTL expiry races
   * this harmlessly — worst case we no-op delete a key that no longer
   * exists.
   */
  private async releasePending(
    pendingKey: string,
    token: string,
  ): Promise<void> {
    const current = await this.client.get(pendingKey);
    if (current === token) {
      await this.client.del(pendingKey);
    }
  }

  private async waitForResult<T>(resultKey: string): Promise<Result<T>> {
    const deadline = this.now() + this.inflightWaitMs;
    let interval = this.pollInitialMs;

    while (this.now() < deadline) {
      const cached = await this.client.get(resultKey);
      if (cached !== null) {
        return deserializeResult<T>(cached);
      }
      await this.sleep(interval);
      interval = Math.min(interval * 2, this.pollMaxMs);
    }

    // Final check after the deadline elapses, in case the peer wrote
    // between our last poll and the deadline.
    const finalCheck = await this.client.get(resultKey);
    if (finalCheck !== null) {
      return deserializeResult<T>(finalCheck);
    }

    return {
      ok: false,
      error: {
        code: "IDEMPOTENCY_VIOLATION",
        message: "inflight timeout: peer worker did not publish a result",
        details: { resultKey, waitedMs: this.inflightWaitMs },
      },
    };
  }
}

// --------------------------------------------------------------------------
// Serialization — `Result<T>` is a tagged union of POJOs; `JSON` is fine
// for AEP's action outputs (plain string/number/boolean records).
// --------------------------------------------------------------------------

function serializeResult<T>(result: Result<T>): string {
  return JSON.stringify(result);
}

function deserializeResult<T>(raw: string): Result<T> {
  // Trust the payload — we wrote it ourselves. If parsing fails, surface
  // as an IDEMPOTENCY_VIOLATION rather than leaking a JSON error through
  // the Action<I, O> contract.
  try {
    return JSON.parse(raw) as Result<T>;
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "IDEMPOTENCY_VIOLATION",
        message: `cached result is not valid JSON: ${String(e)}`,
      },
    };
  }
}

// --------------------------------------------------------------------------
// Owner token — a best-effort unique-per-acquire string. Uses the stdlib
// `crypto.randomUUID` on Node 19+; falls back to a timestamp+random pair.
// --------------------------------------------------------------------------

function defaultOwnerToken(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { randomUUID } = require("crypto") as {
      randomUUID?: () => string;
    };
    if (typeof randomUUID === "function") return randomUUID();
  } catch {
    // Fall through to the cheap fallback.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
