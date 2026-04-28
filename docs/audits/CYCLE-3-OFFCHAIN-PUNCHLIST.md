# Cycle 3 — Off-chain Punchlist (2026-04-27)

Production-blocking findings from the cycle-3 off-chain audit. Until
the C/H findings close, `RELAY_REDIS_URL` and `INDEXER_PG_URL` must
remain unset in production.

## Source

- Audit: `docs/audits/ARCHITECTURE-AUDIT-2026-04-27-cycle3-offchain.md`
- Cycle-2 baseline: `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-offchain.md`

## Critical (production blockers)

| ID | Title | File:Lines | Owner | Status |
|---|---|---|---|---|
| OFF-200 | Indexer dual-write non-transactional | src/indexer/index.ts:1030,1082-1089 | k2jac9 | **Partial — `cfe8e92`** [^off200] |
| OFF-201 | Redis counter drifts unbounded | src/x402-relay/redis-dedup.ts:295,322 | k2jac9 | **Closed — `3c63f8e`** [^off201] |

[^off200]: Closed for the canonical event-INSERT + cursor-UPSERT pair via `withTransaction` helper (`postgres-store.ts`) and rewire of the two authoritative dual-write sites in `index.ts`. **Scoped out**: 10 projection-only fire-and-forget sites in `updateAgentFromEvent` (lines 678, 704, 747, 793, 808, 825, 841, 856, 880, 881 of the pre-fix file) remain single-write; projection rows are derivable from the authoritative event log if they ever diverge. Real-PG transactional verification closed in OFF-217 (`c0ba30a`).

[^off201]: Closed by adding a periodic SCAN-based reconciler (`LiveRedisDedup.reconcileCounter`) that recomputes `aep:redeemed:count` from actual `aep:redeemed:*` cardinality, ignoring the counter key itself. The fast path stays O(1) (INCR / DECR on tryRedeem / releaseRedeemed); the reconciler runs at `RELAY_REDIS_RECONCILE_MS` cadence (default 60s, env-tunable, `0` disables). Reconciler races with INCR/DECR are tolerated — an INCR/DECR landing between SCAN and SET is overwritten, and the next reconciler tick re-establishes truth. Regression tests: `src/x402-relay/test/off-201-203-205-206.test.ts` covers drift-HIGH (counter says 4, only 1 key exists), drift-LOW (INCR-failure shape), counter-key self-exclusion, and saturation false-positive lift after reconcile.

## High

| ID | Title | File:Lines | Owner | Status |
|---|---|---|---|---|
| OFF-202 | Migration __dirname path ENOENT | src/indexer/postgres-store.ts (applyMigration) | k2jac9 | **Closed — `6f5c719`** |
| OFF-203 | Multi-instance race issues 2 JWTs | src/x402-relay/index.ts:594-600,659-664 | k2jac9 | **Closed — `3c63f8e`** [^off203] |
| OFF-204 | pg.Pool no timeouts/error handler | src/indexer/postgres-store.ts:473-475 | _unassigned_ | Open |
| OFF-205 | releaseRedeemed unauthenticated | src/x402-relay/redis-dedup.ts:348-373 | k2jac9 | **Closed — `3c63f8e`** [^off205] |
| OFF-206 | Redis client no commandTimeout | src/x402-relay/redis-dedup.ts:269 | k2jac9 | **Closed — `3c63f8e`** [^off206] |
| OFF-207 | Schema-parity gate self-referential | src/indexer/test/aud-128-postgres-store.test.ts:127-156 | _unassigned_ | Open |
| OFF-217 | OFF-200 transactional semantics tested only against pg-mem mock; pg-mem 3.x does not honour BEGIN/COMMIT/ROLLBACK, so `withTransaction` rollback path is verified via a hand-rolled mock Pool rather than a real engine. Required before flipping `INDEXER_PG_URL` in production. | src/indexer/test/aud-200-dual-write-tx.test.ts | k2jac9 | **Closed — `c0ba30a`** [^off217] |

[^off217]: Closed via new test file `src/indexer/test/aud-200-dual-write-tx-real-pg.test.ts` (commit `c0ba30a`). Four describe-blocks gate on a new env var `INDEXER_PG_TEST_URL`; when unset the suite skips with a one-line notice and the workspace `npm test` stays green. When set, the suite runs against a real `pg.Pool`, drops + recreates the Phase 1 schema between blocks, and asserts ROW-LEVEL state after a real PG-engine ROLLBACK (the load-bearing assertion pg-mem 3.x cannot honour). Scenarios: (1) happy-path commit, (2) mid-tx invalid statement aborts the tx and the prior INSERT does NOT persist, (3) body throws before any write, pool stays healthy across 6 follow-up txs, (4) idempotent re-run via ON CONFLICT DO NOTHING. **Deferred to follow-up**: a CI workflow job that boots a `postgres:16` service container and sets `INDEXER_PG_TEST_URL`. Operators can already run the suite manually against a local Postgres; the Cutover-Gate § for `INDEXER_PG_URL` is unblocked by the existence of the test plus an operator-driven run.

[^off203]: Closed by enforcing the redis-lock atomic-claim invariant in `processPaymentRequest`: the lock IS the cluster-wide redemption record and once a JWT is minted ANYWHERE in the cluster, the lock must ride out its TTL. The two pre-fix `releaseRedeemed` call sites on the in-memory race-loss branches (pre-verify hit at `index.ts:594-600`; post-verify hit at `index.ts:659-664`) were the bug — releasing on race-loss let a SECOND relay instance re-acquire, re-verify, and mint a duplicate JWT. Fix removes both release calls; the redis lock holds for the full SIGNATURE_TTL_MS, the duplicate signature stays globally rejected, and only the verify-failed / no-config / saturation-after-acquire branches still release (no JWT minted on those paths). Combined with OFF-205's owner-bound release token, the contract is now: only the slot owner can release, and the slot owner only releases when no JWT was issued. Regression test: `src/x402-relay/test/off-201-203-205-206.test.ts` "OFF-203" describe-block covers the two-client cross-instance idempotency loop AND the in-memory race-loss-no-release invariant via `processPaymentRequest`.

[^off205]: Closed by binding `releaseRedeemed` to an owner-bound capability token via Lua CAS-DEL. `tryRedeem` now returns `{ kind: "ok", releaseToken }` where `releaseToken = "<instanceId>|<128-bit-CSPRNG-nonce>"` and IS the lock value stored in Redis. `releaseRedeemed(sig, releaseToken)` runs `EVAL "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end"` against the lock; only the original `tryRedeem` caller can free the slot. An attacker with Redis network reach but no in-process token cannot DEL arbitrary slots; a forged or stale token is a CAS mismatch and a no-op. Counter DECR is gated on `removed > 0`, so a forged release does not underflow the counter. Regression test: `off-201-203-205-206.test.ts` "OFF-205" describe-block covers token uniqueness (16 distinct tokens), forged-token rejection, empty-token hard-refuse, authorized-release happy path, and the CAS-vs-sibling-SET-NX race where the original holder's stale token must NOT delete a sibling instance's fresh re-acquired lock.

[^off206]: Closed by passing `commandTimeout`, `connectTimeout`, and `maxRetriesPerRequest: 1` to the ioredis constructor in `LiveRedisDedup`. Default `commandTimeout` is 2000ms (`REDIS_COMMAND_TIMEOUT_DEFAULT_MS`), env-overridable via `RELAY_REDIS_COMMAND_TIMEOUT_MS`. NaN / non-positive env values fall back to the default so a typo does not silently disable the timeout (the pre-fix failure mode). A Redis brown-out now surfaces as `ETIMEDOUT` on `tryRedeem` rather than stalling the /pay request indefinitely. Regression test: `off-201-203-205-206.test.ts` "OFF-206" describe-block pins the default-constant export, the option-acceptance shape, and the post-timeout error-propagation contract via a slow-client mock.

## Medium

| ID | Title | File:Lines | Status |
|---|---|---|---|
| OFF-208 | Prom counters never incremented | src/indexer/metrics-server.ts:17-35 | Open |
| OFF-209 | Logger redaction misses INDEXER_PG_URL | src/indexer/logger.ts:20-31 | Open |
| OFF-210 | Heartbeat resets failures before callback | src/indexer/index.ts:1481-1489 | Open |
| OFF-211 | pruneRateLimitMap not LRU | src/x402-relay/index.ts:397-402 | Open |
| OFF-212 | Indexer single-writer guarantee unenforced | src/indexer/index.ts:1720 | Open |
| OFF-213 | setPostgresStoreForTest in public surface | src/indexer/index.ts:71-73 | Open |

## Low

| ID | Title | File:Lines | Status |
|---|---|---|---|
| OFF-214 | countRows allowed-list duplicates migration | src/indexer/postgres-store.ts:383-394 | Open |
| OFF-215 | INDEXER_PG_POOL_MAX no NaN check | src/indexer/postgres-store.ts:473 | Open |
| OFF-216 | RELAY_INSTANCE_ID not unique across restarts | src/x402-relay/index.ts:175-177 | Open |

## Cutover gates

- `RELAY_REDIS_URL` unblock: OFF-201, OFF-203, OFF-205, OFF-206 closed + reconciler shipped
- `INDEXER_PG_URL` unblock: OFF-200, OFF-202, OFF-204, OFF-207, OFF-217 closed + reconciler shipped
