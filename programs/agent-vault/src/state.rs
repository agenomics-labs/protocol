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

    /// ADR-138: monotonically-increasing counter incremented on every
    /// successful `update_policy` call. Stamped into every
    /// `ExecutionAttested` event so off-chain consumers can pin which
    /// policy version was in force when a value-moving action executed.
    ///
    /// Initialized to 0 by `initialize_vault`. Bumped via
    /// `checked_add(1)` in `update_policy`; the protocol does NOT support
    /// rollback, so the field is strictly increasing across the vault's
    /// lifetime.
    ///
    /// Migration note: vaults deployed before ADR-138 have this field
    /// implicitly set to 0 on first post-upgrade deserialization (Anchor
    /// zero-fills new trailing fields). Their first `update_policy` after
    /// the upgrade lands at version 1; subsequent actions are stamped
    /// with whatever the cumulative version is. Bumps the account `space`
    /// by 4 bytes.
    pub policy_version: u32,

    /// ADR-111: Count of `DelegationGrant` PDAs currently outstanding for
    /// this vault. Bumped on `create_delegation_grant`, decremented on
    /// `revoke_delegation_grant`. The vault rejects creation of a new
    /// grant once this reaches `MAX_ACTIVE_GRANTS_PER_VAULT` (32).
    ///
    /// Migration note: vaults deployed before ADR-111 have this field
    /// implicitly set to 0 (Anchor zero-fills new fields appended at the
    /// end of the account on first post-upgrade deserialization). Bumps
    /// the account `space` by 1 byte; the existing 200-byte safety margin
    /// in the vault allocation absorbs it without a layout change.
    ///
    /// Ordering note: this field MUST stay after `policy_version` (ADR-138)
    /// so the Anchor zero-fill semantics work for vaults deployed with the
    /// ADR-138 upgrade but not yet the ADR-111 one. New trailing fields go
    /// at the end of the struct in chronological merge order.
    pub active_grant_count: u8,
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

// ============================================================================
// ADR-111: Delegation grants — bounded, auditable sub-authority
// ============================================================================

/// Maximum number of `allowed_recipients` entries on a single delegation grant.
///
/// ADR-111: bounded so the worst-case grant account size is predictable
/// (8 * 32 = 256 bytes for recipients). Operators who need broader coverage
/// can either (a) issue multiple grants or (b) set the recipient list empty
/// — empty means "any recipient already allowed at the vault level still
/// goes through the vault's own program/recipient gates."
pub const MAX_GRANT_ALLOWED_RECIPIENTS: usize = 8;

/// Maximum number of `token_spend_caps` entries on a single delegation grant.
///
/// Sized to match `MAX_TOKEN_ALLOWLIST` so a grant can carry caps for every
/// token the parent vault is allowed to move.
pub const MAX_GRANT_TOKEN_CAPS: usize = 10;

/// ADR-111 §"Security": Hard cap on active grants per vault. Mirrors the
/// `max_active_grants_per_vault` ProtocolConfig knob the ADR proposes, but
/// is enforced at the program level today (governance plumbing arrives in
/// ADR-111b). At 32 grants × ~512 bytes per PDA worst-case ≈ 16 KB of grant
/// rent per vault, which is the rough 5 SOL ceiling the ADR cites.
pub const MAX_ACTIVE_GRANTS_PER_VAULT: u8 = 32;

/// ADR-111: Bitflags for the actions a delegation grant authorizes.
///
/// Bit-flagged so a single `u8` covers the full action surface and grants
/// can be checked with a cheap `actions & required != 0`. Future bits MUST
/// be appended; reusing a removed bit position is forbidden because it
/// would silently expand the action surface of historical grants.
pub mod grant_actions {
    /// Allow `execute_grant_transfer` (SOL transfers via the grant).
    pub const EXECUTE_TRANSFER: u8 = 0b0000_0001;
    /// Allow `execute_grant_token_transfer` (SPL transfers via the grant).
    pub const EXECUTE_TOKEN_TRANSFER: u8 = 0b0000_0010;
    /// Sentinel for "read-only" grants. A grant with `allowed_actions == 0`
    /// authorizes no transfer instruction — useful for off-chain agents
    /// that only need to observe a vault.
    pub const READ_ONLY: u8 = 0b0000_0000;
    /// All bits that v1 recognizes. `update_delegation_grant` validates
    /// that the new bitmap is a subset of this — unknown bits are
    /// rejected so a future bit cannot be accidentally loosened in a
    /// pre-rotation grant.
    pub const ALL_KNOWN: u8 = EXECUTE_TRANSFER | EXECUTE_TOKEN_TRANSFER;
}

/// ADR-111: Per-mint spend cap for a delegation grant.
///
/// Mirrors the shape of `TokenSpendRecord` but is grant-local — the
/// grantee's spending under a grant is capped per-mint INDEPENDENTLY of
/// the parent vault's daily allocation. A transfer must satisfy BOTH the
/// grant cap AND the vault's per-mint daily cap (see
/// `execute_grant_token_transfer`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct GrantTokenCap {
    /// The SPL token mint this cap covers.
    pub mint: Pubkey,
    /// Lifetime cumulative cap for this mint, in base units.
    pub cap: u64,
    /// Lifetime spent under this grant for this mint, in base units.
    pub spent: u64,
}

/// ADR-111: First-class delegation grant — bounded sub-authority on a vault.
///
/// The grantor is always `vault.authority`; the grantee is a hot key (a
/// pubkey, not necessarily an on-chain account) whose Ed25519 signature
/// over a transaction containing the matching `DelegationGrant` PDA
/// authorizes `execute_grant_transfer` / `execute_grant_token_transfer`.
///
/// Account lifetime: created by `create_delegation_grant`, can be
/// `revoke_delegation_grant`d by either the grantor (vault authority) or
/// the grantee. Revocation does NOT close the account — the audit-trail
/// preservation invariant in ADR-111 §"Enforcement" is implemented by
/// keeping `revoked = true` rows on-chain. Close is deferred to a
/// follow-up `close_delegation_grant` instruction (ADR-111b).
#[account]
pub struct DelegationGrant {
    /// Parent `Vault` PDA. All grant-scoped checks resolve against this
    /// vault's policy / pause / suspension gates.
    pub vault: Pubkey,
    /// The vault `authority` at grant creation. Pinned so a subsequent
    /// authority rotation (none today — but reserved for governance) can't
    /// re-attribute existing grants.
    pub grantor: Pubkey,
    /// The grantee hot key — required signer for `execute_grant_*`.
    pub grantee: Pubkey,
    /// Bitmap of authorized actions (see `grant_actions::*`).
    pub allowed_actions: u8,
    /// Cumulative lifetime SOL spend cap, in lamports.
    pub spend_cap_lamports: u64,
    /// Cumulative lifetime SOL spent under this grant, in lamports.
    pub spent_lamports: u64,
    /// Per-mint SOL/SPL spend caps. Each entry is independent of the
    /// vault's `token_spend_records`. Empty = no SPL transfers allowed
    /// via this grant regardless of `allowed_actions` —
    /// `execute_grant_token_transfer` MUST find a matching cap or fail.
    pub token_spend_caps: Vec<GrantTokenCap>,
    /// Optional list of allowed recipient pubkeys. Empty list means
    /// "any recipient" subject to the vault's own recipient/program
    /// guards. Length bounded by `MAX_GRANT_ALLOWED_RECIPIENTS`.
    pub allowed_recipients: Vec<Pubkey>,
    /// Unix-seconds expiry. `0` is the "no expiry" sentinel. Past-tense
    /// expiry forces every `execute_grant_*` to fail with
    /// `GrantExpired`. Updates can only ratchet this DOWN (see
    /// `update_delegation_grant` invariant).
    pub expires_at: i64,
    /// `true` once `revoke_delegation_grant` has fired. Set is permanent
    /// for the lifetime of the account.
    pub revoked: bool,
    /// Unix-seconds of grant creation. Pinned at create time; never
    /// mutated.
    pub created_at: i64,
    /// PDA nonce. Used as the third seed so a single vault/grantee pair
    /// can hold multiple grants over its lifetime — e.g. a revoked grant
    /// with `nonce = 0` and a fresh grant at `nonce = 1`. Nonce reuse
    /// against an open PDA is impossible (Anchor's `init` constraint
    /// guards it); nonce reuse against a closed PDA is documented as a
    /// future risk in ADR-111 §"Security" — close is deferred to v2.
    pub nonce: u8,
    /// PDA bump cached so the runtime doesn't re-derive on every read.
    pub bump: u8,
}

impl DelegationGrant {
    /// Anchor account discriminator (8) + sized fields:
    ///   vault(32) + grantor(32) + grantee(32) + allowed_actions(1)
    ///   + spend_cap_lamports(8) + spent_lamports(8)
    ///   + token_spend_caps: Vec<GrantTokenCap> — 4 (len) + 10 * (32+8+8) = 484
    ///   + allowed_recipients: Vec<Pubkey>      — 4 (len) + 8 * 32       = 260
    ///   + expires_at(8) + revoked(1) + created_at(8) + nonce(1) + bump(1)
    /// = 8 + 32+32+32 + 1 + 8+8 + 484 + 260 + 8+1+8+1+1 = 884
    /// Pad to 1024 for forward-compat headroom (future v2 sub-delegation
    /// link, optional SAS credential reference per ADR-111 open item #3).
    pub const SPACE: usize = 1024;

    /// `true` iff the grant authorizes `action_bit` (e.g.
    /// `grant_actions::EXECUTE_TRANSFER`).
    pub fn allows(&self, action_bit: u8) -> bool {
        self.allowed_actions & action_bit == action_bit && action_bit != 0
    }

    /// `true` if `recipient` is acceptable under this grant.
    ///
    /// Empty allowlist means "delegate the recipient guard to the vault."
    /// Non-empty allowlist means "the recipient MUST be one of these."
    pub fn is_recipient_allowed(&self, recipient: &Pubkey) -> bool {
        self.allowed_recipients.is_empty() || self.allowed_recipients.contains(recipient)
    }

    /// Project the post-spend lamport tally without mutating.
    pub fn project_spend(&self, amount: u64) -> Option<u64> {
        self.spent_lamports.checked_add(amount)
    }

    /// Returns `true` if the grant is still inside its time window.
    /// `expires_at == 0` is the "no expiry" sentinel.
    pub fn is_within_window(&self, now: i64) -> bool {
        self.expires_at == 0 || now < self.expires_at
    }
}
