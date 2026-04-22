use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::state::Vault;
use crate::errors::VaultError;

/// ADR-050 + findings #13/#14: Explicit serialized size.
/// 8 (disc) + 32 (agent_id) + 32 (authority) + 1 (paused) + 8 (spent_today) + 8 (last_day)
/// + VaultPolicy: 8+8+4+324+324=668 + 4 (txs_window) + 8 (rate_start)
/// + 4+(10*(32+8+8+8+8))=644 (token_spend_records, now carrying per-mint limits)
/// + 1 (bump) = 1414 + 200 margin = 1614
#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = authority,
        space = 1614,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// ADR-041: All vault mutation contexts use has_one=authority for defense-in-depth.
#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ManageAllowlist<'info> {
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}

/// ADR-069 (SEC-2): Context for rotating `vault.agent_identity`.
///
/// `agent_identity` is a **hot key**: it is supplied by the authority at
/// `initialize_vault` with no on-chain validation, and it is one of two keys
/// (alongside `authority`) accepted as a signer for `execute_transfer` /
/// `execute_token_transfer`. Compromise of the off-chain agent-runtime key
/// bound to `agent_identity` means an attacker can drain up to the daily cap
/// indefinitely — and the human-custodied `authority` cannot revoke it
/// without this dedicated rotation path.
///
/// Rotation is deliberately unilateral: `has_one = authority` gates the
/// context with no multisig requirement. The threat model assumes `authority`
/// is the human-custodied root of trust; forcing multisig would defeat the
/// fast-rotation design goal (see ADR-069 Alternatives Considered).
#[derive(Accounts)]
pub struct UpdateAgentIdentity<'info> {
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ManageProgramAllowlist<'info> {
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteTransfer<'info> {
    /// The vault PDA — serves as both state account and SOL source.
    /// ADR-029: Removed vestigial vault_account field; the vault PDA itself
    /// holds SOL and is used directly for lamport transfers.
    #[account(
        mut,
        seeds = [b"vault", vault.authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    /// The signer must be the agent authority or the vault authority.
    pub agent: Signer<'info>,

    /// CHECK: The recipient of the SOL transfer; validated in instruction handler.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ADR-050: ExecuteProgramCall removed — see lib.rs comment.

#[derive(Accounts)]
pub struct ExecuteTokenTransfer<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    /// The signer must be the agent authority or the vault authority.
    pub agent: Signer<'info>,

    /// The vault's token account (source of SPL tokens). Must be owned by the vault PDA.
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key() @ VaultError::Unauthorized,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// The recipient's token account.
    ///
    /// Constraints:
    /// - Mint must match `vault_token_account.mint` (already-mitigated per
    ///   DEEP-AUDIT-2026-04-22 Audit 1 finding SEC-6 — retained as-is).
    /// - ADR-072 (SEC-6): The recipient account must NOT be the vault's own
    ///   token account (the exact same account) AND its SPL owner must not
    ///   be the vault PDA. This blocks a self-transfer loop that would
    ///   otherwise let a griefer (or a compromised `agent_identity`) burn
    ///   rate-limit slots and exhaust the hourly window during incident
    ///   response — every self-transfer is a no-op at the token-program
    ///   layer but still increments `txs_in_current_window`.
    ///
    /// Note: the recipient-mint match was already present pre-ADR-072; the
    /// recipient-owner / self-account checks are the net-new SEC-6 fix.
    #[account(
        mut,
        constraint = recipient_token_account.mint == vault_token_account.mint @ VaultError::TokenNotAllowed,
        constraint = recipient_token_account.key() != vault_token_account.key() @ VaultError::SelfTransferNotAllowed,
        constraint = recipient_token_account.owner != vault.key() @ VaultError::SelfTransferNotAllowed,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PauseVault<'info> {
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResumeVault<'info> {
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}
