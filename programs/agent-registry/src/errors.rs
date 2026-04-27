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

    // SEC-11 (per ADR-075, Accepted 2026-04-25): the slashing path did
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

    // AUD-001 / AUD-002 (PR-G): closed-state-machine invariants enforced by
    // `assert_valid_profile`. Each variant maps to one of the three rules:
    //   - InvalidReputationScore     → `score <= MAX_REPUTATION_SCORE`
    //   - InvalidSuspendedProfile    → `status == Suspended ⇒ slash_count >= 3`
    //   - InvalidClearedCount        → `cleared_count <= MAX_CLEARED` (3)
    // Trips occur only if a mutation or migration produced inconsistent
    // state — i.e. a bug. Surfacing them as typed errors makes the
    // failure mode obvious in transaction logs.
    #[msg("AgentProfile.reputation_score must be in [0, MAX_REPUTATION_SCORE] (AUD-001/002)")]
    InvalidReputationScore,
    #[msg("AgentProfile in Suspended status must have slash_count >= 3 (AUD-001/002)")]
    InvalidSuspendedProfile,
    #[msg("AgentProfile.cleared_count must be <= 3 (AUD-001/002, paired with PR-I)")]
    InvalidClearedCount,

    // AUD-001 / AUD-002 (PR-G): `verify_protocol_invariants` requires the
    // signer to match `ProtocolConfig.authority` from the Settlement program.
    // Same code is reused by other admin-only paths if they ever appear.
    #[msg("Unauthorized: caller is not the ProtocolConfig authority")]
    Unauthorized,

    // AUD-104 (cycle-2): `verify_protocol_invariants` reads the
    // ProtocolConfig PDA's raw bytes (via UncheckedAccount) to avoid pulling
    // in a Settlement crate dependency. Before reading the authority field
    // at offset [8..40], the 8-byte Anchor discriminator must match
    // sha256("account:ProtocolConfig")[..8]. A mismatch means the address
    // was hijacked by an account of a different type and the read would be
    // garbage; reject with this typed error rather than trusting the bytes.
    #[msg("ProtocolConfig discriminator mismatch — account is not a Settlement ProtocolConfig (AUD-104)")]
    InvalidProtocolConfigAccount,

    // AUD-106 (cycle-2): cap on `verify_protocol_invariants` batch size.
    // Each remaining_account triggers a full Borsh deserialize of a
    // ~1.4KB AgentProfile + the invariant helper; ~64 accounts can
    // exhaust the 200k CU budget and a single failure aborts the whole
    // tx with no partial-progress visibility. MAX_INVARIANT_BATCH (16)
    // keeps worst-case CU well under budget.
    #[msg("verify_protocol_invariants batch exceeds MAX_INVARIANT_BATCH (16); slice into smaller transactions (AUD-106)")]
    InvariantBatchTooLarge,
}
