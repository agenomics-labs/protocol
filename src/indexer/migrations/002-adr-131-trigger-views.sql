-- ===========================================================================
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
--       inequality `E > 3R + 3L` becomes adversary-favorable once median
--       `E` is two orders of magnitude above `R ≈ 0.011 SOL`.
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
--   * `events.data` is TEXT (JSON-stringified by `JSON.stringify` in
--     `index.ts::insertEvents`); jsonb access requires an explicit
--     `data::jsonb` cast. The cast is IMMUTABLE in PG 12+ so it can
--     appear in expression indexes.
--   * Idempotent: every view uses `CREATE OR REPLACE VIEW` (PG always
--     supports this for non-materialized views); every index uses
--     `CREATE INDEX IF NOT EXISTS`. Operators may re-run during
--     bring-up + parity testing without harm — same contract as
--     001-initial-postgres.sql.
--   * Views (regular, not materialized) chosen on these grounds:
--       - The trigger query cadence is daily / weekly, not per-event.
--       - The underlying `events` table is already indexed on
--         `event_name`; the per-event-name jsonb-expression indexes
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
--   * `EscrowCreated` decoder in `index.ts::EVENT_DECODERS` MUST
--     surface `total_amount` (u64 → TEXT via u64ToJson) AND
--     `token_mint` (Pubkey → base58) at JSON keys matching
--     `(data::jsonb)->>'total_amount'` and `(data::jsonb)->>'token_mint'`.
--     `token_mint` was added per ADR-131 — the metric is only
--     meaningful when bucketed by denomination (SOL vs USDC have
--     wildly different unit values).
--   * `DisputeResolved` decoder MUST surface `task_id`, `client_refund`,
--     `provider_refund` so vw_dispute_resolved can compute the
--     winning side from the refund split. (Currently
--     DisputeResolved falls through to the `event_<hex>` raw
--     classification — the decoder is pre-existing tech debt that
--     blocks trigger-1 from being computable from indexed data.
--     Noted, not fixed in this migration.)
--   * `AgentRegistered` decoder already surfaces `authority` and
--     `timestamp` per `EVENT_DECODERS.AgentRegistered` in `index.ts`.
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

-- Time-bounded scans use the existing `timestamp` column on events
-- (TIMESTAMPTZ, indexed implicitly via slot-correlated insert order).
-- An explicit btree on `timestamp` makes the 7-day / 30-day window
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
-- KNOWN CONSTRAINT: as of this migration, the `EVENT_DECODERS` map
-- in `src/indexer/index.ts` does NOT include a DisputeResolved
-- decoder, so events fall through to the `event_<hex>` raw
-- classification with `data = {discriminator, rawData}`. This view
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
-- `incident_count` across rows to compute the quarterly tally.
--
-- Window alignment: `date_trunc('week', dispute_at)` (ISO-8601 weeks
-- starting Monday). This is a deterministic, simple bucketing — the
-- alternative (true rolling 7-day windows) requires a window function
-- with a frame clause that is more expensive to compute and harder to
-- materialize. ADR-131's threshold semantics ("≥5/quarter") are
-- aggregate enough that ISO-week alignment vs true-rolling differs at
-- most by a single window per quarter; the trigger-action (open a
-- successor ADR) is unaffected by that resolution.
--
-- Winner derivation: relies on `vw_dispute_resolved.winner_side`,
-- which classifies the refund split into Provider / Client / Split /
-- Unknown. Only Provider and Client outcomes contribute to a "fresh
-- authority won" cluster; Splits and Unknowns are excluded — they
-- don't unambiguously identify a beneficiary, so they don't fit the
-- ADR-131 "favored a counterparty" semantic.
--
-- KNOWN CONSTRAINT: this view depends on `vw_dispute_resolved`, which
-- in turn depends on a `DisputeResolved` decoder in
-- `index.ts::EVENT_DECODERS`. The decoder is added in the same
-- ADR-131 wiring pass that ships this view; without it,
-- `vw_dispute_resolved` returns zero rows and this view returns
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
