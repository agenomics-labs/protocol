/**
 * Shared TypeScript types and enums mirroring the AEP on-chain program state.
 *
 * These definitions are hand-maintained to match the Rust source:
 *   - programs/agent-registry/src/state.rs  (AgentStatus, PricingModel)
 *   - programs/settlement/src/state.rs      (EscrowStatus, MilestoneStatus)
 *
 * When @agenomics/idl matures to include generated account types (ADR-099
 * follow-up), the Anchor-generated shapes will become the canonical source.
 * Until then, these enums are the off-chain contract for third-party builders.
 */

// ---------------------------------------------------------------------------
// agent-registry enums
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a registered agent.
 * Mirrors `AgentStatus` in programs/agent-registry/src/state.rs.
 */
export enum AgentStatus {
  Active = 0,
  Paused = 1,
  Retired = 2,
  Suspended = 3,
}

/**
 * Pricing model offered by a registered agent.
 * Mirrors `PricingModel` in programs/agent-registry/src/state.rs.
 *
 * Note: the on-chain enum variants are PerTask / PerHour / PerToken.
 */
export enum PricingModel {
  PerTask = 0,
  PerHour = 1,
  PerToken = 2,
}

// ---------------------------------------------------------------------------
// settlement enums
// ---------------------------------------------------------------------------

/**
 * High-level status of a TaskEscrow account.
 * Mirrors `EscrowStatus` in programs/settlement/src/state.rs.
 */
export enum EscrowStatus {
  Created = 0,
  Active = 1,
  Completed = 2,
  Disputed = 3,
  Cancelled = 4,
  Expired = 5,
}

/**
 * Status of an individual milestone within a TaskEscrow.
 * Mirrors `MilestoneStatus` in programs/settlement/src/state.rs.
 */
export enum MilestoneStatus {
  Pending = 0,
  Submitted = 1,
  Approved = 2,
  Rejected = 3,
  Disputed = 4,
}

// ---------------------------------------------------------------------------
// Reputation staking (agent-registry)
// ---------------------------------------------------------------------------

/**
 * Embedded reputation-staking data on AgentProfile.
 * Mirrors `ReputationStake` in programs/agent-registry/src/state.rs.
 */
export interface ReputationStake {
  stakedAmount: bigint;
  slashCount: number;
}
