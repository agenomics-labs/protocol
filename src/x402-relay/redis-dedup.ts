/**
 * ADR-126 Phase 1 — Redis-backed redemption dedup (scaffolding).
 *
 * This module ships the SET-NX primitive + dual-write capability for
 * cross-instance signature dedup. It is OPT-IN: when `RELAY_REDIS_URL`
 * is unset, `index.ts` instantiates `DisabledRedisDedup` and behavior
 * is byte-identical to the pre-ADR-126 in-memory-only path.
 *
 *   - Phase 1 (this PR): `RELAY_REDIS_URL` unset -> no-op client; the
 *     in-memory `redeemedSignatures` Map remains authoritative. When
 *     SET, redis becomes the cross-instance authority and the in-memory
 *     map is dual-written as a local cache (still consulted first for
 *     AUD-208 in-flight-verify collapsing semantics). No production
 *     behavior changes for existing operators.
 *   - Phase 2 (separate future PR): remove the in-memory map + the
 *     `__fillRedemptionStateForTests` hook + the AUD-208 in-flight cache,
 *     promote `RELAY_REDIS_URL` to REQUIRED (matching ADR-126 §"Surface
 *     impact"), update INCIDENT_RESPONSE.md §4 saturation runbook.
 *
 * Wire-level redemption sequence (ADR-126 §"Decision" steps 2-3):
 *
 *   1. tryRedeem(sig, ttlMs, instanceId):
 *        SET aep:redeemed:<sig> <instanceId> NX PX <ttlMs>
 *          -> "OK"  -> { kind: "ok" }       (this instance owns the slot)
 *          -> nil   -> { kind: "redeemed",
 *                        instanceId: GET aep:redeemed:<sig> }
 *      Saturation check (see "Saturation strategy" below) gates the
 *      SET-NX call and returns { kind: "saturated" } at cap.
 *   2. releaseRedeemed(sig):
 *        DEL aep:redeemed:<sig>
 *      Called by the relay when the post-RPC verify FAILS, so the slot
 *      is reclaimable. Happy-path redemptions stay locked for the full
 *      TTL window — the lock IS the redemption record.
 *
 * Trust-boundary placement (ADR-126 §"Trust-boundary placement" +
 * AUD-212 doc-comment in mcp-server/src/pipeline/idempotency-redis.ts):
 *
 *   Redis is INSIDE the trust boundary today (operator-controlled,
 *   network-isolated, no HMAC wrapper). The lock value carries
 *   `instanceId` for observability ONLY — operators can `redis.GET
 *   aep:redeemed:<sig>` to see which instance issued the JWT — it is
 *   NOT a security primitive. If a future deployment moves Redis
 *   outside that boundary (shared cluster, multi-tenant), HMAC
 *   wrapping happens at `mcp-server/src/pipeline/idempotency-redis.ts`
 *   `deserializeResult`; the relay's redemption keys are write-only
 *   short-lived locks and don't need the same envelope.
 *
 * Saturation strategy (ADR-126 §"Decision" — "SCAN COUNT on the prefix
 * or a maintained counter key"):
 *
 *   We use a MAINTAINED COUNTER KEY (`aep:redeemed:count`) rather than
 *   `SCAN COUNT MATCH aep:redeemed:*`. Justification:
 *
 *     - SCAN with the launch-window throughput estimate (~30 sigs/sec
 *       sustained per roadmap §4 C6) and MAX = 100k means each /pay
 *       call walks up to 100k keys to compute cardinality — O(N)
 *       per redemption when the in-memory map's `.size` was O(1).
 *       Operationally heavy and re-introduces a different scaling
 *       ceiling than the one ADR-126 lifts.
 *     - A counter key is O(1) per redemption (INCR on SET-NX OK,
 *       DECR on explicit releaseRedeemed). It mirrors the in-memory
 *       map's `.size` semantic exactly.
 *
 *   KNOWN PHASE 1 LIMITATION: TTL-expired keys do NOT auto-decrement
 *   the counter. Under sustained throughput the counter drifts HIGH
 *   over time (false-positive saturation). For Phase 1 this is
 *   acceptable because the in-memory map is still authoritative — the
 *   counter only gates a strictly-stricter check. Phase 2 closes the
 *   drift via one of:
 *     (a) Redis keyspace-notification subscriber that DECRs on
 *         `expired` events for the prefix; or
 *     (b) periodic background `SCAN MATCH aep:redeemed:* | wc -l`
 *         reconciliation (slow path, runs every minute, OK because
 *         the fast path is the counter); or
 *     (c) Redis 7.4 hash-field TTL + HLEN on a single hash key.
 *
 *   When `releaseRedeemed` runs we DECR (the verify-failed path is
 *   the only path that explicitly releases; happy-path lock holders
 *   ride out their TTL).
 */

import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RedeemResult =
  | { kind: "ok" }
  | { kind: "redeemed"; instanceId?: string }
  | { kind: "saturated" };

/**
 * Structural Redis client — only the commands we use. Mirrors the
 * pattern in `mcp-server/src/pipeline/idempotency-redis.ts` so tests
 * can inject `ioredis-mock` without a transitive type import.
 *
 * The variadic `set(...args: SetArgs)` signature matches both ioredis
 * v5 and ioredis-mock v8.
 */
export type SetNxPxArgs = [
  key: string,
  value: string,
  nx: "NX",
  px: "PX",
  ttlMs: number,
];

export interface RedisClient {
  set(...args: SetNxPxArgs): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  quit?(): Promise<"OK" | string>;
  disconnect?(): void;
}

export interface RedisDedup {
  /**
   * Attempt to claim the redemption slot for `signature`.
   *   - `{ kind: "ok" }`         — this instance owns the slot; proceed
   *                                 to RPC verify.
   *   - `{ kind: "redeemed" }`   — another instance (or a previous call
   *                                 from this one) holds the slot.
   *   - `{ kind: "saturated" }`  — the cluster-wide count is at cap.
   *                                 Mirrors the AUD-209 503 contract.
   */
  tryRedeem(
    signature: string,
    ttlMs: number,
    instanceId: string,
  ): Promise<RedeemResult>;

  /**
   * Release a slot acquired via `tryRedeem` — used on the verify-FAILED
   * path so the slot is reclaimable. Happy-path redemptions ride out
   * their TTL (the lock IS the redemption record).
   *
   * No-op if the key does not exist (TTL already expired, or never set).
   * Idempotent.
   */
  releaseRedeemed(signature: string): Promise<void>;

  /**
   * For tests + `/admin/status` introspection. Returns the maintained
   * counter value. May drift HIGH from the true cardinality (see
   * "Saturation strategy" header comment).
   */
  approximateSize(): Promise<number>;

  /** Close the underlying client (if owned). Safe to call repeatedly. */
  close(): Promise<void>;

  /** Whether this client is the active (live) implementation. */
  readonly enabled: boolean;
}

// ---------------------------------------------------------------------------
// Key namespace
// ---------------------------------------------------------------------------

/**
 * Per ADR-126 §"Decision" step 2 — `aep:redeemed:<txSignature>`.
 * Exported so tests can inspect the underlying mock without
 * re-deriving the prefix.
 */
export const REDEEMED_KEY_PREFIX = "aep:redeemed:";

/** Maintained counter for the saturation gate. See header comment. */
export const REDEEMED_COUNTER_KEY = "aep:redeemed:count";

export function redeemedKey(signature: string): string {
  return REDEEMED_KEY_PREFIX + signature;
}

// ---------------------------------------------------------------------------
// Disabled (no-op) implementation
// ---------------------------------------------------------------------------

/**
 * Used when `RELAY_REDIS_URL` is unset. Mirrors the B11 `DisabledEvoClient`
 * pattern + ADR-129's kill-switch precedent: every call returns the
 * "carry on, in-memory path is authoritative" answer (`kind: "ok"` for
 * tryRedeem, no-op release).
 *
 * IMPORTANT: returning `kind: "ok"` here is correct precisely because
 * `index.ts` then runs the existing in-memory `redeemedSignatures.has`
 * check immediately afterward. The disabled path cannot itself reject
 * a duplicate signature — it MUST defer to the in-memory authority.
 * If you ever flip the call order (redis-after-memory), revisit this.
 */
export class DisabledRedisDedup implements RedisDedup {
  readonly enabled = false;

  async tryRedeem(): Promise<RedeemResult> {
    return { kind: "ok" };
  }

  async releaseRedeemed(): Promise<void> {
    // intentional no-op
  }

  async approximateSize(): Promise<number> {
    return 0;
  }

  async close(): Promise<void> {
    // intentional no-op
  }
}

// ---------------------------------------------------------------------------
// Live (Redis-backed) implementation
// ---------------------------------------------------------------------------

export interface LiveRedisDedupOptions {
  /**
   * `redis://` URL. Ignored if `client` is supplied (tests). When
   * absent, the constructor will throw — wire-level construction MUST
   * supply one of url/client.
   */
  url?: string;

  /** Pre-built client (tests, shared pool). Takes precedence over `url`. */
  client?: RedisClient;

  /** Saturation cap. Mirrors `MAX_REDEEMED_SIGNATURES` in `index.ts`. */
  maxRedeemed: number;

  /** Optional structured logger; if absent, errors are silently swallowed. */
  logger?: Logger;
}

export class LiveRedisDedup implements RedisDedup {
  readonly enabled = true;

  private readonly client: RedisClient;
  private readonly ownsClient: boolean;
  private readonly maxRedeemed: number;
  private readonly logger?: Logger;

  constructor(opts: LiveRedisDedupOptions) {
    if (opts.client) {
      this.client = opts.client;
      this.ownsClient = false;
    } else if (opts.url) {
      // The relay's tsconfig is `module: "commonjs"`, so a plain
      // `require("ioredis")` works without `createRequire`. We keep
      // the load lazy (constructor-time) for two reasons:
      //   (a) when `RELAY_REDIS_URL` is unset, the module must not
      //       pay the import cost or crash on a missing dependency;
      //   (b) tests pass a pre-built `client` and never trigger this
      //       branch, so they don't need ioredis on disk.
      //
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const RedisCtor = require("ioredis") as
        | (new (url: string) => RedisClient)
        | { default: new (url: string) => RedisClient };
      const Ctor =
        typeof RedisCtor === "function"
          ? RedisCtor
          : (RedisCtor as { default: new (url: string) => RedisClient }).default;
      if (typeof Ctor !== "function") {
        throw new Error(
          "redis-dedup: failed to load 'ioredis'. Did you install the dependency?",
        );
      }
      this.client = new Ctor(opts.url);
      this.ownsClient = true;
    } else {
      throw new Error(
        "LiveRedisDedup: either `url` or `client` must be provided",
      );
    }

    if (!Number.isInteger(opts.maxRedeemed) || opts.maxRedeemed <= 0) {
      throw new Error(
        `LiveRedisDedup: maxRedeemed must be a positive integer; got ${opts.maxRedeemed}`,
      );
    }
    this.maxRedeemed = opts.maxRedeemed;
    this.logger = opts.logger;
  }

  async tryRedeem(
    signature: string,
    ttlMs: number,
    instanceId: string,
  ): Promise<RedeemResult> {
    // Saturation check FIRST — mirrors the in-memory `index.ts` path
    // where `redeemedSignatures.size >= MAX_REDEEMED_SIGNATURES` is
    // checked before the `.set` commit. Here the counter may drift
    // HIGH (TTL-expired keys don't decrement); that is the documented
    // Phase 1 trade-off (see header comment "Saturation strategy").
    //
    // We use GET (not the post-INCR value) to avoid the race where two
    // concurrent callers both INCR past the cap and only then check.
    // GET-then-INCR is not atomic, but the in-memory map's
    // `.size >= cap` check is also a non-atomic read — the AUD-209
    // contract is "fail-closed at cap"; a small overshoot from
    // concurrent racers is acceptable, and the SET-NX itself is the
    // hard atomicity boundary for the dedup invariant.
    const sizeRaw = await this.client.get(REDEEMED_COUNTER_KEY);
    const size = sizeRaw === null ? 0 : Number.parseInt(sizeRaw, 10);
    if (Number.isFinite(size) && size >= this.maxRedeemed) {
      return { kind: "saturated" };
    }

    const key = redeemedKey(signature);
    // ADR-126 §"Decision" step 2: SET key value NX PX ttlMs.
    //   "OK" -> we own the slot.
    //   null -> someone else (this or another instance) holds it.
    const setResult = await this.client.set(key, instanceId, "NX", "PX", ttlMs);

    if (setResult === "OK") {
      // Maintain the counter. If INCR fails (network blip), the SET
      // already committed — log and proceed; the dedup invariant is
      // intact, only the saturation accounting drifts low for this
      // entry. Phase 2's reconciliation pass would catch it.
      try {
        await this.client.incr(REDEEMED_COUNTER_KEY);
      } catch (err) {
        this.logger?.warn(
          { err, signature_prefix: signature.slice(0, 8), event: "redis_dedup_counter_incr_failed" },
          "redis-dedup: INCR on counter failed after successful SET-NX; saturation accounting may drift low",
        );
      }
      return { kind: "ok" };
    }

    // SET-NX failed -> already redeemed. Best-effort GET the holder's
    // instanceId for observability. If the key has since expired
    // between the SET-NX result and our GET (TTL race), `current` is
    // null and we still return `redeemed` — the SET-NX result is the
    // authoritative answer for THIS call; the post-hoc GET is purely
    // for the operator-facing instanceId trace.
    let holder: string | undefined;
    try {
      const current = await this.client.get(key);
      if (current !== null) holder = current;
    } catch {
      // swallow — observability lookup, never blocks the dedup answer
    }
    return { kind: "redeemed", instanceId: holder };
  }

  async releaseRedeemed(signature: string): Promise<void> {
    const key = redeemedKey(signature);
    // DEL returns the number of keys removed (0 if already gone).
    // Decrement the counter ONLY if we actually removed a key, to avoid
    // double-decrement when releaseRedeemed runs twice (e.g. retry).
    let removed = 0;
    try {
      removed = await this.client.del(key);
    } catch (err) {
      this.logger?.warn(
        { err, signature_prefix: signature.slice(0, 8), event: "redis_dedup_release_del_failed" },
        "redis-dedup: DEL on redemption key failed; slot will reclaim via TTL",
      );
      return;
    }
    if (removed > 0) {
      try {
        await this.client.decr(REDEEMED_COUNTER_KEY);
      } catch (err) {
        this.logger?.warn(
          { err, event: "redis_dedup_counter_decr_failed" },
          "redis-dedup: DECR on counter failed after successful DEL; saturation accounting may drift high",
        );
      }
    }
  }

  async approximateSize(): Promise<number> {
    const raw = await this.client.get(REDEEMED_COUNTER_KEY);
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  }

  async close(): Promise<void> {
    if (!this.ownsClient) return;
    if (typeof this.client.quit === "function") {
      await this.client.quit();
    } else if (typeof this.client.disconnect === "function") {
      this.client.disconnect();
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateRedisDedupOptions {
  /** Raw value of `process.env.RELAY_REDIS_URL`. Empty string treated as unset. */
  url: string | undefined;
  /** Cap to enforce when live. Mirrors `MAX_REDEEMED_SIGNATURES` in `index.ts`. */
  maxRedeemed: number;
  logger?: Logger;
}

/**
 * Wire-level entry point used by `index.ts`. Returns the disabled
 * implementation when `url` is unset/empty (Phase 1 default), or a
 * live `LiveRedisDedup` otherwise.
 *
 * AUD-027 fail-closed pattern: if `url` is set but malformed (not a
 * valid `redis://` / `rediss://` URL), throw at module load. Mirrors
 * the JWT_SECRET length-floor gate — misconfigurations surface at
 * boot, not on the first /pay call mid-incident.
 */
export function createRedisDedup(opts: CreateRedisDedupOptions): RedisDedup {
  const raw = opts.url;
  if (raw === undefined || raw === "") {
    return new DisabledRedisDedup();
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "RELAY_REDIS_URL is set but not a valid URL. Expected redis:// or rediss:// scheme.",
    );
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error(
      `RELAY_REDIS_URL has unsupported scheme '${parsed.protocol}'. Expected redis:// or rediss://.`,
    );
  }
  return new LiveRedisDedup({
    url: raw,
    maxRedeemed: opts.maxRedeemed,
    logger: opts.logger,
  });
}
