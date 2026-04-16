# ADR-030: Multi-Sig Dispute Resolution with Timeout

## Status
Accepted

## Date
2026-04-15

## Context
The original dispute resolution had a critical flaw: the `dispute_resolver` (a single address) had unilateral power to split funds with no deadline. If the resolver disappeared or was compromised:
1. Funds remained locked indefinitely in the escrow
2. Neither client nor provider could recover their tokens
3. No appeal mechanism or fallback existed

## Decision
Add a **dispute timeout mechanism** with auto-resolution:

1. **`disputed_at` field** added to `TaskEscrow` — records when the dispute was raised (Unix timestamp)
2. **`DISPUTE_TIMEOUT_SECONDS = 604,800`** (7 days) — window for the resolver to act
3. **`resolve_dispute_timeout` instruction** — callable by anyone after the timeout expires:
   - Refunds all remaining funds to the client (safe default)
   - Marks escrow as Completed
   - Emits `DisputeResolved` event

### Why client gets the refund on timeout?
The client locked the funds and is the party at risk of loss. If the resolver fails to act, the conservative default is to return funds to the original payer. The provider retains any already-released milestone payments.

### Future: Multi-sig resolution
The current `dispute_resolver: Option<Pubkey>` field can be upgraded to a Squads multi-sig address, providing committee-based resolution without protocol changes. The timeout mechanism works regardless of whether the resolver is a single key or a multi-sig.

## Alternatives Considered

### Alternative: Split 50/50 on timeout
Rejected — gives the provider an incentive to stall disputes since they receive funds without completing work.

### Alternative: On-chain arbitration DAO
Ideal long-term but requires governance infrastructure. The timeout mechanism is a practical first step that prevents indefinite fund locking.

## Consequences

### Positive
- Funds can never be locked indefinitely
- Anyone can trigger timeout resolution (permissionless)
- Compatible with future multi-sig upgrade
- 7-day window gives resolver reasonable time

### Negative
- Client-favored default may discourage providers from participating in disputes
- `disputed_at` adds 8 bytes to escrow account size

## Files Changed
- `programs/settlement/src/lib.rs` — `disputed_at` field, `DISPUTE_TIMEOUT_SECONDS`, `resolve_dispute_timeout` instruction, `ResolveDisputeTimeout` context, error variant
