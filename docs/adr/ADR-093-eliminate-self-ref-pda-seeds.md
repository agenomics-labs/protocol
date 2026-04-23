# ADR-093 — Eliminate Self-referential PDA Seeds

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-04-23 |

## Context

The `agent-vault` program's `ExecuteTransfer` and `ExecuteTokenTransfer` instruction
contexts derived the vault PDA using `vault.authority.key().as_ref()` as the seed —
reading the `authority` field from inside the vault account's own stored data. While
technically valid at CPI call time (the account is already loaded), this pattern is
self-referential: to derive the PDA address, a caller must first load the vault account
to read `vault.authority`, but loading the vault account requires knowing its PDA address.

This circular dependency makes off-chain PDA derivation harder than necessary. All
other vault instruction contexts (`InitializeVault`, `UpdatePolicy`, `ManageAllowlist`,
`UpdateAgentIdentity`, `ManageProgramAllowlist`, `PauseVault`, `ResumeVault`) already
use the canonical `seeds = [b"vault", authority.key().as_ref()]` pattern where
`authority` is a separate account in the context — fully deterministic from external
inputs alone.

## Decision

Add an explicit `authority: UncheckedAccount` field to `ExecuteTransfer` and
`ExecuteTokenTransfer` instruction contexts, and derive the vault PDA from
`authority.key()` rather than `vault.authority`. A `has_one = authority` constraint
verifies that the supplied `authority` account matches `vault.authority`, preserving
the same security invariant with no additional trust requirements.

Seeds for all vault contexts are now uniformly `[b"vault", authority.key().as_ref()]`,
derived purely from externally-deterministic inputs.

## Alternatives

- **Keep as-is**: Works at runtime but confuses auditors and off-chain derivation
  tooling. Any off-chain code that wants to compute the vault PDA must perform an
  on-chain account read before it can even formulate the derivation — a latency
  and reliability cost with no benefit.
- **Use a program-derived nonce stored in account data**: Adds storage overhead and
  a separate initialization step without improving determinism for callers.
- **Use the vault owner's keypair as a signer for execute_transfer**: Breaks the
  dual-signer design (agent identity OR authority can sign transfers). The agent
  runtime holds the `agent_identity` key, not the `authority` key.

## Consequences

- **PDA addresses are unchanged**: The seeds `[b"vault", authority]` are identical
  to what all other instruction contexts already use, and to what the off-chain
  TypeScript tests (`findProgramAddress([Buffer.from("vault"), authority.toBuffer()])`)
  already derive. No account migration is required.
- **Instruction accounts grow by one**: Both `ExecuteTransfer` and
  `ExecuteTokenTransfer` now require the `authority` public key as an additional
  (non-signer) account. TypeScript callers must pass it; the IDL will reflect this
  after the next `anchor build`.
- **Off-chain derivation is purely a function of owner key + fixed discriminant**:
  No on-chain reads are required before computing a vault address.
- **Security posture is unchanged**: The `has_one = authority` constraint enforces
  that the supplied `authority` matches the stored `vault.authority` before the
  PDA derivation is validated, preventing a caller from supplying an arbitrary
  authority key to derive a different vault.

## References

- Architecture Audit 2026-04-23, Item 18, Arch §4.4
- ADR-029: Removed vestigial `vault_account` field (prior simplification)
- ADR-041: `has_one = authority` defense-in-depth pattern used across all vault contexts
