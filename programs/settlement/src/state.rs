use anchor_lang::prelude::*;

// ============================================================================
// CONSTANTS
// ============================================================================

/// Agent Registry program ID — used for CPI reputation updates.
pub const AGENT_REGISTRY_PROGRAM_ID: Pubkey = pubkey!("8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh");
pub const MAX_MILESTONES: usize = 5;

/// ADR-028: Minimum escrow amount to prevent cheap reputation farming.
/// Set to 10,000 base units (e.g., 0.01 USDC with 6 decimals).
/// Self-dealing attacks must lock at least this much per task, making
/// large-scale reputation inflation economically costly.
pub const MIN_ESCROW_AMOUNT: u64 = 10_000;

/// ADR-030: Dispute resolution timeout in seconds (7 days).
/// If the dispute resolver doesn't act within this window,
/// anyone can trigger auto-resolution that refunds the client.
pub const DISPUTE_TIMEOUT_SECONDS: i64 = 7 * 24 * 3600;

/// Reputation deltas for CPI updates to the Agent Registry.
/// Extracted as named constants to avoid magic numbers and enable future governance.
pub const REPUTATION_DELTA_TASK_COMPLETED: i64 = 50;
pub const REPUTATION_DELTA_DISPUTE_LOSS: i64 = -25;
pub const REPUTATION_DELTA_EXPIRY_UNDELIVERED: i64 = -10;

// ============================================================================
// ACCOUNT STRUCTS
// ============================================================================

#[account]
pub struct TaskEscrow {
    pub client: Pubkey,
    pub provider: Pubkey,
    pub client_vault: Pubkey,
    pub provider_vault: Pubkey,
    pub token_mint: Pubkey,
    pub total_amount: u64,
    pub released_amount: u64,
    pub milestones: Vec<Milestone>,
    pub status: EscrowStatus,
    pub task_id: u64,
    pub description_hash: [u8; 32],
    pub created_at: i64,
    pub deadline: i64,
    pub dispute_resolver: Option<Pubkey>,
    /// ADR-047: Timestamp when dispute was raised. None if not disputed.
    /// Uses Option<i64> instead of sentinel 0 for proper null semantics.
    pub disputed_at: Option<i64>,
    pub bump: u8,
}

#[derive(Clone, Debug, PartialEq, AnchorSerialize, AnchorDeserialize)]
pub struct Milestone {
    pub description_hash: [u8; 32],
    pub amount: u64,
    pub status: MilestoneStatus,
}

#[derive(Clone, Debug, PartialEq, AnchorSerialize, AnchorDeserialize)]
pub enum MilestoneStatus {
    Pending,
    Submitted,
    Approved,
    Rejected,
    Disputed,
}

impl std::fmt::Display for MilestoneStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MilestoneStatus::Pending => write!(f, "Pending"),
            MilestoneStatus::Submitted => write!(f, "Submitted"),
            MilestoneStatus::Approved => write!(f, "Approved"),
            MilestoneStatus::Rejected => write!(f, "Rejected"),
            MilestoneStatus::Disputed => write!(f, "Disputed"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, AnchorSerialize, AnchorDeserialize)]
pub enum EscrowStatus {
    Created,
    Active,
    Completed,
    Disputed,
    Cancelled,
    Expired,
}

impl std::fmt::Display for EscrowStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EscrowStatus::Created => write!(f, "Created"),
            EscrowStatus::Active => write!(f, "Active"),
            EscrowStatus::Completed => write!(f, "Completed"),
            EscrowStatus::Disputed => write!(f, "Disputed"),
            EscrowStatus::Cancelled => write!(f, "Cancelled"),
            EscrowStatus::Expired => write!(f, "Expired"),
        }
    }
}

// ============================================================================
// INSTRUCTION STRUCTS
// ============================================================================

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct MilestoneData {
    pub description_hash: [u8; 32],
    pub amount: u64,
}
