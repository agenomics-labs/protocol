# AEAP External Audit Scope Document

**Protocol**: Agenomics Protocol
**Version**: 1.0.0 (pre-audit)
**Date**: 2026-04-15
**Chain**: Solana (Mainnet-Beta)
**Framework**: Anchor v0.30+
**Language**: Rust (on-chain), TypeScript (off-chain)

---

## 1. In-Scope: On-Chain Programs

### 1.1 Program Summary

| Program | Program ID | Source Path | Lines of Code | Instructions |
|---------|-----------|-------------|---------------|-------------|
| Agent Vault | `4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN` | `programs/agent-vault/src/lib.rs` | 1,340 | 11 |
| Agent Registry | `8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh` | `programs/agent-registry/src/lib.rs` | 1,034 | 5 |
| Settlement | `GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3` | `programs/settlement/src/lib.rs` | 1,309 | 9 |
| **Total** | | | **3,683** | **25** |

### 1.2 Agent Vault Instructions

| Instruction | Description | Critical |
|-------------|-------------|----------|
| `initialize_vault` | Create vault PDA with spending policies | Medium |
| `update_policy` | Modify daily/per-tx limits | Medium |
| `add_token_allowlist` | Add SPL mint to allowed list | Low |
| `remove_token_allowlist` | Remove SPL mint from allowed list | Low |
| `add_program_allowlist` | Add program ID to CPI allowlist | Medium |
| `remove_program_allowlist` | Remove program ID from CPI allowlist | Medium |
| `execute_transfer` | SOL transfer with policy enforcement | Critical |
| `execute_program_call` | Arbitrary CPI via vault PDA signing | Critical |
| `execute_token_transfer` | SPL token transfer via vault PDA | Critical |
| `pause_vault` | Emergency pause all vault operations | High |
| `resume_vault` | Resume paused vault | High |

### 1.3 Agent Registry Instructions

| Instruction | Description | Critical |
|-------------|-------------|----------|
| `register_agent` | Create agent profile PDA | Low |
| `update_profile` | Modify profile fields | Low |
| `update_status` | Change agent status (active/paused/retired) | Medium |
| `update_reputation` | CPI-only: called by Settlement program | Critical |
| `deregister_agent` | Remove agent profile | Low |

### 1.4 Settlement Instructions

| Instruction | Description | Critical |
|-------------|-------------|----------|
| `create_escrow` | Lock funds in escrow PDA for task | Critical |
| `accept_task` | Provider accepts task | Medium |
| `submit_milestone` | Provider submits completed milestone | Medium |
| `approve_milestone` | Client approves and releases funds | Critical |
| `reject_milestone` | Client rejects milestone submission | Medium |
| `raise_dispute` | Either party raises dispute | Medium |
| `resolve_dispute` | Resolver or client splits remaining funds | Critical |
| `cancel_escrow` | Client cancels before acceptance | High |
| `expire_escrow` | Refund client after deadline | High |

### 1.5 Cross-Program Interactions (CPI)

| CPI Path | Caller | Callee | Instruction | Authorization |
|----------|--------|--------|-------------|---------------|
| Settlement -> Registry | Settlement | Agent Registry | `update_reputation` | PDA-signed (`settlement_authority` seeds) |
| Vault -> Arbitrary | Agent Vault | Any allowlisted program | User-specified | Vault PDA signing |

---

## 2. Out of Scope

The following components are explicitly excluded from the audit scope:

| Component | Reason |
|-----------|--------|
| `mcp-server/` (TypeScript MCP server) | Off-chain code; does not affect on-chain security |
| `dashboard/` (Web dashboard) | UI only; no on-chain interactions |
| `integrations/` (ElizaOS, Solana Agent Kit, Goat plugins) | Wrapper code over MCP server |
| Test files (`tests/`, `scripts/*test*`) | Test infrastructure |
| Build tooling (`Cargo.toml`, `Anchor.toml`, `tsconfig.json`) | Configuration |
| Documentation (`docs/`) | Non-executable |

**Note**: While the MCP server is out of scope for the on-chain audit, we welcome informational findings about off-chain input validation if discovered during the review.

---

## 3. Known Issues and Mitigations

The following issues have been identified internally and documented in Architecture Decision Records. Auditors should verify the mitigations are correct and complete.

| ID | Issue | Severity | ADR | Mitigation Status |
|----|-------|----------|-----|-------------------|
| V-A4 | `vault_account` (UncheckedAccount) in `ExecuteTransfer` may be vestigial | Medium | ADR-010 | Reviewed; field not used in transfer logic |
| V-A5 | Vault PDA signs arbitrary CPI to allowlisted programs | High | ADR-003 | Allowlist enforcement; `remaining_accounts` unvalidated |
| V-A6 | SPL token transfers lack per-tx and daily spending limits | Medium | ADR-015 | By design; rate limiting only |
| R-A1 | Reputation farming via self-dealing (client == provider) | Medium | ADR-020 | No mitigation yet; staking planned |
| S-A4 | Dispute resolver has unilateral fund-split authority | High | -- | Accepted risk; resolver is optional |
| S-A6 | Escrow expiry ignores submitted-but-unapproved milestones | Medium | ADR-025 | Documented behavior |
| S-A7 | `released_amount` not updated on dispute resolution | Low | ADR-026 | Bookkeeping only; no fund loss |
| CPI-1 | CPI discriminator not verified in cross-program calls | Medium | ADR-014 | Anchor handles discriminator check |

### ADR Reference Index

| ADR | Title | Security Relevance |
|-----|-------|--------------------|
| ADR-001 | CPI Caller Verification | PDA-signed CPI pattern for `update_reputation` |
| ADR-002 | Settlement Anchor Constraints | `has_one` constraints for authorization |
| ADR-003 | SPL Token Transfers | Vault PDA-signed token CPI |
| ADR-005 | Input Validation Consistency | Off-chain validation patterns |
| ADR-006 | Allowlist Size Caps | 10-entry hard limit on allowlists |
| ADR-007 | Settlement CPI Pattern | Cross-program reputation updates |
| ADR-014 | CPI Discriminator Verification | Instruction discriminator checks |
| ADR-015 | Token Daily Limits | SPL token rate limiting design |
| ADR-024 | Scoped CPI Restrictions | Vault CPI security boundaries |

---

## 4. Threat Model Summary

A full threat model (STRIDE analysis) is provided in `docs/SECURITY_AUDIT.md`. Key highlights:

### 4.1 Trust Boundaries

```
AI Agent (untrusted) -> MCP Server (semi-trusted) -> Solana Runtime (trusted)
                                                        |
                                           Vault / Registry / Settlement
```

- AI agents are fully untrusted and may craft malicious inputs
- MCP server validates inputs but holds the signing keypair
- On-chain programs are the final enforcement layer

### 4.2 Highest-Risk Attack Vectors

| Vector | Program | Severity | Description |
|--------|---------|----------|-------------|
| V-A5 | Vault | Critical | Arbitrary CPI via `execute_program_call` with vault PDA signing |
| S-A1 | Settlement | Critical | Escrow fund theft via unauthorized token account access |
| R-S1 | Registry | Critical | Direct `update_reputation` call bypassing Settlement CPI |
| V-T3 | Vault | Critical | Fraudulent `vault_account` in `ExecuteTransfer` |
| S-E1 | Settlement | High | Dispute resolver collusion |

### 4.3 Trust Assumptions

1. Solana runtime correctly enforces signer verification and PDA derivation
2. Anchor framework correctly enforces `has_one`, `seeds`, and `constraint` checks
3. The deployer wallet and multi-sig keys are not compromised

---

## 5. Critical Invariants

The following properties must hold at all times. A violation of any invariant constitutes a critical vulnerability.

### Settlement Invariants

| ID | Invariant |
|----|-----------|
| INV-S1 | `escrow.total_amount == sum(milestone.amount)` at creation time |
| INV-S2 | `escrow.released_amount <= escrow.total_amount` at all times |
| INV-S3 | `escrow_token_account.amount >= escrow.total_amount - escrow.released_amount` for active escrows |
| INV-S4 | Each milestone can only transition to `Approved` once |
| INV-S5 | `resolve_dispute` refund split: `client_refund + provider_refund == total_amount - released_amount` |

### Vault Invariants

| ID | Invariant |
|----|-----------|
| INV-V1 | `vault.spent_today_lamports <= vault.policy.daily_limit_lamports` within a single day |
| INV-V2 | No single SOL transfer exceeds `vault.policy.per_tx_limit_lamports` |
| INV-V3 | `vault.txs_in_current_window <= vault.policy.max_txs_per_hour` |
| INV-V4 | Paused vault blocks all transfers and program calls |
| INV-V5 | Only vault authority can modify policies, allowlists, or pause/resume |

### Registry Invariants

| ID | Invariant |
|----|-----------|
| INV-R1 | Only Settlement authority PDA can call `update_reputation` |
| INV-R2 | Only profile authority can modify profile fields |
| INV-R3 | Retired status is terminal (no transition from Retired to Active/Paused) |
| INV-R4 | `avg_rating` is always in range `[0, 5]` |

---

## 6. Recommended Auditors

The following firms have relevant Solana and Anchor audit experience:

| Firm | Specialization | Notable Solana Audits | Website |
|------|---------------|----------------------|---------|
| **OtterSec** | Solana-native security | Marinade, Raydium, Phoenix, Tensor | [osec.io](https://osec.io) |
| **Neodyme** | Solana program security, exploit research | Multiple Solana Foundation grants | [neodyme.io](https://neodyme.io) |
| **Halborn** | Blockchain security, multi-chain | Solana ecosystem projects | [halborn.com](https://halborn.com) |
| **Trail of Bits** | Deep security research, formal methods | Cross-chain; Solana experience | [trailofbits.com](https://trailofbits.com) |

### Selection Criteria

- Prior Solana Anchor audit experience (required)
- Familiarity with PDA-signed CPI patterns
- Experience with escrow/DeFi fund-flow audits
- Availability within timeline

---

## 7. Estimated Timeline and Cost

### Timeline

| Phase | Duration | Description |
|-------|----------|-------------|
| Engagement setup | 1-2 weeks | NDA, scoping call, kickoff |
| Audit execution | 2-3 weeks | Code review, finding documentation |
| Report draft | 1 week | Initial findings report |
| Remediation | 1-2 weeks | Fix Critical and High findings |
| Re-review | 1 week | Verify fixes, finalize report |
| **Total** | **6-9 weeks** | |

### Cost Estimate

| Scope | Lines of Code | Estimated Cost (USD) |
|-------|---------------|---------------------|
| 3 Solana programs | 3,683 LoC | $40,000 - $80,000 |
| CPI interaction review | Cross-program flows | Included |
| Invariant verification | 14 invariants | Included |

**Notes**:
- Pricing varies significantly by firm and current demand
- Expedited timelines (< 4 weeks) may incur a premium
- Re-audit of remediated findings typically included in initial engagement
- Formal verification (if desired) would be an additional engagement

---

## 8. Contact Information

### Engagement Submission Format

When submitting to audit firms, include:

```
Subject: Audit Engagement Request - AEAP (Solana)

Protocol: Agenomics Protocol
Chain: Solana (Mainnet-Beta)
Framework: Anchor v0.30+
Language: Rust
Scope: 3 programs, 3,683 lines of Rust, 25 instructions
Timeline: Targeting mainnet deployment Q2 2026

Repository: [provide private repo access]
Documentation: docs/AUDIT_SCOPE.md, docs/SECURITY_AUDIT.md, docs/ARCHITECTURE.md

Primary Contact: [Name]
Email: [email]
Telegram/Signal: [handle]

Budget Range: $40,000 - $80,000 USD
Preferred Start: [date]
```

### Deliverables Expected from Auditor

1. **Findings report** with severity classification (Critical, High, Medium, Low, Informational)
2. **Executive summary** suitable for public disclosure
3. **Remediation guidance** for each finding
4. **Re-review confirmation** after fixes are applied
5. **Final report** suitable for public publishing (redacting sensitive details if needed)

### Deliverables Provided to Auditor

1. This scope document (`docs/AUDIT_SCOPE.md`)
2. Security audit preparation (`docs/SECURITY_AUDIT.md`)
3. Architecture overview (`docs/ARCHITECTURE.md`)
4. All ADR documents (`docs/adr/ADR-001` through `ADR-027`)
5. Full source code (programs + MCP server for context)
6. Generated IDL files (`target/idl/*.json`)
7. Complete test suite with run instructions
8. Deployed devnet program addresses
9. List of known issues and accepted risks (Section 3 above)
