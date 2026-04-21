// ADR-065 — SAS-resolver cache backends.
//
// Implements the in-memory L1 path and the env-driven factory described
// in ADR-065 §3. The Redis L2 backend lives in `./cache-redis.ts` and is
// lazy-loaded only when `AEP_REDIS_URL` is set — identical pattern to
// `mcp-server/src/pipeline/idempotency{,-redis}.ts`.
//
// Scope note (see ADR-065 §3 vs. PR scope):
//   The ADR describes five logical layers (registry, manifest,
//   attestation, schema, credential). Only attestation / schema /
//   credential live inside `@aep/sas-resolver`'s fetch surface today;
//   Registry (`AgentProfile`) and manifest-body caching require new
//   fetch seams and are deferred to a follow-up PR. The cache primitive
//   in this file is deliberately **layer-agnostic** — callers build the
//   namespaced key themselves (e.g. `aep:cache:attestation:<pda>`).
//
// Public surface:
//   - `CacheBackend` interface — the contract all backends implement.
//   - `CacheMetrics` — counters exposed via `SasResolver.cacheMetrics()`.
//   - `InMemoryCache` — LRU + TTL bounded, default 10 000 entries.
//   - `LayeredCache`  — L1-in-front-of-L2 composition helper.
//   - `createCache()` — env-driven factory (returns Redis when
//     `AEP_REDIS_URL` is set, else `InMemoryCache`).

// --------------------------------------------------------------------------
// Contract
// --------------------------------------------------------------------------

/**
 * Cache backend contract (ADR-065 §3).
 *
 * All backends (in-memory, Redis, layered) implement this interface.
 * Values are JSON-shaped — any `T` passed through `set` must be safe to
 * round-trip through `JSON.stringify` / `JSON.parse` for the Redis
 * backend to work. The in-memory backend stores references directly and
 * is stricter about what it returns (see `InMemoryCache.get` for the
 * "same reference twice" caveat).
 */
export interface CacheBackend {
  /**
   * Fetch a cached entry. Returns `null` when the key is missing OR the
   * entry's TTL has elapsed (expired entries are treated as misses and
   * removed opportunistically).
   */
  get<T>(key: string): Promise<{ value: T; cachedAt: number } | null>;

  /**
   * Store a value under `key` with a relative TTL in milliseconds.
   * A `ttlMs <= 0` is treated as "already expired" and the entry is
   * dropped rather than stored (semantically equivalent to `delete`).
   */
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;

  /** Drop a single key from the cache (idempotent). */
  delete(key: string): Promise<void>;

  /** Drop everything. Optional — Redis consumers typically implement as a no-op. */
  clear?(): Promise<void>;
}

/**
 * Observability counters (ADR-065 §7). Exposed verbatim via
 * `SasResolver.cacheMetrics()` — consumers adapt to Prometheus / OTel /
 * their backend of choice. Deliberately not a `Record<Layer, number>`
 * map because the per-layer breakdown would tie the cache primitive to
 * the resolver-specific layer enum; this PR keeps the cache layer-agnostic
 * and lets the resolver aggregate.
 */
export interface CacheMetrics {
  /** Count of `get` calls that returned a non-null entry. */
  hits: number;
  /** Count of `get` calls that returned `null` (absent OR expired). */
  misses: number;
  /**
   * Count of LRU evictions (in-memory) plus explicit `delete` /
   * TTL-expiry evictions observed at `get` time. Expiry-on-insert
   * (ttlMs <= 0) is *not* counted — it never occupied a slot.
   */
  evictions: number;
}

// --------------------------------------------------------------------------
// In-memory backend — LRU + TTL
// --------------------------------------------------------------------------

interface InMemoryEntry {
  value: unknown;
  cachedAt: number;
  expiresAt: number;
  /**
   * `setTimeout` handle armed for eviction at `expiresAt`. `unref`'d so
   * a short-lived test process is not held open by the timer. We keep a
   * reference so `delete` and `set`-over-existing can cancel it before
   * installing a replacement.
   */
  timer: NodeJS.Timeout | null;
}

export interface InMemoryCacheOptions {
  /**
   * LRU ceiling — when exceeded, the least-recently-used entry is
   * evicted. ADR-065 §6 sizes this at 10 000 entries per layer; this
   * cache primitive is layer-agnostic, so the same number applies as a
   * **total** ceiling. Operators that want per-layer bounds should
   * instantiate one `InMemoryCache` per layer (or raise the ceiling).
   */
  maxEntries?: number;

  /** Test hook — defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * In-memory cache with LRU eviction and per-entry TTL.
 *
 * Implementation notes:
 *   - We use `Map`'s insertion order as the LRU order. On every `get`
 *     hit we `delete` + re-`set` the entry, which moves it to the tail
 *     (most-recently-used). On overflow we evict the head.
 *   - TTL is enforced both lazily (on `get`) and eagerly (via
 *     `setTimeout`). Eager eviction keeps the Map from growing with
 *     stale entries that are never read, which would pin memory until
 *     an overflow pushes them out.
 *   - Timer handles are `unref`'d — a short-lived test process must
 *     not be held open by the cache.
 */
export class InMemoryCache implements CacheBackend {
  readonly #store = new Map<string, InMemoryEntry>();
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #metrics: CacheMetrics = { hits: 0, misses: 0, evictions: 0 };

  constructor(opts: InMemoryCacheOptions = {}) {
    const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(max) || max <= 0) {
      throw new Error("InMemoryCache: maxEntries must be a positive integer");
    }
    this.#maxEntries = max;
    this.#now = opts.now ?? (() => Date.now());
  }

  async get<T>(
    key: string,
  ): Promise<{ value: T; cachedAt: number } | null> {
    const entry = this.#store.get(key);
    if (!entry) {
      this.#metrics.misses++;
      return null;
    }
    if (entry.expiresAt <= this.#now()) {
      // Lazy expiry — treat as a miss, evict, count as eviction.
      this.#cancelTimer(entry);
      this.#store.delete(key);
      this.#metrics.misses++;
      this.#metrics.evictions++;
      return null;
    }
    // Move to tail of LRU order — delete + re-set keeps Map insertion
    // order === LRU order.
    this.#store.delete(key);
    this.#store.set(key, entry);
    this.#metrics.hits++;
    return { value: entry.value as T, cachedAt: entry.cachedAt };
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    // Already-expired TTL is equivalent to `delete` — don't occupy a slot.
    if (ttlMs <= 0) {
      const existing = this.#store.get(key);
      if (existing) {
        this.#cancelTimer(existing);
        this.#store.delete(key);
      }
      return;
    }

    // Replace-in-place: cancel the previous timer so we don't double-evict.
    const prior = this.#store.get(key);
    if (prior) {
      this.#cancelTimer(prior);
      this.#store.delete(key);
    }

    const cachedAt = this.#now();
    const expiresAt = cachedAt + ttlMs;
    const entry: InMemoryEntry = {
      value,
      cachedAt,
      expiresAt,
      timer: null,
    };

    // Arm eager eviction. We guard the callback against racing with
    // an explicit `set` under the same key: only evict if the entry
    // we recorded is still the live one.
    const timer = setTimeout(() => {
      const current = this.#store.get(key);
      if (current === entry) {
        this.#store.delete(key);
        this.#metrics.evictions++;
      }
    }, ttlMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    entry.timer = timer;

    this.#store.set(key, entry);

    // LRU overflow — drop the least-recently-used entry (the head of
    // the insertion order).
    while (this.#store.size > this.#maxEntries) {
      const oldestKey = this.#store.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.#store.get(oldestKey);
      if (oldest) this.#cancelTimer(oldest);
      this.#store.delete(oldestKey);
      this.#metrics.evictions++;
    }
  }

  async delete(key: string): Promise<void> {
    const entry = this.#store.get(key);
    if (!entry) return;
    this.#cancelTimer(entry);
    this.#store.delete(key);
  }

  async clear(): Promise<void> {
    for (const entry of this.#store.values()) {
      this.#cancelTimer(entry);
    }
    this.#store.clear();
  }

  /** Snapshot of the counter record. Safe to hand to observability code. */
  metrics(): CacheMetrics {
    return { ...this.#metrics };
  }

  /** Current entry count — visible for tests / operators. */
  size(): number {
    return this.#store.size;
  }

  #cancelTimer(entry: InMemoryEntry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }
}

// --------------------------------------------------------------------------
// Layered cache — L1 in front of L2 (ADR-065 §3 "Layered deployment")
// --------------------------------------------------------------------------

/**
 * L1-in-front-of-L2 cache composition. Reads prefer L1 and fall through
 * to L2 on miss, populating L1 on L2 hit so subsequent reads short-circuit.
 * Writes fan out to all layers.
 *
 * L1 TTLs SHOULD be the same as or shorter than L2 TTLs (ADR-065 §3) so
 * invalidation propagates via L1 expiry without requiring an explicit
 * L1-flush signal on L2 invalidation. This helper does not enforce that
 * — it's a composition primitive, policy is the caller's.
 *
 * Example:
 *   const l1 = new InMemoryCache({ maxEntries: 1_000 });
 *   const l2 = new RedisCache({ client: redis });
 *   const cache = new LayeredCache([l1, l2]);
 */
export class LayeredCache implements CacheBackend {
  readonly #layers: readonly CacheBackend[];

  constructor(layers: readonly CacheBackend[]) {
    if (!Array.isArray(layers) || layers.length === 0) {
      throw new Error("LayeredCache: at least one layer is required");
    }
    this.#layers = [...layers];
  }

  async get<T>(
    key: string,
  ): Promise<{ value: T; cachedAt: number } | null> {
    for (let i = 0; i < this.#layers.length; i++) {
      const layer = this.#layers[i]!;
      const hit = await layer.get<T>(key);
      if (hit !== null) {
        // Populate every shallower layer from this hit so the next
        // lookup short-circuits. We use a bounded back-fill TTL —
        // per-layer TTL isn't exposed by the `CacheBackend` contract
        // (the composition helper is deliberately TTL-agnostic), so we
        // cap at `BACKFILL_TTL_MS` to prevent an unexpectedly stale L2
        // hit from pinning L1 indefinitely. This matches the "L1 TTL ≤
        // L2 TTL" guidance in ADR-065 §3: the L1 entry expires soon
        // enough that the next miss will re-read L2 (which has its own
        // TTL), so staleness is bounded by the smaller of the two.
        for (let j = 0; j < i; j++) {
          await this.#layers[j]!.set(key, hit.value, BACKFILL_TTL_MS);
        }
        return hit;
      }
    }
    return null;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    // Fan out. We await all so callers can `.catch` and know every
    // layer has committed before the next `get`.
    await Promise.all(
      this.#layers.map((l) => l.set(key, value, ttlMs)),
    );
  }

  async delete(key: string): Promise<void> {
    await Promise.all(this.#layers.map((l) => l.delete(key)));
  }

  async clear(): Promise<void> {
    await Promise.all(
      this.#layers.map((l) => (l.clear ? l.clear() : Promise.resolve())),
    );
  }
}

/**
 * Default back-fill TTL (ms) used by `LayeredCache` when promoting an
 * L2 hit into L1. 60 s is short enough that L1 cannot pin stale data
 * for long, and long enough to absorb a burst of repeat reads.
 */
const BACKFILL_TTL_MS = 60_000;

// --------------------------------------------------------------------------
// Factory — env-driven backend selection (ADR-065 §3)
// --------------------------------------------------------------------------

/**
 * Build the cache backend implied by the current process env.
 *
 * - `AEP_REDIS_URL` set → returns a `RedisCache` bound to that URL.
 * - Otherwise → returns an `InMemoryCache`.
 *
 * Loaded lazily so in-memory deployments never pay the `ioredis` import
 * cost. Mirrors `createIdempotencyStore()` in
 * `mcp-server/src/pipeline/idempotency.ts` — ADR-065 §3 calls out the
 * shared `AEP_REDIS_URL` env var explicitly.
 *
 * For L1+L2 topologies, callers construct the composition themselves:
 *
 *   const cache = new LayeredCache([new InMemoryCache(), createCache(env)]);
 *
 * The factory does not compose by default because the in-memory-only
 * path is the common case and a 1-entry `LayeredCache` wrapper adds
 * overhead without benefit.
 */
export function createCache(
  env: { AEP_REDIS_URL?: string } = process.env,
): CacheBackend {
  const redisUrl = env.AEP_REDIS_URL;
  if (redisUrl && redisUrl.length > 0) {
    // Lazy require — keeps `ioredis` out of the in-memory path's import
    // graph. `require` (vs. dynamic `import()`) keeps the factory
    // synchronous so callers can wire it into a constructor without
    // awaiting.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("./cache-redis.js") as {
      RedisCache: new (opts: { url: string }) => CacheBackend;
    };
    return new mod.RedisCache({ url: redisUrl });
  }
  return new InMemoryCache();
}

/** Returns `"redis"` or `"memory"` — used at startup logging. */
export function activeCacheBackend(
  env: { AEP_REDIS_URL?: string } = process.env,
): "redis" | "memory" {
  return env.AEP_REDIS_URL && env.AEP_REDIS_URL.length > 0
    ? "redis"
    : "memory";
}
