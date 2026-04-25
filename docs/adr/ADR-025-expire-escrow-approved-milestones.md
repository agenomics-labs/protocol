# ADR-025: Expire Escrow with Approved Milestone Handling (S-A6 Fix)

## Status

Accepted

## Date

2026-04-15

## Context

Security audit finding **S-A6** identified that `expire_escrow` refunds the entire remaining balance to the client regardless of milestone status. If a provider has completed work and the client has approved one or more milestones but the escrow deadline passes before `release_payment` is called, the provider loses payment for already-approved work. This creates an incentive for clients to delay the final release and let the escrow expire.

## Decision

Modify `expire_escrow` to iterate over all milestones and distribute funds according to their approval status:

1. **Iterate milestones**: For each milestone in the escrow:
   - If status is `Approved`, add its amount to `provider_payout`.
   - If status is `Submitted`, `Pending`, or `Rejected`, add its amount to `client_refund`.
2. **Transfer to provider**: Transfer `provider_payout` from the escrow vault to `provider_token_account` via CPI to `token::transfer`.
3. **Refund to client**: Transfer `client_refund` from the escrow vault to `client_token_account`.
4. **Close escrow vault**: Close the token account and return rent to the client.
5. **Account context update**: Add `provider_token_account` as a required account in the `ExpireEscrow` context struct, validated against `escrow.provider`.

The provider is guaranteed payment for all work the client has already approved, even if the escrow expires.

## Alternatives Considered

1. **Auto-extend deadline on approved milestones** -- Delays resolution; client may want to move on with a different provider.
2. **Require explicit release before expiry** -- Current behaviour; unfair to provider when client is unresponsive.
3. **Dispute-based resolution for expired escrows** -- Adds complexity; approved milestones already represent client consent to pay.

## Consequences

- Closes S-A6: providers are protected against loss of approved work on deadline expiry.
- `ExpireEscrow` context now requires one additional account (`provider_token_account`), which is a breaking change for existing callers.
- Off-chain indexers must update their `expire_escrow` event parsing to include the provider payout amount.
- Gas cost of `expire_escrow` increases proportionally to the number of milestones (loop iteration).

## Files Changed

- `programs/settlement/src/instructions/expire_escrow.rs` -- milestone iteration and split payout logic
- `programs/settlement/src/contexts/expire_escrow.rs` -- add `provider_token_account` to context
- `tests/settlement/expire-approved-milestones.test.ts` -- new test covering partial approval + expiry

## Revisions

- 2026-04-25 — Files Changed citation refers to a pre-ADR-049 mono-program
  layout (`programs/aep/...` / `programs/vault/...`); current code lives at
  `programs/settlement/src/instructions/escrow.rs:376` after the multi-program
  split. AUD-2026-04-25 / drift matrix §5.
