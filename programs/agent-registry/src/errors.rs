use anchor_lang::prelude::*;

#[error_code]
pub enum AgentRegistryError {
    #[msg("Agent name exceeds maximum length of 64 bytes")]
    NameTooLong,
    #[msg("Description exceeds maximum length of 256 bytes")]
    DescriptionTooLong,
    #[msg("Invalid number of capabilities (must be 1-10)")]
    InvalidCapabilitiesCount,
    #[msg("Invalid number of accepted tokens (must be 1-5)")]
    InvalidTokensCount,
    #[msg("Invalid rating (must be 0-5)")]
    InvalidRating,
    #[msg("Unauthorized caller (must be settlement program for reputation updates)")]
    UnauthorizedCaller,
    #[msg("Invalid PDA derivation")]
    InvalidPDA,
    #[msg("Invalid status transition: Retired agents cannot be reactivated")]
    InvalidStatusTransition,
    #[msg("Invalid stake amount (must be > 0)")]
    InvalidStakeAmount,
    #[msg("Insufficient staked amount for withdrawal")]
    InsufficientStake,
    #[msg("Category exceeds maximum length of 50 bytes")]
    CategoryTooLong,

    #[msg("Unstake would leave the stake account with a non-zero sub-rent-exempt balance, which would be garbage-collected and strand funds")]
    WouldOrphanStakeAccount,

    #[msg("Stake amount is below the rent-exempt minimum for the staking PDA")]
    StakeBelowRentExempt,

    #[msg("clear_suspension requires status == Suspended and slash_count >= 3")]
    NotSuspended,
}
