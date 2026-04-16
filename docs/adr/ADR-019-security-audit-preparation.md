# ADR-019: Security Audit Preparation and Threat Model

## Status
Accepted

## Date
2026-04-15

## Context

The Agenomics Protocol is approaching its first external security audit. The protocol consists of three Solana programs (Agent Vault, Agent Registry, Settlement) and an off-chain MCP server that exposes these programs to AI agents. Together, these components manage real economic value: custodial vaults with spending policies, agent reputation scores that influence hiring decisions, and milestone-based escrow payments between autonomous agents.

Before engaging an audit firm, we need a comprehensive threat model, attack surface analysis, and audit-ready checklist to maximize the value of the engagement. The protocol handles SOL, SPL tokens, and reputation state that directly affects agent income -- any vulnerability could result in loss of funds or manipulation of the agent marketplace.

Prior ADRs (ADR-001 through ADR-010) have already addressed several security concerns discovered during development, including CPI caller verification (ADR-001), Anchor constraint hardening (ADR-002), SPL token transfer patterns (ADR-003), and input validation consistency (ADR-005). This ADR consolidates the security posture and identifies remaining areas requiring audit attention.

## Decision

We will produce a comprehensive security audit preparation document (`docs/SECURITY_AUDIT.md`) that covers:

1. **Full scope definition** -- all three on-chain programs plus the MCP server, with program IDs, instruction counts, and lines of code.

2. **Trust boundary analysis** -- mapping the trust relationships between AI agents, the MCP server, on-chain programs, and the Solana runtime.

3. **STRIDE threat model** -- systematic analysis of Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, and Elevation of Privilege for each program.

4. **Per-program attack surface enumeration** -- specific attack vectors for each instruction, focusing on:
   - Agent Vault: spending policy bypass, pause bypass, allowlist bypass, lamport manipulation
   - Agent Registry: reputation inflation, sybil attacks, unauthorized profile modification
   - Settlement: escrow fund theft, milestone double-claim, deadline manipulation, dispute resolver collusion

5. **Critical invariants** -- formal properties that must hold at all times, verifiable through on-chain state inspection.

6. **Audit focus recommendations** -- prioritized areas based on risk severity and likelihood.

7. **Audit-ready checklist** -- code freeze criteria, test coverage targets, and documentation completeness requirements.

The threat model follows the STRIDE framework because it is well-understood by Solana audit firms and provides systematic coverage of the attack categories most relevant to DeFi/agent protocols.

## Alternatives Considered

### 1. DREAD-based risk scoring
DREAD (Damage, Reproducibility, Exploitability, Affected users, Discoverability) was considered for risk prioritization. We chose STRIDE for threat identification but may layer DREAD scoring on top during the actual audit engagement.

### 2. Formal verification only (no manual audit)
Tools like Certora or Halmos could verify critical invariants mathematically. However, formal verification alone misses business logic issues, economic attacks, and cross-program interaction bugs. We will pursue formal verification as a complement to, not replacement for, manual audit.

### 3. Bug bounty without prior audit
Launching a bug bounty before a professional audit risks exposing unpatched vulnerabilities to adversarial researchers. The audit should come first, followed by a bug bounty program.

## Consequences

### Positive
- Audit firm receives a clear scope and threat model, reducing engagement time and cost
- Development team has a shared understanding of security assumptions and invariants
- Critical invariants become testable properties that can be monitored post-deployment
- The SECURITY_AUDIT.md document serves as living documentation for future audits

### Negative
- Preparing the audit document requires developer time that could be spent on features
- The threat model may create a false sense of completeness -- auditors should still explore beyond the documented surface
- Publicly documenting attack vectors (if the repo is public) could inform attackers before mitigations are deployed

### Risks
- The threat model is only as good as the team's understanding; novel attack vectors in the Solana runtime or Anchor framework may not be covered
- Economic attacks (e.g., oracle manipulation, MEV) are harder to model and may require specialized DeFi audit expertise
