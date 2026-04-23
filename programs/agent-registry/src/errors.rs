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

    // ADR-060: capability manifest errors.
    #[msg("Ed25519 signature over manifest_hash failed verification against the authority pubkey")]
    InvalidManifestSignature,
    #[msg("On-chain capabilities are not a subset of the supplied manifest capability name list")]
    CapabilitySubsetViolation,
    #[msg("Manifest version must be non-zero (packed semver: high=major, low=minor)")]
    InvalidManifestVersion,
    #[msg("update_manifest requires a paired Ed25519 precompile instruction in the same transaction")]
    MissingEd25519Instruction,
    #[msg("The paired Ed25519 instruction does not match the supplied manifest_hash / manifest_signature / authority")]
    Ed25519InstructionMismatch,

    // SEC-4 (per ADR-070, in-flight): deregister_agent was orphaning the
    // `reputation-stake` PDA, and a subsequent register_agent with the same
    // authority reset slash_count / Suspended state. Refuse deregister
    // while any stake remains; require an explicit full unstake first.
    #[msg("Cannot deregister while reputation stake is present; call unstake_reputation for the full amount first (SEC-4)")]
    StakePresentOnDeregister,

    // SEC-11 (per ADR-075, in-flight): the slashing path did
    // `(-reputation_delta) as u64` which panics in debug for
    // `reputation_delta == i64::MIN`. Use `checked_neg` and surface the
    // overflow as a typed error rather than a panic.
    #[msg("Reputation delta magnitude overflows i64 negation (delta == i64::MIN); governance must choose a valid slash magnitude (SEC-11)")]
    ReputationDeltaOverflow,

    // ADR-094: propose_reputation_delta rejects calls where |delta| exceeds
    // MAX_DELTA_PER_CALL (10). This caps single-call reputation manipulation
    // and makes large shifts require multiple observable transactions.
    #[msg("Reputation delta magnitude exceeds MAX_DELTA_PER_CALL (10); split into smaller increments")]
    ReputationDeltaExceedsMax,
}
