# ADR-066: On-chain governance migration path — Reserved

## Status
Reserved (placeholder; decision deferred — see ADR-063 §9 and ADR-065 §"Open items" for trigger conditions)

## Date
2026-04-23

## Context

ADR-066 was reserved as a forward-looking placeholder by **ADR-063 (`sas-credential-authority-governance`, Accepted)** in §9 ("Why off-chain + on-chain execution, not fully on-chain governance"), at multiple cross-references throughout the same ADR (§3 "no proposal can modify its own thresholds … see ADR-066 in §9", §"Rejected alternatives" references, and §"Related ADRs" entry — *"On-chain governance upgrade path. If the protocol outgrows multisig-executed off-chain proposals — for example, if volume grows past ~100 proposals per year, or if token-weighted voting becomes desirable — this ADR lays out the migration from the current model to a full on-chain governance framework (Squads, Realms, or a custom program). Supersedes §2 and §3 of this ADR."*), and again by **ADR-065 (`caching-strategy`, Accepted)** in its "Open items / follow-up ADRs" section.

The audit trail in `docs/adr/ADR-056-not-written-x402-hardening-and-globalconfig.md` also names ADR-066 (or higher) as the future home of any on-chain governance / runtime-updatable `ProtocolConfig` decision should the v2 sketch in ADR-053 ever be promoted to a concrete proposal.

No live trigger exists today: governance volume is well below the ~100/year threshold, token-weighted voting is explicitly off the table per ADR-063, and the Squads v4 2-of-3 devnet substrate (ADR-078) plus the off-chain proposal venue (ADR-063 §2) are the operational governance for v1. Reserving the number keeps the corpus reference graph valid (5 cross-references in ADR-063 alone); promotion to Proposed/Accepted requires a future PR.

## Decision

**Reserved — not a decision.** This ADR holds slot 066 as a placeholder for a future on-chain governance migration decision. No technical decision is being made here. Triggers for promotion:

1. Governance proposal volume exceeds ~100/year (the threshold ADR-063 §9 names as the inflection point).
2. External stakeholders demand token-weighted voting on credential-authority changes.
3. The off-chain proposal venue (GitHub Discussions per ADR-063 §2) is censored, lost, or otherwise becomes unavailable, forcing a fully-on-chain audit-trail substrate.
4. AEP launches a governance token for any reason, at which point token-weighted voting becomes a discussion-worthy mechanism.

If any trigger fires, this ADR is superseded by a freshly-authored ADR-066 with full Context / Decision / Alternatives / Consequences / References sections, including explicit supersession of ADR-063 §2 and §3.

## Consequences

Reserves ADR number to keep the corpus reference graph valid; promotion to Proposed/Accepted requires a future PR.

## References
- `docs/adr/ADR-063-sas-credential-authority-governance.md` §3, §9, "Rejected alternatives", "Related ADRs" — five cross-references to ADR-066
- `docs/adr/ADR-065-caching-strategy.md` §"Open items / follow-up ADRs" — placeholder reference
- `docs/adr/ADR-053-compile-time-parameters.md` §"v2 Sketch" — adjacent runtime-updatable `ProtocolConfig` direction
- `docs/adr/ADR-056-not-written-x402-hardening-and-globalconfig.md` — investigation note that any governance migration lands at ADR-066+ in the numbering
- `docs/adr/ADR-078-program-upgrade-authority-transfer.md` — Squads v4 substrate currently in use
- `docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md` F-1 (dangling-ref backfill obligation)
