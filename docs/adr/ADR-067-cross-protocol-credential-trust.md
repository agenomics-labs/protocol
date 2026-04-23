# ADR-067: Cross-protocol credential trust — Reserved

## Status
Reserved (placeholder; decision deferred — see ADR-063 §"Related ADRs", ADR-064 §"Open items / follow-up ADRs", and ADR-065 §"Open items" for trigger conditions)

## Date
2026-04-23

## Context

ADR-067 was reserved as a forward-looking placeholder by three Accepted ADRs:

- **ADR-063 (`sas-credential-authority-governance`)** §"Related ADRs": *"Cross-protocol credential trust. Whether SAS attestations issued under AEP authorities are accepted by external protocols, and conversely, whether external-protocol SAS attestations are surfaced by the AEP resolver. This is a policy question about the `@agenomics/sas-resolver` (ADR-064) allowlist and is independent of the authority governance in this ADR."*
- **ADR-064 (`sas-resolver-package`)** §"Open items / follow-up ADRs": *"ADR-067 — cross-protocol credential trust, if external protocols want their credentials honored by the AEP resolver's default allowlist or vice versa."*
- **ADR-065 (`caching-strategy`)** §"Open items / follow-up ADRs": *"ADR-067: cross-protocol credential trust — how AEP resolvers handle SAS attestations signed by credential authorities from other protocols, including whitelist expansion governance."*

No live trigger exists today: the AEP `@agenomics/sas-resolver` v0.1.0 ships with a strictly internal allowlist (`AEP_PROTOCOL` only; `AEP_VALIDATORS` deferred per ADR-077), and no external protocol has formally requested AEP-credential honor or offered its credentials for AEP resolver inclusion. Reserving the number keeps the corpus reference graph valid (named explicitly by three accepted ADRs); promotion to Proposed/Accepted requires a future PR.

## Decision

**Reserved — not a decision.** This ADR holds slot 067 as a placeholder for a future cross-protocol credential-trust decision. No technical decision is being made here. Triggers for promotion:

1. An external Solana protocol (other than AEP) operates a SAS credential authority and requests resolver-level interop with AEP (either direction).
2. AEP-issued attestations need to be honored by an external reputation system, requiring a documented format / verification policy AEP commits to.
3. The default allowlist policy (per ADR-064) needs an explicit governance pathway for adding/removing third-party credential authorities, beyond the current "internal-only" stance.

If any trigger fires, this ADR is superseded by a freshly-authored ADR-067 with full Context / Decision / Alternatives / Consequences / References sections — including the policy interaction with ADR-063 (governance), ADR-064 (resolver allowlist mechanism), and ADR-076 (per-credential signer/schema binding).

## Consequences

Reserves ADR number to keep the corpus reference graph valid; promotion to Proposed/Accepted requires a future PR.

## References
- `docs/adr/ADR-063-sas-credential-authority-governance.md` §"Related ADRs" — original ADR-067 placeholder
- `docs/adr/ADR-064-sas-resolver-package.md` §"Open items / follow-up ADRs" — placeholder reference
- `docs/adr/ADR-065-caching-strategy.md` §"Open items / follow-up ADRs" — placeholder reference
- `docs/adr/ADR-061-sas-integration.md` §3 — credential-authority model that any cross-protocol trust would extend
- `docs/adr/ADR-076-sas-resolver-schema-credential-binding.md` — per-credential enforcement layer that any cross-protocol trust would compose with
- `docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md` F-1 (dangling-ref backfill obligation)
