# ADR-024: Scoped CPI Restrictions (V-A5 Fix)

## Status

Accepted

## Date

2026-04-15

## Context

Security audit finding **V-A5** identified that `execute_program_call` in the vault program performs a CPI to an allowlisted program but does not verify the SOL balance of the vault after the call returns. An allowlisted program could transfer SOL out of the vault (e.g., via `system_program::transfer` within its own logic), bypassing the per-transaction and daily spend limits enforced by the vault instruction. Token transfers are similarly unconstrained when routed through a generic CPI path.

## Decision

Add a post-CPI balance snapshot to `execute_program_call` and enforce spend limits on the net SOL outflow:

1. **Pre-CPI snapshot**: Record `vault.lamports()` before invoking the target program.
2. **Post-CPI snapshot**: After `invoke_signed` returns, read `vault.lamports()` again.
3. **Net outflow check**: Compute `pre_balance - post_balance` (saturating). If the net SOL outflow exceeds `per_tx_limit`, revert with `VaultError::PerTxLimitExceeded`.
4. **Daily accumulation**: Add the net outflow to `vault_state.daily_spent`. If `daily_spent` exceeds `daily_limit`, revert with `VaultError::DailyLimitExceeded`.
5. **Token transfer separation**: SPL token transfers are removed from the generic CPI path and enforced exclusively through the dedicated `execute_token_transfer` instruction, which already validates token-specific spend limits and allowlisted mints.

This ensures that even a fully trusted allowlisted program cannot drain vault SOL beyond the configured limits.

## Alternatives Considered

1. **Disallow SOL transfers entirely in CPI** -- Too restrictive; some programs legitimately need SOL for rent or fees.
2. **Whitelist specific instruction discriminators** -- Fragile; inner instructions of a CPI target are opaque to the caller.
3. **Simulate CPI before execution** -- Solana runtime does not support dry-run CPI; would require an off-chain preflight step.

## Consequences

- Closes V-A5: vault SOL is protected against drain via allowlisted program abuse.
- Adds ~2,000 compute units per CPI call for the balance snapshot comparison.
- Token transfers through the generic CPI path will now fail with `InvalidInstruction`, forcing callers to migrate to `execute_token_transfer`.
- Daily limit accounting becomes accurate across both direct transfers and CPI-induced outflows.

## Files Changed

- `programs/vault/src/instructions/execute_program_call.rs` -- add pre/post balance snapshot and limit checks
- `programs/vault/src/error.rs` -- add `PerTxLimitExceeded` variant if not already present
- `programs/vault/src/state.rs` -- add `daily_spent` field to `VaultState` (if not present)
- `tests/vault/cpi-balance-guard.test.ts` -- new integration test for post-CPI balance enforcement
