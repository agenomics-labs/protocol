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
}
