-- ===========================================================================
-- ADR-128 Phase 1 — Initial PostgreSQL schema (shadow / dual-write).
--
-- This migration mirrors the SQLite schema defined inline in
-- `src/indexer/index.ts::initDb` (the seven-table CREATE TABLE block at
-- lines 53-198 as of commit 7886554, ADR-128 acceptance) so a future
-- Phase 2 PR can flip reads from SQLite to Postgres by config alone
-- without redesigning the storage shape.
--
-- Phase 1 contract (read carefully before editing):
--   * SQLite (`better-sqlite3`) remains the authoritative read + write
--     store. Postgres is shadow-write-only; operators verify schema and
--     data parity offline.
--   * This file is idempotent (`CREATE TABLE IF NOT EXISTS`,
--     `CREATE INDEX IF NOT EXISTS`). Operators may re-run during
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
--     primitive on `events` maps 1:1 onto Postgres
--     `INSERT ... ON CONFLICT (program, signature, event_ordinal)
--     DO NOTHING`. This is the load-bearing claim per ADR-128
--     §"Decision" (5).
--   * u64 amounts (e.g. `min_escrow_amount`) are stored as TEXT in both
--     stores — see `coerceU64String` in `src/indexer/index.ts`. Lossless
--     round-trip is the requirement; arithmetic at read time is the
--     consumer's problem.
--   * No SQLite-only feature is in use upstream
--     (no FTS5, no WITHOUT ROWID, no AUTOINCREMENT abuse, no BLOB) —
--     so there is no Phase 1 schema-feature gap to paper over.
--
-- Phase 2 (separate future PR) will:
--   1. Flip reads from SQLite to Postgres (driven by `INDEXER_PG_URL`
--      presence + a future `INDEXER_STORAGE` flag).
--   2. Deprecate SQLite write path; the dual-write becomes
--      Postgres-only.
--   3. Convert the inline SQLite DDL block in `index.ts::initDb` to a
--      thin migration runner over this file plus future `00N-*.sql`
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
-- SQLite UNIQUE INDEX created at `index.ts:194`. The `INSERT ... ON
-- CONFLICT (program, signature, event_ordinal) DO NOTHING` semantics in
-- `postgres-store.ts` depend on this index existing.
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
-- from `upsertCursor` in `src/indexer/index.ts`. Phase 2 needs this in
-- lockstep with the SQLite cursor row at cutover, so Phase 1 dual-writes
-- on every cursor advance.
CREATE TABLE IF NOT EXISTS cursor (
  program              TEXT PRIMARY KEY,
  last_processed_slot  BIGINT NOT NULL DEFAULT 0,
  last_signature       TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- S-offchain-04 tombstone table. The AgentRegistered handler in
-- `updateAgentFromEvent` consults this BEFORE inserting an agent row to
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
