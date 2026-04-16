# ADR-006: Cap Allowlist Sizes with On-Chain Validation

## Status
Accepted

## Date
2026-04-15

## Context
The `VaultPolicy` struct stores `token_allowlist: Vec<Pubkey>` and `program_allowlist: Vec<Pubkey>` with no maximum size enforced. The vault account allocates 1024 bytes of headroom beyond the base struct size. Each `Pubkey` is 32 bytes, plus 4 bytes for the Vec length prefix.

Without size caps:
1. Repeated `add_token_allowlist` calls could exceed the account's allocated space
2. The Solana runtime would return an opaque "account data too small" error
3. An attacker (or buggy agent) could bloat the account to consume maximum rent

## Decision
Add compile-time constants and runtime validation:

```rust
const MAX_TOKEN_ALLOWLIST: usize = 10;   // 10 * 32 = 320 bytes
const MAX_PROGRAM_ALLOWLIST: usize = 10; // 10 * 32 = 320 bytes
```

Both `add_token_allowlist` and `add_program_allowlist` now check:
```rust
require!(vault.policy.token_allowlist.len() < MAX_TOKEN_ALLOWLIST, VaultError::AllowlistFull);
```

The existing `AllowlistFull` error variant is reused.

### Size budget
- Token allowlist: 4 (len) + 10 * 32 = 324 bytes
- Program allowlist: 4 (len) + 10 * 32 = 324 bytes
- Total: 648 bytes, well within the 1024 headroom

## Alternatives Considered

### Alternative: Use a separate account for large allowlists
Over-engineered for the current use case. 10 tokens and 10 programs cover all realistic agent scenarios. Can be extended later if needed.

### Alternative: Dynamic reallocation via `realloc`
Anchor supports `realloc` but it adds complexity (payer for additional rent) and isn't needed given the generous initial allocation.

## Consequences

### Positive
- Prevents account space overflow
- Clear error message when limit is reached
- Constants are documented with sizing rationale

### Negative
- Hard cap of 10 may be restrictive for agents interacting with many DeFi protocols
- Would require program upgrade to change the limit

## Files Changed
- `programs/agent-vault/src/lib.rs` - Constants added, validation in add handlers
