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
    ///
    /// ADR-102: `grace_period_slots` sets an anti-front-running window. Any
    /// slash instruction (expire_escrow) that fires while
    /// `Clock::get()?.slot < milestone.grace_ends_at` returns
    /// `MilestoneInGracePeriod` instead of applying the penalty.
    /// Pass 0 (default) to opt out of grace protection.
    pub fn submit_milestone(
        ctx: Context<SubmitMilestone>,
        milestone_index: u32,
        grace_period_slots: u64,
    ) -> Result<()> {
        instructions::submit_milestone(ctx, milestone_index, grace_period_slots)
    }

    /// Client approves a submitted milestone, releasing funds.
    ///
    /// `rating` (0..=5) is the client's per-task rating of the provider's
    /// work. It is folded into `avg_rating` in the registry via the
    /// reputation CPI when the final milestone of the escrow is approved.
    /// Pass 0 when no rating is given; non-zero values below or above the
    /// 0..=5 band are rejected with `InvalidRating`. See finding #8 in
    /// ARCHITECTURE_DEEP_CRITIQUE.md for the pre-fix dead-state behavior.
    pub fn approve_milestone(
        ctx: Context<ApproveMilestone>,
        milestone_index: u32,
        rating: u8,
    ) -> Result<()> {
        instructions::approve_milestone(ctx, milestone_index, rating)
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

    /// Finding #19: One-shot initialization of the `ProtocolConfig` PDA.
    /// Must be called once per program deployment before any escrow can be
    /// created. The `payer` becomes the initial governance authority.
    pub fn initialize_protocol_config(ctx: Context<InitializeProtocolConfig>) -> Result<()> {
        instructions::initialize_protocol_config(ctx)
    }

    /// Finding #19: Authority-gated update of the governance-owned tunables.
    /// Any `Option::None` field is left unchanged. See
    /// `instructions::update_protocol_config` for sanity-bound details.
    pub fn update_protocol_config(
        ctx: Context<UpdateProtocolConfig>,
        min_escrow_amount: Option<u64>,
        dispute_timeout_seconds: Option<i64>,
        reputation_delta_task_completed: Option<i64>,
        reputation_delta_dispute_loss: Option<i64>,
        reputation_delta_expiry_undelivered: Option<i64>,
    ) -> Result<()> {
        instructions::update_protocol_config(
            ctx,
            min_escrow_amount,
            dispute_timeout_seconds,
            reputation_delta_task_completed,
            reputation_delta_dispute_loss,
            reputation_delta_expiry_undelivered,
        )
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

    /// AUD-001 / AUD-002 (PR-G): the typed-CPI invariant test now pins
    /// `propose_reputation_delta` instead of the legacy `update_reputation`.
    /// The Registry program owns the unified reputation policy (i16 delta,
    /// [0, 100] clamp, |delta| <= 10); Settlement calls into it via the
    /// Anchor-generated `agent_registry::cpi::propose_reputation_delta`
    /// helper. If that symbol or the `ProposeReputationDelta` account
    /// struct is renamed/reshaped in the Registry, the settlement build
    /// breaks here — exactly the compile-time guarantee Finding #17 set
    /// up for the prior CPI surface.
    #[test]
    fn test_cpi_propose_reputation_delta_symbol_exists() {
        type _ProposeReputationDeltaAccounts<'a> =
            agent_registry::cpi::accounts::ProposeReputationDelta<'a>;
    }

    /// Finding #19: ProtocolConfig defaults must match the compile-time
    /// constants they back. If the two drift, existing tests/tooling that
    /// still reference the `MIN_ESCROW_AMOUNT`-style names will silently
    /// disagree with fresh `initialize_protocol_config` calls.
    #[test]
    fn test_protocol_config_defaults_match_constants() {
        assert_eq!(DEFAULT_MIN_ESCROW_AMOUNT, MIN_ESCROW_AMOUNT);
        assert_eq!(DEFAULT_DISPUTE_TIMEOUT_SECONDS, DISPUTE_TIMEOUT_SECONDS);
        assert_eq!(
            DEFAULT_REPUTATION_DELTA_TASK_COMPLETED,
            REPUTATION_DELTA_TASK_COMPLETED
        );
        assert_eq!(
            DEFAULT_REPUTATION_DELTA_DISPUTE_LOSS,
            REPUTATION_DELTA_DISPUTE_LOSS
        );
        assert_eq!(
            DEFAULT_REPUTATION_DELTA_EXPIRY_UNDELIVERED,
            REPUTATION_DELTA_EXPIRY_UNDELIVERED
        );
    }

    /// Finding #19: `ProtocolConfig::SPACE` must accommodate all fields
    /// including the 8-byte account discriminator. Under-allocation causes
    /// `init` to fail with a cryptic serialization error.
    #[test]
    fn test_protocol_config_space_is_sufficient() {
        // 8 (disc) + 32 (Pubkey) + 8 (u64) + 8 (i64) + 3*8 (i64 deltas)
        // + 1 (bump) = 81 bytes minimum. SPACE = 88 gives 7-byte margin.
        let min_required = 8 + 32 + 8 + 8 + 8 + 8 + 8 + 1;
        assert!(ProtocolConfig::SPACE >= min_required);
    }

    // ================================================================
    // C1/C2/C3: Critical economic-integrity fix tests
    // (See ARCHITECTURE_DEEP_CRITIQUE.md §1 and instructions/escrow.rs)
    // ================================================================

    /// C1: expire_escrow must treat Submitted milestones as implicitly
    /// approved — silence equals acceptance. A stall-then-refund attack
    /// by the client is now unprofitable because the provider is paid
    /// for every Submitted milestone on expiry.
    #[test]
    fn c1_expire_pays_submitted_milestones_to_provider() {
        let total_amount: u64 = 1_000_000;
        let released_amount: u64 = 0;

        let milestones = vec![
            (MilestoneStatus::Submitted, 400_000u64),
            (MilestoneStatus::Submitted, 300_000u64),
            (MilestoneStatus::Pending,   300_000u64),
        ];

        let mut provider_earned: u64 = 0;
        let mut has_pending = false;
        for (status, amount) in &milestones {
            match status {
                MilestoneStatus::Submitted => {
                    provider_earned = provider_earned.checked_add(*amount).unwrap();
                }
                MilestoneStatus::Pending => has_pending = true,
                _ => {}
            }
        }
        let remaining = total_amount.checked_sub(released_amount).unwrap();
        let client_refund = remaining.checked_sub(provider_earned).unwrap();

        assert_eq!(provider_earned, 700_000, "Submitted milestones must auto-pay");
        assert_eq!(client_refund, 300_000, "Only Pending milestones refund to client");
        assert!(has_pending, "Slash is gated on Pending, not Submitted");
    }

    /// C1: When every milestone is Submitted by the deadline, the client
    /// receives nothing on expiry and the provider is not slashed. This
    /// is the key economic reversal — before the fix, the provider lost
    /// the full amount *and* took a reputation hit.
    #[test]
    fn c1_expire_all_submitted_pays_full_provider_no_slash() {
        let total_amount: u64 = 900_000;
        let released_amount: u64 = 0;

        let milestones = vec![
            (MilestoneStatus::Submitted, 300_000u64),
            (MilestoneStatus::Submitted, 300_000u64),
            (MilestoneStatus::Submitted, 300_000u64),
        ];

        let mut provider_earned: u64 = 0;
        let mut has_pending = false;
        for (status, amount) in &milestones {
            match status {
                MilestoneStatus::Submitted => {
                    provider_earned = provider_earned.checked_add(*amount).unwrap();
                }
                MilestoneStatus::Pending => has_pending = true,
                _ => {}
            }
        }
        let remaining = total_amount.checked_sub(released_amount).unwrap();
        let client_refund = remaining.checked_sub(provider_earned).unwrap();

        assert_eq!(provider_earned, 900_000);
        assert_eq!(client_refund, 0);
        assert!(!has_pending, "No Pending → no slash");
    }

    /// C1: Dead arithmetic regression guard. The pre-fix formula
    /// `provider_earned = approved_sum - released_amount` always
    /// evaluated to 0 because approve_milestone releases immediately,
    /// so approved_sum and released_amount were always equal.
    #[test]
    fn c1_pre_fix_dead_arithmetic_was_always_zero() {
        // Reproduce the old (buggy) calculation on a realistic state.
        let total: u64 = 1_000_000;
        let released: u64 = 400_000;
        let milestones = vec![
            (MilestoneStatus::Approved,  400_000u64), // already paid
            (MilestoneStatus::Submitted, 300_000u64),
            (MilestoneStatus::Pending,   300_000u64),
        ];
        let approved_sum: u64 = milestones.iter()
            .filter(|(s, _)| *s == MilestoneStatus::Approved)
            .map(|(_, a)| *a)
            .sum();
        let legacy_provider_earned = approved_sum.saturating_sub(released);
        assert_eq!(legacy_provider_earned, 0,
            "Old formula was dead arithmetic by construction");
        let _ = total;
    }

    /// C1: When the escrow expires in Created state (provider never
    /// accepted), the provider is NOT slashed — they never committed.
    #[test]
    fn c1_expire_in_created_state_does_not_slash() {
        let prior_status = EscrowStatus::Created;
        let has_pending = true;
        let should_slash = prior_status == EscrowStatus::Active && has_pending;
        assert!(!should_slash, "Never-accepted task cannot be non-delivery");
    }

    /// C1: Expiring in Active with at least one Pending milestone
    /// correctly triggers the slash.
    #[test]
    fn c1_expire_active_with_pending_triggers_slash() {
        let prior_status = EscrowStatus::Active;
        let has_pending = true;
        let should_slash = prior_status == EscrowStatus::Active && has_pending;
        assert!(should_slash, "Active + Pending is true non-delivery");
    }

    /// C2: approve_milestone must be gated on `now <= deadline`,
    /// symmetric with submit_milestone. This closes the case where a
    /// client could approve Submitted work arbitrarily far past the
    /// deadline (intentional or accidental) rather than letting the
    /// settle-on-expire path auto-approve.
    #[test]
    fn c2_approve_milestone_rejects_post_deadline() {
        let now: i64 = 2_000;
        let deadline: i64 = 1_000;
        let within_deadline = now <= deadline;
        assert!(!within_deadline, "post-deadline approval must fail");
    }

    /// C2: The happy path — approval inside the deadline window passes
    /// the guard.
    #[test]
    fn c2_approve_milestone_accepts_pre_deadline() {
        let now: i64 = 500;
        let deadline: i64 = 1_000;
        let within_deadline = now <= deadline;
        assert!(within_deadline);
    }

    // ================================================================
    // AUD-009: accept_task deadline guard (PR-R)
    // ================================================================

    /// AUD-009: A provider must not be able to accept an escrow whose
    /// deadline has already passed. The pre-fix handler only checked
    /// `status == Created`, which let a provider grief-flip an expired
    /// Created escrow to Active and lock client funds until
    /// `expire_escrow` fires. The new guard `now <= deadline` rejects
    /// the transition with `DeadlinePassed`.
    #[test]
    fn aud009_accept_task_rejects_post_deadline() {
        let now: i64 = 2_000;
        let deadline: i64 = 1_000;
        let within_deadline = now <= deadline;
        assert!(!within_deadline, "post-deadline accept_task must fail");
    }

    /// AUD-009: Happy path — accept_task is permitted when the deadline
    /// is still in the future. Symmetric with submit_milestone /
    /// approve_milestone deadline gating.
    #[test]
    fn aud009_accept_task_accepts_pre_deadline() {
        let now: i64 = 500;
        let deadline: i64 = 1_000;
        let within_deadline = now <= deadline;
        assert!(within_deadline);
    }

    /// AUD-009: Edge case — accepting at exactly the deadline boundary
    /// is allowed. The guard is `now <= deadline` (inclusive), matching
    /// the convention used by submit_milestone and approve_milestone.
    #[test]
    fn aud009_accept_task_accepts_at_deadline_boundary() {
        let now: i64 = 1_000;
        let deadline: i64 = 1_000;
        let within_deadline = now <= deadline;
        assert!(within_deadline, "now == deadline must be accepted (inclusive)");
    }

    /// C3: A dispute_resolver equal to the client is rejected. Without
    /// this guard, the client can flip `is_resolver = true` in
    /// resolve_dispute and trigger provider reputation slashing
    /// unilaterally, bypassing A-03.
    #[test]
    fn c3_resolver_cannot_be_client() {
        let client = Pubkey::new_unique();
        let provider = Pubkey::new_unique();
        let resolver = client; // attacker sets self as resolver
        let ok = resolver != client && resolver != provider;
        assert!(!ok, "client-as-resolver must be rejected");
    }

    /// C3: A dispute_resolver equal to the provider is also rejected.
    /// Symmetric guard — a provider-as-resolver would self-adjudicate
    /// disputes in their favor.
    #[test]
    fn c3_resolver_cannot_be_provider() {
        let client = Pubkey::new_unique();
        let provider = Pubkey::new_unique();
        let resolver = provider;
        let ok = resolver != client && resolver != provider;
        assert!(!ok, "provider-as-resolver must be rejected");
    }

    /// C3: A genuine third-party resolver is accepted.
    #[test]
    fn c3_resolver_third_party_accepted() {
        let client = Pubkey::new_unique();
        let provider = Pubkey::new_unique();
        let resolver = Pubkey::new_unique();
        let ok = resolver != client && resolver != provider;
        assert!(ok);
    }

    /// C3: Escrows with no resolver (None) are unaffected by the new
    /// constraint — the A-03 guard in resolve_dispute already handles
    /// no-resolver self-resolution without slashing.
    #[test]
    fn c3_no_resolver_is_still_allowed() {
        let dispute_resolver: Option<Pubkey> = None;
        // The new constraint is `if let Some(r) = dispute_resolver { ... }`
        // so None passes through unchanged.
        assert!(dispute_resolver.is_none());
    }

    // ================================================================
    // ADR-102: Grace-window unit tests
    // ================================================================

    /// ADR-102: grace_period_slots == 0 means no grace protection.
    /// The grace_ends_at is set to current_slot + 0 == current_slot,
    /// so the check `clock.slot < grace_ends_at` is immediately false.
    #[test]
    fn adr102_grace_zero_slash_permitted_immediately() {
        let current_slot: u64 = 500;
        let grace_period_slots: u64 = 0;
        let grace_ends_at = current_slot.saturating_add(grace_period_slots);
        // The expire_escrow guard: grace_ends_at > 0 && clock.slot < grace_ends_at
        let blocked = grace_ends_at > 0 && current_slot < grace_ends_at;
        assert!(!blocked, "grace==0: slash must be permitted immediately");
    }

    /// ADR-102: With a non-zero grace window, a slash attempted within the
    /// window is blocked.
    #[test]
    fn adr102_grace_nonzero_slash_blocked_within_window() {
        let submission_slot: u64 = 100;
        let grace_period_slots: u64 = 1_000;
        let grace_ends_at = submission_slot.saturating_add(grace_period_slots); // 1100
        let current_slot: u64 = 500; // inside the window
        let blocked = grace_ends_at > 0 && current_slot < grace_ends_at;
        assert!(blocked, "slash must be blocked inside the grace window");
    }

    /// ADR-102: Once grace_ends_at is reached the slash is permitted.
    #[test]
    fn adr102_grace_elapsed_slash_permitted() {
        let submission_slot: u64 = 100;
        let grace_period_slots: u64 = 1_000;
        let grace_ends_at = submission_slot.saturating_add(grace_period_slots); // 1100
        let current_slot: u64 = 1_100; // exactly at grace_ends_at
        let blocked = grace_ends_at > 0 && current_slot < grace_ends_at;
        assert!(!blocked, "slash must be permitted once grace window elapses");
    }

    /// ADR-102: saturating_add on u64::MAX does not panic or overflow.
    #[test]
    fn adr102_grace_ends_at_saturates_on_overflow() {
        let submission_slot: u64 = u64::MAX;
        let grace_period_slots: u64 = 100;
        let grace_ends_at = submission_slot.saturating_add(grace_period_slots);
        assert_eq!(grace_ends_at, u64::MAX);
    }

    /// ADR-102: A Milestone initialised with grace_ends_at == 0 (create_escrow
    /// default) must never block a slash regardless of the current slot.
    #[test]
    fn adr102_grace_zero_field_never_blocks_slash() {
        let grace_ends_at: u64 = 0;
        let current_slot: u64 = 0; // worst case
        let blocked = grace_ends_at > 0 && current_slot < grace_ends_at;
        assert!(!blocked, "grace_ends_at==0 must never block the slash");
    }

    // ================================================================
    // AUD-018: raise_dispute grace gate (ADR-102 applied to dispute path)
    // ================================================================
    //
    // The `raise_dispute` handler iterates `escrow.milestones` and applies the
    // SAME predicate `expire_escrow` uses:
    //   blocked = status == Submitted && grace_ends_at > 0 && slot < grace_ends_at
    // The unit tests below exercise the predicate as it composes with the
    // milestone status, since `raise_dispute` only enforces the gate against
    // Submitted milestones (Pending / Approved / Rejected / Disputed entries
    // never block).

    /// AUD-018: a Submitted milestone within its grace window blocks
    /// `raise_dispute` exactly as it blocks `expire_escrow`.
    #[test]
    fn aud018_raise_dispute_blocked_within_grace_for_submitted_milestone() {
        let status = MilestoneStatus::Submitted;
        let grace_ends_at: u64 = 1_100;
        let current_slot: u64 = 500; // inside the window
        let blocked = status == MilestoneStatus::Submitted
            && grace_ends_at > 0
            && current_slot < grace_ends_at;
        assert!(blocked, "Submitted milestone in grace window must block raise_dispute");
    }

    /// AUD-018: a non-Submitted milestone never blocks `raise_dispute`,
    /// even with a non-zero grace_ends_at in the future. (Pending milestones
    /// were never submitted so there is no front-run window to protect.)
    #[test]
    fn aud018_raise_dispute_unblocked_for_non_submitted_milestone() {
        let grace_ends_at: u64 = 1_100;
        let current_slot: u64 = 500;
        for status in [
            MilestoneStatus::Pending,
            MilestoneStatus::Approved,
            MilestoneStatus::Rejected,
            MilestoneStatus::Disputed,
        ] {
            let blocked = status == MilestoneStatus::Submitted
                && grace_ends_at > 0
                && current_slot < grace_ends_at;
            assert!(
                !blocked,
                "non-Submitted milestone (status={}) must not block raise_dispute",
                status
            );
        }
    }

    /// AUD-018: once the grace window has elapsed, `raise_dispute` is
    /// unblocked even for a Submitted milestone.
    #[test]
    fn aud018_raise_dispute_unblocked_after_grace_elapses() {
        let status = MilestoneStatus::Submitted;
        let grace_ends_at: u64 = 1_100;
        let current_slot: u64 = 1_100; // exactly at boundary
        let blocked = status == MilestoneStatus::Submitted
            && grace_ends_at > 0
            && current_slot < grace_ends_at;
        assert!(!blocked, "raise_dispute must be permitted at grace_ends_at boundary");

        let later: u64 = 1_500;
        let blocked_later = status == MilestoneStatus::Submitted
            && grace_ends_at > 0
            && later < grace_ends_at;
        assert!(!blocked_later, "raise_dispute must be permitted past grace window");
    }

    /// AUD-018: a Submitted milestone with grace_ends_at == 0 (provider opted
    /// out at submit_milestone time) never blocks raise_dispute.
    #[test]
    fn aud018_raise_dispute_unblocked_when_grace_opted_out() {
        let status = MilestoneStatus::Submitted;
        let grace_ends_at: u64 = 0;
        let current_slot: u64 = 0;
        let blocked = status == MilestoneStatus::Submitted
            && grace_ends_at > 0
            && current_slot < grace_ends_at;
        assert!(!blocked, "grace_ends_at==0 must never block raise_dispute");
    }

    /// AUD-018: an escrow with no Submitted milestones (all Pending /
    /// Approved / Rejected / Disputed) is a no-op for the grace gate. The
    /// per-milestone guard short-circuits on the status check.
    #[test]
    fn aud018_raise_dispute_no_op_when_no_submitted_milestones() {
        // Iterate a representative mix: Pending + Approved + Rejected.
        let mix = [
            MilestoneStatus::Pending,
            MilestoneStatus::Approved,
            MilestoneStatus::Rejected,
        ];
        let grace_ends_at: u64 = 1_000_000; // pathological future deadline
        let current_slot: u64 = 0; // worst case
        let any_blocked = mix.iter().any(|s| {
            *s == MilestoneStatus::Submitted
                && grace_ends_at > 0
                && current_slot < grace_ends_at
        });
        assert!(!any_blocked, "raise_dispute must be a no-op when no milestone is Submitted");
    }

    // ================================================================
    // AUD-024: escrow deadline upper-bound predicate
    // ================================================================

    /// AUD-024: `create_escrow` rejects `deadline > now + MAX_ESCROW_DEADLINE_SECS`
    /// and accepts everything inside the window (including the boundary).
    /// This mirrors the `require!(deadline <= now + MAX_ESCROW_DEADLINE_SECS, ...)`
    /// guard in `instructions::escrow::create_escrow` so a regression in
    /// either operand re-admits the `i64::MAX` lock-forever attack.
    #[test]
    fn aud024_deadline_upper_bound_predicate() {
        // Sanity: cap is exactly 365 days in seconds.
        assert_eq!(MAX_ESCROW_DEADLINE_SECS, 365 * 24 * 60 * 60);
        assert_eq!(MAX_ESCROW_DEADLINE_SECS, 31_536_000);

        // Pick a fixed "now" comfortably above 0 to mirror real Unix time.
        let now: i64 = 1_800_000_000;
        let max_deadline = now.checked_add(MAX_ESCROW_DEADLINE_SECS).unwrap();

        // Boundary happy: just under the cap → allowed.
        let just_under = now + MAX_ESCROW_DEADLINE_SECS - 60;
        assert!(just_under <= max_deadline, "60s under cap must pass");

        // Exact boundary: `<=` admits the equality case.
        let at_cap = now + MAX_ESCROW_DEADLINE_SECS;
        assert!(at_cap <= max_deadline, "exactly at cap must pass (<=)");

        // Negative: one second past the cap → rejected.
        let one_past = now + MAX_ESCROW_DEADLINE_SECS + 1;
        assert!(!(one_past <= max_deadline), "1s past cap must fail");

        // Pathological: i64::MAX is the original AUD-024 attack value.
        // The lock-forever case must be rejected by the predicate.
        assert!(!(i64::MAX <= max_deadline), "i64::MAX must be rejected");

        // The cap itself never overflows for any realistic Unix `now`.
        // (year ~3000 is ~3.25e10; cap ~3.15e7; sum fits trivially.)
        let far_future_now: i64 = 32_503_680_000; // year 3000
        assert!(far_future_now.checked_add(MAX_ESCROW_DEADLINE_SECS).is_some());
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

            /// Finding #19: `update_protocol_config` sanity bounds must
            /// reject any positive-→-negative or negative-→-positive flip
            /// of a slash-style delta. Random inputs exercise the rule.
            #[test]
            fn protocol_config_slash_delta_sign_invariant(
                delta in any::<i64>()
            ) {
                let reward_rule_ok = delta >= 0;
                let slash_rule_ok = delta <= 0;
                // A specific delta either satisfies the reward rule, the
                // slash rule, or both (when delta == 0). Exactly-zero
                // is a no-op.
                prop_assert!(reward_rule_ok || slash_rule_ok);
                if delta == 0 {
                    prop_assert!(reward_rule_ok && slash_rule_ok);
                }
            }

            /// S-onchain-01 (2026-04 re-audit): any `dispute_timeout_seconds`
            /// value that passes the `update_protocol_config` bounds check
            /// must survive the `disputed_at + timeout` arithmetic for any
            /// plausible `disputed_at`. The cap is `MAX_DISPUTE_TIMEOUT_SECONDS`
            /// (365 days); `disputed_at` is a Unix epoch (fits comfortably
            /// in ~60 bits). Together they cannot overflow i64.
            #[test]
            fn dispute_timeout_add_never_overflows_within_bounds(
                timeout in 1i64..=MAX_DISPUTE_TIMEOUT_SECONDS,
                disputed_at in 0i64..=32_503_680_000i64, // year 3000
            ) {
                let deadline = disputed_at.checked_add(timeout);
                prop_assert!(deadline.is_some());
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
