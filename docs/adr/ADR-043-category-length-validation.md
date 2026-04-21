# ADR-043: Category Length Validation

- **Status**: Accepted
- **Date**: 2026-04-16

## Context

The `category` field on `AgentProfile` is a `String` with no length validation at the instruction level. Because account space is allocated with a fixed maximum (see ADR-040), an unbounded category string can exceed the reserved 50 bytes, causing Borsh serialization to write past the account boundary and triggering a runtime error. Even if the transaction fails, the lack of an explicit check means callers receive an opaque serialization error rather than a meaningful application-level error.

## Decision

Add `require!(category.len() <= 50, AepError::CategoryTooLong)` validation in both the `register_agent` and `update_profile` instruction handlers. This check runs before any state mutation, providing a clear error message and preventing accounts from entering an inconsistent state.

A new error variant `CategoryTooLong` is added to the `AepError` enum with a descriptive message: "Category exceeds maximum length of 50 characters."

The 50-byte limit aligns with the space reserved in ADR-040's explicit account size calculation.

## Alternatives Considered

1. **No validation, rely on serialization failure** -- poor UX; callers see a generic `BorshIoError` with no indication of which field is too long.
2. **Truncate the category silently** -- violates the principle of least surprise; the stored value would differ from what the caller submitted.
3. **Use a fixed-size `[u8; 50]` array instead of `String`** -- eliminates the problem but changes the serialization format and requires migration of existing accounts.
4. **Larger limit (e.g., 128 bytes)** -- wastes account space for a field that is typically short (e.g., "DeFi", "Gaming", "Infrastructure").

## Consequences

- Callers attempting to register or update an agent with a category longer than 50 characters receive a clear `CategoryTooLong` error.
- The validation is consistent across both entry points (`register_agent` and `update_profile`), preventing divergent behavior.
- The error variant increases the program's error enum by one entry, which is a negligible cost.
- Future fields with similar constraints should follow this pattern of explicit length validation with dedicated error variants.

## Files Changed

- `programs/aep/src/instructions/register_agent.rs` -- added `require!(category.len() <= 50, ...)`
- `programs/aep/src/instructions/update_profile.rs` -- added `require!(category.len() <= 50, ...)`
- `programs/aep/src/errors.rs` -- added `CategoryTooLong` variant to `AepError`
- `tests/agent_registration.ts` -- added test for category exceeding 50 characters
