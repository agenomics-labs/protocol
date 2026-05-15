-- ===========================================================================
-- ADR-138 — Execution provenance attestations.
--
-- Persists `ExecutionAttested` events (emitted by every value-moving or
-- authority-changing instruction in the agent-vault program) so off-chain
-- consumers can answer: "which agent, under which delegation/policy,
-- executing which tool, with which manifest, at what slot?".
--
-- Phase 1 contract (read carefully before editing):
--   * SQLite remains authoritative; Postgres is shadow-write-only.
--     This migration adds ONE new table (`execution_attestations`) and
--     three btree indexes — the SQLite mirror is created inline in
--     `index.ts::initDb` and dual-written from `updateAgentFromEvent`.
--   * Idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
--     EXISTS`). Operators may re-run during bring-up + parity testing.
--   * Idempotency primitive: `UNIQUE(tx_signature, instruction_index)`.
--     A single transaction can emit at most one `ExecutionAttested`
--     event per instruction (the on-chain handler emits exactly one at
--     the end of each action ix), so the natural key is (signature,
--     instruction_index). Dual-write uses
--     `INSERT ... ON CONFLICT DO NOTHING` for retry-safety.
--
-- Type mappings vs. SQLite source (matches the convention from
-- 001-initial-postgres.sql):
--   * tool_id / manifest_hash       — hex string TEXT (64 chars)
--   * delegation_grant              — base58 TEXT, NULL when None
--   * mint / recipient              — base58 TEXT, NULL when None
--   * amount                        — TEXT (u64 lossless round-trip, see
--                                     `coerceU64String` in index.ts)
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
-- `query_execution_history` tool exposes; the slot-desc trailing column
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
