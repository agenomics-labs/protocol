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
| OFF-201 | Redis counter drifts unbounded | src/x402-relay/redis-dedup.ts:295,322 | _unassigned_ | Open |

[^off200]: Closed for the canonical event-INSERT + cursor-UPSERT pair via `withTransaction` helper (`postgres-store.ts`) and rewire of the two authoritative dual-write sites in `index.ts`. **Scoped out**: 10 projection-only fire-and-forget sites in `updateAgentFromEvent` (lines 678, 704, 747, 793, 808, 825, 841, 856, 880, 881 of the pre-fix file) remain single-write; projection rows are derivable from the authoritative event log if they ever diverge. Real-PG transactional verification closed in OFF-217 (`c0ba30a`).

## High

| ID | Title | File:Lines | Owner | Status |
|---|---|---|---|---|
| OFF-202 | Migration __dirname path ENOENT | src/indexer/postgres-store.ts (applyMigration) | k2jac9 | **Closed — `6f5c719`** |
| OFF-203 | Multi-instance race issues 2 JWTs | src/x402-relay/index.ts:594-600,659-664 | _unassigned_ | Open |
| OFF-204 | pg.Pool no timeouts/error handler | src/indexer/postgres-store.ts:473-475 | _unassigned_ | Open |
| OFF-205 | releaseRedeemed unauthenticated | src/x402-relay/redis-dedup.ts:348-373 | _unassigned_ | Open |
| OFF-206 | Redis client no commandTimeout | src/x402-relay/redis-dedup.ts:269 | _unassigned_ | Open |
| OFF-207 | Schema-parity gate self-referential | src/indexer/test/aud-128-postgres-store.test.ts:127-156 | _unassigned_ | Open |
| OFF-217 | OFF-200 transactional semantics tested only against pg-mem mock; pg-mem 3.x does not honour BEGIN/COMMIT/ROLLBACK, so `withTransaction` rollback path is verified via a hand-rolled mock Pool rather than a real engine. Required before flipping `INDEXER_PG_URL` in production. | src/indexer/test/aud-200-dual-write-tx.test.ts | k2jac9 | **Closed — `c0ba30a`** [^off217] |

[^off217]: Closed via new test file `src/indexer/test/aud-200-dual-write-tx-real-pg.test.ts` (commit `c0ba30a`). Four describe-blocks gate on a new env var `INDEXER_PG_TEST_URL`; when unset the suite skips with a one-line notice and the workspace `npm test` stays green. When set, the suite runs against a real `pg.Pool`, drops + recreates the Phase 1 schema between blocks, and asserts ROW-LEVEL state after a real PG-engine ROLLBACK (the load-bearing assertion pg-mem 3.x cannot honour). Scenarios: (1) happy-path commit, (2) mid-tx invalid statement aborts the tx and the prior INSERT does NOT persist, (3) body throws before any write, pool stays healthy across 6 follow-up txs, (4) idempotent re-run via ON CONFLICT DO NOTHING. **Deferred to follow-up**: a CI workflow job that boots a `postgres:16` service container and sets `INDEXER_PG_TEST_URL`. Operators can already run the suite manually against a local Postgres; the Cutover-Gate § for `INDEXER_PG_URL` is unblocked by the existence of the test plus an operator-driven run.

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
