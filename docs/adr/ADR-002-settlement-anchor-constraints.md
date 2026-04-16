# ADR-002: Add Anchor-Level Constraints to Settlement Contexts

## Status
Accepted

## Date
2026-04-15

## Context
Several Settlement program instruction contexts (`AcceptTask`, `SubmitMilestone`, `RejectMilestone`, `RaiseDispute`) only specified `#[account(mut)]` on the escrow account without PDA seed verification or `has_one` constraints. While the instruction handlers contained runtime checks (e.g., `require!(ctx.accounts.provider.key() == escrow.provider)`), these checks happened after Anchor's account deserialization, bypassing the framework's built-in constraint system.

This created a defense-in-depth gap: if a handler-level check was accidentally removed during refactoring, there would be no safety net preventing unauthorized access.

## Decision
Add Anchor-level `has_one` and `constraint` attributes to all Settlement instruction contexts:

| Context | Constraint Added |
|---------|-----------------|
| `AcceptTask` | `has_one = provider` |
| `SubmitMilestone` | `has_one = provider` |
| `RejectMilestone` | `has_one = client` |
| `RaiseDispute` | `constraint = escrow.client == requester || escrow.provider == requester` |

Redundant handler-level checks were removed with comments documenting that constraints now enforce authorization.

## Alternatives Considered

### Alternative: Add PDA seed constraints instead of has_one
Rejected because escrow PDAs require `client`, `provider`, and `task_id` as seeds, which would require passing all three as instruction arguments for verification. `has_one` is simpler and sufficient since the escrow account's data is already validated by Anchor deserialization.

## Consequences

### Positive
- Authorization failures now occur at account deserialization (before handler code runs)
- Consistent with Anchor best practices for defense-in-depth
- Custom error messages via `@ SettlementError::*` provide clear failure reasons

### Negative
- Minor: `RaiseDispute` cannot use `has_one` since either party can dispute, requiring a `constraint` expression instead

## Files Changed
- `programs/settlement/src/lib.rs` - All four instruction contexts updated
