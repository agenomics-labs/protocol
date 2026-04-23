# ADR-054: Superseded — expiry-time settlement semantics + governance bounds merged into ADR-025 and ADR-075

## Status
Superseded (merged into ADR-025 and ADR-075)

## Date
2026-04-22 (backfill disposition)

## Context

ADR-054 was referenced in two separate audit documents under two different titles:

- `docs/ARCHITECTURE_REAUDIT_2026-04.md "Recommended next ADRs"`: **"Governance parameter bounds invariants"** — standardize upper/lower bound requirements for every numeric field on `ProtocolConfig`.
- `docs/ARCHITECTURE_DEEP_CRITIQUE.md §11`: **"Expiry-Time Settlement Semantics"** — submitted milestones on expiry are paid to the provider; slashing is removed or gated on "never submitted".

Neither proposal reached ADR status under the number 054. Both were addressed elsewhere before the number could be formally allocated:

**Expiry-time settlement semantics**: the decision to pay Submitted milestones on `expire_escrow` (rather than slash the provider) was made and implemented in `programs/settlement/src/instructions/escrow.rs:385-389`. The on-chain behavior is: if any milestone is in `Submitted` status at expiry, it is paid to the provider from the escrow balance; only milestones still in `Pending` are refunded to the client. This matches the economic equilibrium described in ARCHITECTURE_DEEP_CRITIQUE §11.1. The governing ADR is **ADR-025 (`expire-escrow-approved-milestones`, Accepted 2026-04-15)**, which covers approved-status handling; the Submitted-status handling rides on the same expire-pays-what-was-delivered doctrine and is validated by the `C1` check in ARCHITECTURE_REAUDIT_2026-04 "Verification notes".

**Governance parameter bounds**: the original reaudit ask — "standardize upper/lower bounds for every `ProtocolConfig` numeric field" — was narrowed and sharpened by Deep-Audit 2026-04-22 (Audit 1 finding #11) to a specific correctness bug: `reputation_delta_dispute_loss` unbounded on the low end lets `i64::MIN` through `update_protocol_config`, and `-(i64::MIN)` panics in the registry. The concrete fix is scoped by **ADR-075 (`protocol-config-delta-bounds`, drafted 2026-04-22 by a parallel audit-response track on `docs/adrs-sec-068-076`)**. Broader parameter-bound work is an optional follow-up with no mainnet-gating concern.

Audit 3 gap #12 flagged ADR-054 as "referenced but not present." Investigation confirms that the referenced decisions exist and are governed by the two ADRs above; ADR-054 itself is a numbering artifact of two competing proposals that were each absorbed without formal ADR-054 authorship.

## Decision

**Supersede ADR-054 by ADR-025 (expiry-time semantics) and ADR-075 (protocol-config delta bounds).** This ADR is a disposition stub; the substantive decisions live in the superseding ADRs.

## Consequences

- Preserves the audit trail: both original proposals are attributed to the ADRs that actually carry their decisions.
- No open architectural question remains under ADR-054.
- Does not gate mainnet — the expiry-time semantics are already live in production code and were verified clean (`C1` in REAUDIT); the delta-bounds fix lands with ADR-075's implementation PR.

## References
- `docs/adr/ADR-025-expire-escrow-approved-milestones.md` — expiry-time settlement doctrine (Accepted)
- `docs/adr/ADR-075-protocol-config-delta-bounds.md` — delta bounds on `ProtocolConfig` numeric fields (drafted concurrently on `docs/adrs-sec-068-076`)
- `docs/ARCHITECTURE_REAUDIT_2026-04.md "Recommended next ADRs"` — original governance-bounds proposal
- `docs/ARCHITECTURE_DEEP_CRITIQUE.md §11.1` — original expiry-time proposal
- `docs/adr/DEEP-AUDIT-2026-04-22.md` Audit 1 finding #11, Audit 3 gap #12 — current audit triggers
- `programs/settlement/src/instructions/escrow.rs:385-389` — live code implementing expire-time settlement
