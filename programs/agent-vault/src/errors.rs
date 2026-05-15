use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Vault is paused and cannot execute transactions")]
    VaultPaused,

    #[msg("Per-transaction limit exceeded")]
    PerTxLimitExceeded,

    #[msg("Daily spending limit exceeded")]
    DailyLimitExceeded,

    #[msg("Rate limit (transactions per hour) exceeded")]
    RateLimitExceeded,

    #[msg("Token is not in the vault's allowlist")]
    TokenNotAllowed,

    #[msg("Program is not in the vault's program allowlist")]
    ProgramNotAllowed,

    #[msg("Unauthorized: must be vault authority")]
    Unauthorized,

    #[msg("Insufficient funds in vault")]
    InsufficientFunds,

    #[msg("Invalid recipient address")]
    InvalidRecipient,

    #[msg("Invalid amount (must be > 0)")]
    InvalidAmount,

    #[msg("Allowlist is full")]
    AllowlistFull,

    #[msg("Item already in allowlist")]
    ItemAlreadyListed,

    #[msg("Item not found in allowlist")]
    ItemNotFound,

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    #[msg("Per-token daily spending limit exceeded")]
    TokenDailyLimitExceeded,

    #[msg("Token spend records full (max 10)")]
    TokenSpendRecordsFull,

    /// Finding #13: A single-tx amount exceeded the mint's configured per-tx cap.
    #[msg("Per-transaction limit for this token exceeded")]
    PerTxTokenLimitExceeded,

    /// Finding #13/#14: A token transfer was attempted for a mint that
    /// has no configured per-mint limits. Call add_token_allowlist first.
    #[msg("Token not configured: call add_token_allowlist with per-tx/daily limits")]
    TokenNotConfigured,

    /// Finding #13/#14: add_token_allowlist was called with invalid limits
    /// (zero, or per_tx_limit greater than daily_limit).
    #[msg("Invalid token limits: must have 0 < per_tx_limit <= daily_limit")]
    InvalidTokenLimits,

    /// Finding #15: The SOL transfer would leave the vault PDA below the
    /// rent-exempt minimum, risking garbage collection by the Solana runtime.
    #[msg("Transfer would leave vault below rent-exempt minimum")]
    BelowRentExemption,

    /// ADR-072 (SEC-6): The recipient token account's owner is the vault
    /// itself (or the recipient account IS the vault's token account). This
    /// blocks a self-transfer loop that would otherwise let a griefer burn
    /// rate-limit slots and exhaust the window during incident response.
    #[msg("Recipient token account must not be owned by the vault (self-transfer)")]
    SelfTransferNotAllowed,

    /// ADR-095: The agent's Registry profile has status == Suspended.
    /// A suspended agent may not move assets through the vault; suspension
    /// must be resolved via `clear_suspension` before transfers resume.
    #[msg("Agent is suspended in the Registry; transfers are blocked until suspension is cleared")]
    AgentSuspended,

    /// PR-X / AUD-023: `update_agent_identity` was called less than 24h
    /// after the previous rotation. The per-day rotation cap prevents a
    /// compromised authority from rotating to a fresh hot key, draining the
    /// daily cap, and rotating again to bypass the daily limit. Wait until
    /// `vault.last_rotation_at + 86_400` before retrying.
    #[msg("Rotation rate-limited: update_agent_identity may be called at most once per 24h")]
    RotationRateLimited,

    /// ADR-124 / AUD-116 (path-a): `initialize_vault` requires a paired
    /// `Ed25519Program` sig-verify instruction in the same transaction
    /// covering `vault_identity_bind_message(authority, agent_identity)`
    /// signed by the holder of `agent_identity`'s private key. The sysvar
    /// scan found no neighbouring ed25519-program instruction; the caller
    /// must prepend (or append) the precompile ix before re-trying.
    #[msg("initialize_vault requires a paired Ed25519 precompile instruction proving control of agent_identity (ADR-124)")]
    MissingAgentIdentityBindSignature,

    /// ADR-124 / AUD-116 (path-a): a paired ed25519-program instruction was
    /// present, but its inline pubkey / signature / message bytes do not
    /// match the supplied `agent_identity` / `agent_identity_signature` /
    /// `vault_identity_bind_message(authority, agent_identity)`. Either:
    ///   - the signature was produced over the wrong domain-tagged message
    ///     (e.g. wrong authority, wrong agent_identity, or no domain tag);
    ///   - the precompile ix references a different pubkey or signature
    ///     than the handler argument;
    ///   - the precompile data is malformed (cross-instruction reference,
    ///     non-32-byte message, or out-of-range offsets).
    #[msg("The paired Ed25519 instruction does not match the supplied agent_identity / agent_identity_signature / vault_identity_bind_message (ADR-124)")]
    AgentIdentityBindSignatureMismatch,

    // ====================================================================
    // ADR-111: Delegation grant error surface
    // ====================================================================

    /// ADR-111: `execute_grant_*` was invoked against a grant whose
    /// `revoked` flag is set. Revocation is permanent for the lifetime of
    /// the account; the caller must obtain a freshly-issued grant.
    #[msg("Delegation grant has been revoked")]
    GrantRevoked,

    /// ADR-111: The current Unix timestamp is at or past the grant's
    /// `expires_at` boundary. `expires_at == 0` is the no-expiry sentinel
    /// and never raises this.
    #[msg("Delegation grant has expired")]
    GrantExpired,

    /// ADR-111: The requested action bit is not set in
    /// `grant.allowed_actions`. E.g. an `execute_grant_transfer` call
    /// against a grant whose `allowed_actions` only carries
    /// `EXECUTE_TOKEN_TRANSFER`.
    #[msg("Action not permitted by delegation grant")]
    ActionNotAllowed,

    /// ADR-111: The recipient pubkey is not in `grant.allowed_recipients`.
    /// An empty `allowed_recipients` list is the "delegate to vault"
    /// sentinel and never raises this — only a non-empty list with no
    /// match does.
    #[msg("Recipient not allowed by delegation grant")]
    RecipientNotAllowed,

    /// ADR-111: The cumulative spend (lamports or per-mint base units)
    /// would exceed the grant's lifetime cap. Distinct from the vault's
    /// own `DailyLimitExceeded` / `TokenDailyLimitExceeded` so operators
    /// can tell at a glance whether a transfer was blocked by the grant
    /// or by the parent vault.
    #[msg("Delegation grant spend cap exceeded")]
    GrantSpendCapExceeded,

    /// ADR-111: The `vault` PDA passed in the `execute_grant_*` context
    /// is not the same vault that owns the grant. The seeds binding on
    /// the grant PDA already enforces this; the explicit check belt-and-
    /// braces guards against a future loosening of the seeds constraint.
    #[msg("Delegation grant does not belong to the supplied vault")]
    GrantNotForVault,

    /// ADR-111: `update_delegation_grant` attempted a change that would
    /// LOOSEN the grant's scope — e.g. raising `spend_cap_lamports`,
    /// adding a recipient, granting a new action bit, or extending
    /// `expires_at`. Updates are tighten-only by invariant; loosening
    /// requires revoking the old grant and issuing a new one.
    #[msg("Delegation grant updates may only tighten scope (cannot loosen)")]
    GrantUpdateCannotLoosen,

    /// ADR-111: `create_delegation_grant` was attempted while the parent
    /// vault already holds `MAX_ACTIVE_GRANTS_PER_VAULT` active grants.
    /// Operators must revoke a stale grant first.
    #[msg("Vault already holds the maximum number of active delegation grants")]
    TooManyActiveGrants,

    /// ADR-111: Generic input-validation error for grant create/update —
    /// e.g. `allowed_actions` carries an unknown bit, `allowed_recipients`
    /// exceeds the bounded vec, or `expires_at` is in the past at create
    /// time. The error message identifies which guard fired in the docs;
    /// the on-chain message stays generic to avoid leaking sensitive
    /// detail in the log surface.
    #[msg("Invalid delegation grant parameters")]
    InvalidGrantParameters,

    /// ADR-111: A SOL grant transfer was attempted but the grant carries
    /// no `spend_cap_lamports > 0` envelope. Treated separately from
    /// `GrantSpendCapExceeded` so the error message tells the operator
    /// "this grant was issued without lamport authority" rather than
    /// "you've blown the cap."
    #[msg("Delegation grant has no SOL spend authority")]
    GrantHasNoLamportCap,

    /// ADR-111: An SPL grant transfer was attempted for a mint that has
    /// no matching `GrantTokenCap` entry. The grantee can only move
    /// mints the grantor explicitly enumerated at create time.
    #[msg("Delegation grant has no spend authority for this token mint")]
    GrantTokenNotConfigured,
}
