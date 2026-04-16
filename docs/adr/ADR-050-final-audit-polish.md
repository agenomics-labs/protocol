# ADR-050: Final Audit Polish

- **Status**: Accepted
- **Date**: 2026-04-16
- **Context**: Pre-mainnet audit sweep addressing medium and low-severity findings across all three on-chain programs and the MCP server layer.

## Summary

This ADR documents the nine fixes applied during the final audit polish pass. Each item is categorized by severity (M = medium, L = low) and references the affected component.

## Fixes

### M1 — Vault space: explicit calculation

Replaced `mem::size_of::<Vault>()` with an explicit per-field byte breakdown for the `#[account(space = ...)]` attribute. This eliminates silent drift when fields are added or reordered, and makes the on-chain space allocation auditable at a glance.

### M2 — VaultAction enum removed

Deleted the orphaned `VaultAction` enum that was defined but never referenced by any instruction or account. Dead code in on-chain programs increases audit surface and can mislead reviewers into thinking functionality exists that does not.

### M3 — TaskEscrow space documented

Added a per-field breakdown comment for the `TaskEscrow` account space calculation, matching the pattern established in M1 for Vault. Each field's contribution (discriminator, pubkeys, BN values, Vec overhead, enum tags, timestamps) is now individually documented.

### M4 — resolve_dispute_timeout slashes provider reputation

The `resolve_dispute_timeout` instruction now applies a -25 reputation penalty to the provider via CPI into the Registry program. Previously, a timed-out dispute had no reputational consequence, which removed any incentive for providers to resolve disputes promptly.

### M5 — expire_escrow slashes for submitted-but-unapproved milestones

When an escrow expires with milestones in the `Submitted` state (work delivered but never approved by the client), the provider now receives a reputation slash. This closes a loophole where a provider could submit low-quality work and let the deadline pass without consequence.

### L1 — execute_program_call removed

Removed the `execute_program_call` instruction from the Vault program. Without the vault PDA being a signer on the inner CPI, the instruction had limited practical utility and introduced unnecessary attack surface. Arbitrary CPI can be re-added in a future version with proper PDA signing and allowlist enforcement.

### L2 — Integration tests deferred

Integration tests that exercise cross-program CPI (e.g., Settlement calling Registry for reputation updates) require a running Solana validator with all three programs deployed. This is deferred to the devnet CI pipeline rather than blocking the current audit pass. Unit-level coverage for each program remains in place.

### L3 — Staking PDA is an acceptable pattern

The reputation staking PDA (`seeds = [authority, "reputation-stake"]`) holds only SOL (no data fields beyond the PDA itself). This is a standard Solana pattern for SOL-only escrow accounts and does not require a dedicated data struct. No change needed.

### L4 — handleResolveDispute updated with registry accounts

The MCP server's `handleResolveDispute` handler now passes three additional accounts required by the updated `ResolveDispute` on-chain context:

- `registryProgram` — the Registry program ID, needed for CPI.
- `providerProfile` — PDA derived from `[provider, "agent-profile"]` via the Registry program, target of the reputation update.
- `settlementAuthority` — PDA derived from `["settlement_authority"]` via the Settlement program, used as the CPI signer.

The provider pubkey is read from the fetched escrow account (same fetch that already retrieves `tokenMint`).

## Decision

All nine items are resolved or explicitly deferred (L2). The codebase is ready for external audit submission.
