# ADR-062: MPP canonical wire-format conformance — Reserved

## Status
Reserved (placeholder; decision deferred — see ADR-058 §"Open items" and ADR-059 §"Alternative D" for trigger conditions)

## Date
2026-04-23

## Context

ADR-062 was reserved as a forward-looking placeholder by **ADR-058 (`action-and-signer-abstraction`, Accepted)** under "Open items" — *"`mpp-sdk` canonical wire-format conformance if AEP speaks HTTP-402"* — and again by **ADR-059 (`tx-submission-pipeline`, Accepted)** in its rejected "Alternative D" — *"Use `solana-mpp` directly as a dependency for replay protection"*. Both ADRs explicitly bracket the question: *if* AEP later commits to speaking the sendaifun MPP (Solana Multi-Party Payment) HTTP-402 wire format end-to-end (as opposed to merely emitting an x402 payment proof per ADR-017), this ADR captures the conformance decision — which fields are mirrored verbatim, which are AEP-specific extensions, which mismatches are acceptable, and what the version-skew policy looks like.

No live trigger exists today: AEP's current x402 path does not commit to MPP wire format, the mutex-per-sig replay-protection pattern was reimplemented in `mcp-server/pipeline` at ~50 LoC rather than by importing `solana-mpp`, and no consumer has requested MPP interop on the AEP roadmap. Reserving the number keeps the corpus reference graph valid (ADR-058 §"Open items" and ADR-059 Alternative D both name `ADR-062` as the future home of this decision); promotion to Proposed/Accepted requires a future PR.

## Decision

**Reserved — not a decision.** This ADR holds slot 062 as a placeholder for a future MPP wire-format conformance decision. No technical decision is being made here. Triggers for promotion:

1. AEP adopts MPP HTTP-402 wire format as the canonical payment-proof envelope (would conflict with the current x402-only path under ADR-017).
2. A consumer or integration partner requests MPP wire interop, with sufficient deal-economics to justify the conformance work.
3. sendaifun's MPP becomes the de-facto Solana payment-channel standard and AEP needs interop for ecosystem reach.

If any trigger fires, this ADR is superseded by a freshly-authored ADR-062 with full Context / Decision / Alternatives / Consequences / References sections.

## Consequences

Reserves ADR number to keep the corpus reference graph valid; promotion to Proposed/Accepted requires a future PR.

## References
- `docs/adr/ADR-058-action-and-signer-abstraction.md` §"Open items (tracked for follow-up ADRs)" — original ADR-062 placeholder
- `docs/adr/ADR-059-tx-submission-pipeline.md` §"Alternative D" — original `solana-mpp` rejected-alternative reference to ADR-062
- `docs/adr/ADR-017-x402-http-payment-relay.md` — current AEP payment-proof path
- `docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md` F-1 (dangling-ref backfill obligation)
