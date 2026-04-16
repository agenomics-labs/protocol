# ADR-039: Fix C2/H2/H3 — Wire Slashing, Remove Dead AuditEntry, Add Unstake

## Status
Accepted

## Date
2026-04-16 05:15 UTC

## Context
ADR-037 (architecture deep audit) identified three related issues:

1. **C2 (Critical)**: The slashing logic in `update_reputation` (negative delta + failed task = slash) was unreachable in production. The only caller (`update_provider_reputation`) hardcoded `reputation_delta = 50` and `task_completed = true`. Dispute resolution and escrow expiry never called `update_reputation`.

2. **H2 (High)**: The `AuditEntry` account struct was defined but never instantiated by any instruction. Auditing is done via `emit!` events. The dead struct inflated the IDL.

3. **H3 (High)**: `stake_reputation` transferred SOL to a staking PDA but no `unstake_reputation` instruction existed. Staked SOL was locked permanently.

## Decision

### C2 Fix: Parameterize reputation CPI and wire into dispute resolution

`update_provider_reputation` now accepts `reputation_delta` and `task_completed` as parameters instead of hardcoding them:

```rust
fn update_provider_reputation(
    provider, earnings,
    reputation_delta: i64,    // was hardcoded 50
    task_completed: bool,     // was hardcoded true
    registry_program, provider_profile, settlement_authority, bump
)
```

**Call sites:**
- `approve_milestone` (all milestones complete): `delta = +50, task_completed = true` — rewards provider
- `resolve_dispute` (client got refund): `delta = -25, task_completed = false` — slashes provider, triggers `slash_count` increment in Registry

The `ResolveDispute` context now includes `registry_program`, `provider_profile`, and `settlement_authority` accounts for the CPI.

### H2 Fix: Remove AuditEntry

The dead `AuditEntry` struct was removed from `agent-vault/src/lib.rs`. Audit logging continues through events (`TransactionExecuted`, `ProgramCallExecuted`, `TokenTransferExecuted`).

### H3 Fix: Add unstake_reputation instruction

New `unstake_reputation(amount)` instruction in the Agent Registry:
- Transfers SOL from staking PDA back to the authority via lamport manipulation
- Validates `amount <= staked_amount`
- Suspended agents cannot unstake (prevents slash-then-flee)
- Emits `ReputationUnstaked` event

## Alternatives Considered

### C2 Alternative: Create separate `slash_reputation` instruction
Rejected — would require a separate CPI path and duplicate the Settlement->Registry authorization pattern. Parameterizing the existing function is simpler and maintains the single CPI channel.

### H3 Alternative: Cooldown timer on unstaking
Considered adding a `last_slashed_at` timestamp and requiring 7-day cooldown after last slash before unstaking. Deferred to a future ADR — the Suspended status check provides the core protection.

## Consequences

### Positive
- Slashing is now a live feature — disputed providers lose reputation and can be auto-suspended at 3 slashes
- Staked SOL is recoverable (agents will actually use staking now)
- Dead code removed from IDL and program
- Clear reward/punishment cycle: complete tasks = +50 rep, lose disputes = -25 rep + slash

### Negative
- `ResolveDispute` context now requires 3 additional accounts (registry_program, provider_profile, settlement_authority)
- MCP server's `handleResolveDispute` handler must be updated to pass these new accounts

## Files Changed
- `programs/settlement/src/lib.rs` — `update_provider_reputation` parameterized; slashing CPI added to `resolve_dispute`; `ResolveDispute` context expanded
- `programs/agent-vault/src/lib.rs` — `AuditEntry` removed; `execute_program_call` rewritten (ADR-038)
- `programs/agent-registry/src/lib.rs` — `unstake_reputation` instruction + `UnstakeReputation` context + `ReputationUnstaked` event + `InsufficientStake` error
