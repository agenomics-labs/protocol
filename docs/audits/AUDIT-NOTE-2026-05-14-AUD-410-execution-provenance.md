# AUDIT NOTE AUD-410 — ADR-138 Execution Provenance Attestations

- **Date**: 2026-05-14
- **Surface**: on-chain (agent-vault) + off-chain (indexer + MCP)
- **Companion ADR**: `docs/adr/ADR-138-execution-provenance-attestations.md`
- **Cycle**: 4

## Invariants pinned by ADR-138 + this audit note

### I-1 — One attestation per action

Every successful execution of a value-moving or authority-changing
instruction in the agent-vault program emits EXACTLY ONE
`ExecutionAttested` event. The emit lands AFTER the value move (so a
failed instruction rolls back both atomically) but inside the same
instruction handler (so the log line is bound to the on-chain
transaction commit).

Surfaces in scope:
- `execute_transfer`         → `ActionKind::Transfer`
- `execute_token_transfer`   → `ActionKind::TokenTransfer`
- `update_policy`            → `ActionKind::PolicyUpdate`
- `add_token_allowlist`      → `ActionKind::AllowlistManage`
- `remove_token_allowlist`   → `ActionKind::AllowlistManage`
- `add_program_allowlist`    → `ActionKind::AllowlistManage`
- `remove_program_allowlist` → `ActionKind::AllowlistManage`
- `update_agent_identity`    → `ActionKind::IdentityRotation`
- `pause_vault`              → `ActionKind::PauseToggle`
- `resume_vault`              → `ActionKind::PauseToggle`

ADR-111 reserves `ActionKind::GrantTransfer` and
`ActionKind::GrantTokenTransfer` for the delegation-grant branch.

Verifier: rust unit test
`programs/agent-vault/src/lib.rs::tests::adr_138_*`.

### I-2 — `policy_version` is monotonic and non-rollback

`Vault.policy_version` is mutated only by `update_policy`, via
`checked_add(1)`. The protocol does not expose a rollback path. The
initial value is 0 (set by `initialize_vault`); pre-ADR-138 vaults
zero-fill the field on first post-upgrade deserialize.

### I-3 — Idempotent indexer projection

The `execution_attestations` table is keyed
`UNIQUE(tx_signature, instruction_index)`. The dual-write SQL is
`INSERT OR IGNORE` (SQLite) /
`INSERT ... ON CONFLICT (tx_signature, instruction_index) DO NOTHING`
(Postgres). Backfill replay or websocket reconnect that re-delivers an
event MUST be a no-op.

Verifier: `src/indexer/test/aud-128-postgres-store.test.ts` (schema
parity gate covers the new table).

### I-4 — ActionKind tag order is positional and pinned

The borsh-encoded enum tag is positional in declaration order. A
reorder of the Rust enum without an indexer update would silently
mis-decode every historical event. Both sides have explicit pin tests:

- on-chain: `programs/agent-vault/src/lib.rs::adr_138_action_kind_tag_values_pinned`
- off-chain: `src/indexer/adr-138-execution-attested.test.ts::"pins the ActionKind variant order"`

### I-5 — `tool_id_hash` zero sentinel is the only acceptable migration path

Pre-migration callers MAY pass the all-zeros sentinel. Non-zero values
MUST be `sha256("agenomics.tool." + name)`. Indexers MAY surface a
`tool_id_zero_count` metric to track migration debt.

### I-6 — Manifest binding is sampled at execution time

`manifest_hash` on the attestation is copied from
`AgentProfile.manifest_hash` at the instant of execution, NOT at the
instant of query. A manifest rotation after-the-fact does NOT
retroactively change any historical attestation. Joins back to
`manifest_history` (ADR-082) by `(authority, slot)` reconstruct the
full context if needed.

## Schema-parity gate

The OFF-214 single-source-of-truth gate
(`src/indexer/test/off-208-215-bundle.test.ts::"OFF-214"`) is extended
to include `execution_attestations` in `INDEXER_PG_TABLES`. The
ADR-128 column-name parity gate
(`src/indexer/test/aud-128-postgres-store.test.ts`) auto-derives the
expected column set from `PRAGMA table_info` + `information_schema`;
the SQLite + Postgres halves of migration 003 must therefore stay in
lockstep.

## Status

**Accepted, in-tree, all tests passing.** No follow-up debt opened.
