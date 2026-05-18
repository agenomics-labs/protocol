use anchor_lang::prelude::*;

// ============================================================================
// CONSTANTS
// ============================================================================

/// Agent Registry program ID — used for CPI reputation updates.
pub const AGENT_REGISTRY_PROGRAM_ID: Pubkey = pubkey!("psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv");

/// Finding #21: Agent Vault program ID — used to validate that
/// `client_vault`/`provider_vault` in `CreateEscrow` are genuine
/// vault PDAs derived under the vault program, not arbitrary
/// 32-byte keys. Must match `declare_id!` in programs/agent-vault/src/lib.rs.
pub const AGENT_VAULT_PROGRAM_ID: Pubkey = pubkey!("28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw");

pub const MAX_MILESTONES: usize = 5;

/// ADR-028: Minimum escrow amount to prevent cheap reputation farming.
/// Set to 10,000 base units (e.g., 0.01 USDC with 6 decimals).
/// Self-dealing attacks must lock at least this much per task, making
/// large-scale reputation inflation economically costly.
///
/// Finding #19: This is now a DEFAULT value. The authoritative runtime
/// value lives in `ProtocolConfig.min_escrow_amount` and is supplied as an
/// account to `create_escrow`. `initialize_protocol_config` seeds the
/// config with this constant; `update_protocol_config` lets governance
/// change it without a program upgrade.
pub const DEFAULT_MIN_ESCROW_AMOUNT: u64 = 10_000;

/// ADR-030: Dispute resolution timeout in seconds (7 days).
/// Finding #19: Default for the governance-owned `ProtocolConfig.dispute_timeout_seconds`.
pub const DEFAULT_DISPUTE_TIMEOUT_SECONDS: i64 = 7 * 24 * 3600;

/// S-onchain-01 (2026-04 re-audit): upper bound on
/// `ProtocolConfig.dispute_timeout_seconds`. Governance can set this
/// field to any positive `i64` with no ceiling, and the timeout check
/// in `resolve_dispute_timeout` evaluates `disputed_at + dispute_timeout_seconds`.
/// A pathological value near `i64::MAX` would overflow and panic every
/// call to `resolve_dispute_timeout` — effectively bricking the
/// timeout-resolution path for every disputed escrow at once. 365 days
/// is a comfortable ceiling: it's longer than any reasonable protocol
/// dispute window and leaves `i64::MAX - 1 year` of headroom so the
/// arithmetic cannot overflow for any `disputed_at` this side of the
/// year ~292e9. Downstream arithmetic also uses `checked_add` as a
/// belt-and-braces guard.
pub const MAX_DISPUTE_TIMEOUT_SECONDS: i64 = 365 * 24 * 3600;

/// AUD-024 (2026-04 audit): upper bound on the `deadline` argument to
/// `create_escrow`. Without a ceiling, a client can lock funds with
/// `deadline = i64::MAX`, effectively forever — the escrow can only be
/// expired via `expire_escrow`, which requires `now > deadline`. 365
/// days is long enough for any legitimate long-running task while
/// keeping the lock bounded; together with `disputed_at` arithmetic
/// elsewhere it leaves comfortable headroom against i64 overflow.
///
/// AUD-121 (cycle-2 worst-case lock window): both `MAX_ESCROW_DEADLINE_SECS`
/// (above) and `MAX_DISPUTE_TIMEOUT_SECONDS` (the constant immediately
/// preceding) are 365 days, but they apply to different time-axes —
/// `escrow.deadline` is wall-clock; dispute timeout is
/// `disputed_at + dispute_timeout_seconds`. Worst case: a milestone
/// disputed on day 364 with a 365-day timeout has the dispute window
/// extending to day 729. `expire_escrow` requires `Active || Created`
/// status and rejects `Disputed`, so a `Disputed` escrow's funds can
/// remain locked for up to ~730 days end-to-end. This is bounded and
/// the audit accepted it as documented; if mainnet operations require
/// a tighter cap, reduce one of the two constants.
pub const MAX_ESCROW_DEADLINE_SECS: i64 = 365 * 24 * 3600;

/// C4-OB-03 (cycle-4): post-deadline challenge window before an
/// `expire_escrow` may apply the *undelivered* reputation slash.
///
/// `expire_escrow` is permissionless (any signer is `payer`) and the only
/// per-milestone front-running guard (ADR-102 `grace_ends_at`) protects a
/// milestone that the provider actually *Submitted*. A milestone the
/// provider never `submit_milestone`'d has `grace_ends_at == 0` and no
/// protection. Because `submit_milestone` hard-rejects `now > deadline`,
/// a client (or anyone) who censors / front-runs the provider's
/// `submit_milestone` for a single block can call `expire_escrow` at
/// `deadline + 1`, recover the full unreleased balance *and* permanently
/// slash the provider's reputation for "non-delivery" — the exact inverse
/// of the C1 stall attack the codebase already hardened the provider→client
/// direction against.
///
/// The chosen fix is the lower-risk of the two the audit proposed
/// (option b: gate the *slash*, not the refund, behind a short post-deadline
/// challenge window). Rationale for preferring it over option a
/// (a protocol-level minimum execution window keyed on an `accepted_at`
/// field):
///   * Option a requires a new `TaskEscrow` field → struct layout change →
///     `CreateEscrow` `space` bump → IDL regen → indexer Borsh-decoder
///     change (F-08 / decoder-hardening territory, explicitly out of scope
///     here) and a migration story for already-created escrows.
///   * Option b adds only a compile-time constant and a conditional around
///     the existing reputation CPI. Fund flow is byte-for-byte unchanged:
///     the refund + any Submitted-milestone auto-pay (the C1 "silence =
///     acceptance" settlement) still execute *immediately* at `deadline`.
///     Only the negative reputation delta is deferred until the protocol is
///     confident the provider was genuinely silent rather than censored for
///     one block. This removes both the "instant slash at deadline+1" grief
///     and the front-run profitability (the griefing client must now wait
///     the full window for the slash, while gaining no earlier access to
///     funds than before), with zero blast radius on serialization-coupled
///     consumers.
///
/// 1 hour (3600 s) is long enough that a single-block / short-burst censor
/// of `submit_milestone` no longer yields a slash, while still bounding the
/// provider's reputational exposure to a delayed-but-certain penalty for a
/// genuine non-delivery. It is intentionally short relative to
/// `MAX_ESCROW_DEADLINE_SECS`; governance tuning of this value is a possible
/// future ADR (analogous to ADR-102) but is out of scope for this fix.
pub const SLASH_CHALLENGE_WINDOW_SECS: i64 = 3600;

/// Reputation deltas for CPI updates to the Agent Registry.
/// Finding #19: Defaults for the governance-owned `ProtocolConfig` fields
/// `reputation_delta_task_completed`, `_dispute_loss`, `_expiry_undelivered`.
///
/// AUD-001 / AUD-002 (PR-G): the Registry now caps `|delta| <= 10` per call
/// (`MAX_DELTA_PER_CALL`) and clamps scores to `[0, 100]`. The legacy
/// defaults (50, -25, -10) lived in the old unbounded-u64 reputation model
/// and are no longer compatible with the unified policy. Bring them inside
/// the new range. Governance can tune via `update_protocol_config`.
///   - task_completed:     +10 (the cap; rewards saturate quickly so
///                              repeated tasks accrue reputation linearly
///                              up to the [0, 100] ceiling)
///   - dispute_loss:        -5  (moderate penalty for an adjudicated loss)
///   - expiry_undelivered:  -3  (lighter penalty for a stalled task)
pub const DEFAULT_REPUTATION_DELTA_TASK_COMPLETED: i64 = 10;
pub const DEFAULT_REPUTATION_DELTA_DISPUTE_LOSS: i64 = -5;
pub const DEFAULT_REPUTATION_DELTA_EXPIRY_UNDELIVERED: i64 = -3;

/// SEC-11 (per ADR-075, Accepted 2026-04-25): lower bound on slash-style
/// reputation deltas. The pre-fix `update_protocol_config` check was `v <=
/// 0`, which admits `i64::MIN`. The registry's slashing math then panics
/// on `(-reputation_delta) as u64` in debug mode because `-i64::MIN`
/// overflows.
///
/// AUD-102 (cycle-2): match Registry's per-call cap (`MAX_DELTA_PER_CALL =
/// 10`). The previous Settlement-side bounds (`-1_000_000`) were five
/// orders of magnitude wider than the Registry's `i16` cap, so any
/// "valid" Settlement-side governance value beyond ±10 would revert at the
/// Registry constraint via the i16 clamp + magnitude check in
/// `propose_reputation_delta`. Tightening here turns a runtime CPI revert
/// into a governance-time `update_protocol_config` reject, matching the
/// Registry policy exactly.
pub const MIN_REPUTATION_DELTA: i64 = -10;

/// AUD-102 (cycle-2): upper bound on reward-style reputation deltas. The
/// pre-fix `update_protocol_config` check was `v >= 0`, which admits
/// `i64::MAX` — and the Registry's `i16` clamp + `|delta| <=
/// MAX_DELTA_PER_CALL = 10` would then reject every CPI. Cap at +10 here
/// so governance-time values are guaranteed to satisfy the Registry's
/// per-call cap.
pub const MAX_REPUTATION_DELTA: i64 = 10;

/// Finding #19: Seed for the single-instance `ProtocolConfig` PDA.
/// Derived as `[b"protocol_config"]` under this program's ID.
pub const PROTOCOL_CONFIG_SEED: &[u8] = b"protocol_config";

// Finding #19: Back-compat aliases — downstream modules still reference
// these names. They resolve to the default constants above.
pub const MIN_ESCROW_AMOUNT: u64 = DEFAULT_MIN_ESCROW_AMOUNT;
pub const DISPUTE_TIMEOUT_SECONDS: i64 = DEFAULT_DISPUTE_TIMEOUT_SECONDS;
pub const REPUTATION_DELTA_TASK_COMPLETED: i64 = DEFAULT_REPUTATION_DELTA_TASK_COMPLETED;
pub const REPUTATION_DELTA_DISPUTE_LOSS: i64 = DEFAULT_REPUTATION_DELTA_DISPUTE_LOSS;
pub const REPUTATION_DELTA_EXPIRY_UNDELIVERED: i64 = DEFAULT_REPUTATION_DELTA_EXPIRY_UNDELIVERED;

// ============================================================================
// ACCOUNT STRUCTS
// ============================================================================

#[account]
pub struct TaskEscrow {
    pub client: Pubkey,
    pub provider: Pubkey,
    pub client_vault: Pubkey,
    pub provider_vault: Pubkey,
    pub token_mint: Pubkey,
    pub total_amount: u64,
    pub released_amount: u64,
    pub milestones: Vec<Milestone>,
    pub status: EscrowStatus,
    pub task_id: u64,
    pub description_hash: [u8; 32],
    pub created_at: i64,
    pub deadline: i64,
    pub dispute_resolver: Option<Pubkey>,
    /// ADR-047: Timestamp when dispute was raised. None if not disputed.
    /// Uses Option<i64> instead of sentinel 0 for proper null semantics.
    pub disputed_at: Option<i64>,
    pub bump: u8,
}

/// Finding #19 (ARCHITECTURE_DEEP_CRITIQUE): On-chain governance parameters
/// for the Settlement program. Before this account existed, the economic
/// tunables (minimum escrow, dispute timeout, reputation deltas) were
/// compile-time constants — changing any of them required a full program
/// redeploy. Now they live in a single PDA owned by this program and can
/// be updated by `update_protocol_config` from an authority-gated tx.
///
/// This is an *interim* governance path. A richer DAO/multisig scheme is
/// out of scope; the `authority` field can be rotated to any key — a
/// timelock or multisig program's PDA would be a natural upgrade target.
///
/// AUD-202 (cycle-3): `#[repr(C)]` is load-bearing. Agent Registry's
/// `verify_protocol_invariants` reads `authority` from raw account bytes
/// at offset `[8..40]` (8 = Anchor discriminator, then `authority`'s 32
/// bytes). Borsh serializes fields in declaration order, so as long as
/// `authority` is the first declared field the on-wire layout is correct.
/// `#[repr(C)]` additionally pins the in-memory layout to declaration
/// order, which lets the `const _: ()` block below assert at *Settlement
/// build time* that `authority` has not been displaced — failing the
/// build before any drifted binary can ship. AUD-104 closed the
/// discriminator-name leg of this gate; AUD-202 closes the field-order
/// leg. See also the runtime Borsh-layout regression test in this file's
/// `#[cfg(test)] mod layout_pin` and the symmetric Registry-side
/// regression test `aud_202_*` in
/// `programs/agent-registry/src/lib.rs`.
#[account]
#[repr(C)]
pub struct ProtocolConfig {
    /// Key authorized to run `update_protocol_config`. Can be rotated.
    ///
    /// AUD-202: MUST remain the first declared field. Registry's
    /// `verify_protocol_invariants` reads bytes `[8..40]` of the raw
    /// account data as this pubkey. Reordering or prepending another
    /// field would silently break every governance sweep — see the
    /// `const _: ()` build-time pin below and the layout-pin test
    /// module at the bottom of this file.
    pub authority: Pubkey,

    /// ADR-028: minimum escrow amount in token base units. Anti-sybil floor.
    pub min_escrow_amount: u64,

    /// ADR-030: seconds between `raise_dispute` and the earliest timestamp
    /// at which `resolve_dispute_timeout` may auto-resolve.
    pub dispute_timeout_seconds: i64,

    /// ADR-039: positive delta applied via CPI when the final milestone is approved.
    pub reputation_delta_task_completed: i64,

    /// ADR-039: negative delta applied via CPI when a dispute resolves against the provider.
    pub reputation_delta_dispute_loss: i64,

    /// ADR-050: negative delta applied via CPI when an escrow expires with undelivered milestones.
    pub reputation_delta_expiry_undelivered: i64,

    /// PDA bump for re-derivation.
    pub bump: u8,
}

// AUD-202 (cycle-3): build-time pin on `ProtocolConfig`'s field-order
// layout. Combined with `#[repr(C)]` on the struct above, in-memory
// offsets equal declaration order, and Borsh (used by Anchor for on-wire
// serialization) also follows declaration order — so an `offset_of!`
// check on the in-memory layout transitively pins the on-wire layout
// Registry depends on. If anyone ever prepends a field to
// `ProtocolConfig`, this assertion fires at *Settlement build time*,
// before any drifted binary can ship to a cluster where Registry would
// silently read garbage as `config_authority`.
//
// `core::mem::offset_of!` is stable since Rust 1.77; const `assert!` is
// stable since 1.79. The workspace toolchain is `stable` (see
// rust-toolchain.toml), well above both floors. Done with `core::mem`
// rather than the `static_assertions` crate to avoid a new workspace
// dependency for a one-off check.
const _: () = {
    assert!(
        core::mem::offset_of!(ProtocolConfig, authority) == 0,
        "AUD-202: `authority` must be the first field of ProtocolConfig — \
         Agent Registry's verify_protocol_invariants reads bytes [8..40] of \
         the raw account as this pubkey. Reordering or prepending a field \
         would silently break every governance sweep. See programs/\
         agent-registry/src/lib.rs:766-799."
    );
};

impl ProtocolConfig {
    /// Explicit serialized size (8 disc + fields + margin).
    /// 8 (disc) + 32 (authority) + 8 (min_escrow) + 8 (timeout)
    /// + 8*3 (3 deltas) + 1 (bump) + 7 (margin) = 88 bytes.
    pub const SPACE: usize = 88;
}

#[derive(Clone, Debug, PartialEq, AnchorSerialize, AnchorDeserialize)]
pub struct Milestone {
    pub description_hash: [u8; 32],
    pub amount: u64,
    pub status: MilestoneStatus,
    /// ADR-102: slot after which a slash may be applied for this milestone.
    /// Set to `submission_slot + grace_period_slots` by `submit_milestone`.
    /// Zero (default / no grace requested) means slashing is always permitted.
    pub grace_ends_at: u64,
}

#[derive(Clone, Debug, PartialEq, AnchorSerialize, AnchorDeserialize)]
pub enum MilestoneStatus {
    Pending,
    Submitted,
    Approved,
    Rejected,
    Disputed,
}

impl std::fmt::Display for MilestoneStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MilestoneStatus::Pending => write!(f, "Pending"),
            MilestoneStatus::Submitted => write!(f, "Submitted"),
            MilestoneStatus::Approved => write!(f, "Approved"),
            MilestoneStatus::Rejected => write!(f, "Rejected"),
            MilestoneStatus::Disputed => write!(f, "Disputed"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, AnchorSerialize, AnchorDeserialize)]
pub enum EscrowStatus {
    Created,
    Active,
    Completed,
    Disputed,
    Cancelled,
    Expired,
}

impl std::fmt::Display for EscrowStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EscrowStatus::Created => write!(f, "Created"),
            EscrowStatus::Active => write!(f, "Active"),
            EscrowStatus::Completed => write!(f, "Completed"),
            EscrowStatus::Disputed => write!(f, "Disputed"),
            EscrowStatus::Cancelled => write!(f, "Cancelled"),
            EscrowStatus::Expired => write!(f, "Expired"),
        }
    }
}

// ============================================================================
// INSTRUCTION STRUCTS
// ============================================================================

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct MilestoneData {
    pub description_hash: [u8; 32],
    pub amount: u64,
}

// ============================================================================
// LAYOUT PIN — AUD-202 (cycle-3)
// ============================================================================

#[cfg(test)]
mod layout_pin {
    //! AUD-202 (cycle-3): runtime Borsh-layout regression tests for
    //! `ProtocolConfig`. The compile-time `const _: ()` block above pins
    //! the in-memory layout via `#[repr(C)] + offset_of!`; this module
    //! verifies the *on-wire* (Borsh / Anchor `try_serialize`) layout that
    //! Agent Registry actually reads. The two checks are belt-and-braces:
    //! `#[repr(C)]` + Borsh's "fields in declaration order" contract make
    //! them equivalent, but if either contract ever changed (e.g. an
    //! upstream Anchor major-version that switched serialization formats),
    //! these tests would be the second line of defense.
    //!
    //! See `verify_protocol_invariants` at
    //! `programs/agent-registry/src/lib.rs:764-799` for the consumer of
    //! this layout invariant.
    use super::*;
    use anchor_lang::AccountSerialize;

    /// AUD-202: with the discriminator stripped, `authority` must occupy
    /// the first 32 bytes of the Borsh-serialized payload. Equivalently,
    /// it must occupy bytes `[8..40]` of the raw account data Registry
    /// reads.
    #[test]
    fn aud_202_authority_at_offset_zero_after_discriminator() {
        let authority = Pubkey::new_from_array([0xAB; 32]);
        let cfg = ProtocolConfig {
            authority,
            min_escrow_amount: 10_000,
            dispute_timeout_seconds: 7 * 24 * 3600,
            reputation_delta_task_completed: 10,
            reputation_delta_dispute_loss: -5,
            reputation_delta_expiry_undelivered: -3,
            bump: 255,
        };

        let mut buf: Vec<u8> = Vec::with_capacity(ProtocolConfig::SPACE);
        cfg.try_serialize(&mut buf)
            .expect("ProtocolConfig must serialize");

        // Anchor's `try_serialize` writes 8-byte discriminator + Borsh
        // payload. The discriminator is the same `cf 5b fa 1c 98 b3 d7 d1`
        // hardcoded in `agent-registry/src/lib.rs::PROTOCOL_CONFIG_DISCRIMINATOR`.
        assert!(
            buf.len() >= 8 + 32,
            "serialized ProtocolConfig must be at least 40 bytes (8 disc + 32 authority)"
        );

        // Bytes [8..40] of the on-wire layout MUST equal the authority
        // pubkey. This is the exact slice Registry reads at
        // `verify_protocol_invariants`. If a field is ever prepended to
        // `ProtocolConfig`, those bytes will instead hold the new field's
        // serialization, this assertion will fail, and the build's test
        // suite will block the bad change before redeploy.
        assert_eq!(
            &buf[8..8 + 32],
            authority.as_ref(),
            "AUD-202: bytes [8..40] of serialized ProtocolConfig must be \
             the authority pubkey. If this fails, a field has been \
             reordered/prepended and Registry's verify_protocol_invariants \
             will silently reject every legitimate sweep."
        );
    }

    /// AUD-202: simulate the footgun. Construct a hypothetical "drifted"
    /// payload as if Settlement had prepended a `u64` field before
    /// `authority` (Borsh-serialized = 8 bytes of LE), then verify that a
    /// reader using the AUD-104 gate's `[8..40]` slice would read the
    /// prepended field's bytes instead of the authority — i.e. confirms
    /// the threat is real and the pin above is what closes it.
    ///
    /// This test does NOT modify `ProtocolConfig`; it constructs a raw
    /// byte buffer that mimics what Settlement WOULD serialize if a
    /// future refactor added a leading field, and proves the resulting
    /// bytes do not match the actual authority. The compile-time pin
    /// above is what prevents this drift from ever materializing in a
    /// real `ProtocolConfig`.
    #[test]
    fn aud_202_simulated_prepended_field_breaks_authority_offset() {
        let authority = Pubkey::new_from_array([0xCD; 32]);
        let prepended_value: u64 = 0xDEAD_BEEF_CAFE_F00D;

        // Hypothetical drifted on-wire layout:
        //   [0..8]   = Anchor discriminator (any 8 bytes for the simulation)
        //   [8..16]  = prepended u64 (Borsh LE)
        //   [16..48] = authority (the field that USED to be at [8..40])
        let mut drifted = Vec::with_capacity(48);
        drifted.extend_from_slice(&[0u8; 8]); // disc placeholder
        drifted.extend_from_slice(&prepended_value.to_le_bytes());
        drifted.extend_from_slice(authority.as_ref());

        // What Registry's AUD-104 gate would read at the (now-stale) offset:
        let reader_offset_authority = &drifted[8..8 + 32];

        // Confirm the threat: the reader does NOT see the real authority,
        // it sees the prepended u64 followed by the first 24 bytes of the
        // real authority — i.e. garbage. This is precisely the silent
        // mis-read AUD-202 flagged.
        assert_ne!(
            reader_offset_authority,
            authority.as_ref(),
            "AUD-202: a prepended field WOULD shift authority past offset 8 — \
             confirming this was a real footgun before the field-order pin \
             closed it. The compile-time `const _: ()` block above + \
             `#[repr(C)]` on `ProtocolConfig` now prevents this drift from \
             ever reaching the build."
        );

        // And specifically the first 8 bytes the reader sees are the
        // prepended u64 (Borsh LE), not any portion of the authority.
        assert_eq!(
            &reader_offset_authority[..8],
            &prepended_value.to_le_bytes(),
            "AUD-202: reader at offset 8 would mistake the prepended field's \
             bytes for the authority's leading bytes."
        );
    }
}
