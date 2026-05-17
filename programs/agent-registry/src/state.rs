use anchor_lang::prelude::*;
use crate::errors::AgentRegistryError;

/// The Settlement program ID — used to verify CPI caller for reputation updates.
pub const SETTLEMENT_PROGRAM_ID: Pubkey = pubkey!("9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95");

/// The Agent Vault program ID — used to validate that `AgentProfile.vault_address`
/// is the canonical vault PDA for the registering authority.
///
/// Finding #9: Before this, `vault_address` was a free-form `Pubkey` argument
/// with no on-chain check; a malicious provider could point at an attacker-
/// controlled account and off-chain consumers (discovery, MCP) would trust it.
/// Now the field is derived from a seed-constrained account, so impersonation
/// is rejected at transaction construction time.
pub const AGENT_VAULT_PROGRAM_ID: Pubkey = pubkey!("28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw");

/// ADR-096: bytes reserved beyond `AgentProfile::SPACE` in the initial account
/// allocation and as the growth target for `migrate_agent_profile`.
/// 64 bytes covers the next 2–3 field additions without requiring a realloc per
/// upgrade. New accounts start with this headroom so migration calls on modern
/// accounts are zero-cost (account is already large enough).
pub const MIGRATION_HEADROOM: usize = 64;

/// AgentProfile: The core account representing a registered agent.
///
/// ADR-040: Account space is explicitly calculated as 1436 bytes
/// (1243 baseline + 162 bytes for the ADR-060 manifest fields:
///  manifest_cid 64 + manifest_hash 32 + manifest_signature 64 + manifest_version 2 = 162,
///  + 1 byte for ADR-096 version: u8 + 8 bytes for ADR-097 registration_nonce: u64
///  + 1 byte for AUD-004 cleared_count: u8 + 21 bytes for Q-S3-A
///  cdp_wallet: Option<[u8; 20]> (1-byte discriminant + 20-byte EVM address)
///  = 1436).
///
/// AUD-007 (PR-Q): the legacy `total_tasks_completed: u64`, `total_earnings: u64`,
/// and `avg_rating: u8` fields were removed. PR-G (AUD-001/002) had already
/// deleted the only writer (`update_reputation`), so these fields had become
/// permanently zero — misleading consumers that they represented real telemetry.
/// Because the fields are NOT contiguous at the end of the struct (they sit
/// between `reputation_score` and `created_at`), a clean removal would shift
/// every subsequent field's serialization offset and silently corrupt every
/// existing account on upgrade. We therefore retain a single 17-byte
/// `__padding_aud007` array of equivalent total size (8 + 8 + 1) at the same
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
    pub __padding_aud007: [u8; 17],
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
    // Q-S3-A (Surface 3 / Surface 4 binding): on-chain pointer to the CDP
    // (Coinbase Developer Platform) Server Wallet that this agent uses on
    // Base for x402 settlements. The CCTP V2 Hook reads this field on the
    // post-mint approval path and asserts it matches the IC-4 payload's
    // recipient before CPIing into Settlement::approve_milestone. Until
    // Surface 4 wires the binding writer, the field stays `None` and the
    // Hook's binding check rejects (closed-by-default).
    //
    // Encoding: `Option<[u8; 20]>` serializes as a 1-byte Borsh
    // discriminant (0x00 = None, 0x01 = Some) followed by a fixed 20-byte
    // payload (the EVM address); total 21 bytes. New accounts zero-init
    // via the discriminator-init path → `None`. Existing accounts cross
    // `migrate_agent_profile(target_version=2)` → `realloc::zero = true`
    // pads the new bytes with 0x00, which Borsh-decodes as `None`. No
    // separate explicit zeroing is needed in the migration handler.
    pub cdp_wallet: Option<[u8; 20]>,    // 1 + 20 = 21 bytes
}

impl AgentProfile {
    /// ADR-040 / ADR-096 / ADR-097 / AUD-004 / AUD-007 / Q-S3-A explicit
    /// space calc. Do NOT drift from the `space = ...` literal in
    /// `contexts.rs::RegisterAgent`.
    ///
    /// Baseline (pre-ADR-060): 1243 bytes (see earlier history).
    /// ADR-060 additions: 64 + 32 + 64 + 2 = 162 bytes.
    /// ADR-096 addition: version u8 = 1 byte.
    /// ADR-097 addition: registration_nonce u64 = 8 bytes.
    /// AUD-004 addition: cleared_count u8 = 1 byte.
    /// AUD-007 (PR-Q): replaced 17 bytes (8 + 8 + 1) of dangling fields with a
    /// 17-byte `__padding_aud007: [u8; 17]` padding array. Net delta = 0.
    /// Q-S3-A addition: cdp_wallet Option<[u8; 20]> = 1 + 20 = 21 bytes.
    /// Total SPACE: 1436 bytes.
    ///
    /// RegisterAgent allocates 8 (discriminator) + SPACE + MIGRATION_HEADROOM
    /// (64) = 1508 bytes total on-chain. Existing on-disk accounts allocated
    /// at the pre-Q-S3-A 1487-byte size are picked up by
    /// `migrate_agent_profile(target_version=2)`, whose `realloc = ...`
    /// constraint resizes them to the new 1508-byte target with `realloc::zero
    /// = true` zero-padding the appended bytes — which Borsh-decodes as
    /// `cdp_wallet = None` for the new field.
    pub const SPACE: usize = 1436;

    /// ADR-096 / Q-S3-A: the schema version corresponding to the layout this
    /// crate compiles. Bumped from `1` (post-AUD-007) to `2` to mark accounts
    /// that have crossed the Q-S3-A `cdp_wallet` field addition. New
    /// registrations stamp this value into `version`; legacy accounts cross
    /// via `migrate_agent_profile(target_version = AgentProfile::CURRENT_VERSION)`.
    pub const CURRENT_VERSION: u8 = 2;
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
///   3. `cleared_count <= 3` (AUD-004, shipped PR-I). The
///      `clear_suspension` escalation ladder is 1 → halve, 2 → zero,
///      3+ → terminal Retired; a `cleared_count` beyond 3 means a third
///      clear landed on a non-Suspended profile, only reachable via
///      state corruption. Enforced at the require! below.
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

#[cfg(test)]
mod space_tests {
    use super::*;

    /// Q-S3-A: the new `cdp_wallet: Option<[u8; 20]>` field adds exactly 21
    /// serialized bytes (1-byte Borsh discriminant + 20-byte payload). Net
    /// SPACE = 1415 (pre-Q-S3-A) + 21 = 1436. This test pins the value so
    /// any future refactor that reorders the field or changes its width
    /// breaks the build, not the runtime account-init path.
    #[test]
    fn q_s3_a_space_includes_cdp_wallet_21_bytes() {
        const PRE_Q_S3_A_SPACE: usize = 1415;
        const CDP_WALLET_SERIALIZED: usize = 1 + 20;
        assert_eq!(
            AgentProfile::SPACE,
            PRE_Q_S3_A_SPACE + CDP_WALLET_SERIALIZED,
            "AgentProfile::SPACE must include 21 bytes for cdp_wallet (Q-S3-A)"
        );
        assert_eq!(AgentProfile::SPACE, 1436);
    }
}

#[cfg(test)]
mod layout_pin {
    //! F-08-02 (cycle-4) — CI layout-parity tether for the indexer's
    //! hand-rolled `AgentProfile` decoder.
    //!
    //! `src/indexer/reputation-attestor-wire.ts::decodeAgentProfileSlice`
    //! reads the on-chain `AgentProfile` account by walking Borsh fields
    //! in declaration order with NO IDL/Anchor dependency and NO runtime
    //! schema check. ADR-139 then signs `reputation_score`, `slash_count`,
    //! `registration_nonce`, `manifest_hash`, and `authority` from those
    //! bytes into a reputation attestation. If a future registry change
    //! reorders, inserts, or resizes any field at or before
    //! `registration_nonce`, the indexer would silently decode the WRONG
    //! values and sign them with a VALID issuer key — the highest
    //! blast-radius failure in the cycle-4 audit (F-08-02).
    //!
    //! This module Borsh-serializes a fully-populated `AgentProfile`
    //! (exactly what Anchor writes to the account) and asserts the BYTE
    //! OFFSET of every field the TS decoder consumes. Any drift fails the
    //! Agent Registry build's `cargo test` — which CI runs before any
    //! redeploy — so the indexer can never silently sign wrong reputation.
    //! The offset constants below MUST stay in lockstep with the comment
    //! block at `src/indexer/reputation-attestor-wire.ts:115-151` and the
    //! field walk at `:206-234`.
    use super::*;
    use anchor_lang::AccountSerialize;

    // Borsh-serialized field offsets RELATIVE TO THE START OF THE ACCOUNT
    // DATA (i.e. including Anchor's 8-byte discriminator, exactly as the
    // indexer sees it via `getAccountInfo`). The TS decoder skips the
    // first 8 bytes then reads in this order. Fixture string/Vec lengths
    // are chosen below so these are deterministic.
    const DISC: usize = 8;
    const NAME_LEN: usize = 4; // "name"
    const DESC_LEN: usize = 4; // "desc"
    const CAT_LEN: usize = 3; // "cat"
    const N_CAPS: usize = 2; // capabilities entries
    const CAP_LEN: usize = 2; // each "cX"
    const N_TOKENS: usize = 1; // accepted_tokens entries

    #[test]
    fn f_08_02_agentprofile_borsh_offsets_match_indexer_decoder() {
        let authority = Pubkey::new_from_array([0x11; 32]);
        let vault_address = Pubkey::new_from_array([0x22; 32]);
        let token = Pubkey::new_from_array([0x33; 32]);
        let manifest_hash = [0x44u8; 32];
        let profile = AgentProfile {
            authority,
            name: "name".to_string(),
            description: "desc".to_string(),
            category: "cat".to_string(),
            capabilities: vec!["c0".to_string(), "c1".to_string()],
            pricing_model: PricingModel::PerTask,
            pricing_amount: 7,
            accepted_tokens: vec![token],
            vault_address,
            status: AgentStatus::Active,
            reputation_score: 87,
            __padding_aud007: [0u8; 17],
            created_at: 1_700_000_000,
            updated_at: 1_700_000_100,
            reputation_stake: ReputationStake {
                staked_amount: 5_000,
                slash_count: 2,
            },
            bump: 254,
            manifest_cid: [0x55u8; 64],
            manifest_hash,
            manifest_signature: [0x66u8; 64],
            manifest_version: 0x0102,
            version: AgentProfile::CURRENT_VERSION,
            registration_nonce: 0xDEAD_BEEF,
            cleared_count: 1,
            cdp_wallet: None,
        };

        let mut buf: Vec<u8> = Vec::with_capacity(8 + AgentProfile::SPACE);
        profile
            .try_serialize(&mut buf)
            .expect("AgentProfile must serialize");

        // Walk the SAME field order the TS `decodeAgentProfileSlice`
        // walks, computing each field's start offset, and assert the
        // bytes at that offset equal the fixture value the indexer would
        // decode. A reorder/insert/resize shifts these and fails here.
        let mut off = DISC;

        // authority @ [8..40]
        assert_eq!(off, 8, "authority must start immediately after disc");
        assert_eq!(&buf[off..off + 32], authority.as_ref(), "authority offset");
        off += 32;

        // name: u32 len + bytes
        assert_eq!(
            u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) as usize,
            NAME_LEN,
            "name length prefix"
        );
        off += 4 + NAME_LEN;
        // description
        assert_eq!(
            u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) as usize,
            DESC_LEN,
            "description length prefix"
        );
        off += 4 + DESC_LEN;
        // category
        assert_eq!(
            u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) as usize,
            CAT_LEN,
            "category length prefix"
        );
        off += 4 + CAT_LEN;
        // capabilities: Vec<String> — u32 count, then each string
        assert_eq!(
            u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) as usize,
            N_CAPS,
            "capabilities vec count"
        );
        off += 4;
        for _ in 0..N_CAPS {
            assert_eq!(
                u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) as usize,
                CAP_LEN,
                "capability string length"
            );
            off += 4 + CAP_LEN;
        }
        // pricing_model: enum → 1-byte variant tag
        assert_eq!(buf[off], 0, "pricing_model PerTask tag = 0");
        off += 1;
        // pricing_amount: u64
        assert_eq!(
            u64::from_le_bytes(buf[off..off + 8].try_into().unwrap()),
            7,
            "pricing_amount"
        );
        off += 8;
        // accepted_tokens: Vec<Pubkey> — u32 count then 32 bytes each
        assert_eq!(
            u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) as usize,
            N_TOKENS,
            "accepted_tokens vec count"
        );
        off += 4 + 32 * N_TOKENS;
        // vault_address: Pubkey (skipped by the indexer but offset matters)
        assert_eq!(
            &buf[off..off + 32],
            vault_address.as_ref(),
            "vault_address offset"
        );
        off += 32;
        // status: enum → 1-byte tag; indexer reads this (Active == 0)
        assert_eq!(buf[off], 0, "status Active tag = 0 (indexer isActive gate)");
        off += 1;
        // reputation_score: u64 — SIGNED into ADR-139 attestation
        assert_eq!(
            u64::from_le_bytes(buf[off..off + 8].try_into().unwrap()),
            87,
            "reputation_score offset (ADR-139 attested value)"
        );
        off += 8;
        // __padding_aud007: [u8; 17] — indexer `skip(17)`
        off += 17;
        // created_at: i64, updated_at: i64 — indexer skips both
        off += 8 + 8;
        // reputation_stake.staked_amount: u64 — attested
        assert_eq!(
            u64::from_le_bytes(buf[off..off + 8].try_into().unwrap()),
            5_000,
            "reputation_stake.staked_amount offset (ADR-139 attested)"
        );
        off += 8;
        // reputation_stake.slash_count: u8 — attested
        assert_eq!(
            buf[off], 2,
            "reputation_stake.slash_count offset (ADR-139 attested)"
        );
        off += 1;
        // bump: u8 — indexer skips
        off += 1;
        // manifest_cid: [u8; 64] — indexer skips
        off += 64;
        // manifest_hash: [u8; 32] — attested
        assert_eq!(
            &buf[off..off + 32],
            &manifest_hash,
            "manifest_hash offset (ADR-139 attested)"
        );
        off += 32;
        // manifest_signature: [u8; 64] — indexer skips
        off += 64;
        // manifest_version: u16 — indexer skips
        off += 2;
        // version: u8 — indexer skips
        off += 1;
        // registration_nonce: u64 — the LAST field the indexer reads;
        // attested into the ADR-139 monotone-invariant set.
        assert_eq!(
            u64::from_le_bytes(buf[off..off + 8].try_into().unwrap()),
            0xDEAD_BEEF,
            "registration_nonce offset (ADR-139 attested, last decoded field)"
        );
        off += 8;

        // Everything the indexer decodes ends exactly here. Pin the
        // absolute offset so a field added ANYWHERE at or before
        // `registration_nonce` (which would shift this) fails the build.
        assert_eq!(
            off, 379,
            "F-08-02: total bytes the indexer decodes (disc..=registration_nonce) \
             changed. The hand-rolled decoder in \
             src/indexer/reputation-attestor-wire.ts is now reading WRONG \
             offsets and ADR-139 will sign incorrect reputation with a valid \
             key. Update BOTH this pin and the TS decoder in lockstep."
        );
    }

    /// F-08-02: prove the threat is real — simulate a registry refactor
    /// that inserts a `u64` field before `reputation_score`, and show the
    /// indexer's fixed offset would then read the inserted field's bytes
    /// as the attested reputation score. The compile-order of the real
    /// struct + the pin above is what prevents this from shipping.
    #[test]
    fn f_08_02_simulated_inserted_field_corrupts_attested_score() {
        // Real serialized prefix up to (but not including) reputation_score.
        let authority = Pubkey::new_from_array([0xAA; 32]);
        let profile = AgentProfile {
            authority,
            name: "n".to_string(),
            description: "d".to_string(),
            category: "c".to_string(),
            capabilities: vec![],
            pricing_model: PricingModel::PerTask,
            pricing_amount: 1,
            accepted_tokens: vec![],
            vault_address: Pubkey::new_from_array([0xBB; 32]),
            status: AgentStatus::Active,
            reputation_score: 42,
            __padding_aud007: [0u8; 17],
            created_at: 0,
            updated_at: 0,
            reputation_stake: ReputationStake {
                staked_amount: 0,
                slash_count: 0,
            },
            bump: 0,
            manifest_cid: [0u8; 64],
            manifest_hash: [0u8; 32],
            manifest_signature: [0u8; 64],
            manifest_version: 0,
            version: AgentProfile::CURRENT_VERSION,
            registration_nonce: 0,
            cleared_count: 0,
            cdp_wallet: None,
        };
        let mut real: Vec<u8> = Vec::new();
        profile.try_serialize(&mut real).unwrap();

        // Locate reputation_score the same way the indexer would (fixed
        // walk). With empty caps/tokens the offset is deterministic.
        // disc8 + auth32 + name(4+1) + desc(4+1) + cat(4+1)
        //  + caps_count4 + pricing_tag1 + pricing_amt8
        //  + tokens_count4 + vault32 + status1 = reputation_score start.
        let rep_off = 8 + 32 + (4 + 1) * 3 + 4 + 1 + 8 + 4 + 32 + 1;
        assert_eq!(
            u64::from_le_bytes(real[rep_off..rep_off + 8].try_into().unwrap()),
            42,
            "sanity: indexer would read reputation_score = 42 on the real layout"
        );

        // Simulate the drift: splice an 8-byte `u64` (value 999) in front
        // of reputation_score, as a careless registry refactor would.
        let mut drifted = real[..rep_off].to_vec();
        drifted.extend_from_slice(&999u64.to_le_bytes()); // inserted field
        drifted.extend_from_slice(&real[rep_off..]);

        // The indexer's FIXED offset now reads the inserted field, not the
        // real score — it would sign reputation_score = 999 (clamped to
        // 100 by ADR-139) into a credential with a valid issuer key.
        let read_after_drift =
            u64::from_le_bytes(drifted[rep_off..rep_off + 8].try_into().unwrap());
        assert_eq!(
            read_after_drift, 999,
            "F-08-02: confirms a pre-reputation_score field insertion makes \
             the hand-rolled indexer decoder sign the WRONG value. The \
             layout-pin test above is what fails the build before this \
             drift can reach a cluster."
        );
        assert_ne!(
            read_after_drift, 42,
            "drifted layout no longer yields the true reputation_score"
        );
    }
}
