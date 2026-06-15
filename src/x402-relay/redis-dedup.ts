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
 * Wire-level redemption sequence (ADR-126 §"Decision" steps 2-3, as
 * hardened by the cycle-3 off-chain audit close — OFF-201/203/205/206):
 *
 *   1. tryRedeem(sig, ttlMs, instanceId):
 *        lockValue = "<instanceId>|<random-nonce>"
 *        SET aep:redeemed:<sig> <lockValue> NX PX <ttlMs>
 *          -> "OK"  -> { kind: "ok", releaseToken: <lockValue> }
 *                        (this instance owns the slot; the releaseToken
 *                         is a capability the caller must present to
 *                         release the slot — see OFF-205 below)
 *          -> nil   -> { kind: "redeemed",
 *                        instanceId: GET aep:redeemed:<sig> (parsed) }
 *      Saturation check (see "Saturation strategy" below) gates the
 *      SET-NX call and returns { kind: "saturated" } at cap.
 *   2. releaseRedeemed(sig, releaseToken):
 *        Lua CAS-DEL: only DEL if the current lock value matches the
 *        presented releaseToken. Counters are decremented only when a
 *        DEL actually fires.
 *      Called by the relay when the post-RPC verify FAILS, so the slot
 *      is reclaimable. Happy-path redemptions stay locked for the full
 *      TTL window — the lock IS the redemption record. The CAS-DEL gate
 *      means an attacker who can reach Redis but cannot observe the
 *      relay's in-process releaseToken cannot free arbitrary slots.
 *
 * OFF-205 (cycle-3, 2026-04-27) — owner-bound release.
 *
 *   Pre-fix `releaseRedeemed(sig)` performed an unconditional `DEL
 *   aep:redeemed:<sig>`. Anyone with network reach to Redis (operator
 *   plane, sidecar, or — if the trust boundary moves — an external
 *   caller) could free a redeemed slot and re-open the replay window.
 *   The post-fix flow gates the DEL behind a Lua CAS that compares the
 *   stored lock value against a releaseToken returned only to the
 *   original `tryRedeem` caller. This binds release authority to the
 *   in-process slot owner regardless of who can talk to Redis.
 *
 * OFF-203 (cycle-3, 2026-04-27) — atomic claim invariant.
 *
 *   Pre-fix `index.ts` called `releaseRedeemed` on two race-loss
 *   branches (pre-verify in-memory hit; post-verify in-memory hit) on
 *   the assumption that the redis lock was a "leak" if a sibling local
 *   awaiter committed in-memory first. That release dropped the
 *   cluster-wide redemption record and let a SECOND relay instance
 *   re-acquire the slot, run verify, and mint a duplicate JWT for one
 *   payment. The OFF-203 fix removes those two release sites — the
 *   redis lock is the authoritative cluster-wide record, and once a
 *   JWT has been minted ANYWHERE in the cluster, the lock must ride
 *   out its TTL. The owner-bound release token (OFF-205) makes the
 *   atomic-claim contract explicit at the API: only the verify-failed
 *   / no-config / saturation-after-acquire branches call release, and
 *   they pass the token they received from `tryRedeem`.
 *
 * Trust-boundary placement (ADR-126 §"Trust-boundary placement" +
 * AUD-212 doc-comment in mcp-server/src/pipeline/idempotency-redis.ts):
 *
 *   Redis is INSIDE the trust boundary today (operator-controlled,
 *   network-isolated, no HMAC wrapper). The lock value's instanceId
 *   prefix is for observability ONLY — operators can `redis.GET
 *   aep:redeemed:<sig>` to see which instance issued the JWT — it is
 *   NOT a security primitive. The releaseToken nonce IS a security
 *   primitive (post-OFF-205): it is the capability that proves slot
 *   ownership and gates `releaseRedeemed`. If a future deployment moves
 *   Redis outside that boundary (shared cluster, multi-tenant), HMAC
 *   wrapping happens at `mcp-server/src/pipeline/idempotency-redis.ts`
 *   `deserializeResult`; the relay's redemption keys are write-only
 *   short-lived locks and the OFF-205 CAS-DEL already binds release.
 *
 * Saturation strategy (ADR-126 §"Decision" — "SCAN COUNT on the prefix
 * or a maintained counter key"):
 *
 *   We use a MAINTAINED COUNTER KEY (`aep:redeemed:count`) rather than
 *   walking SCAN on every /pay call. Justification:
 *
 *     - SCAN with the launch-window throughput estimate (~30 sigs/sec
 *       sustained per roadmap §4 C6) and MAX = 100k means each /pay
 *       call walks up to 100k keys to compute cardinality — O(N)
 *       per redemption when the in-memory map's `.size` was O(1).
 *       Operationally heavy and re-introduces a different scaling
 *       ceiling than the one ADR-126 lifts.
 *     - A counter key is O(1) per redemption (INCR on SET-NX OK,
 *       DECR on owner-authorized release). It mirrors the in-memory
 *       map's `.size` semantic exactly.
 *
 *   OFF-201 (cycle-3, 2026-04-27) — counter reconciler.
 *
 *     Pre-fix the counter only moved on INCR/DECR. TTL-expired keys did
 *     NOT auto-decrement, and under sustained throughput the counter
 *     drifted HIGH over time, eventually triggering false-positive
 *     `kind: "saturated"` 503s while the real cardinality was well
 *     below cap. The cycle-3 fix introduces a periodic SCAN-based
 *     reconciler (`reconcileCounter`) that recomputes the counter from
 *     actual `aep:redeemed:*` cardinality (excluding the counter key
 *     itself) and atomically replaces the maintained value. The fast
 *     path stays O(1); the reconciler is the slow-path source of truth
 *     and runs at a configurable interval (`RELAY_REDIS_RECONCILE_MS`,
 *     default 60s). Reconciler races with INCR/DECR are tolerated: an
 *     INCR/DECR that lands between SCAN and SET is overwritten, but
 *     the next reconciler tick re-establishes truth — the saturation
 *     gate's contract is "fail closed at cap +/- a tick of drift",
 *     never "deny on a stale count for an hour."
 */

import * as crypto from "node:crypto";
import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RedeemResult =
  | {
      kind: "ok";
      /**
       * OFF-205 owner-bound release capability. Opaque string the caller
       * MUST present to `releaseRedeemed` to free the slot. The token IS
       * the lock value stored in Redis; `releaseRedeemed` performs an
       * atomic CAS-DEL against it. Only meaningful for the LIVE client;
       * the disabled (no-op) implementation returns the empty string.
       */
      releaseToken: string;
    }
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
  set(key: string, value: string): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  /**
   * EVAL with KEYS / ARGV — used by `releaseRedeemed` (OFF-205 CAS-DEL).
   * ioredis v5 and ioredis-mock v8 both expose this signature
   * (`script, numKeys, ...keysAndArgs`).
   */
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown>;
  /**
   * SCAN cursor [MATCH pattern] [COUNT count] — used by the OFF-201
   * counter reconciler. ioredis v5 and ioredis-mock v8 both return
   * `[cursor, keys]`.
   */
  scan(
    cursor: string | number,
    ...args: (string | number)[]
  ): Promise<[string, string[]]>;
  quit?(): Promise<"OK" | string>;
  disconnect?(): void;
}

export interface RedisDedup {
  /**
   * Attempt to claim the redemption slot for `signature`.
   *   - `{ kind: "ok", releaseToken }` — this instance owns the slot;
   *                                       proceed to RPC verify. The
   *                                       releaseToken is the OFF-205
   *                                       owner capability and MUST be
   *                                       passed to `releaseRedeemed`
   *                                       on the verify-failed path.
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
   * OFF-205: the releaseToken returned by `tryRedeem` MUST be presented.
   * Release is gated by an atomic Lua CAS-DEL against the stored lock
   * value, so a caller without the token (network attacker, sidecar,
   * race-loser awaiter that never owned the lock) cannot free the slot.
   * No-op if the key does not exist (TTL already expired, or never set)
   * or if the token does not match. Idempotent.
   */
  releaseRedeemed(signature: string, releaseToken: string): Promise<void>;

  /**
   * For tests + `/admin/status` introspection. Returns the maintained
   * counter value. May briefly drift between reconciler ticks (see
   * "Saturation strategy" header comment) — `reconcileCounter()` is
   * the periodic source of truth that closes OFF-201.
   */
  approximateSize(): Promise<number>;

  /**
   * OFF-201 — recompute the saturation counter from the actual
   * `aep:redeemed:*` cardinality via SCAN. Called periodically by the
   * background reconciler (see `LiveRedisDedup` constructor) and also
   * exposed for direct invocation by tests + the `/admin/reconcile`
   * runbook step. Returns the new counter value.
   *
   * The disabled (no-op) implementation returns 0 — it has no Redis
   * to scan and the in-memory map is authoritative there.
   */
  reconcileCounter(): Promise<number>;

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

/**
 * Lua CAS-DEL script (OFF-205). Returns 1 on a successful authorized
 * delete, 0 on token-mismatch or already-gone. Stored as a top-level
 * constant so ioredis EVALSHA caching kicks in after the first call.
 *
 * KEYS[1] = redemption key (`aep:redeemed:<sig>`)
 * ARGV[1] = expected lock value (the releaseToken returned by tryRedeem)
 *
 * The counter DECR is intentionally NOT in the Lua block — it lives in
 * JS in `releaseRedeemed` so the counter-side correctness is unit-
 * testable without a Lua sandbox, and so a future move to Redis Cluster
 * (where multi-key Lua needs CROSSSLOT awareness) only has to re-think
 * one operation at a time.
 */
const RELEASE_CAS_DEL_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

/**
 * OFF-201 reconciler defaults. Operators tune via env in `index.ts`.
 *   - RECONCILE_DEFAULT_MS: how often to run the SCAN-based recount.
 *     60s is well above the SCAN cost at 100k cap (sub-second on a
 *     warm Redis) and well below SIGNATURE_TTL_MS (~hour) so a single
 *     drift run cannot accumulate enough false-positive saturation
 *     to matter operationally.
 *   - RECONCILE_SCAN_COUNT: SCAN COUNT hint per call. 1000 is the
 *     ioredis default for SCAN; explicit value here pins behavior
 *     against any future ioredis change.
 */
export const RECONCILE_DEFAULT_MS = 60_000;
export const RECONCILE_SCAN_COUNT = 1000;

/**
 * OFF-206 — default Redis command timeout (ms). Picked to be larger
 * than the worst-case healthy-Redis P99 (~50ms intra-AZ) but small
 * enough that a Redis brown-out shows up as 503s on the relay rather
 * than as request timeouts at the SDK / load balancer.
 */
export const REDIS_COMMAND_TIMEOUT_DEFAULT_MS = 2000;

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

  // Args are accepted-and-ignored to keep the call signature
  // structurally identical to the live implementation; the parameters
  // are intentionally unused (the disabled path defers to the
  // in-memory authority in index.ts).
  /* eslint-disable @typescript-eslint/no-unused-vars */
  async tryRedeem(
    _signature?: string,
    _ttlMs?: number,
    _instanceId?: string,
  ): Promise<RedeemResult> {
    // releaseToken is the empty string for the disabled path — the
    // caller MUST gate releaseRedeemed on `redisDedup.enabled` anyway,
    // so the value is unobservable by production code. Kept as `""`
    // rather than a sentinel string so a misuse (calling release with
    // the empty token against the LIVE path) is a guaranteed CAS
    // mismatch rather than a silent no-op.
    return { kind: "ok", releaseToken: "" };
  }

  async releaseRedeemed(
    _signature?: string,
    _releaseToken?: string,
  ): Promise<void> {
    // intentional no-op
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  async approximateSize(): Promise<number> {
    return 0;
  }

  async reconcileCounter(): Promise<number> {
    // No Redis to scan; the in-memory map is authoritative on the
    // disabled path. Returning 0 matches `approximateSize` for parity.
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

  /**
   * OFF-206 — per-command timeout in ms. Forwarded to ioredis as
   * `commandTimeout`. Ignored when `client` is supplied (tests inject
   * a mock; the timeout would have no effect on an in-process mock).
   * Defaults to `REDIS_COMMAND_TIMEOUT_DEFAULT_MS` when omitted on the
   * URL path.
   */
  commandTimeoutMs?: number;

  /**
   * OFF-201 — automatic reconciler interval in ms. When `> 0`, the
   * constructor schedules a `setInterval` that calls
   * `reconcileCounter()` on cadence. When `0` or omitted, no automatic
   * reconciler runs and operators (or tests) must call
   * `reconcileCounter()` manually. The interval is `.unref()`'d so it
   * does not keep the Node event loop alive on its own.
   */
  reconcileIntervalMs?: number;
}

export class LiveRedisDedup implements RedisDedup {
  readonly enabled = true;

  private readonly client: RedisClient;
  private readonly ownsClient: boolean;
  private readonly maxRedeemed: number;
  private readonly logger?: Logger;
  private reconcilerHandle?: NodeJS.Timeout;
  /**
   * In-flight reconciler de-dupe. If a tick is still running when the
   * next interval fires (e.g. SCAN is slow against a saturated cluster),
   * we skip the second tick instead of stacking concurrent SCAN walks.
   */
  private reconciling = false;

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
      // OFF-206: pass `commandTimeout` to the constructor so a Redis
      // brown-out times out at the command level rather than stalling
      // every /pay request indefinitely. ioredis v5 honors this option
      // verbatim. We also set a symmetric `connectTimeout` so a
      // never-completing TCP connect cannot sit on the initial dial
      // path longer than a single command would, and cap
      // `maxRetriesPerRequest` to 1 so a transient blip surfaces in
      // bounded time rather than ioredis's default 20-retry backoff.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const RedisCtor = require("ioredis") as
        | (new (
            url: string,
            options?: Record<string, unknown>,
          ) => RedisClient)
        | {
            default: new (
              url: string,
              options?: Record<string, unknown>,
            ) => RedisClient;
          };
      const Ctor =
        typeof RedisCtor === "function"
          ? RedisCtor
          : (
              RedisCtor as {
                default: new (
                  url: string,
                  options?: Record<string, unknown>,
                ) => RedisClient;
              }
            ).default;
      if (typeof Ctor !== "function") {
        throw new Error(
          "redis-dedup: failed to load 'ioredis'. Did you install the dependency?",
        );
      }
      const commandTimeout =
        opts.commandTimeoutMs ?? REDIS_COMMAND_TIMEOUT_DEFAULT_MS;
      this.client = new Ctor(opts.url, {
        commandTimeout,
        connectTimeout: commandTimeout,
        maxRetriesPerRequest: 1,
      });
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

    // OFF-201 — start the periodic reconciler if requested. Tests
    // typically pass `reconcileIntervalMs: 0` (or omit it) and call
    // `reconcileCounter()` directly so they can deterministically
    // observe the counter transition without timer flakiness.
    const reconcileMs = opts.reconcileIntervalMs ?? 0;
    if (reconcileMs > 0) {
      this.reconcilerHandle = setInterval(() => {
        // Fire-and-forget. Errors are logged inside `reconcileCounterTick`
        // and never propagated up through the timer callback (which
        // would otherwise crash the process).
        void this.reconcileCounterTick();
      }, reconcileMs);
      // Don't pin the event loop alive on the reconciler's behalf.
      this.reconcilerHandle.unref?.();
    }
  }

  async tryRedeem(
    signature: string,
    ttlMs: number,
    instanceId: string,
  ): Promise<RedeemResult> {
    // Saturation check FIRST — mirrors the in-memory `index.ts` path
    // where `redeemedSignatures.size >= MAX_REDEEMED_SIGNATURES` is
    // checked before the `.set` commit. Post-OFF-201 the counter is
    // periodically reconciled against actual cardinality, so this
    // check is bounded above by reconcile-cadence drift rather than
    // unbounded TTL drift.
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
    // OFF-205 owner-bound release token. The lock value is
    // `<instanceId>|<random-nonce>`:
    //
    //   - The instanceId prefix preserves the ADR-126 observability
    //     contract — operators can `redis-cli GET aep:redeemed:<sig>`
    //     and split on `|` to see which instance owns the slot.
    //   - The random-nonce suffix is the actual capability. 16 bytes
    //     of CSPRNG output is 128 bits of entropy — no birthday
    //     collisions across the 100k-entry cap, no meaningful chance
    //     of a network attacker guessing the token within the
    //     SIGNATURE_TTL_MS lifetime.
    //
    // The whole `<instanceId>|<nonce>` string IS the releaseToken; the
    // caller passes it verbatim to releaseRedeemed.
    const nonce = crypto.randomBytes(16).toString("hex");
    const lockValue = `${instanceId}|${nonce}`;

    // ADR-126 §"Decision" step 2: SET key value NX PX ttlMs.
    //   "OK" -> we own the slot.
    //   null -> someone else (this or another instance) holds it.
    const setResult = await this.client.set(key, lockValue, "NX", "PX", ttlMs);

    if (setResult === "OK") {
      // Maintain the counter. If INCR fails (network blip), the SET
      // already committed — log and proceed; the dedup invariant is
      // intact, only the saturation accounting drifts low for this
      // entry. The OFF-201 reconciler catches up on the next tick.
      try {
        await this.client.incr(REDEEMED_COUNTER_KEY);
      } catch (err) {
        this.logger?.warn(
          {
            err,
            signature_prefix: signature.slice(0, 8),
            event: "redis_dedup_counter_incr_failed",
          },
          "redis-dedup: INCR on counter failed after successful SET-NX; saturation accounting may drift low (reconciler will fix)",
        );
      }
      return { kind: "ok", releaseToken: lockValue };
    }

    // SET-NX failed -> already redeemed. Best-effort GET the holder's
    // instanceId for observability. If the key has since expired
    // between the SET-NX result and our GET (TTL race), `current` is
    // null and we still return `redeemed` — the SET-NX result is the
    // authoritative answer for THIS call; the post-hoc GET is purely
    // for the operator-facing instanceId trace. We split on `|` to
    // strip the OFF-205 nonce suffix; only the instanceId is surfaced.
    let holder: string | undefined;
    try {
      const current = await this.client.get(key);
      if (current !== null) {
        const pipeIdx = current.indexOf("|");
        holder = pipeIdx === -1 ? current : current.slice(0, pipeIdx);
      }
    } catch {
      // swallow — observability lookup, never blocks the dedup answer
    }
    return { kind: "redeemed", instanceId: holder };
  }

  async releaseRedeemed(
    signature: string,
    releaseToken: string,
  ): Promise<void> {
    if (typeof releaseToken !== "string" || releaseToken === "") {
      // OFF-205: empty/missing token can never match a live lock value
      // (which is always `<instanceId>|<nonce>`). Refuse early so a
      // caller mistake (or a forged release attempt that lacks the
      // capability) is loud rather than silently no-op.
      this.logger?.warn(
        {
          signature_prefix: signature.slice(0, 8),
          event: "redis_dedup_release_missing_token",
        },
        "redis-dedup: releaseRedeemed called without a release token; refusing",
      );
      return;
    }

    const key = redeemedKey(signature);
    // OFF-205 — Lua CAS-DEL. Atomic GET-then-DEL race-free against
    // concurrent SET-NX from other relay instances. Returns 1 on a
    // successful authorized DEL, 0 on token-mismatch or already-gone.
    let removed = 0;
    try {
      const result = await this.client.eval(
        RELEASE_CAS_DEL_LUA,
        1,
        key,
        releaseToken,
      );
      // ioredis returns Lua integer returns as JS numbers; ioredis-mock
      // matches. Defensive parse for any client that stringifies.
      if (typeof result === "number") {
        removed = result;
      } else if (typeof result === "string") {
        const parsed = Number.parseInt(result, 10);
        removed = Number.isFinite(parsed) ? parsed : 0;
      }
    } catch (err) {
      this.logger?.warn(
        {
          err,
          signature_prefix: signature.slice(0, 8),
          event: "redis_dedup_release_eval_failed",
        },
        "redis-dedup: CAS-DEL eval on redemption key failed; slot will reclaim via TTL",
      );
      return;
    }
    if (removed > 0) {
      try {
        await this.client.decr(REDEEMED_COUNTER_KEY);
      } catch (err) {
        this.logger?.warn(
          { err, event: "redis_dedup_counter_decr_failed" },
          "redis-dedup: DECR on counter failed after successful CAS-DEL; saturation accounting may drift high (reconciler will fix)",
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

  /**
   * OFF-201 — recompute the saturation counter from actual
   * `aep:redeemed:*` cardinality and atomically replace the maintained
   * value. SCAN is cursor-based and non-blocking; we walk to
   * completion (cursor "0") summing key counts that are NOT the counter
   * key itself, then SET the counter to that sum.
   *
   * Race tolerance: an INCR or DECR landing between our last SCAN page
   * and our SET will be overwritten. Acceptable per the contract — the
   * next reconciler tick re-establishes truth, and the fast-path
   * `tryRedeem` saturation gate is bounded above by the cap regardless
   * of small drift.
   */
  async reconcileCounter(): Promise<number> {
    let cursor: string = "0";
    let trueCount = 0;
    do {
      const [next, keys] = await this.client.scan(
        cursor,
        "MATCH",
        REDEEMED_KEY_PREFIX + "*",
        "COUNT",
        RECONCILE_SCAN_COUNT,
      );
      cursor = next;
      for (const k of keys) {
        // SCAN MATCH `aep:redeemed:*` matches the counter key itself
        // (`aep:redeemed:count`) — exclude it or we'd be counting it
        // as a redemption.
        if (k !== REDEEMED_COUNTER_KEY) {
          trueCount++;
        }
      }
    } while (cursor !== "0");

    // Plain SET (no NX/PX) — periodic source-of-truth overwrite.
    // The two-arg overload on the structural `RedisClient` interface
    // is the right shape for this.
    await this.client.set(REDEEMED_COUNTER_KEY, String(trueCount));

    this.logger?.debug?.(
      {
        true_count: trueCount,
        event: "redis_dedup_counter_reconciled",
      },
      "redis-dedup: counter reconciled from SCAN cardinality (OFF-201)",
    );

    return trueCount;
  }

  /**
   * Internal — wraps `reconcileCounter` with the in-flight de-dupe
   * guard and structured-error swallow that the timer callback needs.
   * Public callers should use `reconcileCounter` directly so SCAN
   * failures surface.
   */
  private async reconcileCounterTick(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this.reconcileCounter();
    } catch (err) {
      this.logger?.warn(
        { err, event: "redis_dedup_reconcile_failed" },
        "redis-dedup: reconciler tick failed; counter may continue to drift until next tick",
      );
    } finally {
      this.reconciling = false;
    }
  }

  async close(): Promise<void> {
    if (this.reconcilerHandle !== undefined) {
      clearInterval(this.reconcilerHandle);
      this.reconcilerHandle = undefined;
    }
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
  /**
   * OFF-206 — forwarded to LiveRedisDedup as ioredis `commandTimeout`.
   * Defaults to `REDIS_COMMAND_TIMEOUT_DEFAULT_MS` (2000ms).
   */
  commandTimeoutMs?: number;
  /**
   * OFF-201 — forwarded to LiveRedisDedup as the periodic SCAN-based
   * reconciler interval. Defaults to `RECONCILE_DEFAULT_MS` (60_000)
   * when live; `0` disables the automatic reconciler (manual call
   * only).
   */
  reconcileIntervalMs?: number;
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
    commandTimeoutMs:
      opts.commandTimeoutMs ?? REDIS_COMMAND_TIMEOUT_DEFAULT_MS,
    reconcileIntervalMs:
      opts.reconcileIntervalMs ?? RECONCILE_DEFAULT_MS,
  });
}
