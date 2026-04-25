# ADR-069: Vault `agent_identity` rotation path and hot-key documentation

## Status
Proposed

## Date
2026-04-22

## Context

DEEP-AUDIT-2026-04-22.md Audit 1 finding **SEC-2 (CRITICAL-adjacent HIGH)** identified a permanent-exposure failure mode in `programs/agent-vault`.

`programs/agent-vault/src/contexts.rs:74-89` (`ExecuteTransfer`) and `:93-120` (`ExecuteTokenTransfer`) gate signer identity via the handler check `agent.key() == vault.authority || agent.key() == vault.agent_identity`. The `agent_identity` field is written once at `initialize_vault` (`lib.rs:26`) with **zero on-chain validation** — the authority supplies any key. There is no rotation instruction.

This creates a permanent authorization trap: if the off-chain "agent runtime" key bound to `agent_identity` is ever compromised — leaked log, lost laptop, terminated contractor — the human authority's only remedy today is to `close_escrow`-equivalent-drain the vault, close the vault, and re-initialize. Worse, a rotated `vault.authority` (the human key) does **not** invalidate `agent_identity`: the compromised agent-runtime key keeps draining under the daily cap indefinitely.

The audit's mitigation is an `update_agent_identity` ix gated by `has_one = authority`, and explicit doc that `agent_identity` is a hot key expected to be rotated on compromise. The alternative — making `agent_identity` a registry-owned PDA so registry suspension cascades — is a larger change and is deferred.

## Decision

Add a new instruction `update_agent_identity` to `programs/agent-vault`. Semantics:

- Context binds `vault` with `has_one = authority` (matching the existing `ADR-041` pattern applied elsewhere in Vault).
- `authority: Signer<'info>` is required.
- Handler overwrites `vault.agent_identity` with a caller-supplied `Pubkey`. No validation of the new key beyond it being a valid curve point — by design, `agent_identity` can be any key the authority chooses, including a freshly-derived keypair or a PDA from another program.
- Emits an event `AgentIdentityRotated { vault, old_identity, new_identity, slot }` for off-chain indexers.
- Does **not** touch vault balances, policies, or the daily-spend window; rotation is instantaneous and cheap.

Also amend the existing `update_policy` context in `programs/agent-vault` (which already carries `has_one = authority`) to explicitly document that it does NOT rotate `agent_identity` — callers must use the new instruction. This avoids a future-maintainer conflation.

**Documentation**: add a section to the Vault SDK README and to `packages/mcp-server`'s Vault docs labeling `agent_identity` as a **hot key** with the following guidance:

1. `agent_identity` should be a keypair distinct from `authority`.
2. If the agent runtime is long-running, rotate `agent_identity` on a routine cadence (suggested: 90 days) and on any suspicion of compromise.
3. The authority retains unilateral rotation power — no multisig required — because the threat model assumes `authority` is itself human-custodied.

**Program changes**: `programs/agent-vault` only. Registry and Settlement unchanged.

**Tests to add** (under `tests/vault/`):

- Happy path: authority calls `update_agent_identity` → `vault.agent_identity` reflects new key → new key can sign `execute_transfer` → old key cannot.
- Negative: non-authority signer calls `update_agent_identity` → rejected with `ConstraintHasOne`.
- Negative: no signer on `authority` → rejected with `ConstraintSigner`.
- Integration: rotate mid-day-window → existing `spent_today` window preserved (rotation does not reset rate limits).

**Deployment**: requires program upgrade. **Multisig signing required** per ADR-031.

## Alternatives Considered

- **Make `agent_identity` a Registry-owned PDA.** Discussed in the audit as a stronger alternative: registry suspension of the agent would automatically kill vault-draining. Rejected for this ADR because (a) it couples Vault to Registry tightly, violating the loose-coupling doctrine from ADR-060; (b) it creates a much larger program change including cross-program account ownership semantics; (c) it does not obviate the need for a rotation path — even registry-owned identities can be compromised if the registry authority is compromised. Tracked as a possible future ADR if operational experience demands the coupling.
- **Require multisig on `update_agent_identity`.** Rejected — the whole point of `agent_identity` being distinct from `authority` is that the human `authority` retains rotation power without multisig overhead. Forcing multisig would defeat the fast-rotation design goal.
- **Force `agent_identity == authority`.** Rejected — collapses the role separation that enables agent runtimes to operate without the human key online. ADR-041 explicitly separates these roles.
- **Do nothing, document the limitation.** Rejected — the audit classifies this as a "compromise of the off-chain agent runtime key = full vault drain under the daily cap indefinitely, even after the human rotates `vault.authority`" hazard, which is exploitable today.

## Consequences

**Positive**: eliminates the permanent-exposure failure mode; gives operators a fast, unilateral rotation path; brings `agent_identity` in line with Vault's existing `has_one = authority` patterns (ADR-041).

**Negative**: one new public instruction on the Vault program ABI. SDKs that wrap Vault must regenerate from the new IDL. No breaking changes to existing instructions.

**Migration path**: additive ABI change. Existing vaults are untouched; the new instruction is opt-in. Post-upgrade, operators are notified via release notes and docs-site changelog to rotate `agent_identity` if it has ever been exposed to logs or shared systems. Devnet rehearsal mandatory (ties to GOV-6). No data migration; existing `vault.agent_identity` fields retain their current values and can be left as-is or rotated at operator discretion.

## References
- `docs/adr/DEEP-AUDIT-2026-04-22.md` — Audit 1, finding SEC-2
- `docs/adr/ADR-041-vault-has-one-authority.md` — existing Vault `has_one` pattern
- `docs/adr/ADR-060-capability-descriptor-format.md` — identity/authority role separation
- `programs/agent-vault/src/contexts.rs:74-89, 93-120`, `src/lib.rs:26`

## Revisions
- 2026-04-25 — MCP tool surface added by PR-U (AUD-015 closure):
  `rotate_agent_identity` wraps `update_agent_identity` via mcp-server.
  Operators can now invoke key rotation through the standard MCP
  interface. Tool count 24 → 25.
