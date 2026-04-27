# Off-chain audit — cycle 3 (2026-04-27)

## Metadata

- **Date**: 2026-04-27
- **HEAD**: _to-fill_
- **Scope**: src/indexer/, src/x402-relay/
- **Prior cycle**: docs/audits/ARCHITECTURE-AUDIT-2026-04-26-offchain.md
- **Methodology**: hostile re-audit of wave 7-8 ADR-126 / ADR-128 Phase 1 scaffolding

## Verdict

Wave 7-8 scaffolding is structurally correct and well-tested for the
golden path, but ships with two production-blocker classes:

1. ADR-126 Redis counter drift (OFF-201) → false-positive 503 saturation within ~1h
2. ADR-128 indexer dual-write non-atomicity (OFF-200) → PG cursor advances past failed events

Phase 1 is "cutover-ready" as scaffolding, NOT as a green-light to flip
operators. ADR-126 and ADR-128 ops notes now carry explicit "do not
flip" warnings until OFF-200 / OFF-201 / OFF-203 / OFF-205 close.

## Findings

### Critical (production blockers)

| ID | Title | File:Lines | Description | Recommendation |
|---|---|---|---|---|
| OFF-200 | Indexer dual-write non-transactional | src/indexer/index.ts:1030,1082-1089 | SQLite write commits and the cursor advances before the PG mirror write resolves; on PG failure the PG store falls behind silently and the cursor (read from SQLite) skips the failed events on resume. | Wrap the SQLite write + PG mirror in a fire-and-forget queue with at-least-once retry, and gate cursor advance on either (a) successful PG ack, or (b) a tombstone row that the reconciler can sweep. Block cutover until ADR-127 reconciler ships. |
| OFF-201 | Redis counter drifts unbounded | src/x402-relay/redis-dedup.ts:295,322 | The saturation counter is `INCR`d on every redemption but never decremented on TTL expiry of the underlying lock keys, so the counter monotonically grows and trips the `MAX_REDEEMED_SIGNATURES` 503 fail-closed guard within ~1h of steady traffic. | Replace counter-based saturation with `SCAN COUNT` against the lock prefix, OR maintain the counter via a Lua script that paired-decrements on `DEL` + relies on Redis keyspace notifications for TTL expiry. Add a regression test that sustains traffic past TTL and asserts counter convergence. |

### High

| ID | Title | File:Lines | Description | Recommendation |
|---|---|---|---|---|
| OFF-202 | Migration __dirname path ENOENT | src/indexer/postgres-store.ts:189-197 | Migration runner resolves SQL files relative to `__dirname`, which after `tsc` build points at `dist/indexer/` — the SQL files live at `src/indexer/migrations/` and are not copied. ENOENT at first run on the shipped artifact. | Either (a) copy the `migrations/` directory at build-time and resolve via `path.join(__dirname, '../migrations')`, or (b) embed migration SQL via `import.meta` / `fs.readFileSync` against a build-time constant. Add a smoke test that runs migrations against the `dist/` output. |
| OFF-203 | Multi-instance race issues 2 JWTs | src/x402-relay/index.ts:594-600,659-664 | The `inFlightVerify` collapse is in-process only; two relay processes racing on the same `txSignature` both pass the `SET … NX` gate when the in-flight cache lookup is empty, so both call the RPC verifier and both issue a JWT before either persists redemption. | Move the in-flight collapse onto Redis (`SET … NX … PX`) BEFORE the RPC verify call, not after. The lock IS the in-flight marker; promote-to-redemption on verify success, `DEL` on verify failure. |
| OFF-204 | pg.Pool no timeouts/error handler | src/indexer/postgres-store.ts:473-475 | `pg.Pool` is constructed with `max` only — no `connectionTimeoutMillis`, no `idleTimeoutMillis`, no `statement_timeout`, no `pool.on('error', …)` handler. A PG outage hangs every awaiting promise indefinitely as leaked microtasks rather than failing fast. | Set `connectionTimeoutMillis: 5000`, `idleTimeoutMillis: 30000`, `statement_timeout: '10s'` (server-side), and attach `pool.on('error', …)` that logs + increments a Prom counter. Add a chaos test that kills PG mid-query and asserts the awaiting promise rejects within 10s. |
| OFF-205 | releaseRedeemed unauthenticated | src/x402-relay/redis-dedup.ts:348-373 | `releaseRedeemed` performs `DEL` against the shared lock key without verifying the lock value matches this instance's `instanceId`. A stale call from a crashed-and-restarted relay can race-DELETE another instance's live lock, opening a re-redemption window. | Replace `DEL` with a Lua compare-and-delete script: `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`. The script makes the release authenticated by the lock value (the issuing `instanceId`). |
| OFF-206 | Redis client no commandTimeout | src/x402-relay/redis-dedup.ts:269 | `ioredis` client constructed without `commandTimeout` or `maxRetriesPerRequest` ceiling. A Redis network partition stalls every awaiting `/pay` request until the OS-level TCP timeout (minutes), gating all redemption traffic. | Set `commandTimeout: 2000`, `maxRetriesPerRequest: 1`, `enableReadyCheck: true`. Surface Redis-down as a 503 fail-closed (consistent with AUD-209 saturation semantics) rather than an indefinite hang. |
| OFF-207 | Schema-parity gate self-referential | src/indexer/test/aud-128-postgres-store.test.ts:127-156 | The "schema parity" test introspects the PG schema and asserts column names match a hardcoded list — the list was hand-derived from the PG migration, so the test compares PG against itself and cannot detect drift from the SQLite source-of-truth. | Replace the hardcoded list with a runtime read of `PRAGMA table_info(<table>)` against a fresh in-memory SQLite + the production schema, then compare normalized column tuples (name, type-class, nullable, default) against the PG `information_schema.columns` introspection. |

### Medium

| ID | Title | File:Lines | Description | Recommendation |
|---|---|---|---|---|
| OFF-208 | Prom counters never incremented | src/indexer/metrics-server.ts:17-35 | The prom-client counter registry is wired and exposed at `/metrics`, but no call site `.inc()`s any counter — the JSON `/metrics` endpoint duplicates the surface and is what consumers actually scrape. | Either (a) wire `.inc()` calls at the same sites that update the JSON metrics object, or (b) delete the prom-client surface and consolidate on JSON `/metrics`. ADR-104 prescribed prom-client; consolidate there. |
| OFF-209 | Logger redaction misses INDEXER_PG_URL | src/indexer/logger.ts:20-31 | Redactor scrubs `DATABASE_URL` and bare keypair patterns but not `INDEXER_PG_URL`, which encodes a password in the URL. Any error path that logs the env config leaks the PG password. | Add `INDEXER_PG_URL` to the redaction allow-list AND switch redaction from key-name match to value-pattern match (URLs containing `://*:*@`). Mirror the relay-side redaction set so the two services scrub the same surface. |
| OFF-210 | Heartbeat resets failures before callback | src/indexer/index.ts:1481-1489 | The watchdog resets `consecutiveFailures = 0` BEFORE the heartbeat callback resolves; if the callback throws, the failure counter never increments and the watchdog never trips. | Move the reset into the callback's success branch (after `await` resolves). Add a test that throws from the heartbeat callback and asserts the watchdog promotes to alarm. |
| OFF-211 | pruneRateLimitMap not LRU | src/x402-relay/index.ts:397-402 | Rate-limit map prunes on size threshold by deleting the FIRST entries (insertion order), not the LEAST-RECENTLY-USED — long-lived hot keys can be pruned while cold keys stay resident. | Replace the `Map` with a proper LRU implementation (e.g. `lru-cache`), or maintain a `lastAccessedAt` timestamp and prune by ascending timestamp on threshold breach. |
| OFF-212 | Indexer single-writer guarantee unenforced | src/indexer/index.ts:1720 | The indexer's "one writer per DB" assumption is enforced by convention only — no advisory lock, no PID file, no PG `pg_advisory_lock`. Two indexer processes against the same SQLite file race on cursor advance. | Acquire `pg_advisory_lock(<programId-hash>)` at startup against the PG mirror; refuse to start if the lock is held. For SQLite-only deployments, fall back to a `flock(2)` on `DB_PATH + '.lock'`. |
| OFF-213 | setPostgresStoreForTest in public surface | src/indexer/index.ts:71-73 | Test-only seam exported from the production module. Increases attack surface (rogue caller can swap the PG store at runtime) and pollutes the public API. | Move the seam behind a `__TEST__` guard or into a separate `*.test-utils.ts` module that production builds tree-shake. |

### Low

| ID | Title | File:Lines | Description | Recommendation |
|---|---|---|---|---|
| OFF-214 | countRows allowed-list duplicates migration | src/indexer/postgres-store.ts:383-394 | Allowed-table list for `countRows` is hardcoded next to the migration's `CREATE TABLE` calls; adding a table requires editing two places, easy to miss. | Derive the allowed list from a single source-of-truth (e.g. `Object.keys(SCHEMA_TABLES)`) shared between migration runner and `countRows`. |
| OFF-215 | INDEXER_PG_POOL_MAX no NaN check | src/indexer/postgres-store.ts:473 | `parseInt(process.env.INDEXER_PG_POOL_MAX, 10)` with no `Number.isFinite` check; a malformed env var produces `NaN` which `pg.Pool` silently coerces to a small default, masking the misconfiguration. | Validate at startup: `Number.isFinite(n) && n > 0 && n <= 100`; throw a startup error otherwise (mirrors AUD-027 length-floor pattern). |
| OFF-216 | RELAY_INSTANCE_ID not unique across restarts | src/x402-relay/index.ts:175-177 | `RELAY_INSTANCE_ID` defaults to `os.hostname()`; in containerized deploys, hostname is stable across restarts so the lock-value `instanceId` collides between a crashed instance and its replacement. | Default to `os.hostname() + ':' + crypto.randomUUID()` regenerated on every process start. The host-component preserves observability; the UUID-component preserves cross-restart uniqueness. |

## Architecture critique

1. **Phase 1 dual-write is fire-and-forget shadow with no
   reconciliation.** ADR-127's "redundancy + backfill" promise needs a
   reconciler job (cron or admin endpoint) that scans SQLite events
   not in PG and replays them. Without it, OFF-200 means "every PG
   write failure permanently desyncs the mirror" — which is the
   opposite of the redundancy ADR-127 promised. The reconciler is the
   load-bearing missing piece for `INDEXER_PG_URL` cutover.

2. **Two parallel observability surfaces in the indexer**
   (`/metrics` JSON vs. prom-client `/metrics` text) waste the ADR-104
   prom-client wiring. Operators scrape the JSON one; the prom-client
   one is defined-but-never-incremented (OFF-208). Pick one and
   delete the other.

3. **Logger redaction has drifted between services.** Relay scrubs
   `JWT_SECRET` / `authorization` / `token`; indexer scrubs
   `DATABASE_URL` / keypairs but NOT `INDEXER_PG_URL` (which contains
   a password — OFF-209). The redaction set should be a shared module,
   not two hand-maintained allow-lists.

4. **The relay's "in-memory authoritative + Redis dual-write" is the
   worst of both worlds during Phase 1.** Cross-instance bugs
   (OFF-203 dual-JWT race, OFF-205 unauthenticated `DEL`) appear that
   did not exist in the single-instance design. The shadow-only
   posture means we get the multi-instance bug surface without the
   multi-instance throughput benefit. Either (a) keep `RELAY_REDIS_URL`
   strictly opt-in for shadow logging until OFF-203 / OFF-205 close,
   or (b) ship the Lua compare-and-delete + redis-side in-flight
   collapse before any operator sees a `RELAY_REDIS_URL=…` example.
