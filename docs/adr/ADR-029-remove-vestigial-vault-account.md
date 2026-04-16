# ADR-029: Remove Vestigial vault_account from ExecuteTransfer

## Status
Accepted

## Date
2026-04-15

## Context
The `ExecuteTransfer` instruction context contained two accounts referencing the vault:
- `vault: Account<'info, Vault>` — The vault PDA with seed-verified constraints
- `vault_account: UncheckedAccount<'info>` — An unchecked account marked as `mut`

The `execute_transfer` handler only used `ctx.accounts.vault.to_account_info()` for the lamport transfer, never referencing `vault_account`. This field was:
1. Redundant — the vault PDA account IS the SOL holder
2. A security surface — `UncheckedAccount` with no seed constraint could accept any account
3. Confusing — callers had to pass the same PDA twice (once as `vault`, once as `vault_account`)

## Decision
Remove `vault_account` from `ExecuteTransfer`. The vault PDA already serves as both the state account and the SOL source. Update the MCP server's `handleVaultTransfer` to stop passing `vaultAccount`.

## Consequences

### Positive
- Eliminates unchecked account surface
- Simpler instruction context (4 accounts instead of 5)
- No functional change — the handler already used the correct account

### Negative
- Breaking change: existing callers must update their account lists
- MCP server handler updated to match

## Files Changed
- `programs/agent-vault/src/lib.rs` — Removed `vault_account` from `ExecuteTransfer`
- `mcp-server/src/index.ts` — Removed `vaultAccount` from `handleVaultTransfer`
