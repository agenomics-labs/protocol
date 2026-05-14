/**
 * AUTO-EMBEDDED FROM src/indexer/migrations/*.sql — DO NOT HAND-EDIT THE SQL
 * STRINGS BELOW. Edit the .sql files (which remain authoritative for
 * grep / SQL-tooling / migration history) and re-run the embedder, OR
 * synchronise by hand and rely on the parity test in
 * `test/aud-202-migration-embedded.test.ts` to catch drift.
 *
 * WHY THIS FILE EXISTS — OFF-202 (ADR-128 cycle-3 off-chain audit):
 *   The previous `applyMigration` used `__dirname` +
 *   `fs.readFileSync('migrations/001-initial-postgres.sql')`. After
 *   `tsc` compiled `postgres-store.ts` into `dist/`, that
 *   `__dirname` resolved under `dist/`, but the migration files
 *   ship at `src/indexer/migrations/*.sql` and were not copied into
 *   `dist/` by the build. Production boot ENOENT'd. Inlining the SQL as
 *   a TypeScript constant makes the migration string a build artifact of
 *   the source itself — no filesystem lookup at runtime, no copy step in
 *   the build pipeline, no source-vs-shipped drift surface.
 *
 * The SQL strings below MUST stay byte-identical to the .sql sources;
 * the parity test enforces that.
 */

export interface EmbeddedMigration {
  /** File-name of the source .sql (also the schema_migrations key when we add one). */
  readonly name: string;
  /** Verbatim SQL contents, comments and whitespace preserved. */
  readonly sql: string;
}

export const MIGRATIONS: ReadonlyArray<EmbeddedMigration> = [
  {
    name: "001-initial-postgres.sql",
    sql: `-- ===========================================================================
-- ADR-128 Phase 1 — Initial PostgreSQL schema (shadow / dual-write).
--
-- This migration mirrors the SQLite schema defined inline in
-- \`src/indexer/index.ts::initDb\` (the seven-table CREATE TABLE block at
-- lines 53-198 as of commit 7886554, ADR-128 acceptance) so a future
-- Phase 2 PR can flip reads from SQLite to Postgres by config alone
-- without redesigning the storage shape.
--
-- Phase 1 contract (read carefully before editing):
--   * SQLite (\`better-sqlite3\`) remains the authoritative read + write
--     store. Postgres is shadow-write-only; operators verify schema and
--     data parity offline.
--   * This file is idempotent (\`CREATE TABLE IF NOT EXISTS\`,
--     \`CREATE INDEX IF NOT EXISTS\`). Operators may re-run during
--     bring-up + parity testing without harm.
--   * Type mappings vs. SQLite source (per ADR-128 §"Surface impact"):
--       SQLite INTEGER PRIMARY KEY AUTOINCREMENT  -> BIGSERIAL PRIMARY KEY
--       SQLite INTEGER (slot, ordinal, timestamp) -> BIGINT
--         (avoids 32-bit overflow at year-out chain scale; ADR-128
--         requirement R7)
--       SQLite TEXT                                -> TEXT
--       SQLite TEXT DEFAULT (datetime('now'))      -> TIMESTAMPTZ
--                                                     DEFAULT now()
--       SQLite CHECK(... IN (...))                 -> identical syntax
--   * The UNIQUE(program, signature, event_ordinal) idempotency
--     primitive on \`events\` maps 1:1 onto Postgres
--     \`INSERT ... ON CONFLICT (program, signature, event_ordinal)
--     DO NOTHING\`. This is the load-bearing claim per ADR-128
--     §"Decision" (5).
--   * u64 amounts (e.g. \`min_escrow_amount\`) are stored as TEXT in both
--     stores — see \`coerceU64String\` in \`src/indexer/index.ts\`. Lossless
--     round-trip is the requirement; arithmetic at read time is the
--     consumer's problem.
--   * No SQLite-only feature is in use upstream
--     (no FTS5, no WITHOUT ROWID, no AUTOINCREMENT abuse, no BLOB) —
--     so there is no Phase 1 schema-feature gap to paper over.
--
-- Phase 2 (separate future PR) will:
--   1. Flip reads from SQLite to Postgres (driven by \`INDEXER_PG_URL\`
--      presence + a future \`INDEXER_STORAGE\` flag).
--   2. Deprecate SQLite write path; the dual-write becomes
--      Postgres-only.
--   3. Convert the inline SQLite DDL block in \`index.ts::initDb\` to a
--      thin migration runner over this file plus future \`00N-*.sql\`
--      siblings.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS events (
  id             BIGSERIAL PRIMARY KEY,
  program        TEXT NOT NULL,
  event_name     TEXT NOT NULL,
  data           TEXT NOT NULL,
  signature      TEXT NOT NULL,
  slot           BIGINT NOT NULL,
  event_ordinal  BIGINT NOT NULL DEFAULT 0,
  timestamp      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_program ON events(program);
CREATE INDEX IF NOT EXISTS idx_events_name    ON events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_slot    ON events(slot);

-- Idempotency primitive (ADR-128 R2 / §"Decision" 5). Mapped from the
-- SQLite UNIQUE INDEX created at \`index.ts:194\`. The \`INSERT ... ON
-- CONFLICT (program, signature, event_ordinal) DO NOTHING\` semantics in
-- \`postgres-store.ts\` depend on this index existing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique
  ON events(program, signature, event_ordinal);

CREATE TABLE IF NOT EXISTS agents (
  id                BIGSERIAL PRIMARY KEY,
  authority         TEXT NOT NULL UNIQUE,
  name              TEXT,
  category          TEXT,
  reputation_score  BIGINT DEFAULT 0,
  tasks_completed   BIGINT DEFAULT 0,
  last_updated      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agents_category   ON agents(category);
CREATE INDEX IF NOT EXISTS idx_agents_reputation ON agents(reputation_score);

-- Per-program checkpoint. Cursor advance is monotonic and dual-written
-- from \`upsertCursor\` in \`src/indexer/index.ts\`. Phase 2 needs this in
-- lockstep with the SQLite cursor row at cutover, so Phase 1 dual-writes
-- on every cursor advance.
CREATE TABLE IF NOT EXISTS cursor (
  program              TEXT PRIMARY KEY,
  last_processed_slot  BIGINT NOT NULL DEFAULT 0,
  last_signature       TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- S-offchain-04 tombstone table. The AgentRegistered handler in
-- \`updateAgentFromEvent\` consults this BEFORE inserting an agent row to
-- prevent backfill resurrection of a deregistered authority. Phase 1
-- preserves consultation against SQLite (authoritative); this Postgres
-- copy stays in lockstep so Phase 2 cutover can flip the consultation
-- target without semantic change.
CREATE TABLE IF NOT EXISTS agent_tombstones (
  authority             TEXT PRIMARY KEY,
  deregistered_at_slot  BIGINT NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ADR-082: append-only history of vault.agent_identity rotations.
CREATE TABLE IF NOT EXISTS vault_identity_history (
  id            BIGSERIAL PRIMARY KEY,
  vault         TEXT NOT NULL,
  old_identity  TEXT NOT NULL,
  new_identity  TEXT NOT NULL,
  slot          BIGINT NOT NULL,
  signature     TEXT NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vault_identity_vault ON vault_identity_history(vault);
CREATE INDEX IF NOT EXISTS idx_vault_identity_slot  ON vault_identity_history(slot);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_identity_unique
  ON vault_identity_history(vault, signature, slot);

-- ADR-082: append-only history of capability-manifest rotations
-- (ADR-060). manifest_cid is the hex-encoded 64-byte CIDv1; manifest_hash
-- is the hex-encoded 32-byte sha256. Both are TEXT in both stores.
CREATE TABLE IF NOT EXISTS manifest_history (
  id                BIGSERIAL PRIMARY KEY,
  authority         TEXT NOT NULL,
  manifest_cid      TEXT NOT NULL,
  manifest_hash     TEXT NOT NULL,
  manifest_version  BIGINT NOT NULL,
  event_timestamp   BIGINT NOT NULL,
  slot              BIGINT NOT NULL,
  signature         TEXT NOT NULL,
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_manifest_authority ON manifest_history(authority);
CREATE INDEX IF NOT EXISTS idx_manifest_slot      ON manifest_history(slot);
CREATE UNIQUE INDEX IF NOT EXISTS idx_manifest_unique
  ON manifest_history(authority, signature, slot);

-- ADR-082: append-only history of ProtocolConfig governance changes.
-- min_escrow_amount stays TEXT (u64 lossless round-trip — see
-- coerceU64String). The CHECK constraint mirrors the SQLite source
-- exactly so a future Phase 2 read against Postgres surfaces the same
-- enum-validity guarantee.
CREATE TABLE IF NOT EXISTS protocol_config_history (
  id                                    BIGSERIAL PRIMARY KEY,
  kind                                  TEXT NOT NULL CHECK (kind IN ('Initialized', 'Updated')),
  authority                             TEXT NOT NULL,
  min_escrow_amount                     TEXT NOT NULL,
  dispute_timeout_seconds               BIGINT NOT NULL,
  reputation_delta_task_completed       BIGINT NOT NULL,
  reputation_delta_dispute_loss         BIGINT NOT NULL,
  reputation_delta_expiry_undelivered   BIGINT NOT NULL,
  slot                                  BIGINT NOT NULL,
  signature                             TEXT NOT NULL,
  observed_at                           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_protocol_config_slot ON protocol_config_history(slot);
CREATE INDEX IF NOT EXISTS idx_protocol_config_kind ON protocol_config_history(kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_protocol_config_unique
  ON protocol_config_history(signature, slot, kind);
`,
  },
  {
    name: "002-adr-131-trigger-views.sql",
    sql: `-- ===========================================================================
-- ADR-131 — Sybil-cost re-calibration trigger views.
--
-- ADR-131 §"Re-calibration trigger" defines two off-chain conditions that
-- re-open the calibration analysis when sustained on mainnet:
--
--   (1) Sybil-pattern incidents. ≥3 newly-registered authorities (no
--       on-chain reputation history pre-registration) all participating
--       in disputes within a 7-day window where the outcome favored a
--       counterparty also showing the same fresh-authority pattern.
--       Threshold: >5/quarter in year 1, >10/quarter thereafter.
--
--   (2) Median escrow value. Sustained 30-day rolling average of median
--       per-task escrow exceeds 1 SOL (≈$150-200 USD). The AUD-205
--       inequality \`E > 3R + 3L\` becomes adversary-favorable once median
--       \`E\` is two orders of magnitude above \`R ≈ 0.011 SOL\`.
--
-- The on-chain protocol does not surface either metric directly;
-- ADR-131 §Consequences §Follow-ups makes the indexer the home of
-- the surfacing work. This migration adds the read-side projections
-- ops dashboards query when computing whether either trigger has
-- fired.
--
-- ADR-128 Phase 1 contract (read carefully before editing):
--   * SQLite remains authoritative; Postgres is shadow-write-only.
--     This migration adds VIEWS + INDEXES only — NO new tables. The
--     SQLite mirror is untouched. Phase 2 (separate future PR) will
--     flip reads to Postgres at which point these views become the
--     trigger queries' read path.
--   * \`events.data\` is TEXT (JSON-stringified by \`JSON.stringify\` in
--     \`index.ts::insertEvents\`); jsonb access requires an explicit
--     \`data::jsonb\` cast. The cast is IMMUTABLE in PG 12+ so it can
--     appear in expression indexes.
--   * Idempotent: every view uses \`CREATE OR REPLACE VIEW\` (PG always
--     supports this for non-materialized views); every index uses
--     \`CREATE INDEX IF NOT EXISTS\`. Operators may re-run during
--     bring-up + parity testing without harm — same contract as
--     001-initial-postgres.sql.
--   * Views (regular, not materialized) chosen on these grounds:
--       - The trigger query cadence is daily / weekly, not per-event.
--       - The underlying \`events\` table is already indexed on
--         \`event_name\`; the per-event-name jsonb-expression indexes
--         added below give views index-only-scan-friendly shape.
--       - Materialization adds a REFRESH maintenance surface with no
--         payoff during Phase 1 shadow-write (when nothing reads from
--         Postgres in production).
--       - When Phase 2 cuts reads over and trigger query latency
--         becomes load-bearing, a follow-up migration can convert any
--         hot view to MATERIALIZED VIEW + scheduled REFRESH without
--         changing the public view names downstream consumers depend
--         on. CREATE OR REPLACE VIEW preserves that option.
--
-- Wire-format dependencies (must stay in lockstep with on-chain):
--   * \`EscrowCreated\` decoder in \`index.ts::EVENT_DECODERS\` MUST
--     surface \`total_amount\` (u64 → TEXT via u64ToJson) AND
--     \`token_mint\` (Pubkey → base58) at JSON keys matching
--     \`(data::jsonb)->>'total_amount'\` and \`(data::jsonb)->>'token_mint'\`.
--     \`token_mint\` was added per ADR-131 — the metric is only
--     meaningful when bucketed by denomination (SOL vs USDC have
--     wildly different unit values).
--   * \`DisputeResolved\` decoder MUST surface \`task_id\`, \`client_refund\`,
--     \`provider_refund\` so vw_dispute_resolved can compute the
--     winning side from the refund split. (Currently
--     DisputeResolved falls through to the \`event_<hex>\` raw
--     classification — the decoder is pre-existing tech debt that
--     blocks trigger-1 from being computable from indexed data.
--     Noted, not fixed in this migration.)
--   * \`AgentRegistered\` decoder already surfaces \`authority\` and
--     \`timestamp\` per \`EVENT_DECODERS.AgentRegistered\` in \`index.ts\`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Expression indexes on events.data (jsonb-cast). These are the load-bearing
-- index surface for both trigger queries — without them the views fall back
-- to a full sequential scan of events on every dashboard refresh.
-- ---------------------------------------------------------------------------

-- Per-(event_name, authority) lookups for fresh-authority correlation.
-- Used by vw_agent_registered and vw_fresh_authorities_90d to find an
-- agent's first registration timestamp without scanning all events.
CREATE INDEX IF NOT EXISTS idx_events_name_authority
  ON events (event_name, ((data::jsonb)->>'authority'));

-- Per-(event_name, task_id) lookups for joining DisputeRaised /
-- DisputeResolved back to their EscrowCreated to identify participants.
CREATE INDEX IF NOT EXISTS idx_events_name_task_id
  ON events (event_name, ((data::jsonb)->>'task_id'));

-- Per-(event_name, token_mint) lookups for the median-escrow trigger.
-- Bucketing by token_mint is required (ADR-131 — SOL vs USDC have
-- wildly different unit values).
CREATE INDEX IF NOT EXISTS idx_events_name_token_mint
  ON events (event_name, ((data::jsonb)->>'token_mint'));

-- Time-bounded scans use the existing \`timestamp\` column on events
-- (TIMESTAMPTZ, indexed implicitly via slot-correlated insert order).
-- An explicit btree on \`timestamp\` makes the 7-day / 30-day window
-- predicates index-friendly without requiring the planner to chase
-- via slot.
CREATE INDEX IF NOT EXISTS idx_events_timestamp
  ON events (timestamp);

-- ---------------------------------------------------------------------------
-- vw_escrow_created — per-event flat projection of EscrowCreated.
--
-- Surfaces the trigger-2 metric inputs (total_amount as numeric,
-- token_mint) plus the join keys (task_id, client, provider) the
-- trigger-1 view needs to identify dispute participants.
--
-- total_amount is stored as TEXT (u64 lossless round-trip per
-- coerceU64String); the cast to NUMERIC happens here so consumers
-- get arithmetic-ready values without re-deriving the cast at every
-- call site.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_escrow_created AS
SELECT
  e.id,
  e.signature,
  e.slot,
  e.timestamp                                        AS observed_at,
  (e.data::jsonb)->>'task_id'                        AS task_id,
  (e.data::jsonb)->>'escrow'                         AS escrow,
  (e.data::jsonb)->>'client'                         AS client,
  (e.data::jsonb)->>'provider'                       AS provider,
  (e.data::jsonb)->>'token_mint'                     AS token_mint,
  ((e.data::jsonb)->>'total_amount')::numeric        AS total_amount
FROM events e
WHERE e.event_name = 'EscrowCreated';

-- ---------------------------------------------------------------------------
-- vw_dispute_resolved — per-event flat projection of DisputeResolved.
--
-- Surfaces the dispute outcome (winning side via refund split) and the
-- task_id needed to join back to EscrowCreated participants.
--
-- Per programs/settlement/src/events.rs::DisputeResolved:
--   pub escrow: Pubkey
--   pub resolver: Pubkey
--   pub client_refund: u64
--   pub provider_refund: u64
--   pub task_id: u64
--
-- Winner derivation: the side receiving > 0 refund is the favored
-- party. A 50/50 split (both refunds > 0) is a draw — surfaced as
-- 'Split' so the trigger-1 query can choose to count or exclude
-- splits per its own policy.
--
-- KNOWN CONSTRAINT: as of this migration, the \`EVENT_DECODERS\` map
-- in \`src/indexer/index.ts\` does NOT include a DisputeResolved
-- decoder, so events fall through to the \`event_<hex>\` raw
-- classification with \`data = {discriminator, rawData}\`. This view
-- will return zero rows until the decoder is added. The trigger-1
-- query is therefore not yet executable end-to-end; that's
-- pre-existing tech debt outside this migration's scope. The view
-- still ships so the dependency surface is visible (and so the
-- decoder fix lands as an isolated diff later).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_dispute_resolved AS
SELECT
  e.id,
  e.signature,
  e.slot,
  e.timestamp                                                  AS observed_at,
  (e.data::jsonb)->>'task_id'                                  AS task_id,
  (e.data::jsonb)->>'escrow'                                   AS escrow,
  (e.data::jsonb)->>'resolver'                                 AS resolver,
  ((e.data::jsonb)->>'client_refund')::numeric                 AS client_refund,
  ((e.data::jsonb)->>'provider_refund')::numeric               AS provider_refund,
  CASE
    WHEN ((e.data::jsonb)->>'client_refund')::numeric > 0
     AND ((e.data::jsonb)->>'provider_refund')::numeric > 0    THEN 'Split'
    WHEN ((e.data::jsonb)->>'client_refund')::numeric > 0      THEN 'Client'
    WHEN ((e.data::jsonb)->>'provider_refund')::numeric > 0    THEN 'Provider'
    ELSE 'Unknown'
  END                                                          AS winner_side
FROM events e
WHERE e.event_name = 'DisputeResolved';

-- ---------------------------------------------------------------------------
-- vw_agent_registered — first-registration timestamp per authority.
--
-- Defines the "no on-chain reputation history pre-registration" half
-- of the fresh-authority predicate (ADR-131 §"Re-calibration
-- trigger"). The predicate operationalizes as: an authority's first
-- AgentRegistered event lies within the look-back window. Using
-- MIN(timestamp) covers the edge case where the same authority was
-- registered, deregistered, and re-registered (ADR-097 makes this
-- land at a different PDA but the AUTHORITY is the same key — the
-- ADR-131 fresh-authority predicate is keyed on AUTHORITY identity,
-- so the FIRST observed registration is the correct anchor).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_agent_registered AS
SELECT
  (e.data::jsonb)->>'authority'   AS authority,
  MIN(e.timestamp)                AS first_registered_at
FROM events e
WHERE e.event_name = 'AgentRegistered'
  AND (e.data::jsonb)->>'authority' IS NOT NULL
GROUP BY (e.data::jsonb)->>'authority';

-- ---------------------------------------------------------------------------
-- vw_fresh_authorities_90d — authorities whose first registration is
-- within the last 90 days, the fresh-authority cohort the trigger-1
-- analysis runs against.
--
-- 90 days is a defensible operational floor: the protocol's slash-to-
-- suspend cadence (3 slashes, MAX_DELTA_PER_CALL = 10) means a sybil
-- ramping reputation 0 → ≥30 across 3+ disputes burns the identity
-- in days-to-weeks, not quarters; 90 days keeps the cohort wide
-- enough to absorb organic churn (legitimate fresh agents that are
-- not adversarial) without diluting the signal. The window is
-- intentionally separate from the 7-day dispute clustering window —
-- they answer different questions: "who counts as fresh?" (90d)
-- vs. "which fresh authorities cluster in disputes?" (7d).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_fresh_authorities_90d AS
SELECT
  authority,
  first_registered_at
FROM vw_agent_registered
WHERE first_registered_at > now() - interval '90 days';

-- ---------------------------------------------------------------------------
-- vw_escrow_median_30d — trigger-2 input.
--
-- Per ADR-131 §"Re-calibration trigger" item 2: trigger fires when
-- the 30-day rolling median escrow value exceeds 1 SOL sustained.
-- The view returns one row per token_mint with the median
-- total_amount over the trailing 30 days. The dashboard owns the
-- "sustained" judgment (i.e., correlating successive snapshots);
-- this view is the per-snapshot input.
--
-- Bucketing by token_mint is mandatory — SOL (lamports, 9 decimals)
-- and USDC (6 decimals) have unit values that differ by orders of
-- magnitude; an unbucketed median is meaningless.
--
-- PERCENTILE_CONT(0.5) is the exact-median aggregate (continuous
-- interpolation between the two middle values for even-count
-- groups). For odd-count groups it returns the middle value
-- directly. This is the canonical PG idiom for medians; no
-- approximate-median (e.g. PERCENTILE_DISC) substitution.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_escrow_median_30d AS
SELECT
  token_mint,
  COUNT(*)::int                                                       AS sample_count,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_amount)           AS median_amount_base_units,
  (now() - interval '30 days')                                        AS window_started_at
FROM vw_escrow_created
WHERE observed_at > now() - interval '30 days'
  AND token_mint IS NOT NULL
GROUP BY token_mint;

-- ---------------------------------------------------------------------------
-- vw_fresh_authority_disputes_7d — trigger-1 surface (cluster aggregator).
--
-- Per ADR-131 §"Re-calibration trigger" item 1: trigger fires when the
-- protocol observes ≥3 fresh authorities (registered <90 days before)
-- winning disputes within a 7-day window, and this happens ≥5 times
-- per quarter (Y1) or ≥10 times per quarter (Y2+).
--
-- This view is the per-7-day-window cluster aggregator the dashboard
-- reads. Each row represents one 7-day window where ≥3 fresh
-- authorities clustered as dispute winners; the dashboard sums
-- \`incident_count\` across rows to compute the quarterly tally.
--
-- Window alignment: \`date_trunc('week', dispute_at)\` (ISO-8601 weeks
-- starting Monday). This is a deterministic, simple bucketing — the
-- alternative (true rolling 7-day windows) requires a window function
-- with a frame clause that is more expensive to compute and harder to
-- materialize. ADR-131's threshold semantics ("≥5/quarter") are
-- aggregate enough that ISO-week alignment vs true-rolling differs at
-- most by a single window per quarter; the trigger-action (open a
-- successor ADR) is unaffected by that resolution.
--
-- Winner derivation: relies on \`vw_dispute_resolved.winner_side\`,
-- which classifies the refund split into Provider / Client / Split /
-- Unknown. Only Provider and Client outcomes contribute to a "fresh
-- authority won" cluster; Splits and Unknowns are excluded — they
-- don't unambiguously identify a beneficiary, so they don't fit the
-- ADR-131 "favored a counterparty" semantic.
--
-- KNOWN CONSTRAINT: this view depends on \`vw_dispute_resolved\`, which
-- in turn depends on a \`DisputeResolved\` decoder in
-- \`index.ts::EVENT_DECODERS\`. The decoder is added in the same
-- ADR-131 wiring pass that ships this view; without it,
-- \`vw_dispute_resolved\` returns zero rows and this view returns
-- empty.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_fresh_authority_disputes_7d AS
WITH fresh_dispute_winners AS (
  SELECT
    dr.observed_at AS dispute_at,
    CASE dr.winner_side
      WHEN 'Provider' THEN ec.provider
      WHEN 'Client'   THEN ec.client
    END AS winning_authority
  FROM vw_dispute_resolved dr
  JOIN vw_escrow_created   ec ON ec.task_id = dr.task_id
  WHERE dr.winner_side IN ('Provider', 'Client')
),
fresh_only AS (
  SELECT
    fdw.dispute_at,
    fdw.winning_authority
  FROM fresh_dispute_winners fdw
  JOIN vw_fresh_authorities_90d fa ON fa.authority = fdw.winning_authority
  WHERE fdw.winning_authority IS NOT NULL
)
SELECT
  date_trunc('week', dispute_at)::timestamptz       AS window_started_at,
  array_agg(DISTINCT winning_authority)             AS fresh_authorities,
  1                                                 AS incident_count
FROM fresh_only
GROUP BY date_trunc('week', dispute_at)::timestamptz
HAVING count(DISTINCT winning_authority) >= 3;
`,
  },
  {
    name: "003-adr-138-execution-attestations.sql",
    sql: `-- ===========================================================================
-- ADR-138 — Execution provenance attestations.
--
-- Persists \`ExecutionAttested\` events (emitted by every value-moving or
-- authority-changing instruction in the agent-vault program) so off-chain
-- consumers can answer: "which agent, under which delegation/policy,
-- executing which tool, with which manifest, at what slot?".
--
-- Phase 1 contract (read carefully before editing):
--   * SQLite remains authoritative; Postgres is shadow-write-only.
--     This migration adds ONE new table (\`execution_attestations\`) and
--     three btree indexes — the SQLite mirror is created inline in
--     \`index.ts::initDb\` and dual-written from \`updateAgentFromEvent\`.
--   * Idempotent (\`CREATE TABLE IF NOT EXISTS\`, \`CREATE INDEX IF NOT
--     EXISTS\`). Operators may re-run during bring-up + parity testing.
--   * Idempotency primitive: \`UNIQUE(tx_signature, instruction_index)\`.
--     A single transaction can emit at most one \`ExecutionAttested\`
--     event per instruction (the on-chain handler emits exactly one at
--     the end of each action ix), so the natural key is (signature,
--     instruction_index). Dual-write uses
--     \`INSERT ... ON CONFLICT DO NOTHING\` for retry-safety.
--
-- Type mappings vs. SQLite source (matches the convention from
-- 001-initial-postgres.sql):
--   * tool_id / manifest_hash       — hex string TEXT (64 chars)
--   * delegation_grant              — base58 TEXT, NULL when None
--   * mint / recipient              — base58 TEXT, NULL when None
--   * amount                        — TEXT (u64 lossless round-trip, see
--                                     \`coerceU64String\` in index.ts)
--   * action_kind                   — TEXT with CHECK constraint
--   * slot / timestamp              — BIGINT
--   * policy_version                — BIGINT (4-byte u32 fits with room
--                                     to spare; matches event_ordinal
--                                     and slot's BIGINT shape)
--
-- Index strategy:
--   - (agent_identity, slot DESC) — "show me this agent's history"
--   - (vault, slot DESC)          — "show me this vault's history"
--   - (tool_id, slot DESC)        — "show me every action through tool X"
-- Each index covers the dominant filter+sort pattern the MCP
-- \`query_execution_history\` tool exposes; the slot-desc trailing column
-- lets a paginating query use the index for both the filter AND the
-- order-by without a separate sort step.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS execution_attestations (
  id                 BIGSERIAL PRIMARY KEY,
  tx_signature       TEXT NOT NULL,
  instruction_index  BIGINT NOT NULL DEFAULT 0,
  vault              TEXT NOT NULL,
  agent_identity     TEXT NOT NULL,
  authority          TEXT NOT NULL,
  action_kind        TEXT NOT NULL CHECK (action_kind IN (
                       'Transfer',
                       'TokenTransfer',
                       'PolicyUpdate',
                       'AllowlistManage',
                       'IdentityRotation',
                       'PauseToggle',
                       'GrantTransfer',
                       'GrantTokenTransfer'
                     )),
  tool_id            TEXT NOT NULL,
  manifest_hash      TEXT NOT NULL,
  policy_version     BIGINT NOT NULL,
  delegation_grant   TEXT,
  amount             TEXT NOT NULL DEFAULT '0',
  mint               TEXT,
  recipient          TEXT,
  slot               BIGINT NOT NULL,
  event_timestamp    BIGINT NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  decoded_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_exec_attest_unique
  ON execution_attestations (tx_signature, instruction_index);

CREATE INDEX IF NOT EXISTS idx_exec_attest_agent_slot
  ON execution_attestations (agent_identity, slot DESC);

CREATE INDEX IF NOT EXISTS idx_exec_attest_vault_slot
  ON execution_attestations (vault, slot DESC);

CREATE INDEX IF NOT EXISTS idx_exec_attest_tool_slot
  ON execution_attestations (tool_id, slot DESC);
`,
  },
  {
    name: "004-adr-111-delegation-grants.sql",
    sql: `-- ===========================================================================
-- ADR-111 — Delegation grant projection tables.
--
-- ADR-111 §"Consequences" makes the indexer the home of the
-- delegation-grant projection: a \`delegation_grants\` table for the
-- per-(vault, grantee, nonce) row plus a \`delegation_grant_events\`
-- append-only audit log of every grant lifecycle event. Dashboards
-- (ADR-111 §"Consequences" / "dashboard renders 'X delegations
-- outstanding' per vault with expiry countdowns") drive off both.
--
-- ADR-128 Phase 1 contract (read carefully before editing):
--   * SQLite remains authoritative for events / agents / cursor.
--     This migration is the Postgres-side schema for the new ADR-111
--     projection. The SQLite mirror is added inline in
--     \`src/indexer/index.ts::initDb\` in lockstep (same dual-write
--     pattern used for vault_identity_history / manifest_history /
--     protocol_config_history). Phase 2 flips reads.
--   * Idempotency: every INSERT uses \`ON CONFLICT (grant_address) DO
--     UPDATE\` for \`delegation_grants\` and the unique
--     \`(grant_address, signature, slot)\` triple for
--     \`delegation_grant_events\` — same \`INSERT OR IGNORE\` shape used
--     by the other history tables.
--   * u64 columns (\`spend_cap_lamports\`, \`spent_lamports\`,
--     \`amount_lamports\`, \`spent_after\`) stay TEXT in both stores to
--     preserve lossless u64 round-trip (see \`coerceU64String\` in
--     \`src/indexer/index.ts\`). i64 \`expires_at\` / \`created_at\` /
--     \`event_timestamp\` stay BIGINT — they fit in INT8 without loss.
--   * Pubkey columns stay TEXT (base58) in both stores, matching
--     \`agents.authority\` / \`vault_identity_history.vault\` etc.
-- ===========================================================================

-- Current-state projection of every observed DelegationGrant PDA. Bumped
-- on Created (insert) / Revoked (update) / Updated (update) /
-- Executed (running tally updates).
CREATE TABLE IF NOT EXISTS delegation_grants (
  grant_address       TEXT PRIMARY KEY,    -- the DelegationGrant PDA
  vault               TEXT NOT NULL,
  grantor             TEXT NOT NULL,
  grantee             TEXT NOT NULL,
  nonce               INTEGER NOT NULL CHECK (nonce >= 0 AND nonce <= 255),
  allowed_actions     INTEGER NOT NULL,
  spend_cap_lamports  TEXT NOT NULL,       -- u64 as decimal string
  spent_lamports      TEXT NOT NULL,       -- u64 as decimal string
  expires_at          BIGINT NOT NULL,     -- 0 = no expiry sentinel
  revoked             BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          BIGINT NOT NULL,
  last_seen_slot      BIGINT NOT NULL,
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delegation_grants_vault    ON delegation_grants(vault);
CREATE INDEX IF NOT EXISTS idx_delegation_grants_grantee  ON delegation_grants(grantee);
-- Operators frequently query "active grants per vault" for dashboards.
CREATE INDEX IF NOT EXISTS idx_delegation_grants_active
  ON delegation_grants(vault) WHERE revoked = FALSE;

-- Append-only audit log of every delegation-grant lifecycle event. One
-- row per Created / Revoked / Updated / Executed event. Dashboards reading
-- this for forensics expect rows to be insert-only.
CREATE TABLE IF NOT EXISTS delegation_grant_events (
  id                  BIGSERIAL PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('Created', 'Revoked', 'Updated', 'Executed')),
  grant_address       TEXT NOT NULL,
  vault               TEXT NOT NULL,
  -- Per-kind payload columns. NULL when not applicable to the event
  -- (e.g. \`recipient\` is only populated on Executed; \`revoker\` only on
  -- Revoked). Storing them in a wide row beats a JSONB blob because
  -- the indexer query layer is \`better-sqlite3\` synchronous SQL and the
  -- dashboard already typed every column.
  grantee             TEXT,
  grantor             TEXT,
  revoker             TEXT,
  recipient           TEXT,
  mint                TEXT,
  action_kind         INTEGER,
  allowed_actions     INTEGER,
  spend_cap_lamports  TEXT,
  amount              TEXT,
  spent_after         TEXT,
  expires_at          BIGINT,
  nonce               INTEGER,
  event_timestamp     BIGINT NOT NULL,
  slot                BIGINT NOT NULL,
  signature           TEXT NOT NULL,
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dgrant_events_grant ON delegation_grant_events(grant_address);
CREATE INDEX IF NOT EXISTS idx_dgrant_events_vault ON delegation_grant_events(vault);
CREATE INDEX IF NOT EXISTS idx_dgrant_events_kind  ON delegation_grant_events(kind);
CREATE INDEX IF NOT EXISTS idx_dgrant_events_slot  ON delegation_grant_events(slot);
-- Idempotency primitive — same shape as the other history tables. A
-- replay of the same (signature, slot, grant_address) does not produce
-- duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dgrant_events_unique
  ON delegation_grant_events(grant_address, signature, slot, kind);
`,
  }
];
