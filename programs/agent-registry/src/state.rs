use anchor_lang::prelude::*;

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
/// ADR-040: Account space is explicitly calculated as 1414 bytes
/// (1243 baseline + 162 bytes for the ADR-060 manifest fields:
///  manifest_cid 64 + manifest_hash 32 + manifest_signature 64 + manifest_version 2 = 162,
///  + 1 byte for ADR-096 version: u8 + 8 bytes for ADR-097 registration_nonce: u64 = 1414).
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
/// explicit writes.
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
    pub total_tasks_completed: u64,
    pub total_earnings: u64,
    pub avg_rating: u8,
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
}

impl AgentProfile {
    /// ADR-040 / ADR-096 / ADR-097 explicit space calc. Do NOT drift from the
    /// `space = ...` literal in `contexts.rs::RegisterAgent`.
    ///
    /// Baseline (pre-ADR-060): 1243 bytes (see earlier history).
    /// ADR-060 additions: 64 + 32 + 64 + 2 = 162 bytes.
    /// ADR-096 addition: version u8 = 1 byte.
    /// ADR-097 addition: registration_nonce u64 = 8 bytes.
    /// Total SPACE: 1414 bytes.
    ///
    /// RegisterAgent allocates 8 (discriminator) + SPACE + MIGRATION_HEADROOM
    /// (64) = 1486 bytes total on-chain.
    pub const SPACE: usize = 1414;
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
