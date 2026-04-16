# ADR-037: Full Architecture Deep Audit — Post-36 ADR Review

## Status
Accepted

## Date
2026-04-16 05:15 UTC

## Context
After implementing 36 ADRs covering security fixes, on-chain features, services, documentation, and production readiness, a comprehensive architecture audit was conducted. All three Solana programs, the MCP server, and supporting infrastructure were reviewed from a fresh read of current source code — not from memory of implementation.

### Codebase at Time of Audit

| Component | Lines | Instructions | Tests |
|-----------|-------|-------------|-------|
| Agent Vault | 1,340 | 11 | 24 unit |
| Agent Registry | 1,034 | 6 | 18 unit |
| Settlement | 1,431 | 10 | 16 unit |
| MCP Server | 2,172 | 20 tools | 31 integration |
| **Total** | **7,047** core | **27 on-chain** | **89 automated** |

Programs deployed on Solana devnet:
- Agent Vault: `4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN`
- Agent Registry: `8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh`
- Settlement: `GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3`

---

## Findings

### Strengths Confirmed

1. **CPI security model is solid** — PDA-signed CPI pattern (ADR-001/007) makes unauthorized reputation inflation cryptographically impossible. Settlement's `settlement_authority` PDA is verified by Registry via `seeds::program`.

2. **Escrow state machine is comprehensive** — Created -> Active -> Submitted -> Approved -> Completed, with dispute, cancel, expire, and timeout branches. Each transition is properly gated.

3. **Checks-Effects-Interactions consistently applied** — `approve_milestone` updates state before CPI transfers. `execute_program_call` snapshots balance before CPI and enforces limits after.

4. **Financial invariant holds** — `released_amount` is updated in all code paths: `approve_milestone`, `resolve_dispute`, `resolve_dispute_timeout`, and `expire_escrow`. `total_amount == sum(milestones)` enforced at creation.

5. **Defense-in-depth layering** — Anchor constraints (`has_one`, `seeds`, `constraint`) + handler-level checks + economic barriers (MIN_ESCROW, self-dealing prohibition, reputation staking).

---

### CRITICAL Findings

#### C1. `execute_program_call` vault PDA signs arbitrary CPIs — SPL token drain risk

**Location:** `programs/agent-vault/src/lib.rs`, `execute_program_call` handler

**Issue:** The post-CPI balance check (ADR-024) only measures SOL outflow. It does not track SPL token drains via the vault PDA's token accounts. An allowlisted program with a "transfer SPL from signer" instruction could drain all vault token accounts because the vault PDA is injected as signer in the CPI account metas.

**Impact:** Any allowlisted program can drain vault SPL tokens without limit.

**Recommendation:** Either (a) stop injecting vault PDA as signer in CPI account metas — require explicit authorization per CPI, or (b) snapshot all vault token account balances before/after CPI and enforce limits, or (c) remove `execute_program_call` entirely and require all financial operations through `execute_transfer` and `execute_token_transfer`.

#### C2. Slashing logic is dead code — no instruction path triggers it

**Location:** `programs/agent-registry/src/lib.rs:272-296`

**Issue:** The slashing logic (`reputation_delta < 0 && !task_completed`) in `update_reputation` only activates under specific conditions. But the only CPI caller (`update_provider_reputation` in settlement) hardcodes `reputation_delta = 50` and `task_completed = true`. Neither `resolve_dispute`, `resolve_dispute_timeout`, nor `expire_escrow` call `update_reputation`. The slashing mechanism exists in code but is unreachable in production.

**Impact:** Agents are never penalized for disputed or failed tasks. The `slash_count` and `Suspended` status are dead features.

**Recommendation:** Add `update_reputation` CPI calls in `resolve_dispute` (negative delta for provider) and `expire_escrow` (negative delta if milestones were submitted but not approved).

---

### HIGH Findings

#### H1. Account space calculation for AgentProfile likely incorrect

**Location:** `programs/agent-registry/src/lib.rs:573`

**Issue:** Space is `8 + mem::size_of::<AgentProfile>() + 500`. For structs with `Vec<T>` and `String`, `size_of` returns the stack size (pointer + length + capacity = 24 bytes each), not the serialized on-chain size. After adding `ReputationStake` (ADR-020), the comment says ~1,108 bytes but the actual serialized size with max-length fields could exceed the allocated space.

**Impact:** Registration may fail if an agent provides maximum-length fields (64-byte name + 256-byte description + 10 capabilities + 5 tokens).

**Recommendation:** Calculate space explicitly from serialized sizes or use Anchor's `#[account(realloc)]` pattern.

#### H2. `AuditEntry` account struct is dead code

**Location:** `programs/agent-vault/src/lib.rs:173-192`

**Issue:** The `AuditEntry` struct is defined with fields for on-chain audit logging, but no instruction in the vault program creates `AuditEntry` accounts. All auditing happens through `emit!` events. The struct inflates the IDL and confuses API consumers.

**Impact:** Dead code in IDL; no functional impact but creates false expectations.

**Recommendation:** Remove `AuditEntry` struct or implement an `create_audit_entry` instruction.

#### H3. No `unstake_reputation` instruction — staked SOL locked forever

**Location:** `programs/agent-registry/src/lib.rs:318-357`

**Issue:** `stake_reputation` transfers SOL from the authority to a staking PDA (`[authority, "reputation-stake"]`). There is no instruction to withdraw staked SOL. Even `deregister_agent` only closes the `AgentProfile` account — the staking PDA remains funded indefinitely.

**Impact:** Staked SOL is permanently locked. Agents will avoid staking if they know funds are irrecoverable.

**Recommendation:** Add `unstake_reputation(amount)` with a cooldown period (e.g., 7 days after last slash, minimum 24 hours after last stake).

#### H4. Vault authority check is redundant but inconsistent

**Location:** `programs/agent-vault/src/lib.rs` — `UpdatePolicy`, `ManageAllowlist`, `ManageProgramAllowlist`

**Issue:** These contexts use `seeds = [b"vault", authority.key().as_ref()]` which validates PDA derivation from the signer. The handlers also check `ctx.accounts.authority.key() == ctx.accounts.vault.authority` — this is redundant since the seed constraint already proves the relationship. However, if the vault struct stored a different `authority` than the PDA derivation seed (e.g., after an authority transfer), the handler check would be the only protection. Since there is no authority transfer instruction, this is currently safe but architecturally fragile.

**Recommendation:** Add explicit `has_one = authority` to these contexts for clarity and defense-in-depth.

---

### MEDIUM Findings

#### M1. `discover_agents` memcmp offset (998) is stale after ADR-020

**Location:** `mcp-server/src/index.ts`, `handleDiscoverAgents`

**Issue:** The status byte offset was calculated from the pre-ADR-020 `AgentProfile` layout. Adding `ReputationStake` (staked_amount: u64 + slash_count: u8 = 9 bytes + padding) shifted the `bump` field and potentially the status field offset. The memcmp filter is now silently matching on the wrong byte position.

**Impact:** Discovery queries may return incorrect results or no results.

**Recommendation:** Recalculate the offset from the current serialized layout, or remove the memcmp filter and filter client-side until an indexer replaces `getProgramAccounts`.

#### M2. No category string length validation

**Location:** `programs/agent-registry/src/lib.rs:36-59`

**Issue:** `register_agent` validates `name.len() <= 64` and `description.len() <= 256`, but `category` has no length check. A maliciously long category string could consume all remaining account space.

**Impact:** Account space exhaustion; agent profile becomes unmodifiable.

**Recommendation:** Add `require!(category.len() <= 50, ...)` matching the documented max in the size comment.

#### M3. `token_spend_records` grows without cleanup

**Location:** `programs/agent-vault/src/lib.rs`, `execute_token_transfer`

**Issue:** Each unique token mint creates a new `TokenSpendRecord` entry. Records for tokens removed from the allowlist remain in the vector indefinitely, consuming space.

**Impact:** Over time, the vault account's dynamic data grows toward the space limit.

**Recommendation:** Clear spend records when removing a token from the allowlist in `remove_token_allowlist`.

#### M4. New on-chain instructions have no integration tests

**Issue:** ADR-015 (`execute_token_transfer` with daily limits), ADR-020 (`stake_reputation`), ADR-028 (minimum escrow, self-dealing), and ADR-030 (`resolve_dispute_timeout`) were added with unit tests but no integration tests against a local validator.

**Impact:** Instruction argument serialization, account context wiring, and CPI behavior are untested in real transactions.

**Recommendation:** Extend `mcp-server/test/mcp-handlers.test.ts` with test sections for each new instruction.

#### M5. MCP tools file doesn't expose new instructions

**Location:** `mcp-server/src/tools.ts` — still exactly 20 tools

**Issue:** `stake_reputation`, `resolve_dispute_timeout`, and `execute_token_transfer` were added on-chain but have no corresponding MCP tool definitions. AI agents cannot access these features through the MCP interface.

**Impact:** New functionality is invisible to MCP consumers.

**Recommendation:** Add 3 new tool definitions: `stake_reputation`, `resolve_dispute_timeout`, `vault_token_transfer`.

---

### LOW Findings

#### L1. `disputed_at = 0` used as sentinel value

**Location:** `programs/settlement/src/lib.rs:88`

**Issue:** `disputed_at: 0` means "not disputed". Unix timestamp 0 (January 1, 1970) is technically valid. Use `Option<i64>` for proper null semantics.

#### L2. `avg_rating` uses truncating integer division

**Location:** `programs/agent-registry/src/lib.rs:265`

**Issue:** `(old_avg * (n-1) + rating) / n` truncates. Ratings 4, 5, 3 produce avg=3 instead of 4. Use `(old * (n-1) + new + n/2) / n` for rounding.

#### L3. Programs exceed CLAUDE.md 500-line limit

**Issue:** All three programs exceed 1,000 lines (vault: 1,340, registry: 1,034, settlement: 1,431). The CLAUDE.md says "Keep files under 500 lines."

**Recommendation:** Split into `instructions/`, `state/`, `errors/` modules per Anchor convention.

#### L4. `solana-v2.ts` compat layer is a stub

**Location:** `mcp-server/src/solana-v2.ts` (122 lines)

**Issue:** Exports address validation and amount conversion but lacks PDA derivation, RPC connection, keypair loading, or transaction building — the core functionality needed for actual web3.js v2 migration.

---

## Decision

Document all findings. Classify C1 and C2 as **must-fix before mainnet**. Classify H1-H4 as **should-fix before external audit**. Classify M1-M5 as **fix during next development cycle**. Classify L1-L4 as **fix opportunistically**.

### Priority Matrix

| ID | Severity | Effort | Priority | Action |
|----|----------|--------|----------|--------|
| C1 | Critical | Medium | **P0** | Remove vault PDA signing from `execute_program_call` or add token balance snapshots |
| C2 | Critical | Low | **P0** | Wire slashing CPI into dispute resolution + expiry |
| H1 | High | Low | P1 | Recalculate account space or use `realloc` |
| H2 | High | Low | P1 | Remove dead `AuditEntry` struct |
| H3 | High | Medium | P1 | Add `unstake_reputation` with cooldown |
| H4 | High | Low | P1 | Add `has_one = authority` to vault contexts |
| M1 | Medium | Low | P2 | Recalculate memcmp offset or remove filter |
| M2 | Medium | Low | P2 | Add `category.len() <= 50` check |
| M3 | Medium | Low | P2 | Clear spend records on allowlist removal |
| M4 | Medium | Medium | P2 | Extend integration tests |
| M5 | Medium | Low | P2 | Add 3 missing MCP tools |
| L1 | Low | Low | P3 | Use `Option<i64>` for `disputed_at` |
| L2 | Low | Low | P3 | Fix avg_rating rounding |
| L3 | Low | Medium | P3 | Split programs into modules |
| L4 | Low | Medium | P3 | Flesh out solana-v2.ts or remove |

## Consequences

### Positive
- Complete inventory of technical debt and security issues before external audit
- Clear prioritization enables focused remediation
- Findings documented for auditor reference

### Negative
- C1 and C2 are blocking issues that must be resolved before mainnet
- Several features shipped in ADR-015, ADR-020, ADR-028, ADR-030 are incomplete without corresponding integration tests and MCP tool exposure

## References
- SECURITY_AUDIT.md — Original threat model (pre-ADR-024 fixes)
- AUDIT_SCOPE.md — External audit scope document
- All 36 prior ADRs in docs/adr/
