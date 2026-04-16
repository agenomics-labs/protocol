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
}
