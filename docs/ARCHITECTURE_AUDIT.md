# Architecture Audit: AEAP (Agenomics Protocol)

**Date:** 2026-04-17
**Auditor:** Automated deep audit via Claude Code
**Scope:** Full codebase — on-chain programs, MCP server, off-chain services, testing, infrastructure

## Executive Summary

The AEAP is a Solana/Anchor protocol enabling autonomous AI agent commerce through three on-chain programs (Agent Vault, Agent Registry, Settlement), an MCP server bridge, off-chain services, and integration plugins. The codebase totals approximately 13,500 lines across Rust and TypeScript with 114 tests and 50 Architecture Decision Records.

**Overall assessment:** The protocol demonstrates strong architectural fundamentals — clean bounded contexts, comprehensive error handling, checked arithmetic, and excellent documentation discipline. However, this audit identified **32 findings** including 1 critical vulnerability, 6 high-severity issues, and 14 medium-severity concerns that should be addressed before mainnet deployment.

| Severity | Count |
|----------|-------|
| CRITICAL | 1 |
| HIGH | 6 |
| MEDIUM | 14 |
| LOW | 9 |
| INFORMATIONAL | 2 |
| **TOTAL** | **32** |

---

## Category 1: On-Chain Security Vulnerabilities

### S-01. `raise_dispute()` Allows Disputing Created/Completed Escrows [HIGH]

**File:** `programs/settlement/src/instructions.rs:289-290`

The `raise_dispute` function uses a denylist approach, only checking that the escrow is NOT in `Disputed` or `Expired` status:

```rust
require!(escrow.status != EscrowStatus::Disputed, SettlementError::AlreadyDisputed);
require!(escrow.status != EscrowStatus::Expired, SettlementError::EscrowExpired);
```

This permits disputes on `Created` (not yet accepted), `Completed` (already settled), and `Cancelled` (already refunded) escrows. Disputing a `Completed` escrow could overwrite terminal state; disputing a `Created` escrow griefs the provider before they accept.

**Fix:** Change to allowlist: `require!(escrow.status == EscrowStatus::Active, SettlementError::InvalidStatus)`.

---

### S-02. `ResolveDispute` Escrow Has No Structural Constraint [HIGH]

**File:** `programs/settlement/src/contexts.rs:168-169`

The escrow account in `ResolveDispute` has only `#[account(mut)]` — no `has_one`, no `seeds` constraint. While instruction-level checks verify the resolver matches `escrow.dispute_resolver` or `escrow.client`, the lack of structural constraints weakens defense-in-depth.

**Fix:** Add a comment documenting the intentional omission (the resolver is not a fixed field on the escrow in the way client/provider are), or add `constraint = escrow.status == EscrowStatus::Disputed` at the Anchor level.

---

### S-03. `provider_profile` Not Validated Against Escrow Provider [HIGH]

**Files:** `programs/settlement/src/contexts.rs:200-202, 243-245, 320-322`

In `ResolveDispute`, `ResolveDisputeTimeout`, and `ExpireEscrow`, the `provider_profile` is an `UncheckedAccount` with only a `mut` constraint. There is no verification that this account belongs to the escrow's actual provider.

The Registry's CPI validates that the profile is a valid AgentProfile PDA, but does NOT verify it corresponds to the escrow's provider. An attacker calling `resolve_dispute_timeout` (callable by anyone) could pass an innocent agent's profile, causing their reputation to be slashed.

**Fix:** Add constraint deriving the expected PDA:
```rust
#[account(
    mut,
    seeds = [escrow.provider.as_ref(), b"agent-profile"],
    bump,
    seeds::program = AGENT_REGISTRY_PROGRAM_ID
)]
pub provider_profile: UncheckedAccount<'info>,
```

---

### S-04. `ResolveDisputeTimeout` Escrow No Structural Constraint [MEDIUM]

**File:** `programs/settlement/src/contexts.rs:218-219`

Same issue as S-02 but for timeout resolution. Since `resolve_dispute_timeout` is callable by anyone (the `payer` is just the fee payer), the instruction logic is the sole gatekeeper. Compounds with S-03 to enable slashing the wrong provider.

---

### S-05. Vault `ExecuteTokenTransfer` No Mint Validation on Recipient [MEDIUM]

**File:** `programs/agent-vault/src/contexts.rs:112-113`

The `recipient_token_account` in `ExecuteTokenTransfer` has only `#[account(mut)]` — no constraint validating its mint matches the source. SPL Token program rejects mismatched mints during CPI, but the error is opaque rather than descriptive.

**Fix:** Add `constraint = recipient_token_account.mint == vault_token_account.mint`.

---

### S-06. `client_vault`/`provider_vault` Are Unvalidated UncheckedAccounts [LOW]

**File:** `programs/settlement/src/contexts.rs:16-20`

In `CreateEscrow`, vault references are stored but never validated on-chain. Currently informational-only, but dangerous if future instructions rely on them.

---

## Category 2: Off-Chain Security Vulnerabilities

### O-01. Hardcoded JWT Secret Fallback in x402 Relay [CRITICAL]

**File:** `src/x402-relay/index.ts:8`

```typescript
const JWT_SECRET = process.env.JWT_SECRET || "aeap-x402-dev-secret-change-in-production";
```

If the environment variable is unset, the relay uses a publicly known secret. Any attacker can forge JWT tokens, completely bypassing payment verification.

**Fix:** Remove the fallback. Crash on startup if `JWT_SECRET` is not set.

---

### O-02. x402 Relay Has No Replay Protection [HIGH]

**File:** `src/x402-relay/index.ts:151-192`

The `/pay` endpoint accepts a Solana transaction signature, verifies it, and issues a JWT. There is no tracking of already-used signatures. The same signature can be submitted repeatedly to generate unlimited tokens.

**Fix:** Track used signatures in a Set with TTL-based cleanup. Reject already-redeemed signatures.

---

### O-03. x402 Relay Has No Rate Limiting [MEDIUM]

**File:** `src/x402-relay/index.ts`

No rate limiting on any endpoint. Each `/pay` request triggers an on-chain RPC lookup. Vulnerable to DoS and economic attacks (RPC bill inflation).

---

### O-04. MCP Server Pervasive `as any` Casts [MEDIUM]

**File:** `mcp-server/src/index.ts` (35+ occurrences)

All account data access uses `(program.account as any).vault.fetch()`. All field reads use `(vault.policy as any).dailyLimitLamports.toNumber()`. Type safety is completely bypassed.

**Fix:** Generate typed IDL clients or create TypeScript interfaces matching the IDL schemas.

---

### O-05. `handleDiscoverAgents()` Fetches All Profiles to Memory [MEDIUM]

**File:** `mcp-server/src/index.ts:640`

```typescript
const allProfiles: any[] = await (program.account as any).agentProfile.all();
```

Downloads every `AgentProfile` account (up to 1243 bytes each) and filters in-memory. Will OOM or timeout at scale (10,000+ agents).

**Fix:** Use `getProgramAccounts` with memcmp filters, or serve discovery from the off-chain indexer.

---

### O-06. Indexer Event Parsing Uses Fragile String Matching [LOW]

**File:** `src/indexer/index.ts:55-105`

Events are detected by checking `if (log.includes("EscrowCreated"))` rather than proper Anchor event deserialization. Prone to false positives.

---

### O-07. Indexer Has No Backfill/Reconnect Mechanism [LOW]

**File:** `src/indexer/index.ts:150`

Uses `onLogs` WebSocket subscription with no reconnection handler. Events are silently lost on WebSocket drop or indexer restart.

---

## Category 3: Design Issues

### D-01. No Account Closure / Rent Reclamation for Escrows [HIGH]

**File:** `programs/settlement/src/contexts.rs` — all terminal-state contexts

Escrow accounts in terminal states (`Completed`, `Cancelled`, `Expired`) are never closed. Each escrow locks ~0.005 SOL in rent permanently. No `close = <target>` constraint exists.

**Fix:** Add a `CloseEscrow` instruction that can be called after an escrow reaches a terminal state. Use `close = client` to return rent.

---

### D-02. One Vault Per Authority / One Agent Per Authority [MEDIUM]

**Files:** Vault PDA seeds: `[b"vault", authority]`; Agent Profile PDA seeds: `[authority, b"agent-profile"]`

Each keypair can have exactly one vault and one agent profile. No multi-vault or multi-agent support.

---

### D-03. Escrow PDA Collision with User-Supplied `task_id` [MEDIUM]

**File:** `programs/settlement/src/contexts.rs:44`

Seeds `[b"escrow", client, provider, &task_id.to_le_bytes()]` use user-supplied `task_id`. Combined with D-01 (no closure), a used task_id can never be reused for the same client-provider pair.

---

### D-04. Hardcoded Reputation Deltas [MEDIUM]

**File:** `programs/settlement/src/instructions.rs:227, 397, 479, 650`

Magic numbers: +50 for completion, -25 for dispute, -25 for timeout, -10 for expiry. Not proportional to task value, not configurable without program redeployment.

---

### D-05. No Upgrade Authority Pattern / Global Config [LOW]

All protocol parameters (`MIN_ESCROW_AMOUNT`, `DISPUTE_TIMEOUT_SECONDS`, reputation deltas) are compile-time constants. Any change requires a program upgrade.

---

## Category 4: Code Quality

### Q-01. MCP `index.ts` God File at 1,278 Lines [MEDIUM]

**File:** `mcp-server/src/index.ts`

All 23 handler functions in one file. Violates the project's own 500-line rule (CLAUDE.md).

**Fix:** Split into `handlers/vault.ts`, `handlers/registry.ts`, `handlers/settlement.ts`.

---

### Q-02. `tools.ts` at 660 Lines [LOW]

**File:** `mcp-server/src/tools.ts`

Exceeds the 500-line project rule. Mostly static data but could be split by domain.

---

### Q-03. `instructions.rs` at 736 Lines [LOW]

**File:** `programs/settlement/src/instructions.rs`

Exceeds the 500-line rule. Could be split into `escrow_lifecycle.rs`, `dispute.rs`, `cpi_helpers.rs`.

---

### Q-04. `solana-v2.ts` Dead Code [LOW]

**File:** `mcp-server/src/solana-v2.ts`

228 lines imported by nothing. Migration incomplete per ADR-048.

---

## Category 5: Testing Gaps

### T-01. No Test for `resolve_dispute_timeout` [HIGH]

**File:** `tests/settlement.ts` — absent

Zero integration test coverage for timeout resolution. Combined with S-03, this is an untested vulnerability path.

---

### T-02. No Test for `expire_escrow` with Approved Milestones [MEDIUM]

The partial-refund path (some milestones approved, remaining split on expiry) is untested.

---

### T-03. No Negative Test for Self-Dealing [MEDIUM]

While `create_escrow` checks `client != provider`, no test validates the `SelfDealingProhibited` error fires correctly.

---

### T-04. No Tests for x402 Relay or Indexer [MEDIUM]

Both off-chain services have zero test coverage.

---

### T-05. MCP Handler Tests Require Live Validator [LOW]

**File:** `mcp-server/test/mcp-handlers.test.ts`

Tests connect to `localhost:8899` and require all three programs deployed. Environment-dependent and fragile.

---

## Category 6: Operational Gaps

### I-01. No CI/CD Pipeline [MEDIUM]

No `.github/workflows/` directory. No automated build/test/lint gates.

---

### I-02. No Linting Configuration [LOW]

No `.eslintrc`, `.prettierrc`, or similar. `npm run lint` referenced in CLAUDE.md has no backing tool.

---

### I-03. Indexer No Retry/Reconnect [LOW]

The `onLogs` WebSocket subscription has no reconnection handler.

---

### I-04. Dashboard Is Placeholder [INFORMATIONAL]

Single-file JSX component with no live data integration. Not production-ready.

---

## Additional Findings

### A-01. Token Daily Limit Uses SOL Limit for Tokens [MEDIUM]

**File:** `programs/agent-vault/src/instructions.rs:311`

`daily_limit_lamports` is used as the cap for per-token daily spending. For USDC (6 decimals), a 1 SOL limit (1B lamports) allows 1,000 USDC/day. Semantics are confusing and may not match intended risk profiles.

---

### A-03. Client Can Self-Resolve Disputes 100% in Their Favor [MEDIUM]

**File:** `programs/settlement/src/instructions.rs:319-321`

Without a `dispute_resolver`, the client can dispute and self-resolve taking all funds. The provider has no recourse.

---

### A-04. Staking PDA Not Initialized [LOW]

**File:** `programs/agent-registry/src/contexts.rs:79-85`

The `staking_pda` relies on implicit system program account creation. Minimum stake must exceed rent exemption.

---

### A-05. Fixed Escrow Space Allocation [INFORMATIONAL]

Escrow space fixed at 693 bytes (5 milestones max) wastes ~164 bytes for 1-milestone escrows.

---

## Strengths

1. **Clean bounded contexts** — 3 independent programs with one-way CPI (Settlement -> Registry)
2. **Checks-Effects-Interactions pattern** — `approve_milestone` follows gold-standard Solana reentrancy prevention
3. **Comprehensive custom error types** — All 3 programs have specific, actionable error enums
4. **Saturating/checked arithmetic** — No overflow vulnerabilities anywhere in the codebase
5. **Event-based audit trail** — Every state change emits a structured event (ADR-039)
6. **Anti-Sybil defense** — `MIN_ESCROW_AMOUNT` makes reputation farming economically costly
7. **Property-based fuzz testing** — proptest suites verify arithmetic invariants
8. **50 Architecture Decision Records** — Exceptional documentation discipline
9. **PDA-signed CPI** — `settlement_authority` verified by Registry via `seeds::program`
10. **Automatic agent suspension** — 3 slashes trigger `Suspended` status automatically
