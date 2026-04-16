# AEAP — Autonomous Economic Agents Protocol

**Colosseum Frontier Hackathon 2026** | Solana / Anchor | Grand Champion Track

---

## What is AEAP?

AEAP is a three-program Solana protocol that enables AI agents to operate as autonomous economic actors. It provides the on-chain infrastructure for agents to hold funds under programmable policies, discover and evaluate each other through a reputation system, and transact using milestone-based escrow with built-in dispute resolution.

The entire protocol is accessible to any AI agent through a Model Context Protocol (MCP) server — meaning Claude, GPT, or any MCP-compatible agent can discover providers, negotiate tasks, lock funds in escrow, and settle payments without human intervention.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     MCP Server (TypeScript)                  │
│           20 tools · Input validation · Error handling        │
├──────────────┬──────────────────┬────────────────────────────┤
│  Agent Vault │  Agent Registry  │   Settlement Protocol      │
│   (Anchor)   │    (Anchor)      │       (Anchor)             │
│              │                  │                            │
│  Programmable│  Discovery &     │  Milestone-based escrow    │
│  wallets     │  reputation      │  with dispute resolution   │
│              │                  │                            │
│  invoke_signed ──────────────── │  invoke() ─── Registry     │
│  (CPI to any │                  │  (CPI reputation update)   │
│   program)   │                  │                            │
└──────────────┴──────────────────┴────────────────────────────┘
                         Solana (devnet / localnet)
```

---

## Programs

### 1. Agent Vault (`4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN`)

Programmable wallets that let agents hold and spend funds under configurable policies.

**Instructions:**

- `initialize_vault` — Create vault PDA with daily limits, per-tx limits, rate limiting
- `execute_transfer` — Send SOL within policy constraints
- `execute_program_call` — Real CPI via `invoke_signed` to any allowed program (vault PDA signs)
- `update_policy` — Modify spending limits and rate caps
- `add_token_allowlist` / `remove_token_allowlist` — Token whitelist management
- `add_program_allowlist` / `remove_program_allowlist` — Program whitelist management
- `pause_vault` / `resume_vault` — Emergency kill switch

**Key implementation details:**

- PDA bump stored on-chain for `invoke_signed` in cross-program calls
- Explicit lifetime annotations (`Context<'_, '_, 'info, 'info, ...>`) for `remaining_accounts` CPI pattern
- Scoped borrows to satisfy Rust's borrow checker with checks-effects-interactions
- Rate limiting with 1-hour sliding window
- Daily spending resets based on Unix day boundaries

**Source:** `programs/agent-vault/src/lib.rs` (848 lines)
**Tests:** 26 passing (`tests/agent-vault.ts`, 1,017 lines)

---

### 2. Agent Registry (`8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh`)

On-chain discovery and reputation system where agents register profiles with capabilities, pricing, and accepted tokens.

**Instructions:**

- `register_agent` — Create profile with name, description, category, capabilities, pricing model, accepted tokens
- `update_profile` — Modify agent metadata (blocked for Retired agents)
- `update_status` — Lifecycle transitions: Active ↔ Paused → Retired (terminal)
- `update_reputation` — CPI-only: called by Settlement program to update score, tasks completed, and earnings
- `deregister_agent` — Close account and reclaim rent

**Key implementation details:**

- Settlement program verified via `require_eq!(settlement_program.key(), SETTLEMENT_PROGRAM_ID)` + `#[account(executable)]`
- Reputation score (i64), tasks_completed (u64), total_earnings (u64) updated atomically via CPI
- Status machine enforces: Retired is terminal, no reactivation allowed
- Validation: name ≤ 64 bytes, description ≤ 256 bytes, 1–10 capabilities, 1–5 accepted tokens

**Source:** `programs/agent-registry/src/lib.rs` (567 lines)
**Tests:** 39 passing (`tests/agent-registry.ts`, 1,254 lines)

---

### 3. Settlement Protocol (`GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3`)

Milestone-based escrow that locks SPL tokens and releases them as milestones are approved, with full dispute resolution.

**Instructions:**

- `create_escrow` — Lock tokens into PDA-owned escrow with 1–5 milestones, deadline, optional resolver
- `accept_task` — Provider accepts (Created → Active)
- `submit_milestone` — Provider marks milestone for review (Pending → Submitted)
- `approve_milestone` — Client approves and releases funds (Submitted → Approved). On final milestone: auto-completes escrow + CPI to Registry for reputation update
- `reject_milestone` — Client rejects, sending back for rework (Submitted → Pending)
- `raise_dispute` — Either party disputes (Active → Disputed)
- `resolve_dispute` — Designated resolver splits funds (Disputed → Completed)
- `cancel_escrow` — Client cancels before acceptance (Created → Cancelled), full refund

**Key implementation details:**

- Real CPI to Registry: `update_provider_reputation` builds instruction manually with discriminator `sha256("global:update_reputation")[0..8]`, passes Settlement's own executable account for caller verification
- Checks-Effects-Interactions (CEI) pattern: scoped borrows separate state reads, state mutations, and CPI calls
- Escrow token account is an ATA owned by the escrow PDA
- Milestone amounts must sum exactly to total_amount; each must be > 0; total must be > 0
- Deadline must be in the future at creation time

**Source:** `programs/settlement/src/lib.rs` (1,039 lines)
**Tests:** 28 passing (`tests/settlement.ts`, 1,357 lines)

---

## Cross-Program Invocations (CPI)

Both CPI flows use real Solana `invoke()` / `invoke_signed()` — not stubs or event-based patterns.

### Settlement → Registry: `update_reputation`

When all milestones in an escrow are approved, the Settlement program calls Registry's `update_reputation` instruction via `invoke()`. This atomically updates the provider's reputation score (+50), tasks_completed (+1), and total_earnings. The Registry verifies the caller by checking `settlement_program.key() == SETTLEMENT_PROGRAM_ID` with an `#[account(executable)]` constraint.

### Vault → Any Program: `execute_program_call`

The vault can call any whitelisted program using `invoke_signed()` with the vault PDA as signer. The bump seed is stored in the Vault account at initialization and used to reconstruct the signer seeds: `[b"vault", authority.as_ref(), &[bump]]`. Target program and accounts are passed via `remaining_accounts`.

---

## MCP Server

A TypeScript MCP server exposes all three programs as 20 tools that any AI agent can invoke through the Model Context Protocol.

**Source:** `mcp-server/src/index.ts` (1,104 lines) + `solana.ts` (309 lines) + `tools.ts` (591 lines)
**Tests:** 21 passing (`mcp-server/test/mcp-handlers.test.ts`, 724 lines)

### Tools

| Program | Tools |
|---------|-------|
| Agent Vault | `create_vault`, `get_vault_info`, `vault_transfer`, `update_vault_policy`, `manage_allowlist`, `pause_vault`, `resume_vault` |
| Agent Registry | `register_agent`, `get_agent_profile`, `update_agent_profile`, `discover_agents` |
| Settlement | `create_escrow`, `get_escrow_status`, `accept_task`, `submit_milestone`, `approve_milestone`, `reject_milestone`, `raise_dispute`, `resolve_dispute`, `cancel_escrow` |

**Features:**

- Input validation helpers (`requireString`, `requireNumber`, `requirePositiveNumber`, `optionalString`)
- Automatic PDA derivation for all account lookups
- Full error propagation with Anchor error code mapping
- Wallet loaded from `ANCHOR_WALLET` environment variable

---

## Test Suite

**114 / 114 tests passing**

| Component | Tests | Source |
|-----------|-------|--------|
| Agent Registry | 39 | `tests/agent-registry.ts` |
| Agent Vault | 26 | `tests/agent-vault.ts` |
| Settlement Protocol | 28 | `tests/settlement.ts` |
| MCP Server | 21 | `mcp-server/test/mcp-handlers.test.ts` |

**Test categories covered:**

- Happy path (full lifecycle for each program)
- Validation (boundary checks, invalid inputs, constraint violations)
- Authorization (non-authority rejection for every protected instruction)
- State enforcement (invalid state transitions, terminal states)
- Cancellation and refund flows
- Dispute resolution with fund splitting
- Rejection → rework → re-approval cycle
- Cross-program CPI verification (reputation score changes on-chain)
- MCP tool integration with real on-chain transactions

---

## E2E Demo Script

`scripts/demo-e2e.ts` runs a full protocol walkthrough:

1. Fund demo accounts
2. Create a vault with spending policies and token allowlist
3. Register a client agent and provider agent in the Registry
4. Create a 2-milestone escrow (2 USDC)
5. Provider accepts → submits milestone 0 → client approves (0.8 USDC released)
6. Provider submits milestone 1 → client approves (1.2 USDC released)
7. Escrow auto-completes → CPI reputation update fires
8. Verify: provider reputation 0 → 50, earnings 0 → 2,000,000

**Run:** `npx ts-mocha -p ./tsconfig.json -t 120000 scripts/demo-e2e.ts`

---

## Interactive Dashboard

`dashboard.jsx` is a React artifact providing a visual overview of all three programs, their instructions, CPI flows, escrow state machine, and MCP tool catalog.

---

## File Structure

```
aeap/
├── programs/
│   ├── agent-vault/src/lib.rs        (848 lines)
│   ├── agent-registry/src/lib.rs     (567 lines)
│   └── settlement/src/lib.rs         (1,039 lines)
├── tests/
│   ├── agent-vault.ts                (1,017 lines, 26 tests)
│   ├── agent-registry.ts             (1,254 lines, 39 tests)
│   └── settlement.ts                 (1,357 lines, 28 tests)
├── mcp-server/
│   ├── src/
│   │   ├── index.ts                  (1,104 lines — MCP handlers)
│   │   ├── solana.ts                 (309 lines — Solana helpers)
│   │   └── tools.ts                  (591 lines — tool definitions)
│   └── test/
│       └── mcp-handlers.test.ts      (724 lines, 21 tests)
├── scripts/
│   └── demo-e2e.ts                   (399 lines — full lifecycle demo)
├── target/
│   ├── idl/
│   │   ├── agent_vault.json
│   │   ├── agent_registry.json
│   │   └── settlement.json
│   └── deploy/
│       ├── agent_vault.so
│       ├── agent_registry.so
│       └── settlement.so
├── dashboard.jsx                     (React dashboard artifact)
├── Anchor.toml
├── Cargo.toml
├── package.json
├── tsconfig.json
└── SUMMARY.md                        (this file)
```

**Total Rust:** ~2,454 lines across 3 programs
**Total TypeScript:** ~5,755 lines (tests + MCP server + demo)
**Total lines of code:** ~8,200+

---

## Technical Decisions & Patterns

| Decision | Rationale |
|----------|-----------|
| Anchor 0.30.1 with `--no-idl` build | IDL generation broken with newer Rust toolchains (`anchor-syn` `source_file()` incompatibility). IDLs maintained manually. |
| Explicit lifetime annotations for CPI | `Context<'_, '_, 'info, 'info, T<'info>>` required when accessing `remaining_accounts` in `invoke_signed` |
| Scoped borrows for CEI | Rust borrow checker requires `{...}` blocks to separate mutable state updates from immutable CPI account access |
| Manual CPI discriminator | Settlement builds Registry CPI manually with `sha256("global:update_reputation")[0..8]` to avoid circular Anchor dependencies |
| PDA bump storage | Vault stores bump at init to avoid recomputing in `invoke_signed` — a gas optimization and correctness requirement |
| `CARGO_TARGET_DIR` override | Moved build artifacts to `/sessions/.../target-aeap` to avoid disk space issues on mounted volumes |
| UncheckedAccount for CPI targets | `provider_profile` and `settlement_self` use `UncheckedAccount` since they're validated by the target program during CPI, not by Anchor constraints |

---

## Next Steps

### High Priority (Hackathon Submission)

1. **README.md** — Write a polished project README with setup instructions, architecture diagram, and quick-start guide for judges
2. **Demo video / recording** — Record the E2E demo script running with commentary explaining each phase
3. **Devnet deployment** — Deploy all 3 programs to Solana devnet and update program IDs
4. **Submission materials** — Prepare Colosseum submission form, project description, and team info

### Medium Priority (Polish)

5. **Error handling hardening** — Add more specific error messages in MCP server; map all Anchor error codes to human-readable strings
6. **IDL auto-generation fix** — Investigate `anchor-syn` patch or alternative IDL generation to eliminate manual IDL maintenance
7. **Rate limit window tests** — Add time-manipulation tests for vault rate limiting (currently only tests boundary, not window expiry)
8. **Escrow deadline enforcement** — Add instruction to claim refund after deadline passes without completion
9. **Client-side rating** — Implement `rate_provider` instruction so clients can set the rating field (currently hardcoded to 0 in CPI)

### Lower Priority (Post-Hackathon)

10. **Multi-token vault support** — Extend vault to hold and manage multiple SPL token accounts, not just SOL
11. **Vault CPI integration test** — End-to-end test that creates a vault, whitelists a program, and executes a real `execute_program_call` against it
12. **Agent discovery API** — Add filtered queries to MCP (by category, minimum reputation, price range)
13. **Governance / upgradeability** — Add program upgrade authority controls and parameter governance
14. **Audit preparation** — Security audit checklist: reentrancy, integer overflow, PDA collision, authority escalation
15. **Frontend dApp** — Build a web frontend for non-MCP users to interact with the protocol (Next.js + Wallet Adapter)

---

*Built by Alejandro for the Colosseum Frontier Hackathon (Apr 6 – May 11, 2026)*
*114 tests passing · 3 programs · 20 MCP tools · Real CPI verified on-chain*
