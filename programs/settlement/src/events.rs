use anchor_lang::prelude::*;

/// ADR-131 (sybil-cost calibration): off-chain consumers compute the
/// "median escrow value" trigger metric per token denomination. SOL and
/// USDC escrows have wildly different unit values, so the metric is only
/// meaningful when bucketed by `token_mint`. The on-chain `TaskEscrow`
/// account already carries `token_mint`; emitting it here closes the
/// missing-emission gap so the indexer no longer has to fetch the
/// account to disambiguate.
#[event]
pub struct EscrowCreated {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub provider: Pubkey,
    pub task_id: u64,
    pub total_amount: u64,
    pub deadline: i64,
    pub milestone_count: u32,
    pub token_mint: Pubkey,
}

#[event]
pub struct TaskAccepted {
    pub escrow: Pubkey,
    pub provider: Pubkey,
    pub task_id: u64,
}

#[event]
pub struct MilestoneSubmitted {
    pub escrow: Pubkey,
    pub provider: Pubkey,
    pub milestone_index: u32,
    pub task_id: u64,
}

#[event]
pub struct MilestoneApproved {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub milestone_index: u32,
    pub amount: u64,
    pub task_id: u64,
}

#[event]
pub struct MilestoneRejected {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub milestone_index: u32,
    pub task_id: u64,
}

#[event]
pub struct EscrowCompleted {
    pub escrow: Pubkey,
    pub provider: Pubkey,
    pub task_id: u64,
    pub total_released: u64,
}

#[event]
pub struct DisputeRaised {
    pub escrow: Pubkey,
    pub requester: Pubkey,
    pub task_id: u64,
}

#[event]
pub struct DisputeResolved {
    pub escrow: Pubkey,
    pub resolver: Pubkey,
    pub client_refund: u64,
    pub provider_refund: u64,
    pub task_id: u64,
}

#[event]
pub struct EscrowCancelled {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub task_id: u64,
    pub refunded_amount: u64,
}

#[event]
pub struct EscrowExpired {
    pub escrow: Pubkey,
    pub task_id: u64,
    pub refunded_amount: u64,
}

/// C4-OB-02 (cycle-4): emitted when `close_escrow` tears down a terminal
/// escrow. `residual_swept` is any dust/remainder that was forwarded to the
/// client's token account before the escrow ATA was `close_account`'d (it is
/// `0` on the normal drained-by-settlement path; a non-zero value flags an
/// unsolicited direct transfer into the escrow ATA that the close path
/// recovered). Indexers project this as the escrow lifecycle's final event.
#[event]
pub struct EscrowClosed {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub task_id: u64,
    pub residual_swept: u64,
}

// AUD-032 + AUD-001/002 (2026-04-25 audit): `ReputationUpdateScheduled`
// was emitted by `cpi::update_provider_reputation` after the synchronous
// CPI returned. The name implied async/queued semantics that don't exist;
// the Registry's own `ReputationDeltaProposed` event is the canonical
// signal and downstream indexers key off it. The Settlement-side emit
// was removed alongside the legacy `update_reputation` CPI (PR-G) to
// eliminate the double-event surface and keep Settlement out of the
// reputation-event business entirely.

/// Finding #19: emitted when `ProtocolConfig` is first created. The initial
/// values are a snapshot of the compile-time defaults.
#[event]
pub struct ProtocolConfigInitialized {
    pub authority: Pubkey,
    pub min_escrow_amount: u64,
    pub dispute_timeout_seconds: i64,
    pub reputation_delta_task_completed: i64,
    pub reputation_delta_dispute_loss: i64,
    pub reputation_delta_expiry_undelivered: i64,
}

/// Finding #19: emitted when `update_protocol_config` successfully mutates
/// the on-chain tunables. Indexers should key off this to drive dashboards.
#[event]
pub struct ProtocolConfigUpdated {
    pub authority: Pubkey,
    pub min_escrow_amount: u64,
    pub dispute_timeout_seconds: i64,
    pub reputation_delta_task_completed: i64,
    pub reputation_delta_dispute_loss: i64,
    pub reputation_delta_expiry_undelivered: i64,
}
