# ADR-026: Resolve Dispute Bookkeeping Fix (S-A7)

- **Status**: Accepted
- **Date**: 2026-04-15

## Context

Security audit finding **S-A7** identified that `resolve_dispute` transfers `client_refund` and `provider_refund` amounts from the escrow vault but does not update `escrow.released_amount`. After dispute resolution, `released_amount` is less than `total_amount`, leaving the escrow in an inconsistent state. Off-chain indexers that rely on `released_amount == total_amount` to mark an escrow as fully settled will report the escrow as partially open indefinitely.

## Decision

Update `resolve_dispute` to increment `released_amount` by the sum of `client_refund + provider_refund` after both token transfers succeed:

1. **Transfer client_refund**: CPI `token::transfer` from escrow vault to client token account (existing logic, unchanged).
2. **Transfer provider_refund**: CPI `token::transfer` from escrow vault to provider token account (existing logic, unchanged).
3. **Update released_amount**: Set `escrow.released_amount = escrow.released_amount + client_refund + provider_refund`.
4. **Invariant assertion**: Add a post-transfer assertion that `escrow.released_amount == escrow.total_amount`. If this fails, revert with `EscrowError::BookkeepingMismatch` to prevent silent accounting errors.

This ensures that after dispute resolution the escrow state is fully consistent and downstream systems can reliably detect settlement completion.

## Alternatives Considered

1. **Off-chain reconciliation** -- Indexers could infer completion from the dispute-resolved event, but this pushes correctness responsibility off-chain and breaks any on-chain program that reads `released_amount`.
2. **Close the escrow account immediately** -- Would fix the inconsistency by removing the account, but prevents post-resolution queries and complicates rent reclaim flows.
3. **Separate `finalize_dispute` instruction** -- Adds unnecessary transaction overhead; the bookkeeping update is small and belongs in the same atomic transaction.

## Consequences

- Closes S-A7: `released_amount` is always consistent after dispute resolution.
- Off-chain indexers can use `released_amount == total_amount` as a reliable settlement-complete signal across all resolution paths (normal release, expiry, and dispute).
- The invariant assertion adds a safety net against future regressions in payout logic.
- No additional accounts or context changes required; only state mutation is added.

## Files Changed

- `programs/settlement/src/instructions/resolve_dispute.rs` -- add `released_amount` update and invariant check
- `programs/settlement/src/error.rs` -- add `BookkeepingMismatch` error variant
- `tests/settlement/resolve-dispute-bookkeeping.test.ts` -- new test verifying `released_amount` after resolution
