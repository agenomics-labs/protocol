use anchor_lang::prelude::*;

/// Maximum number of tokens in the allowlist.
/// Chosen to fit within the 1024-byte allocation headroom: 10 * 32 bytes = 320 bytes.
pub const MAX_TOKEN_ALLOWLIST: usize = 10;

/// Maximum number of programs in the allowlist.
/// Same sizing rationale as token allowlist.
pub const MAX_PROGRAM_ALLOWLIST: usize = 10;

/// Maximum number of per-token daily spend tracking records.
/// Matches MAX_TOKEN_ALLOWLIST so every allowlisted token can be tracked.
pub const MAX_TOKEN_SPEND_RECORDS: usize = 10;

/// Tracks per-token daily spending for a specific mint.
///
/// Findings #13/#14: Each record now carries its own `per_tx_limit` and
/// `daily_limit` expressed in the token's base units. This replaces the
/// previous scheme where the vault's SOL-lamport `daily_limit_lamports`
/// was reused as the cap for every mint, conflating decimal schemes
/// (0.01 SOL = 10M lamports vs. 10M USDC base units = 10 USDC).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct TokenSpendRecord {
    /// The SPL token mint this record tracks.
    pub mint: Pubkey,
    /// Maximum amount of this token transferable in a single tx (base units).
    pub per_tx_limit: u64,
    /// Maximum amount of this token transferable per day (base units).
    pub daily_limit: u64,
    /// Amount of this token spent today (in base units).
    pub spent_today: u64,
    /// The day for which spent_today is tracked (Unix timestamp / 86400).
    pub last_spend_day: u64,
}

#[account]
pub struct Vault {
    /// The agent identity this vault is linked to (for reputation tracking).
    pub agent_identity: Pubkey,

    /// The authority that can pause/resume and update policies.
    pub authority: Pubkey,

    /// When true, no transfers or program calls are permitted.
    pub paused: bool,

    /// Cumulative SOL spent today (resets daily).
    pub spent_today_lamports: u64,

    /// The day for which spent_today_lamports is tracked (Unix timestamp / 86400).
    pub last_spend_day: u64,

    /// Spending policy for this vault.
    pub policy: VaultPolicy,

    /// Counter for transactions in the current rate-limit window.
    pub txs_in_current_window: u32,

    /// Timestamp of when the current rate-limit window started.
    pub rate_limit_window_start: i64,

    /// Per-token daily spending records (max MAX_TOKEN_SPEND_RECORDS entries).
    pub token_spend_records: Vec<TokenSpendRecord>,

    /// PDA bump seed for vault signing in CPIs.
    pub bump: u8,

    /// ADR-095 / ADR-097: The registration nonce of the agent's current
    /// `AgentProfile` PDA at the time this vault was initialized. Used by
    /// `execute_transfer` and `execute_token_transfer` to re-derive the
    /// profile PDA address for the suspension check. Must match the nonce
    /// stamped in `AgentProfile.registration_nonce`.
    pub profile_nonce: u64,

    /// AUD-023 / PR-X: Unix timestamp of the most recent
    /// `update_agent_identity` rotation. Used to enforce a sliding-window
    /// rotation cap of one rotation per 24h, preventing a compromised
    /// authority from rotating to a fresh hot key, draining the daily cap,
    /// and rotating again to bypass the daily limit.
    ///
    /// Initialized to 0 by `initialize_vault`, so the very first rotation
    /// always succeeds. Updated to `Clock::get()?.unix_timestamp` on every
    /// successful rotation.
    ///
    /// Migration note: vaults deployed before PR-X have this field
    /// implicitly set to 0 (Anchor zero-fills new fields at the end of the
    /// account on first deserialization after the upgrade). Their first
    /// rotation post-upgrade is therefore unrestricted; subsequent rotations
    /// are gated by the 24h window. Bumps the account `space` by 8 bytes.
    pub last_rotation_at: i64,
}

// ADR-039: AuditEntry struct removed — auditing is done via emit! events,
// not on-chain accounts. See TransactionExecuted, ProgramCallExecuted,
// TokenTransferExecuted events for the audit trail.

/// The spending policy for a vault.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct VaultPolicy {
    /// Maximum SOL that can be transferred in a single transaction (in lamports).
    pub per_tx_limit_lamports: u64,

    /// Maximum SOL that can be transferred per day (in lamports).
    pub daily_limit_lamports: u64,

    /// Maximum number of transactions allowed per hour.
    pub max_txs_per_hour: u32,

    /// Bitmap for token allowlist (if None, all tokens allowed; if Some, only listed tokens).
    /// This is a simplified version; production would use a separate account for large lists.
    pub token_allowlist: Vec<Pubkey>,

    /// Bitmap for program allowlist (if None, all programs allowed; if Some, only listed programs).
    pub program_allowlist: Vec<Pubkey>,
}

impl VaultPolicy {
    pub fn new(
        per_tx_limit_lamports: u64,
        daily_limit_lamports: u64,
        max_txs_per_hour: u32,
    ) -> Self {
        Self {
            per_tx_limit_lamports,
            daily_limit_lamports,
            max_txs_per_hour,
            token_allowlist: vec![],
            program_allowlist: vec![],
        }
    }

    /// Checks if a token is allowed for transfer.
    pub fn is_token_allowed(&self, mint: &Pubkey) -> bool {
        if self.token_allowlist.is_empty() {
            return true; // No allowlist = all tokens allowed
        }
        self.token_allowlist.contains(mint)
    }

    /// Checks if a program is allowed to be invoked.
    pub fn is_program_allowed(&self, program_id: &Pubkey) -> bool {
        if self.program_allowlist.is_empty() {
            return true; // No allowlist = all programs allowed
        }
        self.program_allowlist.contains(program_id)
    }
}

// ADR-050: VaultAction enum removed — was orphaned dead code from the removed AuditEntry struct.
// Audit logging uses emit! events (TransactionExecuted, ProgramCallExecuted, etc.).
