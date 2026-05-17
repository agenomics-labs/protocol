# ADR-138: Execution Provenance Attestations

## Status

Accepted

## Date

2026-05-14

**Audit ID:** AUD-410

## Context

The Agenomics Protocol lets autonomous agents hold money and act under
vault policies. Pre-ADR-138, the agent-vault program emitted a flat
audit trail (`TransactionExecuted`, `TokenTransferExecuted`,
`PolicyUpdated`, `AllowlistUpdated`, etc.) that recorded WHAT moved but
not WHY. Specifically, no on-chain record bound:

- WHICH agent hot key signed (a vault has both `authority` and
  `agent_identity` accepted signers; the existing events did not
  distinguish them),
- under WHAT delegation grant (ADR-111, parallel branch),
- WHICH MCP tool drove the action,
- under WHICH capability manifest (ADR-060 / ADR-064 SAS attestations),
- at WHICH policy version (no on-chain monotonic version counter
  existed).

For external auditors, marketplaces, and dispute resolvers this gap
makes after-the-fact attribution expensive (require correlating the
on-chain tx log with off-chain MCP request logs, neither of which is
canonical alone) and forensic replay impossible without trusting an
off-chain proxy log.

Three sister-branch surfaces compose with this gap:

- ADR-111 `claude/delegation-grants-adr-111` adds a `DelegationGrant`
  PDA. Without provenance attestations, a grant-authorised action is
  indistinguishable on-chain from an authority-authorised action.
- ADR-060 manifests pin "what tools/permissions has the operator
  declared this agent is allowed to use". Without provenance binding
  to the manifest hash at execution time, manifest revocation has no
  cryptographic anchor in the action trail.
- `claude/portable-reputation-attestations` mints SAS attestations of
  agent behaviour. The attestor's claim is much stronger when it can
  cite the exact `(agent, tool, manifest, policy_version, slot)` tuple.

## Decision

Add an `ExecutionAttested` event emitted at the end of every
value-moving or authority-changing instruction in the agent-vault
program. The event binds:

```rust
#[event]
pub struct ExecutionAttested {
    pub vault: Pubkey,
    pub agent_identity: Pubkey,   // the hot key that signed
    pub authority: Pubkey,         // vault owner (the human-custodied root)
    pub action_kind: ActionKind,   // 1-byte enum tag
    pub tool_id: [u8; 32],         // sha256("agenomics.tool." + name)
    pub manifest_hash: [u8; 32],   // copied from AgentProfile.manifest_hash
    pub policy_version: u32,       // monotonic; bumped on update_policy
    pub delegation_grant: Option<Pubkey>, // ADR-111 reserve (None today)
    pub amount: u64,
    pub mint: Option<Pubkey>,
    pub recipient: Option<Pubkey>,
    pub slot: u64,
    pub timestamp: i64,
}
```

with an accompanying `ActionKind` enum:

```rust
pub enum ActionKind {
    Transfer,
    TokenTransfer,
    PolicyUpdate,
    AllowlistManage,
    IdentityRotation,
    PauseToggle,
    GrantTransfer,        // ADR-111 reserve
    GrantTokenTransfer,   // ADR-111 reserve
}
```

### tool_id_hash convention

A new `tool_id_hash: [u8; 32]` argument is appended to
`execute_transfer` and `execute_token_transfer`. Callers commit to the
MCP tool that triggered the action by computing
`sha256("agenomics.tool." + name)` (helper: `toolIdHash(name)` in
`sdk/client/src/vault.ts`, `mcpToolIdHash(name)` in
`mcp-server/src/handlers/vault.ts`, `v2ToolIdHash(name)` in
`mcp-server/src/handlers-v2/vault.ts` — all byte-for-byte identical).

The all-zeros sentinel is accepted for backwards-compatible callers
that have not migrated; indexers MAY surface a `tool_id_zero_count`
metric to track migration debt. Non-value-moving surfaces
(`update_policy`, `pause_vault`, `resume_vault`,
`update_agent_identity`, allowlist edits) currently emit the zero
sentinel because the MCP wrappers for those surfaces predate the
convention and re-plumbing them adds no security value (those calls
are exclusively `has_one = authority` gated).

### policy_version

New `Vault.policy_version: u32` field, initialized to 0 by
`initialize_vault`, bumped via `checked_add(1)` on every
`update_policy`. The current value is stamped into every
`ExecutionAttested` event so an auditor can pin which policy revision
was in force at execution time.

**Migration**: pre-ADR-138 vaults zero-fill `policy_version` on first
post-upgrade deserialization (Anchor's standard trailing-field
behaviour). The account `space` grows by 4 bytes (1630 → 1634). The
first `update_policy` post-upgrade lands at version 1.

### manifest_hash binding

`manifest_hash` is copied from `AgentProfile.manifest_hash` at
execution time via the `manifest_hash_from_profile(&agent_profile)`
helper. The all-zeros sentinel means the agent had no manifest
registered (ADR-060 pre-manifest profile) — distinct from "no manifest
used". The non-value-moving surfaces (`update_policy`, etc.) do not
have the `AgentProfile` account in their context and emit the zero
sentinel; consumers MAY join against `manifest_history` by
`(authority, slot)` to recover the pin.

### Indexer model

New `execution_attestations` table (migration
`003-adr-138-execution-attestations.sql`):

- mirrors the event payload 1:1,
- adds `tx_signature`, `instruction_index`, `ingested_at`, `decoded_at`,
- idempotent on `UNIQUE(tx_signature, instruction_index)`,
- indexed `(agent_identity, slot DESC)`, `(vault, slot DESC)`,
  `(tool_id, slot DESC)` — covers the dominant filter+sort patterns.

Decoder in `src/indexer/index.ts::EVENT_DECODERS.ExecutionAttested`
walks the borsh wire layout and pins the `ActionKind` variant order via
`ACTION_KIND_VARIANTS` (mirrors the `AGENT_STATUS_VARIANTS` drift-guard
pattern). The pin test
`adr-138-execution-attested.test.ts::"pins the ActionKind variant
order"` fails loudly if either side drifts.

### Query API

HTTP endpoint on the indexer:

```
GET /execution/agent/:agent_identity
GET /execution/vault/:vault
```

with optional `?action_kind=&tool_id=&since=<slot>&limit=<1..500>`.
Cursor pagination via `next_cursor.before_slot`; the indexes cover both
the filter and the `ORDER BY slot DESC` so the query is index-only.

MCP tool `query_execution_history` in `mcp-server/src/tools/vault.ts`
wraps the endpoint; the handler is `handleQueryExecutionHistory` in
`mcp-server/src/handlers/vault.ts`. The action is registered in
`mcp-server/src/actions/vault.ts::queryExecutionHistoryAction`. Tool
count: 28 → 29.

## Threat model

| Threat | Mitigation |
|---|---|
| **Replay attack** — adversary tries to re-emit an attestation for a transfer that did not happen | `ExecutionAttested` is emitted INSIDE the on-chain instruction; the Anchor `emit!` macro lands in the transaction's log only on commit. A failed instruction rolls back BOTH the value move AND the attestation atomically — there can never be an attestation without a corresponding state transition. |
| **Spoofed tool_id** — adversary tags a transfer with an unrelated tool name | The on-chain handler does not verify `tool_id_hash` against any registry. The tool name is committed-to by the SIGNER (whoever sent the tx) — if a compromised agent_identity tags a drain with `"vault_transfer"`, the attestation correctly identifies the signing key and tool name. Detection is the responsibility of off-chain observers correlating tool-name with expected agent behaviour. This is the SAME security posture as the existing `tool_id`-less audit events; ADR-138 strictly increases the information available to detectors without weakening any existing invariant. |
| **Manifest substitution** — adversary registers a benign manifest, transitions to a malicious one mid-session | `manifest_hash` is sampled from `AgentProfile.manifest_hash` at execution time; `manifest_history` (ADR-082) records every rotation. A consumer that observes a tool-id from manifest version N is binding to version N's authorised tool set, NOT to whatever the live manifest pointer says now. This is the load-bearing claim: an attestation records WHAT was in force, not WHAT is in force at query time. |
| **Cross-protocol replay of attestations** | None — the event is on-chain log data, not a signed artifact. The cryptographic anchor is the Solana transaction signature itself. |
| **Tool name collision** — two distinct tools hash to the same 32-byte digest | sha256 collision resistance. Tool-name space is operator-controlled; the operator MUST namespace tool names within their MCP catalogue to avoid in-protocol collisions. |
| **Policy version rollback** | `Vault.policy_version` is a `u32` mutated only via `checked_add(1)` in `update_policy`. The protocol does not expose any rollback path. |

## Interop notes

- **`claude/delegation-grants-adr-111`** — when that branch lands, the
  grant instructions will emit `ExecutionAttested` with
  `action_kind = GrantTransfer` / `GrantTokenTransfer` and
  `delegation_grant = Some(grant_pubkey)`. The enum reserves those
  tags TODAY; the option field is declared TODAY. The merge is
  expected to be additive — no `ExecutionAttested` schema change.

- **`claude/portable-reputation-attestations`** — that branch's SAS
  issuer SHOULD cite the
  `(agent_identity, tool_id, manifest_hash, policy_version, slot)`
  tuple from `execution_attestations` as the canonical event-ID the
  attestation refers to. No on-chain coupling is required.

## Open questions

1. Should non-value-moving surfaces (`update_policy`, etc.) also
   commit to a `tool_id_hash`? The current design accepts zero
   sentinels for those surfaces because the MCP wrappers for them are
   one-step administrative actions whose tool-name is implicit. A
   follow-up ADR may add the binding if a use case emerges.

2. Should the indexer auto-resolve `tool_id` back to its source name
   via a reverse-lookup table? Currently consumers compute
   `sha256("agenomics.tool." + name)` themselves. A reverse table
   would require the MCP catalogue to be available to the indexer at
   start time; not a hard dependency, but adds a deploy coupling.

3. The current `tool_id_hash` is committed-to by the SIGNER, not
   verified against the registry-bound manifest. A stricter mode
   would require the registry's `manifest` to declare a fixed
   tool-id-hash set and the vault handler to reject tx whose
   `tool_id_hash` is not in that set. This is intentionally NOT in
   ADR-138 because it adds an account read (the manifest body) to
   every value-moving call site. Deferred to a successor ADR.

## Consequences

### Positive

- Cryptographic anchor for "which tool, under which manifest, did this
  agent run when it moved this money". Marketplaces, dispute-resolvers,
  and external observability tooling can build on this without
  re-trusting an off-chain proxy log.
- Forward-compatible with ADR-111 delegation grants and the SAS
  attestation export branch.
- Idempotent indexer projection + cursor-paginated HTTP/MCP surface.

### Negative

- Account-space cost: +4 bytes per vault (`policy_version`).
- Instruction-data cost: +32 bytes per `execute_transfer` /
  `execute_token_transfer` (`tool_id_hash`).
- Tool count creeps to 29 (added `query_execution_history`).
- Existing callers (SDK, MCP handlers v1, MCP handlers v2) must pass
  the new arg — done in this same PR; no orphan callers remain.

## References

- `programs/agent-vault/src/events.rs` — `ExecutionAttested`, `ActionKind`
- `programs/agent-vault/src/state.rs` — `Vault.policy_version`
- `programs/agent-vault/src/instructions.rs` — every emit site
- `src/indexer/migrations/003-adr-138-execution-attestations.sql`
- `src/indexer/index.ts` — `ExecutionAttested` decoder + projection
- `mcp-server/src/tools/vault.ts::queryExecutionHistoryTool`
- `sdk/client/src/vault.ts::toolIdHash`
- Sister ADRs: ADR-060 (manifest hash), ADR-082 (off-chain history projections), ADR-095/097 (registry suspension gate), ADR-111 (delegation grants — parallel branch), ADR-124 (agent_identity bind).
