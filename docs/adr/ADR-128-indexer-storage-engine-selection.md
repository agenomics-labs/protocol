# ADR-128: Indexer storage engine selection (PostgreSQL with streaming replication)

## Status

Proposed (supersedes ADR-127's storage-engine choice; ADR-127's
cold-spare *mechanism* remains the documented constrained-scope
alternative)

## Date

2026-04-27

> ⚠️  **Production Status — Phase 1 (do not flip)**
>
> Phase 1 is **scaffolded and tested as shadow only — production
> cutover is blocked on the cycle-3 off-chain audit findings below.**
> Operators MUST leave `INDEXER_PG_URL` **unset** in production until
> these findings close; leaving it unset keeps the legacy SQLite-only
> path live and is the supported production posture today.
>
> Cutover is gated on (cycle-3 off-chain audit, 2026-04-27):
>
> - **OFF-200** — indexer dual-write is non-transactional; PG cursor
>   advances past failed events, which silently corrupts replay state.
> - **OFF-202** — `__dirname`-based migration path resolution ENOENTs
>   after `tsc` build, so migrations cannot run in the shipped
>   artifact.
> - **OFF-204** — `pg.Pool` has no connection / statement timeouts and
>   no `error` handler; a PG outage hangs as leaked microtasks rather
>   than failing fast.
> - **OFF-207** — schema-parity gate compares PG against itself, not
>   against the SQLite source-of-truth, so it cannot detect drift.
>
> Source: `docs/audits/ARCHITECTURE-AUDIT-2026-04-27-cycle3-offchain.md`.
> In-repo punchlist:
> `docs/audits/CYCLE-3-OFFCHAIN-PUNCHLIST.md` (cutover gates section).
> Cutover sequence: close OFF-200 / OFF-202 / OFF-204 / OFF-207 + ship
> the ADR-127 reconciler, then flip `INDEXER_PG_URL` per the operator
> runbook.

## Context

ADR-127 (`docs/adr/ADR-127-indexer-redundancy-backfill.md`, Status:
Proposed) selected **Option β — warm cold-spare with periodic SQLite
snapshot + cursor-anchored replay** for the cycle-3 launch window. That
choice was correct *given the constraint set ADR-127 was bound by*:

> **Stack alignment**: SQLite is the storage substrate today. […]
> Cold-spare needs zero new infrastructure beyond object storage.

> **What the stack already runs (constrains the design space)**:
> SQLite is the only DB the indexer ships against today. […] No
> Postgres anywhere in the protocol — `git grep -l postgres` across
> the workspace is empty.

The user has now explicitly **lifted the "what's already in stack"
constraint**:

> "We could install Postgres or anything else… Let's research and see
> what would be the best solution. It has to be open source, ideally
> MIT or any other permissible license, and that we could self-host."

The wider option space changes the answer. ADR-127 was a *mechanism*
ADR (cold-spare vs. leader election vs. hybrid) implicitly bound to
the SQLite *engine*. ADR-128 is the *engine* ADR that ADR-127 deferred
to ADR-016. With Option γ (Postgres logical replication) no longer
ruled out by stack constraint, ADR-127's Option γ rejection
("`git grep -l postgres` is empty") no longer holds.

This ADR re-evaluates the storage engine across the full open-source
landscape, applies a license bar, and recommends the engine the
implementation PR should target. ADR-127's *mechanism* analysis (RTO
budget, snapshot cadence, cursor-anchored replay, drill cadence) still
informs the operational shape of whatever lands; the difference is
that the storage substrate underneath that mechanism is now an open
choice.

### Requirements rubric (load-bearing for the matrix below)

R1. **Stream Solana events at chain tip.** The indexer reads
`onLogs(programId)` at `Finality = "finalized"`
(`src/indexer/index.ts:41, :1090-1231`). Sustained launch volume per
roadmap §4 D1 is ~5-10 events/sec across three programs, with peak
spikes well under 1k tx/s.

R2. **Cursor-based replay from arbitrary slot N.** The
`backfillProgram` loop (`src/indexer/index.ts:985-1088`) pages
`getSignaturesForAddress(programId, { until: cursor.signature })` from
chain head back to the persisted cursor and walks oldest-first with
`INSERT OR IGNORE` against `UNIQUE(program, signature, event_ordinal)`
(`src/indexer/index.ts:193-195, :932-936`). Whatever engine ships
must preserve **(a)** monotonic cursor advance, **(b)** unique-index
upsert / `INSERT … ON CONFLICT … DO NOTHING` idempotency, **(c)** the
S-offchain-04 tombstone consultation pattern
(`src/indexer/index.ts:96-113, :670-700`).

R3. **Queryable state for downstream.** mcp-server projection
consumers, the dashboard, operator queries. SQL semantics, not
key-value. JOIN across `events`, `agents`, `agent_tombstones`,
`vault_identity_history`, `manifest_history`,
`protocol_config_history` (`src/indexer/index.ts:57-178`) are normal
operator and dashboard load.

R4. **Replication / failover.** ADR-127's primary goal. Whatever
engine ships must have a battle-tested replication story (streaming /
logical / WAL-shipped / Raft / etc.) such that an operator can stand
up a hot-standby replica and promote on primary loss without
hand-rolling the replication layer.

R5. **Backup + point-in-time restore.** `docs/INCIDENT_RESPONSE.md` §3
("Indexer DB recovery from cold backup") demands a defined backup
cadence and a restore procedure that lands the DB at a known cursor
position. PITR (recover to slot/time T) materially improves the
recovery story over snapshot-only.

R6. **Polyglot client story.** The indexer is TypeScript
(`better-sqlite3`); other consumers are Node (mcp-server, dashboard)
or Rust (`crates/evo`). The driver/library matrix matters: a primary
that ships a mature Node driver AND a mature Rust crate is preferable
to one that ships only one.

R7. **Reasonable disk footprint over time.** Indexer state grows with
chain history. Compaction / partitioning / TTL semantics matter at
the year-out horizon, but not for the cycle-3 launch window
(devnet-soak-estimated ~100MB at month one per ADR-127 §"Negative").

### Hard constraints (non-negotiable)

- **License**: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, MPL-2.0,
  or PostgreSQL License only. **EXCLUDE** AGPL-3.0, SSPL, BUSL,
  Elastic License, CockroachDB Software License, PolyForm-restricted
  components, or any source-available-but-not-OSI-approved license.
  Verified per project, **not** assumed from training data.
- **Self-hostable**: must run on operator-controlled infrastructure
  with no SaaS / managed-service dependency. Cloud-managed offerings
  may exist as a bonus; the chosen primary must be self-host-viable.
- **Operational maturity**: documented HA story (replication,
  failover, backup/restore, PITR if applicable), with on-call-runnable
  procedures published by the project.
- **Cycle-3 budget**: ≤2 weeks single-engineer to land. A "right
  answer" that requires a year of platform work is the wrong answer
  for this ADR.

## Decision

Adopt **PostgreSQL** (PostgreSQL License — OSI-approved permissive,
BSD/MIT-style; verified at <https://www.postgresql.org/about/licence/>
on 2026-04-27) as the indexer storage engine, with **streaming
replication** to a hot standby (read-only replica) and **WAL archiving
+ continuous archiving for point-in-time recovery**. The cold-spare
mechanism from ADR-127 is **superseded**: streaming replication
collapses ADR-127's 10-25 minute RTO to seconds-to-tens-of-seconds
without introducing a new coordination primitive (leader election,
fencing token).

**Mechanism (cycle-3 deliverable)**:

1. **Replace `better-sqlite3` with `pg` (`node-postgres`,
   MIT-licensed, mature; `pg.Pool` for connection pooling) in
   `src/indexer/index.ts`.** Schema migrations from
   `CREATE TABLE IF NOT EXISTS` SQLite DDL to PostgreSQL DDL —
   straightforward (one-to-one mapping; the only non-trivial swap is
   `INSERT OR IGNORE` → `INSERT … ON CONFLICT (program, signature,
   event_ordinal) DO NOTHING`, which is the same idempotency
   guarantee).
2. **Stand up a primary + hot-standby pair** using PostgreSQL native
   streaming replication (per
   <https://www.postgresql.org/docs/current/high-availability.html>
   §27.2-27.4). The standby is read-only and lags the primary by
   sub-second under normal operation.
3. **Configure WAL archiving** to operator-chosen object storage
   (`s3://`, `gs://`, `file:///`, same transport pattern ADR-127
   §"Snapshot transport" specified). Enables PITR within the WAL
   retention window — operator can recover to any slot within
   `INDEXER_WAL_RETENTION_DAYS` (default: 14).
4. **Failover ceremony** — on primary loss, operator runs
   `scripts/indexer-failover.sh` which promotes the standby
   (`pg_ctl promote` or equivalent), updates DNS / load-balancer to
   point at the promoted host, and re-provisions the failed primary
   as the new standby. RTO target: **<2 minutes** including operator
   cutover (vs. ADR-127's 10-25 minute target).
5. **Drill** — same quarterly chaos-drill cadence ADR-127 §
   "Mechanism (5)" specified, but the drill validates promotion not
   restore-from-snapshot.
6. **`backfillProgram` semantics preserved verbatim.** The cursor
   table, the `getSignaturesForAddress(… { until: cursor.signature })`
   paging loop, the `INSERT … ON CONFLICT DO NOTHING` idempotency,
   the S-offchain-04 tombstone consultation — all map one-to-one onto
   PostgreSQL. The Finality = "finalized" fork-safety guarantee
   (`src/indexer/index.ts:41`) is unchanged. The audit-cycle
   confidence in those code paths carries over.

**Why PostgreSQL** (six reasons grounded in the rubric, listed in
order of decision weight):

1. **R4 + R5 best-in-class.** Streaming replication has been
   PostgreSQL's flagship HA story since 9.0 (2010). WAL-archiving +
   PITR is a 20-year-old, battle-tested operator pattern. Every
   on-call SRE has touched it; every cloud and every IaaS has
   playbooks. Sub-second replication lag, sub-2-minute promotion RTO,
   PITR to any committed transaction within the WAL retention window
   — none of this is platform work, it's `postgresql.conf`.
2. **R3 native fit.** The indexer's seven tables are already SQL,
   already use multi-table JOIN-style consumer queries
   (`/agents`, `/stats`, mcp-server projection consumers). PostgreSQL
   is a strict SQL superset of the SQLite dialect the indexer uses —
   no consumer rewrite, no projection-layer rebuild. Future analytical
   queries (operator dashboards joining events × agents ×
   manifest-history) get window functions, CTEs, and partial indexes
   for free.
3. **License bar passed cleanly.** PostgreSQL License is BSD/MIT-style
   permissive, OSI-approved
   (<https://opensource.org/licenses/postgresql>), with the
   PostgreSQL Global Development Group's perpetual commitment to
   keeping it free and open. No license-change risk surface (compare:
   CockroachDB went *proprietary* off Apache-2.0 between training
   data and 2026-04-27 verification — see Alternatives §C).
4. **R6 polyglot story.** `pg` (`node-postgres`, MIT) is the standard
   Node driver — async/await, connection pooling, prepared statements,
   LISTEN/NOTIFY for pub-sub if needed. `tokio-postgres` (MIT/Apache-
   2.0) is the standard Rust async driver. Both are decade-mature.
   `crates/evo` consumers are not blocked from a future Rust-side
   read of indexer state.
5. **R2 idempotency primitive maps cleanly.**
   `INSERT … ON CONFLICT (program, signature, event_ordinal) DO NOTHING`
   is the exact one-to-one PostgreSQL equivalent of the
   SQLite `INSERT OR IGNORE` against a UNIQUE index that ADR-127's
   "load-bearing claim about resume correctness" depends on. Same
   semantics, same audit-cycle correctness argument.
6. **Cycle-3-budget realistic.** The largest cost item is the schema
   migration (one-shot SQL rewrite + a `pg`-based replacement of the
   `Database`-typed surface in `src/indexer/index.ts`). At ~1500 lines
   of indexer code touching `better-sqlite3`, with seven tables and a
   well-bounded set of prepared statements, this is a 5-8 day
   single-engineer PR — comparable to ADR-127's β cycle-3 budget,
   with materially better RTO and a real PITR story instead of
   snapshot-window data-at-risk.

**ADR-127 status change** (orchestrator-pending, NOT executed by this
ADR's PR):

ADR-127 should be flipped to `Status: Superseded by ADR-128 (storage
engine); cold-spare mechanism remains documented as the
constrained-scope alternative`. The orchestrator's wrap-up commit
performs that flip; this ADR does not edit ADR-127. The reason
ADR-127's *mechanism* analysis is preserved-not-deleted: if cycle-3
discovers the PG migration is fighting a constraint we missed, the
cold-spare mechanism on top of the existing SQLite substrate is the
documented fallback, and the operator runbook can fall back to it
without re-doing the design work.

## Surface impact

What an implementation PR will need to change (this ADR is design
only — the PR is a separate unit of work):

**New code (cycle-3 implementation PR)**:

- `src/indexer/index.ts` — replace `Database` (better-sqlite3) imports
  with `pg.Pool`; rewrite the seven `CREATE TABLE IF NOT EXISTS` DDL
  blocks for PostgreSQL syntax (numeric types: `BIGINT` instead of
  `INTEGER`; auto-increment: `BIGSERIAL` instead of
  `INTEGER PRIMARY KEY AUTOINCREMENT`; timestamp default:
  `now()` instead of `datetime('now')`); rewrite the seven prepared-
  statement sites to use `pg`'s parameterized-query syntax (`$1`,
  `$2`, … instead of `?`); `INSERT OR IGNORE` →
  `INSERT … ON CONFLICT (…) DO NOTHING`; `ON CONFLICT(program) DO
  UPDATE` for the cursor upsert (already PG-native syntax).
- `src/indexer/migrations/` (new directory) — versioned SQL migration
  files. Initial migration is the seven-table schema; future schema
  changes land here instead of inline `CREATE TABLE IF NOT EXISTS`.
  Use a thin migration runner (`postgres-migrations` MIT, or
  hand-rolled `SELECT FROM schema_migrations` table; do not pull a
  heavyweight ORM).
- `scripts/indexer-failover.sh` (new) — replaces ADR-127's
  snapshot-restore-based failover. Composes: confirm primary
  unrecoverable, `pg_ctl promote` on the standby (or `pg_promote()`
  function call), wait for new primary's `pg_is_in_recovery()` to
  return `false`, update DNS/LB cutover, capture deploy-log per
  ADR-080 §5, prompt operator to re-provision failed primary as new
  standby.
- `scripts/indexer-pitr-restore.sh` (new) — operator script for §3.5
  cold-replay scenarios. Composes: fetch base backup + WAL archive
  segments, run `pg_basebackup` restore + WAL replay to
  `recovery_target_time = 'YYYY-MM-DD HH:MM:SS UTC'`, validate
  cursor table is intact, hand off to operator for cutover.

**New env vars** (mirror ADR-127's pattern — documented inline at the
read site, defaults loopback-safe):

- `INDEXER_PG_HOST` (default `127.0.0.1`).
- `INDEXER_PG_PORT` (default `5432`).
- `INDEXER_PG_DATABASE` (default `aep_events`).
- `INDEXER_PG_USER` (REQUIRED).
- `INDEXER_PG_PASSWORD` (REQUIRED; never logged; per ADR-080 §3
  secret-handling pattern).
- `INDEXER_PG_POOL_MAX` (default `10`).
- `INDEXER_WAL_ARCHIVE_URL` (REQUIRED for PITR; `s3://`, `gs://`,
  `file://` schemes — same operator surface ADR-127 §"Snapshot
  transport" specified).
- `INDEXER_WAL_RETENTION_DAYS` (default `14`).

**No new schema tables** beyond migrating the existing seven. The
cursor table, events table, agents table, agent_tombstones,
vault_identity_history, manifest_history, protocol_config_history all
move 1:1 with type-name adjustments listed above.

**New tests**:

- `src/indexer/decoder.test.ts` — unchanged (decoder is engine-
  agnostic).
- `src/indexer/persistence.test.ts` (new, replaces snapshot.test.ts
  from ADR-127's plan) — unit: `INSERT … ON CONFLICT DO NOTHING`
  preserves event-ordinal idempotency; cursor upsert under concurrent
  writers; tombstone consultation under restored DB.
- `src/indexer/test/aud-128-failover-drill.test.ts` (integration,
  CI-runnable) — full replication-failover chaos drill:
  1. Spin two `pg` containers (primary + streaming standby) via
     testcontainers / docker-compose.
  2. Start indexer against primary; ingest N events from mock RPC.
  3. Verify standby's `events` count converges (replication lag
     < expected bound).
  4. SIGKILL primary container.
  5. Promote standby (`SELECT pg_promote()`).
  6. Reconfigure indexer to point at promoted instance.
  7. Continue ingest; assert cursor advances and final event-count
     matches expectations.
- `src/indexer/test/aud-128-pitr-drill.test.ts` (integration) — PITR
  drill: take base backup at slot M, write events to M+K, restore to
  `recovery_target_time` between M and M+K, assert exact event count
  for that window.
- `tests/indexer-failover-runbook.test.sh` (script-level smoke) —
  `scripts/indexer-failover.sh --self-test` and
  `scripts/indexer-pitr-restore.sh --self-test` validate env-var
  presence and `--dry-run` exit codes.

**Backfill semantics** (the load-bearing claim about resume
correctness, restated for the PG substrate):

- The cursor table is preserved as the canonical resume anchor. The
  `backfillProgram(connection, db, label, programId, state, metrics)`
  loop pages `getSignaturesForAddress(programId, { until:
  cursor.signature })` from chain head back to the persisted cursor,
  then walks oldest-first with `INSERT … ON CONFLICT (program,
  signature, event_ordinal) DO NOTHING` against the UNIQUE index. No
  failover-specific code path: backfill on every restart IS the
  resume mechanism, exactly as ADR-127 specified.
- S-offchain-04 tombstone semantics preserved across promotion: the
  `agent_tombstones` table replicates with the rest of the database;
  the `AgentRegistered` handler consults it post-promotion exactly as
  it did pre-promotion. No resurrection-bug regression surface.
- Chain-finality guarantee unchanged: `Finality = "finalized"` means
  the indexer never persists an event from a transaction that might
  later be dropped. Replicated rows on the standby were committed at
  finalized commitment on the primary; the standby cannot see "rolled-
  back" events.

**Operator runbook for failover ceremony** (replaces the
`<TODO: operator team to fill in>` placeholders in
`docs/INCIDENT_RESPONSE.md` §3.5; lands as a §3.7 addition by the
orchestrator's final commit, **not** in this ADR's PR):

1. Confirm primary is unrecoverable (decision tree §3.2 Q1 → §3.5).
2. Run `scripts/indexer-failover.sh --promote-standby <standby-host>`.
3. Wait for `pg_is_in_recovery()` to return `false` on the new
   primary.
4. Update DNS / LB to point at promoted host.
5. Verify dashboard refreshes and indexer `/health` returns
   `status: ok` on new primary.
6. File post-incident per §3.6.
7. Re-provision the failed primary as the new standby
   (`pg_basebackup` from the now-promoted primary, start with
   `standby.signal`).

**Cross-references updated by separate PRs (NOT this ADR)**:

- `docs/PRE_MAINNET_ROADMAP.md` §4 C5 — orchestrator marks
  `ADR-128 (Proposed)` and links here; ADR-127 reference becomes
  "superseded by ADR-128."
- `docs/INCIDENT_RESPONSE.md` §3 — orchestrator replaces ADR-127
  cold-spare references with ADR-128 streaming-replication promotion
  procedure; updates Q3 of the §3.2 decision tree to reflect "C5
  redundancy in place: standby running, promote per ADR-128 §
  failover ceremony."
- `docs/MAINNET_DEPLOY_RUNBOOK.md` §6.2 + §6.3 — orchestrator updates
  the "ADR-127 Proposed" reference to "ADR-128 Proposed" and
  rewrites the indexer-DB-backed-up checklist item for streaming-
  replication semantics.
- `docs/adr/ADR-127-indexer-redundancy-backfill.md` — orchestrator
  flips Status to "Superseded by ADR-128 (storage engine selection);
  cold-spare mechanism analysis preserved as constrained-scope
  alternative." This ADR does NOT edit ADR-127.

## Consequences

### Positive

- **Sub-2-minute RTO** vs. ADR-127's 10-25-minute RTO. Streaming-
  replication promotion is seconds; operator cutover is the
  remainder.
- **Zero data-at-risk window.** ADR-127's 15-minute snapshot interval
  meant up to 15 minutes of replay on restore; PostgreSQL streaming
  replication is sub-second-lagging continuous, and PITR via WAL
  archive is to-the-transaction.
- **Real PITR story.** Operators can recover to any committed
  transaction within `INDEXER_WAL_RETENTION_DAYS`. ADR-127's
  snapshot-only model could only recover to the last snapshot
  boundary.
- **Closes `<TODO: operator team to fill in>` placeholders in
  `docs/INCIDENT_RESPONSE.md` §3** with a more durable answer than
  ADR-127's snapshot cadence (which itself was an improvement over
  status quo).
- **Better SQL surface for downstream consumers.** Window functions,
  CTEs, partial indexes, full-text search if dashboards need it.
  mcp-server projection consumers and operator queries get a richer
  toolkit without per-feature ADRs.
- **Mature replication observability.** `pg_stat_replication` exposes
  lag-in-bytes / lag-in-time per standby; existing ADR-104
  observability stack can scrape and alert on it directly.
- **Drill-able under CI.** The `aud-128-failover-drill.test.ts` runs
  the full primary-kill / promote-standby / verify-cursor-advance
  cycle on every CI commit, on top of the quarterly operator drill.
- **Forward-compatible.** Future protocol features that want
  read-replica scaling (e.g. dashboard read-only fan-out, mcp-server
  projection-consumer scaling) plug in by adding standbys; no design
  work needed.

### Negative

- **New runtime dependency.** PostgreSQL is a separate process the
  operator must provision, configure, monitor, and patch. ADR-127's
  cold-spare added zero runtime dependencies (snapshot-to-S3 only).
  Mitigation: PG is the most-deployed database on the planet; the
  ops weight is well-understood and well-tooled. Every cloud has a
  managed offering as a bailout.
- **Migration is one-way.** Once the indexer ships against PG, rolling
  back to SQLite is a multi-day engineering effort. Mitigation: the
  cycle-3 PR ships behind a feature flag (`INDEXER_STORAGE=pg|sqlite`,
  default `sqlite` until cutover; ADR-127's cold-spare mechanism can
  serve the SQLite path during overlap).
- **WAL archiving consumes object storage.** `INDEXER_WAL_RETENTION_
  DAYS=14` at ~10MB/day of WAL (devnet-soak estimate) is ~140MB
  rolling — comparable to ADR-127's 12-snapshot rolling cost.
  Materially larger at year-out scale, but compaction-friendly.
- **Operator must learn one more system.** The on-call surface grows
  by one (Postgres alongside Redis-from-ADR-126 alongside the indexer
  itself). Mitigation: PG is the most-documented OSS database; the
  operator runbook addition is well-templated.
- **Two-process integration test setup.** CI now needs to spin a
  PostgreSQL container for `aud-128-*` integration tests. Mitigation:
  testcontainers and `docker-compose` patterns are standard;
  `pg_tmp` exists for fast ephemeral instances.
- **Driver swap is a real PR.** ~1500 lines of `better-sqlite3`-typed
  call sites across `src/indexer/index.ts` need to become `pg.Pool`
  / `pg.Client`-typed. Synchronous SQLite `db.prepare(…).run(…)` →
  asynchronous `await pool.query(…)` is the most material shape
  change. Mitigation: the rewrite is mechanical; the test surface
  ADR-082 + ADR-118 already established gives strong regression
  signal.

### Neutral

- **Operator host count grows by one** (or two if a separate WAL-
  archive host is desired). At small instance sizes this is
  ~$20-50/month per cloud — comparable to ADR-127's idle cold-spare
  cost (~$10-30/month) within rounding error of operator preference.
- **`better-sqlite3` is no longer needed in the indexer.** It remains
  a dev-time dependency in `agentdb-rs` / EVO subsystems unrelated to
  the indexer; this ADR does NOT propose removing it from the broader
  workspace.
- **Schema migrations become explicit.** The `CREATE TABLE IF NOT
  EXISTS` pattern stops compiling against PG's stricter DDL
  semantics; future schema changes go through versioned migrations
  rather than inline DDL. This is best-practice but is a workflow
  change.

## Alternatives considered

The matrix below was scored against R1-R7 + the hard constraints, on
license verification performed 2026-04-27 (training-data assumptions
explicitly NOT trusted; each license fetched at source).

### Comparison matrix (top 9 candidates)

| Candidate           | License (verified 2026-04-27)                  | License OK? | R1 ingest | R2 cursor-replay | R3 SQL/query | R4 replication maturity | R5 backup/PITR | R6 polyglot | Ops complexity (1-5) | Cycle-3 cost (1-5) | Notes                                                                                                  |
|---------------------|------------------------------------------------|:-----------:|:---------:|:----------------:|:------------:|:-----------------------:|:--------------:|:-----------:|:--------------------:|:------------------:|--------------------------------------------------------------------------------------------------------|
| **PostgreSQL**      | PostgreSQL License (BSD/MIT-style, OSI)        | YES         | A         | A                | A            | A                       | A (PITR)       | A           | 3                    | 2                  | Streaming replication + WAL archiving for PITR. Decade-mature `pg` and `tokio-postgres` drivers.       |
| TimescaleDB         | Apache-2.0 (community) + TSL (advanced)        | PARTIAL     | A         | A                | A            | A                       | A (PITR)       | A           | 3                    | 3                  | Apache-2.0 community is fine; TSL features (compression, continuous aggregates) are NOT permissive.   |
| ClickHouse          | Apache-2.0                                     | YES         | A         | B (no UPSERT)    | A (analytical) | B (Keeper-managed)    | B (snapshot)   | B           | 4                    | 4                  | Columnar; no native UPSERT means `INSERT OR IGNORE` idempotency needs ReplacingMergeTree workarounds. |
| DuckDB              | MIT                                            | YES         | C (embedded) | A             | A (analytical) | F (no replication)    | C (file copy)  | A           | 1                    | 2                  | Embedded analytical; no replication primitive — same single-instance failure mode as SQLite today.    |
| CockroachDB         | **Proprietary** (CockroachDB Software License) | **NO**      | -         | -                | -            | -                       | -              | -           | -                    | -                  | LICENSE-FAIL: license changed off Apache-2.0 to proprietary; License Key required for production.    |
| YugabyteDB          | Apache-2.0 (core) + PolyForm (YBA mgmt)        | PARTIAL     | A         | A                | A (PG-compat) | A                       | A              | A           | 5                    | 5                  | Distributed PG-compat; YBA mgmt tier is restricted; raw distributed-SQL ops weight too heavy for cycle-3. |
| TiDB / TiKV         | Apache-2.0                                     | YES         | A         | A                | A (MySQL-compat) | A                    | A              | B           | 5                    | 5                  | Distributed SQL on RocksDB; designed for petabyte scale — wildly oversized for indexer needs.        |
| SurrealDB           | **BSL 1.1** (converts to Apache-2.0 in 2030)   | **NO**      | -         | -                | -            | -                       | -              | -           | -                    | -                  | LICENSE-FAIL: BSL is source-available, NOT OSI-approved; conversion is years out.                    |
| MariaDB             | GPL-2.0                                        | **NO**      | -         | -                | -            | -                       | -              | -           | -                    | -                  | LICENSE-FAIL: GPL-2.0 is copyleft, fails the rubric's "MIT/Apache/BSD/MPL only" bar.                 |
| rqlite              | MIT                                            | YES         | B         | A                | A (SQLite)   | B (Raft, ≤7 nodes)      | B              | B           | 2                    | 2                  | Distributed SQLite via Raft; mature for small clusters; no PITR; smaller community than PG.          |
| SQLite + Litestream | SQLite (PD) + Litestream (Apache-2.0)         | YES         | A         | A                | A (SQLite)   | C (replica, no failover) | A (continuous) | A         | 1                    | 1                  | Litestream replicates SQLite to S3-compatible storage; no native automatic failover; read-replica via VFS. |
| LiteFS              | Apache-2.0 (verified 2026-04-27 — note shift)  | YES         | A         | A                | A (SQLite)   | B (lease-based)         | B              | A           | 3                    | 2                  | Fly.io's distributed SQLite; lease-based primary election. Note: license **was BSL**, now Apache-2.0; verify before adoption. |
| **EVO L3**          | MIT OR Apache-2.0                              | YES         | C         | C                | C            | F (no leader-election)  | C              | A (Rust)    | 5                    | 5                  | Append-only, content-addressed. Sync layer has CRDT-style merge but no replication primitive. See §EVO. |

Legend: A = best fit / mature, B = adequate / minor work, C = workable
with caveats, F = does not fit. Ops complexity / cycle-3 cost: 1 =
trivial, 5 = multi-quarter platform investment.

### Why-not justifications

#### TimescaleDB (RUNNER-UP)

**Pros**: PostgreSQL extension — inherits PG's entire HA / PITR / driver
story (the recommendation's main wins). Time-series-optimized hypertables
give automatic partitioning of `events` by slot/timestamp, which would be
an organic fit for the indexer's append-heavy access pattern. Continuous
aggregates would let dashboards query pre-rolled-up windows cheaply.

**Cons (why not chosen)**: The TSL-licensed advanced features
(compression, continuous aggregates, retention policies) are NOT
permissive, and those are precisely the features that justify reaching
for TimescaleDB over vanilla PG. The Apache-2.0 community subset is
"vanilla PG plus hypertables and a few utility functions" — not a
material win over PG itself for indexer-scale workloads (~100MB at
month one). Adopting TimescaleDB now means either (a) artificially
restricting to the community subset and accepting that we get little
beyond PG, or (b) eventually paying for a TSL license, which violates
the permissive-license bar's spirit. PostgreSQL with a manual
`PARTITION BY RANGE (slot)` declaration on the events table covers the
partitioning need without the license footgun.

**Verdict**: right answer if/when indexer scale reaches the
hundreds-of-GB range and the team is willing to commit to the TSL
licensing tradeoff. Not right for cycle-3.

#### ClickHouse

**Pros**: Apache-2.0 (clean license bar). Columnar engine is
extraordinarily fast for analytical queries (operator-dashboard
joins across event-history tables would be sub-second at GB scale).
ClickHouse Keeper provides Raft-based replication.

**Cons (why not chosen)**: No native UPSERT. The indexer's load-
bearing idempotency primitive is `INSERT OR IGNORE` against a UNIQUE
index. ClickHouse's analog is `ReplacingMergeTree`, which deduplicates
*eventually* during background merges — meaning duplicate events are
visible to consumers between insert and merge, and exact-count
queries return wrong answers in the deduplication window. Working
around this (FINAL keyword, materialized views, application-side
dedup) is real engineering work that the SQL-based candidates avoid.
ClickHouse is the right tool when the workload is analytical OLAP at
billions-of-rows scale; the indexer is OLTP-shaped (small writes,
small reads, idempotency-critical).

**Verdict**: right answer for a future analytical-query layer that
sits *next to* the indexer (e.g. a dashboard read-side store fed by
the indexer's events table). Not right as the indexer's primary
substrate.

#### CockroachDB — LICENSE FAIL

**License situation discovered during research (training-data
assumption was stale)**: CockroachDB's LICENSE file at
<https://github.com/cockroachdb/cockroach/blob/master/LICENSE>
(verified 2026-04-27) is the **proprietary "CockroachDB Software
License"** requiring a License Key for production deployments, with
mandated telemetry sharing and "technical countermeasures to limit
unauthorized use." This is materially worse than the BUSL → Apache-
2.0 time-delayed conversion that earlier versions ran on. CockroachDB
is no longer a candidate under the permissive-license bar at any
version newer than the 2024 conversion; the Apache-2.0 era ended.

**Verdict**: REJECTED. License fail.

#### DuckDB

MIT-licensed (cleanest license bar) and an excellent embedded
analytical engine, but it is single-process and file-based — the
**same single-instance failure mode** as the current SQLite
substrate, with no native replication or leader election. DuckDB does
not solve C5; it would only swap one embedded engine for another.
Right answer for a future operator-side analytical-query tool reading
indexer event exports; not right as the indexer primary.

#### YugabyteDB / TiDB

Apache-2.0 distributed-SQL cores, PG-compatible (YB) or MySQL-
compatible (TiDB), with real horizontal scaling. Rejected because
ops complexity is **5/5** — production-grade distributed-SQL clusters
require dedicated platform-engineering attention (multi-component
coordination, quorum sizing, rebalancing, network-partition handling)
that is wildly overprovisioned for ~5-10 events/sec across three
programs and incompatible with the ≤2-week cycle-3 budget. YBA's
PolyForm-restricted management tier is also a license-bar wrinkle.
Right answer if/when both indexer scale and ops headcount grow by an
order of magnitude.

#### SurrealDB — LICENSE FAIL

SurrealDB 3.0 is currently **BSL 1.1** with a Change Date of
2030-01-01 (or 4 years after first public BSL release), then converts
to Apache 2.0. BSL is source-available but not OSI-approved and is
explicitly excluded by the rubric. **REJECTED until the 2030
conversion.**

#### MariaDB — LICENSE FAIL

GPL-2.0 is copyleft and fails the "MIT/Apache-2.0/BSD/MPL/PG" bar.
MariaDB's HA story (Galera, MariaDB Replication) is competitive but
not materially better than PG's. **REJECTED.**

#### rqlite

MIT-licensed; distributed SQLite via Raft; preserves the SQLite SQL
dialect (smaller migration than PG). Rejected because: smaller
operational community than PG, Raft sizing fixed at ≤7 nodes, no
native PITR (backup is "snapshot the leader"), and HTTP-based driver
loses some polyglot benefit. Viable runner-up for a "minimal-
disruption" path that keeps the SQLite dialect; the PG recommendation
wins on PITR, operational familiarity, and long-tail ecosystem.

#### SQLite + Litestream

Smallest possible code delta. Litestream is Apache-2.0 (verified
2026-04-27) and continuously streams WAL to S3-compatible storage.
Rejected because Litestream's docs explicitly state **no automatic
failover** — the replica is a restore target, not a hot-standby, so
RTO sits in ADR-127's 10-25-minute cold-spare band. PITR is
WAL-segment-granular, not transaction-granular. Strong runner-up if
the team's risk appetite for the PG migration is low; the PG
recommendation wins on RTO (seconds vs. minutes), read-replica
scaling, and long-term forward-compatibility.

#### LiteFS

Apache-2.0 today (verified 2026-04-27 — but LiteFS has shifted off
BSL previously, so the license-stability argument is weaker than for
PG). Distributed SQLite with lease-based primary election; smaller
code delta than PG. Rejected because of tighter operational coupling
to Fly.io ecosystem assumptions (Consul lease backend is the
documented production path), smaller community than PG, and the
license-history wrinkle. The PG recommendation wins on license
stability (PG has *never* changed license; PGDG perpetual commitment
is on record), on operational maturity, and on the polyglot driver
story.

### EVO assessment (the user explicitly surfaced it; honest evaluation owed)

EVO (`/home/neo/dev/projects/EVO`, dual MIT OR Apache-2.0 — verified
in `crates/evo/Cargo.toml`) is the team's own Rust-native cognitive
memory system. The user's question deserves an honest three-way
answer:

**EVO L3 as the indexer primary — REJECTED for cycle-3, possibly
forever.**

EVO L3 is "append-only, content-addressed, Merkle-chained" raw
memory, which on paper matches the indexer's event-log access
pattern beautifully: append-only writes, content-addressed
deduplication, immutable history. But the indexer's load-bearing
requirements R4 (replication maturity), R5 (PITR), and R6 (polyglot
client) all fail:

- **No leader-election / WAL-streaming primitive.** EVO's
  `crates/evo/src/sync/merge.rs` has a CRDT-style
  `merge_ops_trusted` for peer-replicated convergence (which is the
  right primitive for *cognitive memory between agents*), but no
  primary/standby replication, no Raft, no WAL shipping. Adopting
  EVO L3 as the indexer primary would mean *building* the
  replication layer in EVO before the indexer can use it — that's a
  multi-quarter platform investment, not a cycle-3 deliverable.
- **No Node driver.** EVO is Rust-native with NAPI bindings under
  development. The indexer is TypeScript. Wiring TS-to-EVO at the
  hot path is a NAPI-binding-completeness question that is not on
  the cycle-3 critical path.
- **The use case is cognitive memory, not event-log projection.**
  EVO's value proposition — surprise gates, economics-scored
  retrieval, learned strategies — is wasted on the indexer's
  workload (which is mechanical "store every finalized event,
  query by program/slot/signature"). EVO L1's HNSW + L2's strategy
  extraction are the wrong tools for "render `/events?program=vault`."

**EVO as an indexer companion (semantic-search layer on top of a
relational primary) — DEFERRED, worth a separate future ADR.**

There is a real, separate question of whether the protocol benefits
from a *semantic-search layer* over indexer state — "find similar
escrow-dispute events," "find agents with manifests vector-close to
this query," "rank reputation history by trajectory similarity." EVO
L1's HNSW-indexed vector + L2's strategy extraction are well-suited
to that workload. The architecture would be: PG (per this ADR) is
the system-of-record; EVO ingests a derived projection (events →
embeddings) and serves semantic queries the dashboard / mcp-server
can JOIN against PG's relational view. This is **not what ADR-127 /
ADR-128 are solving**, but it is a real follow-up and the user's
EVO suggestion lands here, not on the indexer-primary slot.

**Recommendation**: file a future ADR (post-launch) — "ADR-13X: EVO
semantic-companion layer for indexer event-history" — when the
operator surface stabilizes and the dashboard team has a concrete
"find similar X" query the relational substrate doesn't serve well.

**EVO as the agent-memory backbone (NOT indexer) — STRONGLY
ENDORSED, separate problem space.**

The right place for EVO is the *agent-side* of the protocol — the
mcp-server agent-memory layer, the cycle-3 reasoning-bank pattern
storage, the "what did this agent learn from the last 100 escrow
disputes" loop. That is what EVO was designed for, what its API
contract (`MemoryEngine::observe / retrieve / learn / consolidate`)
is shaped for, what its Rust + NAPI architecture is positioned to
serve. The user's EVO suggestion is *correct*, but the
right-fit-target is agent memory, not indexer storage. The indexer
is system-of-record for finalized chain events — a job PostgreSQL
is uniquely well-suited to and EVO is uniquely poorly-suited to.

**Summary of EVO placement**: companion (future ADR), not indexer
primary, agent-memory backbone separately. The user's instinct that
EVO matters here is right; the ADR's job is to land EVO in the right
slot and not over-stretch its design.

## References

### Superseded / related ADRs

- **ADR-127** — Indexer redundancy + backfill (cold-spare, SQLite-
  bound). This ADR supersedes ADR-127's storage-engine choice;
  ADR-127's mechanism analysis (RTO budget, snapshot cadence,
  cursor-anchored replay, drill cadence) remains documented as the
  constrained-scope alternative. ADR-127 status flip to "Superseded
  by ADR-128" is orchestrator-pending (not executed by this ADR's
  PR).
- **ADR-126** — x402-relay horizontal scale (Redis-backed dedup,
  Proposed). Sister ADR; structural template for this ADR; Redis HA
  is a parallel ops investment that this ADR does NOT subsume.
- **ADR-118** — Indexer concurrency hardening (WAL fullsync + write
  mutex + SIGTERM). Prerequisite that becomes obsolete-by-superset
  once PG ships: PG's own crash safety (synchronous_commit, WAL
  fsync) replaces the SQLite-specific mutex/SIGTERM dance.
- **ADR-082** — Indexer event-coverage CI gate. The test surface this
  ADR's chaos-drill suite plugs into.
- **ADR-080 §5** — Deploy-log discipline applies to the new failover
  and PITR scripts' operator log-capture requirement.
- **ADR-016** — Off-chain event indexer (architectural origin; chose
  SQLite over PG for "zero-configuration deployment"). This ADR
  reverses that storage choice on the basis that the wider rubric
  (R4 replication, R5 PITR) outweighs the deployment-simplicity
  argument once mainnet operations are at stake.

### License-verified candidate sources (fetched 2026-04-27)

- **PostgreSQL License**: <https://www.postgresql.org/about/licence/>
  — OSI-approved BSD/MIT-style permissive; PG Global Development
  Group's perpetual free-and-open commitment.
- **PostgreSQL HA / replication docs**:
  <https://www.postgresql.org/docs/current/high-availability.html>
  — streaming replication, log-shipping, hot standby, WAL archiving,
  PITR, synchronous replication, replication slots, cascading
  replication, failover.
- **node-postgres (`pg`)**: <https://node-postgres.com/> — MIT-
  licensed; standard Node.js PG driver; mature.
- **ClickHouse LICENSE**:
  <https://github.com/ClickHouse/ClickHouse/blob/master/LICENSE> —
  Apache-2.0.
- **CockroachDB LICENSE**:
  <https://github.com/cockroachdb/cockroach/blob/master/LICENSE> —
  proprietary "CockroachDB Software License" (license-fail; verified
  2026-04-27, training-data assumption that this was Apache-2.0 or
  BUSL was stale).
- **TimescaleDB LICENSE**:
  <https://github.com/timescale/timescaledb/blob/main/LICENSE> —
  Apache-2.0 community + TSL advanced features.
- **DuckDB LICENSE**:
  <https://github.com/duckdb/duckdb/blob/main/LICENSE> — MIT.
- **YugabyteDB LICENSE**:
  <https://github.com/yugabyte/yugabyte-db/blob/master/LICENSE.md> —
  Apache-2.0 core + Polyform Free Trial mgmt tier.
- **TiDB LICENSE**:
  <https://github.com/pingcap/tidb/blob/master/LICENSE> — Apache-2.0.
- **SurrealDB LICENSE**:
  <https://github.com/surrealdb/surrealdb/blob/main/LICENSE> — BSL
  1.1 (license-fail until 2030 Apache-2.0 conversion).
- **rqlite LICENSE**:
  <https://github.com/rqlite/rqlite/blob/master/LICENSE> — MIT.
- **Litestream LICENSE**:
  <https://github.com/benbjohnson/litestream/blob/main/LICENSE> —
  Apache-2.0.
- **Litestream how-it-works**: <https://litestream.io/how-it-works/>
  — continuous WAL streaming; explicit "no automatic failover" note.
- **LiteFS LICENSE**:
  <https://github.com/superfly/litefs/blob/main/LICENSE> — Apache-
  2.0 (verified 2026-04-27; note: license has shifted previously,
  re-verify before adoption).
- **EVO**: `/home/neo/dev/projects/EVO/crates/evo/Cargo.toml` — dual
  MIT OR Apache-2.0; storage trait at
  `/home/neo/dev/projects/EVO/crates/evo/src/store/`; sync/merge
  semantics at
  `/home/neo/dev/projects/EVO/crates/evo/src/sync/merge.rs`.

### Operational documents this ADR's outputs feed

- `docs/INCIDENT_RESPONSE.md` §3 — operator-facing recovery procedure.
  Replaces ADR-127 cold-spare references with ADR-128 streaming-
  replication promotion. Orchestrator-pending edit.
- `docs/MAINNET_DEPLOY_RUNBOOK.md` §6.2 + §6.3 — references update
  from ADR-127 to ADR-128. Orchestrator-pending edit.
- `docs/PRE_MAINNET_ROADMAP.md` §4 C5 — closure marker flips to
  ADR-128. Orchestrator-pending edit.

### Code substrate (unchanged by this ADR; touched by the
implementation PR)

- `src/indexer/index.ts:41` — `Finality = "finalized"` fork-safety
  guarantee preserved.
- `src/indexer/index.ts:53-198` — `initDb` schema; the seven-table
  DDL block migrates to PG with type-name adjustments enumerated in §
  Surface impact.
- `src/indexer/index.ts:888-913` — cursor read/upsert helpers; map to
  PG's `INSERT … ON CONFLICT (program) DO UPDATE` (already PG-native
  syntax).
- `src/indexer/index.ts:925-972` — `persistEventsForTx`; the
  `INSERT OR IGNORE` → `INSERT … ON CONFLICT … DO NOTHING` swap is
  the load-bearing idempotency-preservation point.
- `src/indexer/index.ts:985-1088` — `backfillProgram`; preserved
  verbatim except for the `db.prepare(…).run(…)` synchronous calls
  becoming `await pool.query(…)` asynchronous calls.
- `src/indexer/index.ts:96-113, :670-700` — S-offchain-04 tombstone
  semantics; PG-side equivalent is the same query against the
  `agent_tombstones` table.
