# ADR-036: External Audit Engagement

- **Status**: Accepted
- **Date**: 2026-04-15

## Context

AEAP consists of three Solana programs totaling 3,683 lines of Rust that manage agent wallets, identity/reputation, and escrow-based payment settlement. These programs handle real funds on mainnet. An internal security review (`docs/SECURITY_AUDIT.md`) identified 12 attack vectors across the three programs, including critical risks in CPI signing (V-A5), escrow fund flows (S-A1), and cross-program reputation updates (R-S1). Internal review alone is insufficient for a protocol managing user funds; an independent external audit is required before mainnet deployment.

## Decision

1. **Formal audit scope document**: Create `docs/AUDIT_SCOPE.md` formatted for submission to audit firms, containing:
   - In-scope: all 3 Solana programs (3,683 LoC, 25 instructions, 2 CPI paths)
   - Out-of-scope: MCP server, dashboard, integration plugins
   - Known issues with ADR references
   - Threat model summary from `SECURITY_AUDIT.md`
   - 14 critical invariants that must hold
   - Recommended auditors: OtterSec, Neodyme, Halborn, Trail of Bits
   - Timeline estimate: 6-9 weeks total engagement
   - Cost estimate: $40,000-$80,000 USD
   - Contact information template for engagement submission

2. **Auditor selection criteria**: Firms must have prior Solana Anchor audit experience, familiarity with PDA-signed CPI patterns, and experience with escrow/DeFi fund-flow audits.

3. **Pre-audit deliverables**: Source code, IDL files, test suite, architecture docs, all ADRs (001-027), SECURITY_AUDIT.md, and deployed devnet addresses will be provided to the selected auditor.

4. **Post-audit requirements**: All Critical and High findings must be remediated before mainnet deployment. Remediation requires re-review sign-off from the auditor.

## Alternatives Considered

1. **No external audit** -- Rely on internal review and bug bounty. Rejected; insufficient for a fund-handling protocol.
2. **Formal verification only** -- Use tools like Certora or Halmos. Rejected as primary approach; formal verification complements but does not replace manual expert review.
3. **Multiple concurrent auditors** -- Engage two firms simultaneously. Rejected for initial audit due to cost; consider for future upgrades.

## Consequences

- Mainnet deployment is gated on audit completion and remediation.
- Budget of $40,000-$80,000 must be allocated for the audit engagement.
- Timeline adds 6-9 weeks before mainnet readiness.
- Audit report (or a summary) should be published publicly for transparency.
- Identified findings may require code changes, potentially affecting other ADRs.
- The scope document provides a reusable template for future re-audits.

## Files Changed

- `docs/AUDIT_SCOPE.md` -- new formal audit scope document
