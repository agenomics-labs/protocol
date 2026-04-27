# ADR-127: Indexer redundancy + backfill (warm cold-spare with cursor-anchored replay)

## Status

Proposed

## Date

2026-04-26

## Context

The off-chain event indexer (`src/indexer/index.ts`, original architecture
ADR-016) is the single source of truth for every dashboard, mcp-server
projection, and operator query that does not round-trip to chain. It is
single-instance by construction:

- One Node process subscribes to `onLogs` for each program ID
  (`src/indexer/index.ts:1220-1231`).
- One `better-sqlite3` file (`DB_PATH`, default `./aep-events.db`)
  holds every projection: `events`, `agents`, `agent_tombstones`,
  `cursor`, `vault_identity_history`, `manifest_history`,
  `protocol_config_history`.
- Per-program checkpointing lives in the `cursor` table
  (`src/indexer/index.ts:889-913`); the backfill worker resumes from
  `last_processed_slot` on every restart and uses
  `getSignaturesForAddress(programId, { until: cursor.signature })` to
  page back to the last known head before walking oldest-first.
- Idempotency is enforced by the `UNIQUE(program, signature,
  event_ordinal)` index plus `INSERT OR IGNORE`
  (`src/indexer/index.ts:193-195, :932-936`), so any double-delivery
  (websocket replay, backfill ↔ live overlap) is silently dropped.
- Crash-safety semantics from ADR-118 (WAL fullsync + write mutex +
  SIGTERM) bound the on-disk corruption window. A clean restart from
  the same SQLite file resumes correctly; a missing or unreadable file
  resumes from chain head, NOT from genesis (the no-cursor branch at
  `src/indexer/index.ts:995-1017` seeds at the current head signature
  and skips history).

**Failure surface today** (what dies when the indexer host dies):

- `/events`, `/events/:program`, `/agents`, `/stats`, `/metrics` all
  return nothing — every consumer that depends on indexed state stalls.
  This includes the dashboard, the mcp-server projection consumers, and
  any operator query that does not bypass to RPC.
- The `cursor` table stops advancing. On revival from the same DB, the
  backfill loop catches up via `getSignaturesForAddress` paging back to
  the persisted cursor (`src/indexer/index.ts:1019-1088`); at the
  inline `BACKFILL_TX_DELAY_MS = 25` rate (~40 tx/s), a 24-hour gap is
  ~1 hour catch-up at typical launch volume.
- If the SQLite file is unrecoverable AND no backup exists, the
  no-cursor branch seeds at *current* chain head and silently DROPS
  every event between the last known cursor and revival. There is no
  protection against this today.

**What the C2 incident playbook says today**: `docs/INCIDENT_RESPONSE.md`
§3 ("Indexer DB recovery from cold backup") was just landed in commit
`bbeb240`. Its decision tree assumes a cold backup *exists* and the
restore-then-replay flow at §3.5 is gated on cadence that is explicitly
`<TODO: operator team to fill in>` until C5 lands. The §3.6 post-incident
checklist warns:

> If C5 was incomplete: file a P1 to accelerate it. One cold-replay
> incident on a single-instance indexer is acceptable; two is
> operational debt.

This ADR is C5's design counterpart. Its outputs feed:

- `docs/INCIDENT_RESPONSE.md` §3 — every `<TODO: operator team to fill
  in>` placeholder around DB path, backup cadence, and SLO becomes
  resolvable once the design lands.
- `docs/MAINNET_DEPLOY_RUNBOOK.md` (C1, in flight) — operator
  failover ceremony.
- The mcp-server projection consumers' resilience story
  (mcp-server queries that proxy through indexer state must be able
  to fail over without operator intervention).
- The unwritten indexer-side SLO line in roadmap §8 open question #5.

**What the stack already runs** (constrains the design space):

- **SQLite** is the only DB the indexer ships against today.
- **Redis** ships with mcp-server (`mcp-server/package.json:52`,
  `ioredis ^5.10.1`) and ADR-126 commits x402-relay to it as well.
  Operators are about to be on the hook for HA Redis regardless of
  what this ADR decides.
- **No Postgres** anywhere in the protocol — `git grep -l postgres`
  across the workspace is empty. Standing up Postgres for the first
  time is a multi-week operator commitment, not a 2-week
  single-engineer ADR.

**Audit posture at HEAD `9340852`**: cycle-2 indexer findings (AUD-200
sign-extension, AUD-203 `/metrics` host-bind, AUD-204
`removeOnLogsListener`) are all closed. ADR-118 (WAL fullsync + write
mutex + SIGTERM, Proposed) is a prerequisite for the cold-spare
model — without it, the snapshot machinery can copy a partially-fsynced
WAL and backups would mask corruption rather than eliminate it.

**Why now (vs. defer indefinitely)**: roadmap §4 C5 is the C-track
item the C2 playbook §3 explicitly defers to ("Indexer backup cadence
undefined until C5 lands"). The playbook ships to the on-call rotation;
the TODOs in §3.5 are not acceptable in the runbook for first paying
customer. C5 must close before the first `v*-mainnet` tag.

## Decision

Adopt **Option β (warm cold-spare with periodic SQLite snapshot +
cursor-anchored replay)** for the cycle-3 launch window, with an
upgrade path to **Option α (Redis-lease leader election)** documented
as a post-launch follow-up.

**Mechanism (cycle-3 deliverable)**:

1. **Snapshot cron** — a sidecar process (or systemd timer / k8s
   CronJob, operator's choice) runs every `INDEXER_SNAPSHOT_INTERVAL_MIN`
   minutes (default: **15**, justified below) and produces an atomic
   SQLite snapshot via the SQLite Online Backup API. The snapshot is
   written to `INDEXER_SNAPSHOT_DIR` and the file name encodes the
   primary's `cursor.last_processed_slot` for each program at snapshot
   time (e.g. `aep-events-20260426T120000Z-vault-12345-registry-12347-settlement-12342.db`).
   Older snapshots are pruned to `INDEXER_SNAPSHOT_RETAIN_COUNT`
   (default: 12 = 3 hours of 15-minute snapshots, plus a daily and a
   weekly).
2. **Snapshot transport** — the snapshot is uploaded to operator-
   chosen object storage (`INDEXER_SNAPSHOT_REMOTE_URL`; e.g.
   `s3://…`, `gs://…`, `file:///mnt/backup/…`). The uploader runs in
   the same sidecar so failure to upload is visible at the same surface
   as failure to snapshot. Per ADR-080 §5 (deploy-log discipline) the
   upload must complete before the operation is reported successful.
3. **Cold-spare host** — operators provision a second indexer host
   (same image, same env) in a stopped state. The host has read access
   to `INDEXER_SNAPSHOT_REMOTE_URL`. Cost: idle compute + storage; no
   running indexer process, no chain subscriptions, no RPC quota
   consumed.
4. **Failover ceremony** — on primary loss, the operator runs a new
   `scripts/indexer-failover.sh` script that:
   - Fetches the most recent snapshot from
     `INDEXER_SNAPSHOT_REMOTE_URL`.
   - Verifies the per-program cursor in the snapshot is within the
     RPC provider's transaction-retention window (operator-supplied
     `INDEXER_RPC_RETENTION_SLOTS`).
   - Places the snapshot at `DB_PATH` on the spare.
   - Starts the indexer process. The existing backfill loop (§
     `backfillProgram` at `src/indexer/index.ts:985-1088`) resumes
     from each program's persisted cursor and pages forward to head
     using the same idempotent `INSERT OR IGNORE` machinery. No
     bespoke recovery code path — the cursor IS the resume point.
   - Updates DNS / load-balancer to point at the spare.
5. **Drill** — quarterly chaos drill (kill primary, run failover
   ceremony, confirm spare's cursor catches up to within the SLO).

**Why 15-minute snapshots**: at typical devnet launch throughput
(~5-10 events/sec, captured in roadmap §4 D1 soak), a 15-minute window
is ~5,000-10,000 events of at-risk data. The replay cost for that
window at ~40 tx/s (the inline `BACKFILL_TX_DELAY_MS` rate) is ~5
minutes — comfortably inside any reasonable RTO budget. Shorter
intervals (1-minute) risk overlapping snapshots and inflate object-
storage cost without a proportional RTO win. Longer intervals
(60-minute) push replay time past 15 minutes and start brushing up
against RPC retention for low-traffic provider plans.

**Why cold-spare not hot leader-election for cycle-3** (four reasons,
each load-bearing):

1. **Stack alignment**: SQLite is the storage substrate today. Adding
   Redis-lease leader election (Option α) requires standing up a
   second HA Redis cluster or coupling the indexer's lifecycle to
   mcp-server's Redis (violating ADR-016's "self-contained"
   constraint). Cold-spare needs zero new infrastructure beyond
   object storage.
2. **RTO fit**: indexer consumers (dashboard, mcp-server projections,
   operator queries) read indexed state, not chain state, and
   tolerate staleness in seconds-to-minutes. 5-15 min failover RTO
   matches consumer tolerance; sub-second leader-election is not
   load-bearing for launch.
3. **Blast radius**: cold-spare is operator-driven, contained to the
   failover ceremony. Option α introduces automated promotion with
   split-brain modes (two indexers both holding the lease, diverging
   SQLite projections) that cycle-3's review surface cannot cover
   adequately.
4. **Cycle-3 budget**: 5-8 single-engineer days for one sidecar +
   one failover script + env vars + two integration tests + runbook
   section. Option α with safe fencing is 3-4 weeks the launch
   window does not have.

**Upgrade path to Option α (post-launch)**: if launch operations show
the 5-15 minute RTO is too long (operator pages, dashboard outage
visibility, mcp-server projection staleness exceeding consumer
tolerance), upgrade to Redis-lease leader election with a
SET-NX-with-TTL primitive on `aep:indexer:leader:<program>`.
The leader runs as today; the standby tails the chain silently with
its own SQLite file, verifies it stays within `INDEXER_LEADER_LAG_SLOTS`
of the leader's cursor (cross-checked via Redis keys the leader writes
on every batch commit), and claims the lease on TTL expiry. The
existing `cursor` + idempotency-via-UNIQUE-index machinery means the
two SQLite files converge on the same projection without coordination
beyond the lease itself. ADR-126's Redis HA infrastructure is the
prerequisite; until that lands as production, Option α has no Redis
to lease against.

## Surface impact

**New code (cycle-3 implementation PR)**:

- `src/indexer/snapshot.ts` (new) — sidecar entry point. Uses
  `better-sqlite3`'s `db.backup(destPath)` (the SQLite Online Backup
  API; non-blocking, copies pages while the primary continues writes).
  Reads cursor positions before backup completes and embeds them in
  the destination filename.
- `src/indexer/snapshot-uploader.ts` (new) — pluggable transport.
  `s3://`, `gs://`, `file://` schemes mandatory; SDKs guarded behind
  optional deps so single-host deployments don't pull AWS SDK.
- `scripts/indexer-failover.sh` (new) — the operator-driven failover
  ceremony. Composes: fetch snapshot, verify cursor freshness vs RPC
  retention, place at `DB_PATH`, start process, wait for `/health`
  green, prompt operator for DNS/LB cutover, capture deploy-log per
  ADR-080 §5.
- `scripts/indexer-snapshot-restore.sh` (new) — the §3.5 "cold
  replay" companion (used by both failover ceremony and the C2
  playbook §3.5 procedure).

**New env vars** (mirror the AUD-027 / AUD-203 pattern — each is
documented inline at the read site, defaults are loopback-safe /
no-op):

- `INDEXER_SNAPSHOT_DIR` (REQUIRED if snapshot sidecar runs;
  filesystem path).
- `INDEXER_SNAPSHOT_INTERVAL_MIN` (default 15).
- `INDEXER_SNAPSHOT_RETAIN_COUNT` (default 12).
- `INDEXER_SNAPSHOT_REMOTE_URL` (REQUIRED if remote upload enabled;
  `s3://`, `gs://`, `file://` schemes).
- `INDEXER_RPC_RETENTION_SLOTS` (REQUIRED for failover script;
  operator-supplied per RPC provider plan).

**No new schema tables**. The cursor table (`src/indexer/index.ts:89-94`)
is already the canonical resume anchor. The snapshot encodes per-program
cursors in the filename for operator inspection; the SQLite snapshot
itself contains the same data. No coordinator-state tables.

**New tests**:

- `src/indexer/snapshot.test.ts` — unit: snapshot under concurrent
  writes preserves cursor monotonicity; restored DB resumes from
  expected cursor; pruning respects retention count.
- `src/indexer/test/aud-127-failover-drill.test.ts` (integration) —
  full chaos drill in CI:
  1. Spin two `better-sqlite3` files (primary + restored).
  2. Start primary, ingest N events from a mock RPC.
  3. Snapshot at slot M.
  4. Continue primary to slot M+K.
  5. SIGKILL primary.
  6. Restore snapshot to spare's `DB_PATH`.
  7. Start spare against same mock RPC.
  8. Assert spare's cursor advances past M+K within bounded time and
     final event-count matches what primary had.
- `tests/indexer-failover-runbook.test.sh` — script-level smoke:
  `scripts/indexer-failover.sh --self-test` validates env-var presence,
  snapshot-URL parseability, and `--dry-run` exits 0 against a
  synthetic snapshot.

**Backfill semantics** (the ADR's load-bearing claim about resume
correctness):

- The snapshot's `cursor` table contains the exact slot+signature for
  each program at snapshot time. The existing
  `backfillProgram(connection, db, label, programId, state, metrics)`
  loop pages `getSignaturesForAddress(programId, { until: cursor.signature })`
  from chain head back to the persisted cursor, then walks oldest-first
  with `INSERT OR IGNORE` against the UNIQUE index. There is no
  spare-specific resume code: the backfill worker that runs on every
  restart IS the failover resume mechanism.
- The S-offchain-04 tombstone semantics (`agent_tombstones`, lines
  96-113 + 670-700 of `src/indexer/index.ts`) are preserved across
  snapshot/restore: tombstones are full SQLite rows, captured in the
  backup, and consulted by `AgentRegistered` handlers post-restore
  exactly as they were pre-restore. No resurrection-bug regression
  surface.
- Chain-finality guarantee: the indexer reads at `Finality =
  "finalized"` (`src/indexer/index.ts:41`). A snapshot taken at slot
  N records only finalized events; the spare resuming from slot N
  cannot see "already-rolled-back" events, so the resume window is
  fork-safe.

**Operator runbook for failover ceremony** (replaces the
`<TODO: operator team to fill in>` placeholders in
`docs/INCIDENT_RESPONSE.md` §3.5; lands as a §3.7 addition by the
orchestrator's final commit, **not** in this ADR's PR):

1. Confirm primary is unrecoverable (decision tree §3.2 Q1 → §3.5).
2. Run `scripts/indexer-failover.sh --remote-url <URL>` on the spare.
3. Wait for `/health` to return `status: ok` for all three programs.
4. Update DNS / LB to point at spare.
5. Verify dashboard refreshes.
6. File post-incident per §3.6.
7. Re-provision the failed primary as the new spare; confirm snapshot
   cron resumes against the now-promoted indexer.

**Cross-references updated by separate PRs (NOT this ADR)**:

- `docs/PRE_MAINNET_ROADMAP.md` §4 C5 — orchestrator marks
  `ADR-127 (Proposed)` and links here.
- `docs/INCIDENT_RESPONSE.md` §3.5 + §3.6 — orchestrator cross-links
  this ADR and replaces the cadence/path TODOs.
- `docs/MAINNET_DEPLOY_RUNBOOK.md` (C1, in flight) — references this
  ADR for the indexer-redundancy section.

## Consequences

### Positive

- Closes the C2 incident playbook §3 cadence-undefined gap. Operators
  paged at 3am have a written failover ceremony, a known backup
  cadence, and a tested restore path.
- Zero new infrastructure beyond object storage (which most operators
  already have provisioned for log archive / deploy-log retention per
  ADR-080 §5).
- No changes to the indexer's hot path. `subscribeToPrograms`,
  `backfillProgram`, `persistEventsForTx`, idempotency-via-UNIQUE-index
  — all preserved verbatim. The audit-cycle confidence in those paths
  carries over.
- Drill-able. The integration test runs the full cycle on every CI
  commit; the quarterly operator drill validates the human procedure.
  Both failure modes (code regression, operator-procedure regression)
  have a continuous test surface.
- Upgrade-compatible. The snapshot file format IS a SQLite database;
  Option α's leader-election upgrade reads the same files for warm-
  start of a new standby.

### Negative

- RTO is bounded below by `(snapshot-interval / 2) + replay-time +
  operator-cutover-time`. At 15-minute snapshots and ~5-min replay,
  expected RTO is ~10-25 minutes. This is acceptable for the launch
  window per the §"Why cold-spare" justification but is materially
  slower than Option α's sub-second sub-second leader-election RTO.
- Failover is operator-driven, not automated. A pager that fires at
  3am still requires the on-call to run a script. Mitigation: the
  script is a single command with `--self-test` validation, and the
  C2 playbook §3 enumerates the decision tree.
- Snapshot at 15-minute intervals means the at-risk data window is up
  to 15 minutes of events. These events ARE recoverable from chain
  via the backfill loop on restore (the cursor in the snapshot points
  at slot N, the spare backfills from N to head); they are not lost.
  The window is replay time, not data loss.
- One additional process to monitor (the snapshot sidecar). Failed
  snapshots must page the same on-call as failed primary. Adds one
  alert rule.
- Object-storage cost: 12 snapshots × ~100MB SQLite file (devnet soak
  estimate; mainnet may be larger) = ~1.2GB rolling. Negligible at
  any cloud-provider rate but non-zero.

### Neutral

- The cold-spare is idle but not free. Operators pay for the standby
  host's compute reservation. At small instance sizes this is
  ~$10-30/month per cloud — well below the cost of the operator-time
  RTO improvement it buys.
- The snapshot embeds cursor positions in the filename for operator
  inspection; this is convenience, not security. Operators should
  not assume filename-encoded cursors are tamper-resistant.

## Alternatives considered

### Option α — Redis-lease leader election (REJECTED for cycle-3, deferred to post-launch)

Both indexer instances tail the chain. A Redis SET-NX-with-TTL
primitive on `aep:indexer:leader` gates which is "primary" (gets to
write to its SQLite + serve `/events`). The standby tails silently,
verifies its cursor stays within `INDEXER_LEADER_LAG_SLOTS` of the
leader (via a Redis key the leader writes on every batch commit),
and claims the lease on TTL expiry. Sub-second failover.

- **Pros**: Sub-second RTO. Automated promotion (no operator page).
  Reuses the Redis HA infrastructure ADR-126 commits operators to
  anyway. The existing UNIQUE-index idempotency means the two SQLite
  files converge to the same projection without coordination beyond
  the lease.
- **Cons**: Split-brain failure mode if Redis network partitions and
  both instances briefly believe they hold the lease — both write to
  their own SQLite, both serve diverging `/events` responses to
  consumers behind the LB. Mitigation requires a fencing token that
  the LB enforces, which is multi-week design work in its own right.
  Hard dep on Redis HA from ADR-126 being production-grade; ADR-126
  is itself Proposed status.
- **Verdict**: right answer for post-launch when Redis HA is mature
  and operator headcount can support automated-promotion confidence.
  Not right for cycle-3.

### Option γ — Postgres logical replication + read-replica (REJECTED)

Migrate from SQLite to Postgres, set up async logical replication to
a read replica, promote replica on primary loss.

- **Pros**: Postgres replication is mature, well-tooled, and
  operationally well-understood. Standard PG operator playbooks for
  promotion exist.
- **Cons**: The protocol does not run Postgres anywhere
  (`git grep -l postgres` is empty across the workspace). Standing
  up production-grade HA Postgres for the first time is a multi-week
  operator commitment and a months-long muscle-memory build for
  on-call. The indexer schema is currently SQLite-shaped (PRAGMA
  WAL, `INSERT OR IGNORE`, `CREATE TABLE IF NOT EXISTS`-based
  migrations); rewriting it for PG is a larger PR than the entire
  cycle-3 budget for C5. ADR-016 explicitly chose SQLite over
  Postgres for "zero-configuration deployment" — reversing that is a
  bigger ADR than this one.
- **Verdict**: right answer for a v2 indexer when the protocol
  standardizes on Postgres for some other reason. Not right for
  cycle-3, and "indexer redundancy" should not be the forcing
  function for a stack-wide PG adoption.

### Option δ — Status quo (single instance + slot-0 replay on death) (REJECTED)

Accept the current single-instance design. On primary loss, operators
restore from whatever ad-hoc backup exists or replay from chain head
(losing all events since the last cursor commit).

- **Pros**: Zero implementation cost. No new code, no new env vars,
  no new tests, no new runbook.
- **Cons**: The C2 incident playbook §3.5 cold-replay procedure has
  no defined backup — `<TODO: operator team to fill in>` is the
  current state of the runbook. The §3.6 post-incident checklist
  warns "two cold-replay incidents on a single-instance indexer is
  operational debt"; on a launch-day incident, *one* cold-replay
  with a missing backup is a mainnet-visible outage. Status-quo
  punts every operator concern in the §3 decision tree.
- **Verdict**: rejected. The whole point of C5 is to have a written,
  tested, drillable answer to the §3 decision tree before launch.

### Hybrid — cold-spare for storage + Redis-lease for promotion (DEFERRED)

A combination: snapshot machinery as in Option β, but failover
triggered by Redis-lease expiry on the spare (so the spare auto-
promotes when the primary's lease drops).

- **Pros**: Combines β's storage simplicity with α's promotion
  automation. Avoids the split-brain risk of full α because the
  spare has only the last snapshot's data, not a continuously-
  diverging shadow projection.
- **Cons**: The spare doesn't have a current cursor when the lease
  expires — it has a cursor from up to 15 minutes ago. Auto-promoting
  to a stale cursor and then backfilling is correct (the existing
  machinery handles it), but the consumer-facing response window
  during the catch-up replay is the same ~5-15 minutes as Option β's
  manual cutover. So we pay α's complexity cost (Redis-HA dep, lease
  logic, fencing) for a marginal RTO improvement (~5 minutes saved
  on operator page-to-cutover time).
- **Verdict**: right answer if/when the Option α upgrade lands and
  we want to keep the cold-spare's blast-radius safety. Documented
  here so the upgrade path is explicit. Not cycle-3.

## References

- **Origin**: ADR-016 — off-chain event indexer (architectural origin;
  SQLite-over-Postgres choice this ADR preserves).
- **Concurrency prerequisite**: ADR-118 — indexer concurrency
  hardening (WAL fullsync + write mutex + SIGTERM). Cold-spare's
  on-disk-corruption window is bounded by ADR-118 landing first.
- **CI gate prerequisite**: ADR-082 — indexer event-coverage CI gate
  (the test surface this ADR's chaos drill plugs into).
- **Sister ADR**: ADR-126 — x402-relay horizontal scale (Redis HA
  is the post-launch upgrade-path prerequisite; structural template
  for this ADR).
- **Deploy mandates**: ADR-080 §5 — deploy-log discipline applies to
  the failover script's operator log-capture requirement; §1 — pre-
  flight gates pattern (the failover script's `--self-test` mirrors
  `mainnet-deploy.sh --self-test`).
- **Roadmap spec**: `docs/PRE_MAINNET_ROADMAP.md` §4 C5 (this ADR's
  spec); §8 question #5 (indexer SLO drives snapshot interval).
- **Incident playbook**: `docs/INCIDENT_RESPONSE.md` §3 (the operator-
  facing surface that consumes this ADR); §3.5 cold-replay procedure
  (the cadence/path TODOs this ADR resolves).
- **Audit closure context**: `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-offchain.md`
  AUD-203 / AUD-204 (recent indexer fixes confirming hot path is
  audit-clean).
- **Code substrate**:
  - `src/indexer/index.ts:889-913` — cursor helpers.
  - `src/indexer/index.ts:985-1088` — `backfillProgram` (the
    resume-from-cursor loop failover relies on).
  - `src/indexer/index.ts:193-195, :932-936` — UNIQUE-index +
    `INSERT OR IGNORE` idempotency.
  - `src/indexer/index.ts:96-113, :670-700` — S-offchain-04 tombstone
    semantics preserved across restore.
  - `src/indexer/index.ts:41` — `Finality = "finalized"` fork-safety.
- **Stack inventory**: `mcp-server/package.json:52` (`ioredis` —
  Option α upgrade-path's prerequisite). No Postgres in workspace.
