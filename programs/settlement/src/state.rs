use anchor_lang::prelude::*;

// ============================================================================
// CONSTANTS
// ============================================================================

/// Agent Registry program ID — used for CPI reputation updates.
pub const AGENT_REGISTRY_PROGRAM_ID: Pubkey = pubkey!("8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh");

/// Finding #21: Agent Vault program ID — used to validate that
/// `client_vault`/`provider_vault` in `CreateEscrow` are genuine
/// vault PDAs derived under the vault program, not arbitrary
/// 32-byte keys. Must match `declare_id!` in programs/agent-vault/src/lib.rs.
pub const AGENT_VAULT_PROGRAM_ID: Pubkey = pubkey!("4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN");

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

/// Reputation deltas for CPI updates to the Agent Registry.
/// Finding #19: Defaults for the governance-owned `ProtocolConfig` fields
/// `reputation_delta_task_completed`, `_dispute_loss`, `_expiry_undelivered`.
pub const DEFAULT_REPUTATION_DELTA_TASK_COMPLETED: i64 = 50;
pub const DEFAULT_REPUTATION_DELTA_DISPUTE_LOSS: i64 = -25;
pub const DEFAULT_REPUTATION_DELTA_EXPIRY_UNDELIVERED: i64 = -10;

/// SEC-11 (per ADR-075, in-flight): lower bound on slash-style reputation
/// deltas. The pre-fix `update_protocol_config` check was `v <= 0`, which
/// admits `i64::MIN`. The registry's slashing math then panics on
/// `(-reputation_delta) as u64` in debug mode because `-i64::MIN`
/// overflows. -1_000_000 is four orders of magnitude beyond the default
/// slash magnitude (-25) — enough headroom for any plausible tuning while
/// keeping the registry's `checked_neg` comfortably safe.
pub const MIN_REPUTATION_DELTA: i64 = -1_000_000;

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
#[account]
pub struct ProtocolConfig {
    /// Key authorized to run `update_protocol_config`. Can be rotated.
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
