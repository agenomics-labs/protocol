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
| OFF-200 | Indexer dual-write non-transactional | src/indexer/index.ts:1030,1082-1089 | _unassigned_ | Open |
| OFF-201 | Redis counter drifts unbounded | src/x402-relay/redis-dedup.ts:295,322 | _unassigned_ | Open |

## High

| ID | Title | File:Lines | Owner | Status |
|---|---|---|---|---|
| OFF-202 | Migration __dirname path ENOENT | src/indexer/postgres-store.ts:189-197 | _unassigned_ | Open |
| OFF-203 | Multi-instance race issues 2 JWTs | src/x402-relay/index.ts:594-600,659-664 | _unassigned_ | Open |
| OFF-204 | pg.Pool no timeouts/error handler | src/indexer/postgres-store.ts:473-475 | _unassigned_ | Open |
| OFF-205 | releaseRedeemed unauthenticated | src/x402-relay/redis-dedup.ts:348-373 | _unassigned_ | Open |
| OFF-206 | Redis client no commandTimeout | src/x402-relay/redis-dedup.ts:269 | _unassigned_ | Open |
| OFF-207 | Schema-parity gate self-referential | src/indexer/test/aud-128-postgres-store.test.ts:127-156 | _unassigned_ | Open |

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
- `INDEXER_PG_URL` unblock: OFF-200, OFF-202, OFF-204, OFF-207 closed + reconciler shipped
