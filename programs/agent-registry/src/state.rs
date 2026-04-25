use anchor_lang::prelude::*;
use crate::errors::AgentRegistryError;

/// The Settlement program ID — used to verify CPI caller for reputation updates.
pub const SETTLEMENT_PROGRAM_ID: Pubkey = pubkey!("GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3");

/// The Agent Vault program ID — used to validate that `AgentProfile.vault_address`
/// is the canonical vault PDA for the registering authority.
///
/// Finding #9: Before this, `vault_address` was a free-form `Pubkey` argument
/// with no on-chain check; a malicious provider could point at an attacker-
/// controlled account and off-chain consumers (discovery, MCP) would trust it.
/// Now the field is derived from a seed-constrained account, so impersonation
/// is rejected at transaction construction time.
pub const AGENT_VAULT_PROGRAM_ID: Pubkey = pubkey!("4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN");

/// ADR-096: bytes reserved beyond `AgentProfile::SPACE` in the initial account
/// allocation and as the growth target for `migrate_agent_profile`.
/// 64 bytes covers the next 2–3 field additions without requiring a realloc per
/// upgrade. New accounts start with this headroom so migration calls on modern
/// accounts are zero-cost (account is already large enough).
pub const MIGRATION_HEADROOM: usize = 64;

/// AgentProfile: The core account representing a registered agent.
///
/// ADR-040: Account space is explicitly calculated as 1415 bytes
/// (1243 baseline + 162 bytes for the ADR-060 manifest fields:
///  manifest_cid 64 + manifest_hash 32 + manifest_signature 64 + manifest_version 2 = 162,
///  + 1 byte for ADR-096 version: u8 + 8 bytes for ADR-097 registration_nonce: u64
///  + 1 byte for AUD-004 cleared_count: u8 = 1415).
///
/// AUD-007 (PR-Q): the legacy `total_tasks_completed: u64`, `total_earnings: u64`,
/// and `avg_rating: u8` fields were removed. PR-G (AUD-001/002) had already
/// deleted the only writer (`update_reputation`), so these fields had become
/// permanently zero — misleading consumers that they represented real telemetry.
/// Because the fields are NOT contiguous at the end of the struct (they sit
/// between `reputation_score` and `created_at`), a clean removal would shift
/// every subsequent field's serialization offset and silently corrupt every
/// existing account on upgrade. We therefore retain a single 17-byte
/// `_reserved_aud007` array of equivalent total size (8 + 8 + 1) at the same
/// position to preserve the binary layout, while removing the fields from the
/// public API. Future schema work (governance-owned rating ix, telemetry
/// rework) MAY consume these reserved bytes via a dedicated migration; until
/// then they are zero-padded and unread.
///
/// ADR-060 adds four manifest fields that point to an off-chain capability
/// manifest (IPFS CIDv1 or Arweave tx ID). The on-chain fields are the
/// integrity commitment; the manifest body is off-chain. M5 resolution:
/// `manifest_cid` is `[u8; 64]` to fit CIDv1 string encodings (≤ ~60 chars)
/// or Arweave 43-char base64url tx IDs with headroom. Unused bytes are
/// zero-padded; readers trim trailing 0x00.
///
/// The existing `capabilities: Vec<String>` stays as a denormalized on-chain
/// search index (ADR-060 §1 "Relationship"); the manifest is the source of
/// truth. `update_manifest` re-validates the invariant
/// `capabilities ⊆ manifest.capabilities[].name`.
///
/// ADR-097: `registration_nonce` is included in the PDA seed to prevent
/// Sybil reuse via close-then-reopen. The nonce is taken from the owner's
/// `OwnerNonce` account at registration time and incremented on deregister.
/// Zero-value default is valid (first registration uses nonce 0).
///
/// ADR-096: `version` is the schema version for in-place migration. Set to
/// `0` on creation; incremented by `migrate_agent_profile`. New fields added
/// in future upgrades must use zero-value defaults so that the
/// `realloc::zero = true` constraint produces a valid initial state without
/// explicit writes. AUD-007 (PR-Q) bumps the post-migration version to `1`
/// to mark accounts that have crossed the dangling-aggregate removal.
#[account]
pub struct AgentProfile {
    pub authority: Pubkey,
    pub name: String,
    pub description: String,
    pub category: String,
    pub capabilities: Vec<String>,
    pub pricing_model: PricingModel,
    pub pricing_amount: u64,
    pub accepted_tokens: Vec<Pubkey>,
    pub vault_address: Pubkey,
    pub status: AgentStatus,
    pub reputation_score: u64,
    /// AUD-007 (PR-Q) layout-preserving padding.
    ///
    /// Replaces the removed `total_tasks_completed: u64`,
    /// `total_earnings: u64`, and `avg_rating: u8` fields (8 + 8 + 1 = 17
    /// bytes total). Anchor serializes struct fields in declaration order, so
    /// this array sits at the exact byte offsets the deleted fields occupied.
    /// Existing accounts keep their on-disk layout; new accounts zero-init.
    /// The bytes carry no semantics and are not read by any instruction.
    /// Future PRs MAY repurpose this region via an explicit migration with a
    /// version bump.
    pub _reserved_aud007: [u8; 17],
    pub created_at: i64,
    pub updated_at: i64,
    pub reputation_stake: ReputationStake,
    pub bump: u8,
    // ADR-060: capability manifest pointer + integrity commitment.
    // Zero-initialized on register; populated via `update_manifest`.
    pub manifest_cid: [u8; 64],          // 64 bytes — CIDv1 string or Arweave tx ID, zero-padded
    pub manifest_hash: [u8; 32],         // 32 bytes — SHA-256 of RFC-8785 canonical-JSON manifest
    pub manifest_signature: [u8; 64],    // 64 bytes — Ed25519 signature over manifest_hash by authority
    pub manifest_version: u16,           // 2 bytes — high byte = major, low byte = minor
    // ADR-096: schema version for in-place migration (see migrate_agent_profile).
    // 0 = initial layout; bumped to N after the Nth field-adding upgrade migration.
    pub version: u8,                     // 1 byte
    // ADR-097: monotonic registration nonce included in PDA seed.
    // Prevents address reuse after close (Sybil resistance).
    pub registration_nonce: u64,         // 8 bytes
    // AUD-004: monotonic counter of how many times `clear_suspension` has been
    // invoked on this profile. Escalates the cost of clearing — see
    // `clear_suspension` for the cost ladder. Zero-initialized on register;
    // bumped from 0 → 1 → 2 → 3 (terminal Retired). Existing profiles default
    // to 0 via the `realloc::zero = true` migration constraint.
    pub cleared_count: u8,               // 1 byte
}

impl AgentProfile {
    /// ADR-040 / ADR-096 / ADR-097 / AUD-004 / AUD-007 explicit space calc.
    /// Do NOT drift from the `space = ...` literal in
    /// `contexts.rs::RegisterAgent`.
    ///
    /// Baseline (pre-ADR-060): 1243 bytes (see earlier history).
    /// ADR-060 additions: 64 + 32 + 64 + 2 = 162 bytes.
    /// ADR-096 addition: version u8 = 1 byte.
    /// ADR-097 addition: registration_nonce u64 = 8 bytes.
    /// AUD-004 addition: cleared_count u8 = 1 byte.
    /// AUD-007 (PR-Q): replaced 17 bytes (8 + 8 + 1) of dangling fields with a
    /// 17-byte `_reserved_aud007: [u8; 17]` padding array. Net delta = 0.
    /// Total SPACE: 1415 bytes (unchanged across PR-Q on purpose — the
    /// padding preserves the on-disk layout for existing accounts).
    ///
    /// RegisterAgent allocates 8 (discriminator) + SPACE + MIGRATION_HEADROOM
    /// (64) = 1487 bytes total on-chain.
    pub const SPACE: usize = 1415;
}

/// ADR-097: Per-owner monotonic nonce counter.
///
/// Seeded by `[authority.key().as_ref(), b"owner-nonce"]`.
/// Initialized to 0 on first `register_agent` (via `init_if_needed`).
/// Incremented by `deregister_agent` so subsequent registrations derive a
/// different `agent_profile` PDA, preventing Sybil address reuse.
#[account]
pub struct OwnerNonce {
    /// The current nonce value. Used as part of the `agent_profile` PDA seed
    /// on `register_agent`. Incremented on `deregister_agent`.
    pub nonce: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum PricingModel {
    PerTask,
    PerHour,
    PerToken,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum AgentStatus {
    Active,
    Paused,
    Retired,
    Suspended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct ReputationStake {
    pub staked_amount: u64,
    pub slash_count: u8,
}

/// AUD-001 / AUD-002 (PR-G): closed-state-machine invariant for `AgentProfile`.
/// Every reputation/status mutation MUST call this after writing. Migration
/// handlers MUST call this after normalization. A violation panic-reverts
/// the entire transaction, surfacing the mismatch in the program log.
///
/// Invariants enforced:
///   1. `reputation_score <= MAX_REPUTATION_SCORE` (= 100). Pre-PR-G the
///      legacy `update_reputation` could grow `score` without bound.
///   2. `status == Suspended ⇒ slash_count >= 3`. The slash path is the
///      only instruction that legitimately writes `Suspended`; anything
///      else hitting that state is reconciled via `migrate_agent_profile`.
///   3. `cleared_count <= 3` (PR-I, in flight). The base tree shipped to
///      this PR-G worktree does not yet include the `cleared_count` field
///      on `AgentProfile`. The check is left as a TODO that resolves the
///      moment PR-I lands and adds the field — at that point this guard
///      becomes enforceable without a coordination handoff.
///
/// Choosing `require!` (vs. `assert!`) keeps the error path Anchor-typed,
/// so callers see a stable error code instead of an opaque panic. Once a
/// violation fires the runtime aborts the tx without persisting any of
/// the writes that produced the bad state.
pub fn assert_valid_profile(profile: &AgentProfile) -> Result<()> {
    require!(
        profile.reputation_score <= crate::MAX_REPUTATION_SCORE as u64,
        AgentRegistryError::InvalidReputationScore
    );
    require!(
        !(profile.status == AgentStatus::Suspended
            && profile.reputation_stake.slash_count < 3),
        AgentRegistryError::InvalidSuspendedProfile
    );
    // AUD-004 (PR-I) has landed; cleared_count is now part of the schema.
    // The closed-state-machine cap matches `clear_suspension`'s escalation
    // ladder (1 → halve, 2 → zero, 3+ → terminal Retired); a cleared_count
    // beyond 3 means a third clear was attempted on a non-Suspended profile,
    // which would only be reachable through a state corruption.
    require!(
        profile.cleared_count <= 3,
        AgentRegistryError::InvalidClearedCount
    );
    Ok(())
}
