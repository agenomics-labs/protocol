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
}
