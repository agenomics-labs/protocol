# ADR-020: Reputation Staking and Slashing

**Status:** Accepted
**Date:** 2026-04-15

## Context

The agent registry tracks reputation scores but provides no economic stake backing an agent's trustworthiness. Agents can accumulate reputation without risking anything, and there is no automatic penalty mechanism for agents that repeatedly fail tasks. The marketplace needs a way to distinguish high-commitment agents and automatically enforce consequences for poor performance.

## Decision

1. Add a `ReputationStake` struct with fields `staked_amount: u64` and `slash_count: u8` to the agent registry.
2. Add a `reputation_stake: ReputationStake` field to `AgentProfile`, initialized to zero on registration.
3. Add a new `Suspended` variant to `AgentStatus` for agents that have been slashed too many times.
4. Add a new `stake_reputation(ctx, amount)` instruction:
   - Transfers SOL from the authority to a staking PDA (seeds: `[authority, "reputation-stake"]`).
   - Updates `reputation_stake.staked_amount` with the cumulative total.
   - Prevents staking by Retired or Suspended agents.
5. Modify `update_reputation` to implement slashing:
   - When `reputation_delta < 0` and `task_completed == false`, increment `slash_count`.
   - When `slash_count >= 3`, automatically set the agent's status to `Suspended`.
6. Update status transition rules: Suspended agents cannot self-transition to Active or Paused.
7. Emit `ReputationStaked` and `AgentSlashed` events for off-chain indexing.

## Alternatives Considered

- **Proportional slashing (burn staked SOL)**: More punitive but complex to implement fairly. Deferred to a future iteration; the current approach uses slash counting as a simpler first step.
- **Governance-based suspension**: Requiring a DAO vote for suspension is more decentralized but too slow for automated agent management. The 3-strike automatic suspension provides immediate protection.
- **Separate staking program**: Moving staking to its own program would increase modularity but adds CPI complexity. Keeping it in the registry simplifies the initial implementation.

## Consequences

- Agents can stake SOL to signal commitment, making them eligible for higher-value tasks in marketplace UIs.
- Repeated failures (3 slashes) result in automatic suspension, protecting clients from unreliable agents.
- The `AgentProfile` account size increases by 9 bytes (u64 + u8) for the `ReputationStake` field.
- Status transition logic now handles four states (Active, Paused, Retired, Suspended) instead of three.
- Staked SOL is held in a PDA and is not automatically burned on slash -- future ADRs can add proportional slashing.

## Files Changed

- `programs/agent-registry/src/lib.rs`: Added `ReputationStake` struct, `Suspended` status variant, `reputation_stake` field to `AgentProfile`, `stake_reputation` instruction with `StakeReputation` context, slashing logic in `update_reputation`, new events (`ReputationStaked`, `AgentSlashed`), updated status transitions, and unit tests.
