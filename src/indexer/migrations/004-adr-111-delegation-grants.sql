-- ===========================================================================
-- ADR-111 — Delegation grant projection tables.
--
-- ADR-111 §"Consequences" makes the indexer the home of the
-- delegation-grant projection: a `delegation_grants` table for the
-- per-(vault, grantee, nonce) row plus a `delegation_grant_events`
-- append-only audit log of every grant lifecycle event. Dashboards
-- (ADR-111 §"Consequences" / "dashboard renders 'X delegations
-- outstanding' per vault with expiry countdowns") drive off both.
--
-- ADR-128 Phase 1 contract (read carefully before editing):
--   * SQLite remains authoritative for events / agents / cursor.
--     This migration is the Postgres-side schema for the new ADR-111
--     projection. The SQLite mirror is added inline in
--     `src/indexer/index.ts::initDb` in lockstep (same dual-write
--     pattern used for vault_identity_history / manifest_history /
--     protocol_config_history). Phase 2 flips reads.
--   * Idempotency: every INSERT uses `ON CONFLICT (grant_address) DO
--     UPDATE` for `delegation_grants` and the unique
--     `(grant_address, signature, slot)` triple for
--     `delegation_grant_events` — same `INSERT OR IGNORE` shape used
--     by the other history tables.
--   * u64 columns (`spend_cap_lamports`, `spent_lamports`,
--     `amount_lamports`, `spent_after`) stay TEXT in both stores to
--     preserve lossless u64 round-trip (see `coerceU64String` in
--     `src/indexer/index.ts`). i64 `expires_at` / `created_at` /
--     `event_timestamp` stay BIGINT — they fit in INT8 without loss.
--   * Pubkey columns stay TEXT (base58) in both stores, matching
--     `agents.authority` / `vault_identity_history.vault` etc.
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
  -- (e.g. `recipient` is only populated on Executed; `revoker` only on
  -- Revoked). Storing them in a wide row beats a JSONB blob because
  -- the indexer query layer is `better-sqlite3` synchronous SQL and the
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
