# AEAP Security Audit Preparation

**Protocol**: Agenomics Protocol
**Date**: 2026-04-15
**Version**: 1.0.0 (pre-audit)
**Chain**: Solana (Devnet, targeting Mainnet-Beta)
**Framework**: Anchor v0.30+

---

## Table of Contents

1. [Scope](#1-scope)
2. [Trust Boundaries](#2-trust-boundaries)
3. [Threat Model (STRIDE)](#3-threat-model-stride)
4. [Attack Surface per Program](#4-attack-surface-per-program)
5. [Critical Invariants](#5-critical-invariants)
6. [Known Mitigations](#6-known-mitigations)
7. [Recommended Audit Focus Areas](#7-recommended-audit-focus-areas)
8. [Audit-Ready Checklist](#8-audit-ready-checklist)

---

## 1. Scope

### 1.1 On-Chain Programs

| Program | Program ID | Instructions | Source |
|---------|-----------|-------------|--------|
| Agent Vault | `4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN` | 9 | `programs/agent-vault/src/lib.rs` |
| Agent Registry | `8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh` | 5 | `programs/agent-registry/src/lib.rs` |
| Settlement | `GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3` | 8 | `programs/settlement/src/lib.rs` |

**Agent Vault instructions**: `initialize_vault`, `update_policy`, `add_token_allowlist`, `remove_token_allowlist`, `add_program_allowlist`, `remove_program_allowlist`, `execute_transfer`, `execute_program_call`, `execute_token_transfer`, `pause_vault`, `resume_vault`

**Agent Registry instructions**: `register_agent`, `update_profile`, `update_status`, `update_reputation`, `deregister_agent`

**Settlement instructions**: `create_escrow`, `accept_task`, `submit_milestone`, `approve_milestone`, `reject_milestone`, `raise_dispute`, `resolve_dispute`, `cancel_escrow`, `expire_escrow`

### 1.2 Off-Chain Components

| Component | Source | Description |
|-----------|--------|-------------|
| MCP Server | `mcp-server/src/index.ts` | Tool dispatch and input validation for AI agents |
| Solana Client | `mcp-server/src/solana.ts` | Connection, wallet, PDA derivation, IDL loading |

### 1.3 Cross-Program Interactions

- **Settlement -> Agent Registry**: CPI call to `update_reputation` when all milestones are approved. Uses PDA-signed CPI pattern with `settlement_authority` PDA (seeds: `["settlement_authority"]`).
- **Agent Vault -> Arbitrary Programs**: CPI via `execute_program_call` to any program on the vault's program allowlist. Vault PDA signs the CPI.

---

## 2. Trust Boundaries

### 2.1 Trust Boundary Diagram

```
+------------------+      stdio/JSON       +------------------+
|                  | <-------------------> |                  |
|    AI Agent      |                       |   MCP Server     |
|  (untrusted)     |                       | (semi-trusted)   |
|                  |                       |                  |
+------------------+                       +--------+---------+
                                                    |
                                           RPC (JSON-RPC)
                                                    |
                                           +--------v---------+
                                           |                  |
                                           |  Solana Runtime  |
                                           |   (trusted)      |
                                           |                  |
                                           +--+------+-----+--+
                                              |      |     |
                                     +--------+  +---+  +--+--------+
                                     |           |      |           |
                                +----v----+ +----v---+ +v----------+
                                |  Agent  | |  Agent | | Settlement|
                                |  Vault  | |Registry| |  Program  |
                                +---------+ +--------+ +-----------+
```

### 2.2 Trust Relationships

| Boundary | Trust Level | Notes |
|----------|-------------|-------|
| AI Agent -> MCP Server | **Untrusted** | Agent input is arbitrary; MCP server must validate all parameters |
| MCP Server -> Solana RPC | **Semi-trusted** | MCP server holds the wallet keypair; RPC node is assumed honest |
| MCP Server -> On-chain Programs | **Wallet-authed** | Transactions signed by the agent's keypair; on-chain programs enforce policy |
| Settlement -> Registry (CPI) | **PDA-verified** | Settlement authority PDA must sign; Registry verifies seeds::program |
| Vault -> Target Program (CPI) | **Policy-gated** | Target must be on program allowlist; vault PDA signs |
| On-chain Programs -> Solana Runtime | **Trusted** | Runtime enforces account ownership, signer checks, rent |

### 2.3 Key Trust Assumptions

1. The Solana runtime correctly enforces signer verification, account ownership, and PDA derivation.
2. The MCP server's wallet keypair is stored securely on disk (not hardcoded, loaded from `~/.config/solana/id.json` or `SOLANA_KEYPAIR_PATH`).
3. The AI agent communicating via MCP is potentially adversarial -- it may attempt to craft malicious tool calls.
4. Anchor framework correctly enforces `has_one`, `seeds`, and `constraint` checks at deserialization time.
5. The RPC node returns honest data (relevant for off-chain reads used in MCP server logic).

---

## 3. Threat Model (STRIDE)

### 3.1 Agent Vault

| Threat | Category | Description | Severity | Current Mitigation |
|--------|----------|-------------|----------|-------------------|
| V-S1 | Spoofing | Attacker impersonates vault authority to execute transfers | Critical | PDA seeds include `authority.key()`; Anchor verifies signer matches seed derivation |
| V-S2 | Spoofing | Attacker impersonates agent identity to execute transfers | High | `execute_transfer` accepts either `vault.authority` or `vault.agent_identity` as signer |
| V-T1 | Tampering | Manipulate `spent_today_lamports` to bypass daily limit | Critical | State is on-chain; only program can write. Checked math with `saturating_add` |
| V-T2 | Tampering | Manipulate `rate_limit_window_start` to reset rate limit | High | Derived from `Clock::get()`; attacker cannot control on-chain clock |
| V-T3 | Tampering | Pass fraudulent `vault_account` in `ExecuteTransfer` | Critical | **FINDING**: `vault_account` is `UncheckedAccount` with no constraint tying it to `vault` PDA. Relies on lamport manipulation of the vault's own account info, but the `vault` account is validated by seeds. The transfer uses `vault_info` (the Vault account's AccountInfo) directly. See Attack Surface V-A4. |
| V-R1 | Repudiation | Agent denies performing a transfer | Medium | Audit log events emitted for all actions; on-chain and indexable |
| V-I1 | Info Disclosure | Vault balances and policies are publicly readable | Low | By design -- Solana accounts are public. No secrets stored on-chain |
| V-D1 | DoS | Spam `execute_transfer` with 0-amount to exhaust rate limit | Medium | `amount > 0` check prevents zero-amount transfers; rate limit still consumed per tx |
| V-D2 | DoS | Fill allowlist to MAX (10 entries) to prevent adding legitimate tokens | Low | Authority controls allowlist; attacker needs authority key |
| V-E1 | Elevation | Agent escalates from `agent_identity` to `authority` privileges | High | `update_policy`, `pause_vault`, `resume_vault`, and allowlist management require `authority` signer specifically |

### 3.2 Agent Registry

| Threat | Category | Description | Severity | Current Mitigation |
|--------|----------|-------------|----------|-------------------|
| R-S1 | Spoofing | Attacker calls `update_reputation` directly (not via Settlement CPI) | Critical | PDA-signed CPI pattern (ADR-001): `settlement_authority` must be signer with `seeds::program = SETTLEMENT_PROGRAM_ID` |
| R-S2 | Spoofing | Attacker modifies another agent's profile | High | `has_one = authority` constraint; PDA seeds include `authority.key()` |
| R-T1 | Tampering | Inflate reputation by completing many low-value tasks | Medium | Reputation delta is hardcoded at +50 per completion in Settlement; no value-weighted scaling |
| R-T2 | Tampering | Manipulate `avg_rating` via integer truncation in weighted average | Low | Running average uses integer division; truncation favors lower ratings slightly |
| R-R1 | Repudiation | Agent disputes their registered capabilities after accepting a task | Low | Profile state is on-chain with `updated_at` timestamps; events emitted on changes |
| R-I1 | Info Disclosure | Agent profiles (including earnings) are publicly visible | Low | By design for marketplace discovery |
| R-D1 | DoS | Sybil attack: register many cheap agent profiles to pollute discovery | Medium | Registration costs rent (~0.01 SOL); no minimum stake or verification requirement |
| R-D2 | DoS | Register agent with maximum-length strings to consume account space | Low | Bounded: name <= 64 bytes, description <= 256 bytes, capabilities <= 10, tokens <= 5 |
| R-E1 | Elevation | Retired agent reactivates themselves | Low | Status transition from Retired is blocked in `update_status` |

### 3.3 Settlement

| Threat | Category | Description | Severity | Current Mitigation |
|--------|----------|-------------|----------|-------------------|
| S-S1 | Spoofing | Non-provider submits milestone | High | `has_one = provider` constraint on `SubmitMilestone` |
| S-S2 | Spoofing | Non-client approves milestone to release funds | Critical | `has_one = client` constraint on `ApproveMilestone` |
| S-S3 | Spoofing | Unauthorized party resolves dispute | Critical | `resolve_dispute` checks `is_resolver || is_client` against escrow state |
| S-T1 | Tampering | Double-claim a milestone (approve same index twice) | Critical | Status check: `milestones[index].status == MilestoneStatus::Submitted` prevents re-approval of already-approved milestones |
| S-T2 | Tampering | Modify `total_amount` after escrow creation | High | Field set at creation; no instruction modifies it afterward |
| S-T3 | Tampering | Manipulate `released_amount` to exceed `total_amount` | Critical | `checked_add` used; sum of milestone amounts validated against total at creation |
| S-R1 | Repudiation | Client denies approving a milestone | Low | `MilestoneApproved` event emitted with client pubkey and amount |
| S-I1 | Info Disclosure | Escrow details (amounts, parties) publicly visible | Low | By design; task description stored as hash only |
| S-D1 | DoS | Provider never accepts task, locking client funds indefinitely | Medium | Client can call `cancel_escrow` while status is `Created` |
| S-D2 | DoS | Client never approves submitted milestones | Medium | Dispute mechanism exists; `expire_escrow` refunds client after deadline |
| S-D3 | DoS | Spam `raise_dispute` on active escrows | Low | Only client or provider can raise; already-disputed escrows rejected |
| S-E1 | Elevation | Dispute resolver colludes with provider to steal client funds | High | Resolver can split remaining funds arbitrarily; client can also resolve if no resolver set |
| S-E2 | Elevation | Provider submits milestone after deadline | Medium | `submit_milestone` checks `now <= escrow.deadline` |

---

## 4. Attack Surface per Program

### 4.1 Agent Vault

#### V-A1: Spending Policy Bypass

**Vector**: Circumvent `per_tx_limit_lamports` or `daily_limit_lamports`.

**Analysis**: The `execute_transfer` instruction performs validation in a read-only phase (Phase 1), executes the transfer in Phase 2, and updates state in Phase 3. The daily spending counter uses `saturating_add`, preventing overflow. The day boundary is computed as `unix_timestamp / 86400`, and the counter resets when the day changes.

**Risk**: An attacker could make a transfer at 23:59:59 UTC and another at 00:00:00 UTC, effectively doubling their daily limit within a 1-second window. This is inherent to daily-reset designs.

**Audit focus**: Verify that Phase 2 (lamport manipulation) and Phase 3 (state update) cannot be separated by a failed transaction that updates lamports but not state.

#### V-A2: Pause Bypass

**Vector**: Execute transfers while vault is paused.

**Analysis**: All three execution instructions (`execute_transfer`, `execute_program_call`, `execute_token_transfer`) check `!vault.paused` before proceeding. The pause check occurs before any state mutation or CPI.

**Risk**: Low. The check is explicit and early.

#### V-A3: Allowlist Bypass

**Vector**: Transfer a token not on the allowlist or invoke a non-allowlisted program.

**Analysis**: `is_token_allowed` and `is_program_allowed` return `true` when the respective allowlist is empty (permissive default). When populated, they require exact match via `Vec::contains`.

**Risk**: The permissive default (empty allowlist = all allowed) is by design but could surprise users who expect a deny-by-default posture. Once a single entry is added, the allowlist becomes restrictive.

**Audit focus**: Verify that removing the last item from an allowlist correctly returns to permissive mode, and that this behavior is intentional.

#### V-A4: Lamport Manipulation in execute_transfer

**Vector**: The `ExecuteTransfer` context includes a `vault_account: UncheckedAccount` that is used as the SOL source. However, the actual lamport subtraction occurs on `vault_info` (the Vault PDA's `AccountInfo`), not on `vault_account`.

**Analysis**: Looking at the code, `vault_info = ctx.accounts.vault.to_account_info()` is used for the lamport transfer. The `vault_account` field appears unused in the actual transfer logic. The vault PDA is validated by seeds, so the lamport source is the validated vault account.

**Risk**: The `vault_account` field is potentially vestigial and should be removed or properly constrained if used. Its current presence may confuse auditors.

**Audit focus**: Confirm `vault_account` is not used in any path that could redirect funds.

#### V-A5: execute_program_call -- Arbitrary CPI

**Vector**: The vault PDA signs arbitrary CPIs to allowlisted programs. The `remaining_accounts` pattern passes accounts without Anchor validation.

**Analysis**: The instruction verifies the target program is on the allowlist and that `remaining_accounts[0]` matches the declared `program_to_invoke` and is executable. The vault PDA is injected as signer for any account in the CPI that matches the vault key.

**Risk**: High. If a malicious program is on the allowlist, it can perform any action with the vault PDA as signer. The `remaining_accounts` are not validated by Anchor -- the target program must validate them.

**Audit focus**: Review all code paths where vault PDA signing could be abused. Verify that the `is_vault` check in account meta construction cannot be tricked by passing the vault key as a non-vault account.

#### V-A6: Token Transfer Missing Daily/Per-TX Limits

**Vector**: `execute_token_transfer` enforces rate limiting and pause checks but does NOT enforce `per_tx_limit_lamports` or `daily_limit_lamports` for SPL token transfers.

**Analysis**: Only SOL transfers in `execute_transfer` track daily spending. SPL token transfers only check rate limit (txs per hour), pause state, and token allowlist.

**Risk**: Medium. An agent could transfer unlimited SPL tokens per transaction as long as rate limits are not exhausted. This may be by design (SPL tokens have variable value) but should be documented.

**Audit focus**: Determine whether SPL token transfers should have independent spending limits.

### 4.2 Agent Registry

#### R-A1: Reputation Inflation

**Vector**: Self-dealing -- an agent creates escrows with itself (different keypairs) and completes them to farm reputation.

**Analysis**: The Settlement program does not check if `client == provider`. An attacker can create escrow as client with keypair A, accept and complete with keypair B (the agent), earning +50 reputation per cycle. Cost is token transfer fees plus rent.

**Risk**: Medium. Reputation score monotonically increases (saturating_add) with +50 per task. No decay mechanism, no stake-weighted scoring.

**Audit focus**: Assess economic viability of reputation farming. Recommend rate limiting or stake-weighted reputation.

#### R-A2: Sybil via Cheap Registration

**Vector**: Register many agents to dominate the discovery listing.

**Analysis**: Registration only costs account rent (~0.01 SOL). No minimum stake, no identity verification, no registration fee.

**Risk**: Medium. Discovery sorting by reputation mitigates this (sybil agents start at 0), but they can pollute category listings.

#### R-A3: Unauthorized Profile Modification

**Vector**: Modify another agent's profile.

**Analysis**: `UpdateProfile` context uses `has_one = authority` and PDA seeds `[authority.key(), b"agent-profile"]`. Both the authority signer check and PDA derivation must pass.

**Risk**: Low. Double-locked by `has_one` and PDA seeds.

#### R-A4: Average Rating Manipulation via Integer Truncation

**Vector**: The weighted average calculation uses integer division, which truncates. An attacker with a high average could strategically receive low ratings to manipulate the truncation.

**Analysis**: Formula: `new_avg = (old_avg * (n-1) + rating) / n`. With `u128` intermediate and `u8` final result (clamped to 5), truncation always rounds down. After many tasks, a single low rating has diminishing impact.

**Risk**: Low. The truncation bias is consistent and minimal.

### 4.3 Settlement

#### S-A1: Escrow Fund Theft

**Vector**: Drain the escrow token account without proper authorization.

**Analysis**: The escrow PDA is the authority over the escrow token account. Only instructions that derive the correct signer seeds can transfer from it: `approve_milestone`, `resolve_dispute`, `cancel_escrow`, `expire_escrow`. Each has appropriate authorization checks.

**Risk**: Low if PDA derivation and signer seeds are correct.

**Audit focus**: Verify that signer seeds used in `invoke_signed` exactly match the PDA derivation seeds in the `CreateEscrow` context.

#### S-A2: Milestone Double-Claim

**Vector**: Approve the same milestone twice to double-release funds.

**Analysis**: `approve_milestone` requires `milestones[index].status == MilestoneStatus::Submitted`. After approval, status becomes `Approved`. Second call fails the status check.

**Risk**: Low. State machine prevents re-entry.

**Audit focus**: Verify no race condition exists between the status check and the status update (Anchor serialization should prevent this within a single transaction).

#### S-A3: Deadline Bypass

**Vector**: Provider submits milestone after deadline to force payment.

**Analysis**: `submit_milestone` checks `now <= escrow.deadline`. However, `approve_milestone` does NOT check the deadline -- a client can approve a late submission if they choose.

**Risk**: Low. The deadline check on submission prevents provider abuse. Client voluntary approval after deadline is a feature.

#### S-A4: Dispute Resolver Collusion

**Vector**: A pre-designated dispute resolver colludes with the provider to award all remaining funds to the provider.

**Analysis**: `resolve_dispute` allows the resolver (or client) to split remaining funds arbitrarily between `client_refund` and `provider_refund`, as long as they sum to the remaining balance. There is no governance mechanism, no appeal, and no timeout on dispute resolution.

**Risk**: High. The resolver has unilateral power over remaining funds. If the resolver colludes with one party, the other has no recourse.

**Audit focus**: Consider requiring multi-sig resolution, time-locked resolution with appeal periods, or on-chain voting mechanisms.

#### S-A5: Client Griefing via Infinite Rejection

**Vector**: Client repeatedly rejects valid milestone submissions, preventing the provider from ever getting paid.

**Analysis**: `reject_milestone` sets status back to `Pending`, allowing re-submission. There is no limit on rejection cycles. The provider's only recourse is `raise_dispute`.

**Risk**: Medium. The dispute mechanism exists but requires a trusted resolver. If no resolver is set, only the client can resolve disputes (conflict of interest).

#### S-A6: Escrow Expiry Race Condition

**Vector**: `expire_escrow` is callable by anyone (`payer: Signer` is any account). An attacker could expire escrows at the exact deadline to steal partially-completed work.

**Analysis**: The expiry check is `now > escrow.deadline` and status must be `Active` or `Created`. Remaining funds go to client. This is by design -- the deadline is a hard cutoff. However, a provider may have submitted milestones that are awaiting approval when expiry fires.

**Risk**: Medium. Submitted-but-not-yet-approved milestones are lost on expiry. The provider loses work product and payment.

**Audit focus**: Consider whether submitted milestones should block expiry or trigger automatic dispute.

#### S-A7: Missing `released_amount` Update on Dispute Resolution

**Vector**: After `resolve_dispute`, the `released_amount` field is not updated with the `provider_refund`. This means `released_amount` does not reflect the total disbursed from the escrow.

**Analysis**: The `resolve_dispute` function sets `escrow.status = EscrowStatus::Completed` but does not update `released_amount`. Since the escrow is completed and no further operations are possible, this is a bookkeeping inconsistency rather than a fund-loss vulnerability.

**Risk**: Low. Affects off-chain accounting/indexing only.

---

## 5. Critical Invariants

The following properties must hold at all times. Violations indicate a critical vulnerability.

### 5.1 Settlement Invariants

| ID | Invariant | Verification |
|----|-----------|-------------|
| INV-S1 | `escrow.total_amount == sum(milestone.amount)` for all milestones at creation time | Checked in `create_escrow` via `require_eq!(total_milestone_amount, total_amount)` |
| INV-S2 | `escrow.released_amount <= escrow.total_amount` at all times | `released_amount` only increases via `checked_add` in `approve_milestone`; milestone amounts are a partition of `total_amount` |
| INV-S3 | `escrow_token_account.amount >= escrow.total_amount - escrow.released_amount` for active/created escrows | Token transfers use exact milestone amounts; `cancel_escrow` and `expire_escrow` transfer remaining balance |
| INV-S4 | Each milestone can only be approved once | Status must be `Submitted` for approval; approval changes status to `Approved` |
| INV-S5 | `resolve_dispute` refund split: `client_refund + provider_refund == total_amount - released_amount` | Checked via `require!(total_refund == remaining)` |

### 5.2 Vault Invariants

| ID | Invariant | Verification |
|----|-----------|-------------|
| INV-V1 | `vault.spent_today_lamports <= vault.policy.daily_limit_lamports` for the current day | Checked before every SOL transfer; counter resets on day boundary |
| INV-V2 | No single SOL transfer exceeds `vault.policy.per_tx_limit_lamports` | Checked in `execute_transfer` before transfer |
| INV-V3 | `vault.txs_in_current_window <= vault.policy.max_txs_per_hour` | Checked before all transfer/call instructions; window resets after 3600 seconds |
| INV-V4 | Paused vault blocks all transfers and program calls | `!vault.paused` checked in `execute_transfer`, `execute_program_call`, `execute_token_transfer` |
| INV-V5 | Only vault authority can modify policies, allowlists, or pause/resume state | `authority: Signer` in context + `require!(authority.key() == vault.authority)` |

### 5.3 Registry Invariants

| ID | Invariant | Verification |
|----|-----------|-------------|
| INV-R1 | Only Settlement authority PDA can update reputation | `settlement_authority` must be signer with `seeds::program = SETTLEMENT_PROGRAM_ID` |
| INV-R2 | Only profile authority can modify profile fields | `has_one = authority` + PDA seeds include `authority.key()` |
| INV-R3 | Retired status is terminal | `update_status` blocks `Retired -> Active` and `Retired -> Paused` transitions |
| INV-R4 | `avg_rating` is always in range `[0, 5]` | Clamped via `.min(5)` and input validated `rating <= 5` |

---

## 6. Known Mitigations

The following security improvements have already been implemented, documented in prior ADRs:

| ADR | Title | Threat Mitigated |
|-----|-------|-----------------|
| ADR-001 | CPI Caller Verification | R-S1: Direct `update_reputation` call from non-Settlement program. Replaced executable check with PDA-signed CPI pattern. |
| ADR-002 | Settlement Anchor Constraints | S-S1, S-S2: Added `has_one` constraints for provider/client authorization on all Settlement instructions. |
| ADR-003 | SPL Token Transfers | V-A5: Implemented vault PDA-signed CPI for SPL token transfers with token allowlist enforcement. |
| ADR-004 | Discover Agents memcmp | R-D1: Server-side filtering via RPC memcmp to reduce client-side data processing. |
| ADR-005 | Input Validation Consistency | MCP-level: All MCP server handlers validate required parameters with type checks and length bounds. |
| ADR-006 | Allowlist Size Caps | V-D2: Hard caps of 10 tokens and 10 programs in vault allowlists to prevent unbounded account growth. |
| ADR-007 | Settlement CPI Pattern | INV-R1: Settlement authority PDA pattern for cross-program reputation updates. |
| ADR-008 | Rust Unit Tests | All programs: Unit test coverage for policy logic, status transitions, arithmetic bounds. |
| ADR-009 | Edge Case Integration Tests | Cross-program: Integration tests for CPI flows, boundary conditions, error paths. |
| ADR-010 | Repo Cleanup | General: Removed unused code, dead imports, and vestigial account fields. |

---

## 7. Recommended Audit Focus Areas

Ordered by priority (critical first):

### Priority 1: Critical (Must audit)

1. **execute_program_call CPI signing** (V-A5): The vault PDA signs arbitrary CPIs to allowlisted programs. Verify that the `remaining_accounts` pattern cannot be abused to make the vault PDA sign unintended operations. Verify the `is_vault` signer injection logic.

2. **Settlement escrow fund flows** (S-A1, INV-S2, INV-S3): Trace all paths where tokens leave the escrow token account. Verify that `released_amount` accurately tracks disbursements and that no path allows extracting more than `total_amount`.

3. **CPI caller verification for update_reputation** (R-S1, INV-R1): Verify that the PDA-signed CPI pattern (ADR-001) is cryptographically sound and that no direct call can satisfy the signer + seeds::program constraints.

4. **execute_transfer lamport manipulation** (V-A4, V-T3): Verify that the direct lamport manipulation (`try_borrow_mut_lamports`) on the vault account cannot underflow or be separated from the state update. Confirm `vault_account` field is not exploitable.

### Priority 2: High

5. **Dispute resolution authorization** (S-A4, S-E1): Audit the resolver logic for collusion risks. Verify that the `is_resolver || is_client` check correctly handles the `Option<Pubkey>` for `dispute_resolver`.

6. **SPL token transfer missing spending limits** (V-A6): Determine if the lack of per-tx and daily limits on SPL token transfers is an intentional design choice or an oversight.

7. **Rate limit window reset logic**: Verify that the 3600-second window in vault rate limiting cannot be manipulated via clock skew or by timing transactions at window boundaries.

8. **Escrow expiry and submitted milestones** (S-A6): Review whether submitted-but-unapproved milestones should affect expiry behavior.

### Priority 3: Medium

9. **Reputation farming economics** (R-A1): Assess the cost of self-dealing reputation inflation and whether it undermines marketplace trust.

10. **Account size and reallocation**: Verify that dynamic `Vec` fields (allowlists, milestones, capabilities) cannot exceed allocated account space, causing Anchor serialization failures.

11. **MCP server input validation** (off-chain): Review all `requireString`, `requireNumber`, and `parsePublicKey` calls for injection or bypass. Verify that the MCP server cannot be tricked into constructing malicious transactions.

12. **Integer arithmetic across all programs**: Verify all `checked_add`, `checked_sub`, `saturating_add`, `saturating_sub` usage for correctness. Look for any unchecked arithmetic.

---

## 8. Audit-Ready Checklist

### 8.1 Code Freeze

| Item | Status | Notes |
|------|--------|-------|
| Feature freeze date set | Pending | No new instructions after freeze |
| All ADR-001 through ADR-010 changes merged | Done | Security improvements implemented |
| Program IDs finalized | Done | Vault, Registry, Settlement IDs set |
| Anchor version pinned | Pending | Pin exact Anchor version in Cargo.toml |
| Dependencies audited | Pending | Review all crate dependencies for known CVEs |

### 8.2 Test Coverage

| Item | Status | Notes |
|------|--------|-------|
| Unit tests for all instruction handlers | Done | ADR-008: policy, status transitions, arithmetic |
| Integration tests for happy paths | Done | ADR-009: escrow lifecycle, vault operations |
| Integration tests for error paths | Done | ADR-009: unauthorized access, limit violations |
| CPI integration tests (Settlement -> Registry) | Done | ADR-007: reputation update via CPI |
| Fuzz testing (e.g., trident, honggfuzz) | Pending | Recommended for input validation |
| Property-based testing for invariants | Pending | Test INV-S1 through INV-R4 with random inputs |

### 8.3 Documentation

| Item | Status | Notes |
|------|--------|-------|
| Architecture overview | Done | `docs/ARCHITECTURE.md` |
| ADR documents (001-010) | Done | `docs/adr/` |
| Security audit prep (this document) | Done | `docs/SECURITY_AUDIT.md` |
| IDL files generated | Pending | Run `anchor build` to generate `target/idl/*.json` |
| Instruction-level documentation | Done | Inline rustdoc comments in all lib.rs files |
| MCP server API documentation | Partial | Tool definitions in `mcp-server/src/tools.ts` |

### 8.4 Deployment Readiness

| Item | Status | Notes |
|------|--------|-------|
| Devnet deployment tested | Pending | All 3 programs deployed and tested end-to-end |
| Upgrade authority documented | Pending | Document who holds upgrade authority for each program |
| Multisig for upgrade authority | Pending | Recommended for mainnet |
| Monitoring and alerting | Pending | Set up event indexing for audit log events |
| Incident response plan | Pending | Define pause/freeze procedures for each program |
| Bug bounty program | Pending | Launch after audit completion |

### 8.5 Pre-Audit Deliverables to Audit Firm

1. This document (`SECURITY_AUDIT.md`)
2. All source code (programs + MCP server)
3. Generated IDL files (`target/idl/*.json`)
4. Full test suite with instructions to run
5. Architecture diagram (`docs/ARCHITECTURE.md`)
6. ADR documents (ADR-001 through ADR-019)
7. Deployed program addresses on devnet
8. List of known issues and accepted risks
