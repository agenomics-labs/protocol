use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::state::Vault;
use crate::errors::VaultError;

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<Vault>() + 1024,
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

#[derive(Accounts)]
pub struct ExecuteProgramCall<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    /// The signer must be the agent authority or the vault authority.
    pub agent: Signer<'info>,
}

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
    #[account(mut)]
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
