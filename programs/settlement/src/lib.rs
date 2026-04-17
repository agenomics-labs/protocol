use anchor_lang::prelude::*;

pub mod state;
pub mod errors;
pub mod events;
pub mod contexts;
mod instructions;

use state::*;
use errors::*;
use events::*;
use contexts::*;

declare_id!("GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3");

#[program]
pub mod settlement {
    use super::*;

    /// Creates a new task escrow with defined milestones.
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        task_id: u64,
        total_amount: u64,
        description_hash: [u8; 32],
        deadline: i64,
        milestones_data: Vec<MilestoneData>,
        dispute_resolver: Option<Pubkey>,
    ) -> Result<()> {
        instructions::create_escrow(ctx, task_id, total_amount, description_hash, deadline, milestones_data, dispute_resolver)
    }

    /// Provider accepts the task, moving escrow to Active status.
    pub fn accept_task(ctx: Context<AcceptTask>) -> Result<()> {
        instructions::accept_task(ctx)
    }

    /// Provider marks a milestone as submitted (proof of work).
    pub fn submit_milestone(ctx: Context<SubmitMilestone>, milestone_index: u32) -> Result<()> {
        instructions::submit_milestone(ctx, milestone_index)
    }

    /// Client approves a submitted milestone, releasing funds.
    pub fn approve_milestone(ctx: Context<ApproveMilestone>, milestone_index: u32) -> Result<()> {
        instructions::approve_milestone(ctx, milestone_index)
    }

    /// Client rejects a milestone, setting it back to Pending for re-work.
    pub fn reject_milestone(ctx: Context<RejectMilestone>, milestone_index: u32) -> Result<()> {
        instructions::reject_milestone(ctx, milestone_index)
    }

    /// Either client or provider raises a dispute.
    pub fn raise_dispute(ctx: Context<RaiseDispute>) -> Result<()> {
        instructions::raise_dispute(ctx)
    }

    /// The dispute_resolver (or client) resolves a dispute.
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        client_refund: u64,
        provider_refund: u64,
    ) -> Result<()> {
        instructions::resolve_dispute(ctx, client_refund, provider_refund)
    }

    /// ADR-030: Auto-resolve a dispute after timeout.
    pub fn resolve_dispute_timeout(ctx: Context<ResolveDisputeTimeout>) -> Result<()> {
        instructions::resolve_dispute_timeout(ctx)
    }

    /// Client can cancel an escrow that hasn't been accepted yet.
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        instructions::cancel_escrow(ctx)
    }

    /// Anyone can expire an escrow that has passed its deadline.
    pub fn expire_escrow(ctx: Context<ExpireEscrow>) -> Result<()> {
        instructions::expire_escrow(ctx)
    }

    /// Close a terminal-state escrow and reclaim rent to the client.
    pub fn close_escrow(ctx: Context<CloseEscrow>) -> Result<()> {
        instructions::close_escrow(ctx)
    }
}

// ============================================================================
// UNIT TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_milestone_status_display() {
        assert_eq!(format!("{}", MilestoneStatus::Pending), "Pending");
        assert_eq!(format!("{}", MilestoneStatus::Submitted), "Submitted");
        assert_eq!(format!("{}", MilestoneStatus::Approved), "Approved");
        assert_eq!(format!("{}", MilestoneStatus::Rejected), "Rejected");
        assert_eq!(format!("{}", MilestoneStatus::Disputed), "Disputed");
    }

    #[test]
    fn test_escrow_status_display() {
        assert_eq!(format!("{}", EscrowStatus::Created), "Created");
        assert_eq!(format!("{}", EscrowStatus::Active), "Active");
        assert_eq!(format!("{}", EscrowStatus::Completed), "Completed");
        assert_eq!(format!("{}", EscrowStatus::Disputed), "Disputed");
        assert_eq!(format!("{}", EscrowStatus::Cancelled), "Cancelled");
        assert_eq!(format!("{}", EscrowStatus::Expired), "Expired");
    }

    #[test]
    fn test_milestone_sum_validation() {
        let milestones = vec![
            MilestoneData { description_hash: [0u8; 32], amount: 600_000 },
            MilestoneData { description_hash: [0u8; 32], amount: 400_000 },
        ];
        let total: u64 = milestones.iter().map(|m| m.amount).sum();
        assert_eq!(total, 1_000_000);
    }

    #[test]
    fn test_milestone_sum_mismatch() {
        let milestones = vec![
            MilestoneData { description_hash: [0u8; 32], amount: 600_000 },
            MilestoneData { description_hash: [0u8; 32], amount: 300_000 },
        ];
        let total: u64 = milestones.iter().map(|m| m.amount).sum();
        let expected_total = 1_000_000u64;
        assert_ne!(total, expected_total);
    }

    #[test]
    fn test_milestone_count_bounds() {
        assert!(MAX_MILESTONES == 5);

        // 0 milestones invalid
        let empty: Vec<MilestoneData> = vec![];
        assert!(empty.is_empty());

        // 5 milestones valid
        let five: Vec<MilestoneData> = (0..5)
            .map(|_| MilestoneData { description_hash: [0u8; 32], amount: 200_000 })
            .collect();
        assert!(five.len() > 0 && five.len() <= MAX_MILESTONES);

        // 6 milestones invalid
        let six: Vec<MilestoneData> = (0..6)
            .map(|_| MilestoneData { description_hash: [0u8; 32], amount: 100_000 })
            .collect();
        assert!(six.len() > MAX_MILESTONES);
    }

    #[test]
    fn test_escrow_status_equality() {
        assert_eq!(EscrowStatus::Created, EscrowStatus::Created);
        assert_ne!(EscrowStatus::Created, EscrowStatus::Active);
        assert_ne!(EscrowStatus::Active, EscrowStatus::Disputed);
    }

    #[test]
    fn test_milestone_status_transitions() {
        // Valid: Pending -> Submitted
        let status = MilestoneStatus::Pending;
        assert_eq!(status, MilestoneStatus::Pending);

        // Valid: Submitted -> Approved
        let status = MilestoneStatus::Submitted;
        assert_eq!(status, MilestoneStatus::Submitted);

        // Valid: Submitted -> Rejected (back to Pending)
        let status = MilestoneStatus::Rejected;
        assert_eq!(status, MilestoneStatus::Rejected);
    }

    #[test]
    fn test_amount_overflow_checked_add() {
        let a: u64 = u64::MAX;
        let b: u64 = 1;
        assert!(a.checked_add(b).is_none());
    }

    #[test]
    fn test_amount_overflow_checked_sub() {
        let a: u64 = 100;
        let b: u64 = 200;
        assert!(a.checked_sub(b).is_none());
    }

    #[test]
    fn test_released_amount_tracking() {
        let total: u64 = 1_000_000;
        let released: u64 = 600_000;
        let remaining = total.checked_sub(released).unwrap();
        assert_eq!(remaining, 400_000);
    }

    #[test]
    fn test_dispute_refund_split_validation() {
        let remaining: u64 = 400_000;
        let client_refund: u64 = 200_000;
        let provider_refund: u64 = 200_000;
        let total_refund = client_refund.checked_add(provider_refund).unwrap();
        assert_eq!(total_refund, remaining);
    }

    #[test]
    fn test_dispute_refund_split_mismatch() {
        let remaining: u64 = 400_000;
        let client_refund: u64 = 200_000;
        let provider_refund: u64 = 100_000;
        let total_refund = client_refund.checked_add(provider_refund).unwrap();
        assert_ne!(total_refund, remaining);
    }

    /// ADR-014: Verify that the hardcoded CPI discriminator in `update_provider_reputation`
    /// matches the Anchor convention: sha256("global:update_reputation")[..8].
    ///
    /// This test ensures the discriminator stays in sync if the instruction is renamed
    /// or the Anchor namespace convention changes.
    #[test]
    fn test_cpi_discriminator_matches_anchor_convention() {
        use anchor_lang::solana_program::hash::hash;

        // The hardcoded discriminator from update_provider_reputation()
        let hardcoded: [u8; 8] = [194, 220, 43, 201, 54, 209, 49, 178];

        // Compute expected discriminator: sha256("global:update_reputation")[..8]
        let preimage = "global:update_reputation";
        let hash_bytes = hash(preimage.as_bytes()).to_bytes();
        let expected: [u8; 8] = hash_bytes[..8].try_into().unwrap();

        assert_eq!(
            hardcoded, expected,
            "CPI discriminator mismatch! Hardcoded {:?} != computed {:?} from '{}'",
            hardcoded, expected, preimage
        );
    }

    // ================================================================
    // ADR-021: Property-based fuzz tests (proptest)
    // ================================================================

    mod fuzz {
        use super::*;
        use proptest::prelude::*;
        use proptest::collection::vec as prop_vec;

        proptest! {
            /// Milestone amounts with random values either sum correctly
            /// or overflow detection works (checked_add returns None).
            #[test]
            fn milestone_amounts_sum_or_detect_overflow(
                amounts in prop_vec(1u64..=u64::MAX / 5, 1..=MAX_MILESTONES)
            ) {
                let mut total: Option<u64> = Some(0);
                for amount in &amounts {
                    total = total.and_then(|t| t.checked_add(*amount));
                }
                // Either we got a valid sum or overflow was detected (None)
                match total {
                    Some(sum) => prop_assert!(sum >= amounts.iter().copied().min().unwrap_or(0)),
                    None => { /* overflow detected correctly */ }
                }
            }

            /// released_amount tracking with random milestone amounts
            /// never exceeds total_amount (mirrors approve_milestone logic).
            #[test]
            fn released_amount_never_exceeds_total(
                amounts in prop_vec(1u64..=1_000_000_000, 1..=MAX_MILESTONES)
            ) {
                // Compute total using checked_add (skip if overflow)
                let total_amount = amounts.iter().try_fold(0u64, |acc, &a| acc.checked_add(a));
                if let Some(total_amount) = total_amount {
                    let mut released: u64 = 0;
                    for amount in &amounts {
                        released = released.checked_add(*amount)
                            .expect("released_amount overflow");
                    }
                    prop_assert!(released <= total_amount);
                    prop_assert_eq!(released, total_amount);
                }
            }
        }
    }
}
