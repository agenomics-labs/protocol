# ADR-044: Clean Spend Records on Allowlist Removal

- **Status**: Accepted
- **Date**: 2026-04-16

## Context

The `Vault` account maintains a `token_spend_records: Vec<TokenSpendRecord>` that tracks per-token spending against policy limits. When a token is removed from the allowlist via `remove_token_allowlist`, its corresponding spend records are not cleaned up. Over time, repeatedly adding and removing tokens causes unbounded growth of the `token_spend_records` vec, wasting account space and increasing serialization/deserialization costs. In the worst case, the vec can grow to fill the entire account, preventing any further writes.

## Decision

When removing a token from the allowlist, also remove all associated spend records by calling:

```rust
vault.token_spend_records.retain(|r| r.mint != token_mint);
```

This is performed in the `remove_token_allowlist` handler immediately after the token is removed from the allowlist vec. The `retain` call is O(n) in the number of spend records, which is acceptable given the practical upper bound on allowlisted tokens.

## Alternatives Considered

1. **Lazy cleanup on next spend** -- defers the cost but does not bound growth; a vault that only removes tokens would never clean up.
2. **Periodic cleanup via a separate instruction** -- adds complexity and requires someone to call it; the natural cleanup point is at removal time.
3. **Use a HashMap instead of Vec** -- Borsh does not natively serialize `HashMap`; a custom serialization layer adds complexity for marginal benefit at the expected scale.
4. **Set a maximum vec length** -- caps the damage but does not address the root cause of stale records accumulating.

## Consequences

- Spend records are cleaned up at the natural point of token removal, keeping the vec bounded by the number of currently-allowlisted tokens.
- The additional `retain` call adds negligible compute cost to the `remove_token_allowlist` instruction.
- Historical spend data for removed tokens is lost, which is acceptable because the token is no longer allowlisted and the records serve no further purpose.
- If spend records are needed for auditing after removal, a separate event log or off-chain indexer should be used instead.

## Files Changed

- `programs/aeap/src/instructions/manage_allowlist.rs` -- added `vault.token_spend_records.retain(|r| r.mint != token_mint)` in `remove_token_allowlist`
- `tests/vault_allowlist.ts` -- added test verifying spend records are cleaned on token removal
