# ADR-003: Implement SPL Token Transfers in Vault

## Status
Accepted

## Date
2026-04-15

## Context
The Agent Vault program's architecture documentation described SPL token transfers with allowlist enforcement, but the implementation only supported native SOL transfers via `execute_transfer`. The `token_allowlist` field existed in `VaultPolicy` with an `is_token_allowed()` method, but it was unused — flagged as dead code by the compiler.

For AEAP's core use case (USDC-denominated agent payments), SPL token transfers are essential. Without them, the vault cannot participate in the settlement escrow flow that uses SPL tokens.

## Decision
Add a new `execute_token_transfer` instruction to the Agent Vault program:

1. **Authorization**: Same as `execute_transfer` — agent identity or vault authority must sign
2. **Pause check**: Blocked when vault is paused
3. **Token allowlist**: The source token account's mint must be in `vault.policy.token_allowlist` (or allowlist must be empty for "allow all")
4. **Rate limiting**: Shares the hourly transaction counter with SOL transfers
5. **CPI pattern**: Vault PDA signs the SPL `token::transfer` CPI via `invoke_signed`

The instruction does NOT enforce daily/per-tx SOL limits on token transfers since token amounts are in different denominations (USDC decimals != SOL lamports). Rate limiting provides the safety bound.

## Alternatives Considered

### Alternative: Unified transfer instruction handling both SOL and SPL
Rejected because it would complicate the account context (optional token accounts) and make the instruction harder for AI agents to use correctly.

### Alternative: Daily limits in token base units
Deferred to a future enhancement. Would require per-mint daily tracking, which significantly increases account size. Rate limiting provides sufficient protection for v1.

## Consequences

### Positive
- Vault can now hold and transfer USDC, USDT, and any SPL tokens
- Token allowlist is enforced, preventing unauthorized token transfers
- Enables full participation in the Settlement escrow flow
- `is_token_allowed()` is no longer dead code

### Negative
- No per-token daily spending limit (only rate limiting)
- Adds `anchor-spl` as a dependency to the vault program

## Files Changed
- `programs/agent-vault/Cargo.toml` - Added `anchor-spl` dependency
- `programs/agent-vault/src/lib.rs` - New instruction, context, event, and handler
