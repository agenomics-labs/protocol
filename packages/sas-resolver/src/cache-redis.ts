// ADR-065 §3 — Redis-backed cache (multi-instance L2).
//
// Selected at runtime when `AEP_REDIS_URL` is set; see `createCache()` in
// `./cache.ts`. Mirrors the structure of
// `mcp-server/src/pipeline/idempotency-redis.ts` (ADR-059 §5) — same env
// var, same client-injection pattern for tests, same lazy-load of the
// `ioredis` dep, same structural `RedisClient` type so `ioredis-mock`
// drops in without a runtime dep on the real driver.
//
// Wire protocol (one key per cache entry):
//
//   <prefix><key>  — JSON-encoded `{ value, cachedAt }`.
//                    SET with PX <ttlMs>.
//
// JSON caveat: values passed through `set<T>` must be JSON-safe
// (no functions, Maps, Sets, BigInt, undefined, symbols, or cycles).
// The resolver's cache payloads are decoded attestation / schema /
// credential records — all plain string / number / boolean objects —
// so this is not currently a blocker. Consumers with richer types can
// either (a) implement their own `CacheBackend` with a richer codec or
// (b) pre-serialize at the call site.

import type { CacheBackend } from "./cache.js";

// --------------------------------------------------------------------------
// Structural Redis client — we only need SET / GET / DEL.
// Declaring the shape here (rather than depending on `Redis` from the
// `ioredis` types) lets tests inject `ioredis-mock` without a transitive
// type import. Same pattern as `idempotency-redis.ts`'s `RedisClient`.
// --------------------------------------------------------------------------

type SetArgs =
  | [key: string, value: string]
  | [key: string, value: string, px: "PX", ttlMs: number];

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

export interface RedisCacheOptions {
  /**
   * `redis://` URL. Ignored if `client` is supplied. When absent and
   * `client` is supplied, the caller is responsible for `.quit()`.
   */
  url?: string;

  /**
   * Pre-built client (tests, shared pool). Takes precedence over `url`.
   * Must satisfy the `RedisClient` structural shape — `ioredis-mock`
   * qualifies.
   */
  client?: RedisClient;

  /**
   * Key prefix. Defaults to `"aep:cache:"` per ADR-065 §3 key-format
   * spec. Intentionally includes the trailing colon so callers can drop
   * a bare cache key in without reserving a separator.
   *
   * The matching idempotency prefix is `"aep:idem:"` — ADR-065 §3
   * "Key format" and ADR-059 §5 both document this explicitly so
   * operators running both subsystems on one Redis don't collide.
   */
  prefix?: string;
}

const DEFAULT_PREFIX = "aep:cache:";

// --------------------------------------------------------------------------
// Implementation
// --------------------------------------------------------------------------

interface StoredEntry {
  value: unknown;
  cachedAt: number;
}

export class RedisCache implements CacheBackend {
  readonly #client: RedisClient;
  readonly #ownsClient: boolean;
  readonly #prefix: string;

  constructor(opts: RedisCacheOptions = {}) {
    if (opts.client) {
      this.#client = opts.client;
      this.#ownsClient = false;
    } else if (opts.url) {
      // Lazy require — keeps `ioredis` out of the import graph when
      // only the in-memory backend is in use. Same dance as
      // `RedisIdempotencyStore` (ADR-059 §5).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const RedisCtor = require("ioredis") as { default?: unknown } & Record<
        string,
        unknown
      >;
      // CJS export is the class itself; ESM build nests under `.default`.
      const Ctor =
        (typeof RedisCtor === "function" ? RedisCtor : undefined) ??
        (RedisCtor.default as unknown);
      if (typeof Ctor !== "function") {
        throw new Error(
          "cache-redis: failed to load 'ioredis'. Did you install the dependency?",
        );
      }
      const R = Ctor as new (url: string) => RedisClient;
      this.#client = new R(opts.url);
      this.#ownsClient = true;
    } else {
      throw new Error("RedisCache: either `url` or `client` must be provided");
    }

    this.#prefix = opts.prefix ?? DEFAULT_PREFIX;
  }

  async get<T>(
    key: string,
  ): Promise<{ value: T; cachedAt: number } | null> {
    const raw = await this.#client.get(this.#prefix + key);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as StoredEntry;
      if (!parsed || typeof parsed !== "object" || typeof parsed.cachedAt !== "number") {
        // Malformed payload — treat as miss so the caller refetches.
        // A follow-up `set` will overwrite it.
        return null;
      }
      return { value: parsed.value as T, cachedAt: parsed.cachedAt };
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    // Redis rejects SET with PX <= 0 ("value is not an integer or out
    // of range"). Treat non-positive TTL as an explicit delete so the
    // public `CacheBackend` contract matches the in-memory backend.
    if (ttlMs <= 0) {
      await this.#client.del(this.#prefix + key);
      return;
    }
    const payload: StoredEntry = { value, cachedAt: Date.now() };
    await this.#client.set(
      this.#prefix + key,
      JSON.stringify(payload),
      "PX",
      Math.floor(ttlMs),
    );
  }

  async delete(key: string): Promise<void> {
    await this.#client.del(this.#prefix + key);
  }

  /**
   * Best-effort "drop everything". Intentionally a no-op for the
   * production path — there is no cheap way to wipe a prefix without
   * `SCAN`, and this method exists mainly so `CacheBackend`'s shape is
   * uniform. Tests that need a clean slate should use a fresh mock
   * client per test (`ioredis-mock` gives each instance its own keyspace).
   */
  async clear(): Promise<void> {
    // Intentionally empty. See JSDoc above.
  }

  /** Close the owned client (if we created it). Safe to call repeatedly. */
  async close(): Promise<void> {
    if (!this.#ownsClient) return;
    if (typeof this.#client.quit === "function") {
      await this.#client.quit();
    } else if (typeof this.#client.disconnect === "function") {
      this.#client.disconnect();
    }
  }
}
