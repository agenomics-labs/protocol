# Cycle 4 — Off-chain TS Punchlist (2026-04-29)

Hostile re-audit of the post-cycle-3 off-chain corpus
(`src/{indexer,x402-relay}/**`) against HEAD `cd233dc`. Each cycle-3
closure was re-walked under adversarial assumptions and adjacent code
paths were probed for new race-condition / locking / error-recovery gaps
in code touched by the recent batches.

## Source

- Audit: cycle-4 hostile re-audit (security-auditor agent, 2026-04-29)
- Cycle-3 baseline: `docs/audits/CYCLE-3-OFFCHAIN-PUNCHLIST.md`
- Closeouts re-verified: OFF-201/203/205/206 (multi-instance hardening),
  OFF-204/207 (pg.Pool timeouts + schema parity), OFF-208/209/210/212/
  213/214/215 (observability + safety), OFF-211/216 (LRU rate-limit +
  per-boot id), OFF-217 (real-PG transactional verification)
- Cutover gates re-verified: `RELAY_REDIS_URL`, `INDEXER_PG_URL`

## Severity tally

| Critical | High | Medium | Low |
|---|---|---|---|
| 0 | 0 | 0 | 1 |

## Findings

### CYCLE4-OFF-001 (Low) — Indexer SIGTERM does not gracefully release the OFF-212 writer lock

**File:lines:** `src/indexer/index.ts:2042-2060` (only `SIGINT` handler
registered).

**Threat:** When the indexer process receives `SIGTERM` (the default
signal sent by k8s on pod termination, by `systemctl stop`, by
`docker stop` after the grace period, and by orchestration tools that
follow POSIX convention), no graceful-shutdown path runs. The PG
session-close on TCP teardown will eventually release the OFF-212
advisory lock, but:

- The OFF-212 footnote claims "OOM-kill / SIGKILL / host reboot never
  strands the lock" via TCP teardown, which is true; however the
  graceful-SIGTERM path does NOT release the lock proactively the way
  the SIGINT path does, so the lock release is delayed by however long
  the orchestrator's grace period takes to escalate to SIGKILL +
  socket teardown. On a slow-shutdown k8s pod (e.g. `terminationGrace
  PeriodSeconds: 30`), a fresh indexer in the new pod may attempt
  `pg_try_advisory_lock` and fail the boot for tens of seconds.
- The OFF-208 metrics exporter, the heartbeat, and the PG pool also
  do not get the explicit `close()` calls the SIGINT branch invokes —
  the metrics counters won't observe the graceful-shutdown gauge
  values, and the PG pool's idle-client sockets land in `TIME_WAIT`
  rather than being cleanly torn down.

**Severity rationale:** Low because PG advisory lock release is
guaranteed by Postgres on connection close (correctness preserved); the
gap is operational latency on rolling deploys + missing metrics surface,
not a correctness defect. No security impact.

**Suggested closure:** Mirror the existing `SIGINT` handler block at
`src/indexer/index.ts:2042-2060` for `SIGTERM`. Either add a second
`process.on("SIGTERM", ...)` that dispatches to the same shutdown
function, or factor the body into a `gracefulShutdown(reason)` helper
and register both signals against it. The mcp-server transport
shutdown at `mcp-server/src/index.ts:295-299` already handles both
signals via `process.once("SIGTERM", onShutdown); process.once("SIGINT",
onShutdown)` — adopt the same shape.

**Status:** Open.

## Adjacent surfaces probed (no findings)

- **OFF-201 reconciler race window** — `src/x402-relay/redis-dedup.ts:
  687-712`. The SCAN-then-SET shape can race with concurrent INCR/DECR
  landing between the last SCAN page and the SET; an INCR/DECR in that
  window is overwritten by the reconciler's authoritative value. The
  contract is documented at the call site: "next reconciler tick re-
  establishes truth, and the fast-path saturation gate is bounded above
  by the cap regardless of small drift." The default 60s reconcile
  cadence is ≪ `SIGNATURE_TTL_MS` so accumulated drift is bounded. No
  finding — race is intentional and bounded.

- **OFF-203 atomic-claim contract** — `src/x402-relay/index.ts:692-794`.
  The pre-fix two release sites on race-loss branches are gone. The
  remaining release call sites (verify-failed, no-config, saturation-
  after-acquire) are all paths where NO JWT was minted. Confirmed by
  reading every `release` invocation at HEAD. No JWT-mint-then-release
  shape remains.

- **OFF-205 owner-bound release** — `src/x402-relay/redis-dedup.ts:
  282-288, 615-664`. The Lua CAS-DEL gates DEL on
  `GET == ARGV[1]`. An attacker with Redis network reach but no
  in-process `releaseToken` cannot DEL arbitrary slots. The DECR is
  gated on `removed > 0` so a forged release does not drift the
  saturation counter. Verified the shape against the test file `src/
  x402-relay/test/off-201-203-205-206.test.ts` claims (16-token
  uniqueness, forged-token rejection, sibling-CAS-mismatch race).

- **OFF-206 Redis command timeout** —
  `src/x402-relay/redis-dedup.ts:310-311` and the ioredis constructor
  block. `commandTimeout` (default 2000ms) + `connectTimeout` +
  `maxRetriesPerRequest: 1` together close the indefinite-stall failure
  mode. NaN / non-positive env values fall back to the default — the
  silent-disable failure mode is closed by `parsePositiveMsEnv`.

- **OFF-204 pg.Pool timeouts** —
  `src/indexer/postgres-store.ts:108-145, 740+`. Four timeouts
  (`connectionTimeoutMillis`, `idleTimeoutMillis`, `query_timeout`,
  `statement_timeout`) all parse env via `parsePositiveMsEnv` so the
  silent-disable shape is closed. `attachPoolErrorHandler` registers
  `pool.on('error', ...)` so an idle-client socket failure is logged at
  WARN rather than crashing the process via Node's unhandled-
  EventEmitter-error rule.

- **OFF-207 schema parity gate** — `src/indexer/test/aud-128-postgres-
  store.test.ts`. The two-source comparison
  (PRAGMA `table_info` vs. `information_schema.columns`) is real and
  recomputes both sides on every run. The aud-202 byte-for-byte parity
  test (between `001-initial-postgres.sql` and
  `migrations.embedded.ts`) is preserved. Both gates together close
  cross-store + cross-format drift.

- **OFF-208 prom counters wired** — `src/indexer/index.ts` 9 call
  sites of `eventsProcessed.inc()`, `lastSlotProcessed.set()`,
  `indexerErrors.inc({error_type: ...})`. Verified each is on the
  hot path for its claimed event class.

- **OFF-209 logger redaction** — `src/indexer/logger.ts`. `INDEXER_PG_
  URL` and `INDEXER_PG_TEST_URL` both in `REDACTION_PATHS` so a
  postgres connection string never lands in a structured log line.
  `AEP_REDIS_URL` already covered for the relay.

- **OFF-210 heartbeat reset ordering** —
  `src/indexer/index.ts:1672-1715`. `failures = 0` only AFTER
  `opts.onConnectionLost(reason)` returns successfully; a throwing
  callback leaves `failures` at threshold so the next failed tick
  re-fires immediately rather than re-climbing. The reasoning matches
  the OFF-210 footnote.

- **OFF-211 LRU rate-limit map** —
  `src/x402-relay/index.ts:459-523`. Every touch (fresh-window,
  count-bump, 429-rejection) does `delete(ip)` then `set(ip, entry)`
  so the entry moves to the END of insertion-ordered iteration. The
  pruner pops from the FRONT, which is now the LRU end. Hot rejected
  clients are not evicted ahead of cold one-shot scanners.

- **OFF-212 advisory-lock pattern** —
  `src/indexer/postgres-store.ts:949-1020+`,
  `src/indexer/index.ts:1973-2017`. `pg_try_advisory_lock` on a fixed
  i64 key, session-scoped, held for process lifetime via a borrowed
  client that is NOT released to the pool. `INDEXER_ALLOW_NO_WRITER_
  LOCK=1` opt-out for one-off debug runs. PG releases on TCP close
  for SIGKILL / OOM / host reboot. Graceful release path on SIGINT
  works; SIGTERM gap noted as CYCLE4-OFF-001.

- **OFF-213 test-only hook moved out of public surface** —
  `src/indexer/index.ts:88-115`. The hook now refuses to run unless
  `NODE_ENV === "test"` AND a test sentinel is set; a guard message
  cites OFF-213.

- **OFF-214 single-source-of-truth table set** —
  `src/indexer/postgres-store.ts:175-185`.
  `INDEXER_PG_TABLES` exported once; `countRows` reads via
  `INDEXER_PG_TABLE_SET` (a `Set` for O(1) membership). A future
  migration adding a table updates one constant.

- **OFF-215 NaN-safe pool size parse** —
  `src/indexer/postgres-store.ts:740-750`. `parsePositiveIntEnv`
  fallback to `INDEXER_PG_POOL_MAX_DEFAULT = 10`. Mirrors OFF-206.

- **OFF-216 per-boot CSPRNG instance id** —
  `src/x402-relay/index.ts:170-184`. Per-boot CSPRNG nonce ensures
  cross-restart token replay is closed; the lock value's `instanceId`
  prefix is observability-only (per ADR-126 trust-boundary placement),
  the nonce is the security primitive (post-OFF-205).

- **OFF-217 real-PG transactional verification** —
  `src/indexer/test/aud-200-dual-write-tx-real-pg.test.ts`. Test gates
  on `INDEXER_PG_TEST_URL`, skips with notice when unset, runs against
  a real `pg.Pool` when set. Covers happy-path commit, mid-tx invalid
  statement abort, body-throws-before-write, idempotent re-run via
  `ON CONFLICT DO NOTHING`. The `withTransaction` rollback semantics
  load-bearing assertion is satisfied against a real PG engine, not
  pg-mem 3.x's no-honour BEGIN/COMMIT/ROLLBACK shape.

## Recommendation

Cycle-3 off-chain closures hold under hostile re-audit. The single Low
finding (CYCLE4-OFF-001) is operational, not a correctness defect, and
does not block the release window. Recommend folding the SIGTERM
handler into the next routine off-chain bundle.

The corpus is release-window-clean from the off-chain dimension.
