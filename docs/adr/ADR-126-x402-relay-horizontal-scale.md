# ADR-126: x402-relay horizontal scale (Redis-backed dedup)

## Status

Proposed

## Date

2026-04-27

## Context

The x402-relay (`src/x402-relay/index.ts`) is single-instance by
construction. Its replay-prevention surface is two in-process maps:

- `redeemedSignatures: Map<string, number>` — committed signatures,
  TTL-evicted (`SIGNATURE_TTL_MS = (TOKEN_EXPIRY_SECONDS + 300) * 1000`).
- `inFlightVerify: Map<string, Promise<PaymentVerification>>` — in-flight
  RPC calls, collapsed across concurrent callers (AUD-208 TOCTOU fix).

Both are explicitly documented as **single-instance only** at
`src/x402-relay/index.ts:87-91`:

> Two relay processes behind a load balancer can still issue duplicate
> JWTs because they don't share `inFlightVerify` or `redeemedSignatures`.

Two cycle-2 audit findings touch the same scaling boundary:

- **AUD-028**: anti-Sybil defense assumes a single dedup authority.
  Multiple relay processes break the 1-payment-1-token invariant
  the relay's whole job is to enforce.
- **AUD-209**: the saturation guard at `MAX_REDEEMED_SIGNATURES =
  100_000` returns 503 fail-closed (commit `b59ef6c`). At the bound
  AUD-209 names (~30 sigs/sec sustained per the roadmap §4 C6
  estimate, which is `100_000 / SIGNATURE_TTL_MS`), a single instance
  is the throughput ceiling.

The mcp-server idempotency layer at
`mcp-server/src/pipeline/idempotency-redis.ts:340-356` already
deploys Redis for action-result memoization, and AUD-212 (cycle-2,
2026-04-26) explicitly defers an HMAC tamper-detection wrapper
around the cached payload on the basis that "Redis is inside the
trust boundary (operator-controlled, network-isolated)." That trust
posture is exactly the one the relay's horizontal-scale story needs
to inherit.

This ADR records the horizontal-scale design decision so the
relay-side, idempotency-side, and ops-side all reference the same
target.

**Why now (vs. defer indefinitely)**: the roadmap §4 C6 ties this
ADR to a launch-throughput estimate (open question §8 #3). If launch
agents will exceed ~30 sigs/sec sustained, the in-memory ceiling is
load-bearing for the launch; the design must land before first
paying customer rather than after.

**Why not part of ADR-117**: ADR-117 (`docs/adr/ADR-117-x402-relay-error-redaction.md`)
is the **error-redaction** ADR. Multiple in-flight references
(roadmap §4 C6, `src/x402-relay/index.ts:89/481`,
`mcp-server/src/pipeline/idempotency-redis.ts:351-356`) had drifted
into using "ADR-117" as shorthand for "the in-flight horizontal-scale
ADR." This ADR fixes the cross-link so operators and SDK consumers
land on the right document. The error-redaction ADR is unaffected.

## Decision

Replace the in-process `redeemedSignatures` + `inFlightVerify` maps
with a Redis-backed dedup store, gated by a `SET ... NX ... PX`
(SET-IF-NOT-EXISTS with millisecond TTL) primitive that is atomic
across the cluster.

**Wire-level redemption sequence (post-ADR-126)**:

1. Client POSTs `/pay` with `txSignature`.
2. Relay calls `redis.SET("aep:redeemed:" + txSignature, instanceId,
   NX, PX, SIGNATURE_TTL_MS)`.
   - Returns `OK` → this instance is responsible; proceed to RPC verify.
   - Returns `nil` → another instance has the slot; abort with the
     existing 409-redeemed response.
3. After RPC verify resolves, the relay either:
   - Commits the JWT (the lock already held → no further write).
   - Releases the lock with `redis.DEL("aep:redeemed:" + txSignature)`
     IF the verify failed. (Happy-path redemptions stay locked for
     the full TTL window — the lock IS the redemption record.)

The two in-process maps are removed. The saturation 503 surface from
AUD-209 stays, but the bound moves from
`Map.size >= MAX_REDEEMED_SIGNATURES` to a Redis-side cardinality
check (`SCAN COUNT` on the prefix or a maintained counter key).

**Trust-boundary placement**:

- Redis IS inside the trust boundary (per AUD-212): operator-controlled,
  network-isolated, no HMAC wrapper today.
- If a future deployment moves Redis outside that boundary
  (shared cluster, multi-tenant), `mcp-server/src/pipeline/idempotency-redis.ts`
  `deserializeResult` is the documented HMAC enforcement point. The
  relay's redemption keys are write-only short-lived locks, so they
  do not need the same HMAC envelope; the lock-ID-vs-instance-ID
  mismatch is the integrity check.

## Surface impact

- `src/x402-relay/index.ts` — replace the two in-process maps with
  Redis client calls; AUD-208 in-flight-verify collapsing semantics
  preserved via the SET-NX result handling.
- New env var: `RELAY_REDIS_URL` (REQUIRED; relay refuses to start
  without it, mirroring the AUD-027 JWT_SECRET length-floor pattern).
- `src/x402-relay/package.json` — add `ioredis` (or whatever Redis
  client mcp-server already uses, to keep the dep set small —
  cross-check `mcp-server/package.json`).
- `src/x402-relay/test/aud-209-saturation.test.ts` — the
  `__fillRedemptionStateForTests` hook (commit `b59ef6c`) becomes a
  Redis pipeline rather than a `Map.set` loop; the test contract
  (saturation → 503) is unchanged.
- New test: `src/x402-relay/test/aud-126-multi-instance-dedup.test.ts`
  — two in-process relay imports against a shared `redis-mock` (or
  testcontainers Redis), POST same `txSignature` to both, assert
  exactly one 200 + one 409.
- `mcp-server/src/pipeline/idempotency-redis.ts:340-356` —
  cross-reference comment updated to point at this ADR for the
  trust-boundary policy.
- `docs/PRE_MAINNET_ROADMAP.md` §4 C6 — mark as "ADR-126 (Proposed)".
- `docs/INCIDENT_RESPONSE.md` §4 — saturation runbook updated to the
  Redis-backed model (the manual scale-out section becomes "spin up
  a second relay process pointing at the same Redis").

## Consequences

### Positive

- Stateless relay processes; horizontal scaling becomes trivial.
- Lifts the AUD-209 throughput ceiling from "~30 sigs/sec per
  process" to "Redis cluster throughput", which is operationally
  unbounded for our scale.
- Closes the trust-model loop AUD-212 deferred — Redis is now the
  canonical inside-the-boundary store for both action idempotency
  and relay redemption locks.

### Negative

- Redis becomes a hard runtime dependency for x402-relay (today it
  is mcp-server-only). Operators MUST provision and HA-monitor
  Redis as part of the deploy ceremony (folds into C5 indexer
  redundancy + new C-track work for Redis HA).
- Redis outage = relay outage. Today's in-process design fails
  closed at saturation (AUD-209) but otherwise tolerates network
  flakes; post-ADR-126, a Redis-side outage gates ALL `/pay`
  requests, not just the saturation-bound ones.
- AUD-208 in-flight-verify collapsing across instances is not
  preserved — two instances racing on the same `txSignature` will
  both call the RPC verifier; the SET-NX gate ensures only one
  redeems, but the wasted RPC call is a small cost. Single-instance
  deployments retain the in-flight collapse via a local secondary
  cache.

### Neutral

- The `instanceId` field embedded in the lock value is for
  observability (operator can query `redis.GET aep:redeemed:<sig>`
  to see which instance issued the JWT); it is not a security
  primitive.

## Alternatives considered

- **Postgres unique-constraint table** (insert with `ON CONFLICT DO
  NOTHING` returning row-count). Strictly more durable than Redis
  (replicated WAL, cross-region failover semantics), but adds
  ~20-50ms per redemption vs Redis's ~1ms. Roadmap §4 C5 may stand
  up Postgres for indexer; if so, this becomes a more attractive
  fallback. Rejected for primary because mcp-server already runs
  Redis and we want one inside-the-boundary store, not two.
- **CRDB with serializable isolation**: overkill for the throughput
  shape. The 1-payment-1-token invariant only needs SET-NX; CRDB's
  cross-region serializable transactions are paying for guarantees
  we do not need.
- **In-process partitioning by signature prefix** (load-balancer
  hashes by `txSignature[0:2]` to a fixed instance): degenerates to
  a single instance for any `txSignature` collision and re-introduces
  the AUD-209 ceiling per partition. Rejected.
- **Status quo + horizontal scale via separate relay clusters per
  tenant**: works only if tenant-per-relay is the deploy topology;
  changes the operational model in ways that conflict with AUD-027
  shared JWT_SECRET semantics. Rejected.

## References

- ADR-017 — x402 HTTP payment relay (architectural origin).
- ADR-117 — x402-relay error redaction policy (separate concern;
  this ADR fixes references that had drifted into using ADR-117 as
  a shorthand for the horizontal-scale work).
- ADR-080 — mainnet deploy safety mandates (§5 deploy-log
  requirement applies to the new `RELAY_REDIS_URL` env var).
- AUD-028 — anti-Sybil defense (cycle-1; `docs/audits/ARCHITECTURE-AUDIT-2026-04-25.md`).
- AUD-208 — in-flight verify TOCTOU fix (cycle-2 closure;
  `src/x402-relay/index.ts:72-92`).
- AUD-209 — saturation guard (cycle-2 closure, commit `b59ef6c`;
  `src/x402-relay/index.ts:89-91, :419-484`; regression test at
  `src/x402-relay/test/aud-209-saturation.test.ts`).
- AUD-212 — Redis trust-boundary decision (cycle-2 closure;
  `mcp-server/src/pipeline/idempotency-redis.ts:340-356`).
- `docs/PRE_MAINNET_ROADMAP.md` §4 C6 — operational tracking.
- `docs/INCIDENT_RESPONSE.md` §4 — saturation incident runbook
  (will be updated to reference this ADR once it ships).
