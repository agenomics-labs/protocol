use anchor_lang::prelude::*;

#[error_code]
pub enum SettlementError {
    #[msg("Invalid milestone count: must be between 1 and 5")]
    InvalidMilestoneCount,

    #[msg("Milestone amounts do not sum to total escrow amount")]
    MilestoneAmountMismatch,

    #[msg("Deadline cannot be in the past")]
    DeadlineInPast,

    #[msg("Invalid escrow status for this operation")]
    InvalidStatus,

    #[msg("Only the provider can perform this action")]
    UnauthorizedProvider,

    #[msg("Only the client can perform this action")]
    UnauthorizedClient,

    #[msg("Invalid milestone index")]
    InvalidMilestoneIndex,

    #[msg("Invalid milestone status for this operation")]
    InvalidMilestoneStatus,

    #[msg("Amount overflow detected")]
    AmountOverflow,

    #[msg("Only authorized party can raise a dispute")]
    UnauthorizedDispute,

    #[msg("Escrow is already in dispute")]
    AlreadyDisputed,

    #[msg("Escrow has expired")]
    EscrowExpired,

    #[msg("Only dispute resolver or client can resolve disputes")]
    UnauthorizedResolver,

    #[msg("Refund amounts do not match remaining escrow balance")]
    InvalidRefundAmount,

    #[msg("Token account does not match expected mint or owner")]
    InvalidTokenAccount,

    #[msg("Task deadline has passed")]
    DeadlinePassed,

    #[msg("Deadline has not been reached yet")]
    DeadlineNotReached,

    #[msg("Invalid amount: must be greater than zero")]
    InvalidAmount,

    #[msg("Invalid registry program")]
    InvalidRegistryProgram,

    #[msg("Escrow amount below minimum (anti-sybil)")]
    BelowMinimumEscrow,

    #[msg("Client and provider cannot be the same account")]
    SelfDealingProhibited,

    #[msg("Dispute timeout has not been reached yet")]
    DisputeTimeoutNotReached,

    #[msg("Dispute resolver must be a neutral third party — not the client or provider")]
    InvalidDisputeResolver,

    #[msg("Rating must be in 0..=5 (0 = no rating)")]
    InvalidRating,

    /// Finding #19: `update_protocol_config` called by a key other than
    /// `ProtocolConfig.authority`.
    #[msg("Unauthorized: must be ProtocolConfig authority")]
    UnauthorizedConfigAuthority,

    /// Finding #19: `update_protocol_config` tried to set an invalid tunable
    /// (zero min_escrow, non-positive timeout, positive slash delta, etc.).
    #[msg("Invalid ProtocolConfig value: violates sanity bounds")]
    InvalidProtocolConfigValue,

    /// SEC-7 (per ADR-073, Accepted 2026-04-25): `resolve_dispute` on an escrow whose
    /// `dispute_resolver == None`. The only legitimate path for a
    /// no-resolver dispute is `resolve_dispute_timeout`, which refunds the
    /// full remaining balance symmetrically to the client (no slashing). A
    /// `resolve_dispute` call here would have let the client set
    /// `client_refund = remaining, provider_refund = 0` and unilaterally
    /// drain the escrow without the neutral-resolver slashing signal.
    #[msg("Cannot resolve_dispute when dispute_resolver is None; use resolve_dispute_timeout (SEC-7)")]
    NoResolverRequiresTimeout,

    /// ADR-102: A slash was attempted while the milestone is still within
    /// its grace window. Caller must wait until
    /// `Clock::get()?.slot >= milestone.grace_ends_at` before slashing.
    #[msg("Milestone is within grace period; slash not permitted yet (ADR-102)")]
    MilestoneInGracePeriod,

    /// AUD-005 (PR-H): a non-upgrade-authority key attempted
    /// `initialize_protocol_config`. The init context binds the
    /// `payer` to the program's upgrade authority via the
    /// BPF Upgradeable Loader's `ProgramData` account, closing the
    /// front-running window between deploy and config init. After init,
    /// `ProtocolConfig.authority` is fully independent of the upgrade
    /// authority and no other instruction references `ProgramData`.
    #[msg("Unauthorized: caller is not the program's upgrade authority")]
    Unauthorized,

    /// AUD-024 (2026-04 audit): `create_escrow` rejected a `deadline`
    /// further than `MAX_ESCROW_DEADLINE_SECS` (365 days) into the
    /// future. Without this cap a client could lock funds with
    /// `deadline = i64::MAX`, making the escrow effectively
    /// unrecoverable.
    #[msg("Deadline is too far in the future (max 365 days from now)")]
    DeadlineTooFar,
}
