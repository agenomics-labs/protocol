use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::*;
use crate::errors::*;

#[derive(Accounts)]
#[instruction(task_id: u64, total_amount: u64, description_hash: [u8; 32], deadline: i64, milestones_data: Vec<MilestoneData>, dispute_resolver: Option<Pubkey>)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    /// Client's vault (from Agent Vault program)
    /// CHECK: Stored as reference; not deserialized. Validated off-chain.
    pub client_vault: UncheckedAccount<'info>,

    /// Provider's vault (from Agent Vault program)
    /// CHECK: Stored as reference; not deserialized. Validated off-chain.
    pub provider_vault: UncheckedAccount<'info>,

    /// The provider's public key
    /// CHECK: Stored as the task provider identity. Not deserialized.
    pub provider: UncheckedAccount<'info>,

    /// Token mint (e.g., USDC)
    pub token_mint: Account<'info, Mint>,

    /// Client's token account to transfer from
    #[account(mut)]
    pub client_token_account: Account<'info, TokenAccount>,

    /// Escrow state account
    ///
    /// ADR-050: Explicit space breakdown:
    /// 8 (disc) + 160 (5 pubkeys) + 16 (amounts) + 209 (5 milestones max: 4+5*(32+8+1))
    /// + 1 (status) + 8 (task_id) + 32 (desc_hash) + 16 (timestamps)
    /// + 33 (dispute_resolver Option<Pubkey>) + 9 (disputed_at Option<i64>)
    /// + 1 (bump) = 493 + 200 margin = 693
    #[account(
        init,
        payer = client,
        space = 693,
        seeds = [b"escrow", client.key().as_ref(), provider.key().as_ref(), &task_id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, TaskEscrow>,

    /// Escrow token account (ATA of escrow PDA)
    #[account(
        init,
        payer = client,
        associated_token::mint = token_mint,
        associated_token::authority = escrow
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AcceptTask<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(
        mut,
        has_one = provider @ SettlementError::UnauthorizedProvider,
    )]
    pub escrow: Account<'info, TaskEscrow>,
}

#[derive(Accounts)]
pub struct SubmitMilestone<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(
        mut,
        has_one = provider @ SettlementError::UnauthorizedProvider,
    )]
    pub escrow: Account<'info, TaskEscrow>,
}

#[derive(Accounts)]
pub struct ApproveMilestone<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    #[account(
        mut,
        has_one = client @ SettlementError::UnauthorizedClient,
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        constraint = escrow_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = escrow_token_account.owner == escrow.key() @ SettlementError::InvalidTokenAccount,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = provider_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = provider_token_account.owner == escrow.provider @ SettlementError::InvalidTokenAccount,
    )]
    pub provider_token_account: Account<'info, TokenAccount>,

    /// Agent Registry program for CPI reputation updates.
    /// CHECK: Validated by constraint against AGENT_REGISTRY_PROGRAM_ID.
    #[account(
        executable,
        constraint = registry_program.key() == AGENT_REGISTRY_PROGRAM_ID @ SettlementError::InvalidRegistryProgram
    )]
    pub registry_program: UncheckedAccount<'info>,

    /// CHECK: Provider's AgentProfile PDA in the Registry program.
    /// Seeds: [provider.key(), b"agent-profile"]. Validated by Registry program during CPI.
    #[account(mut)]
    pub provider_profile: UncheckedAccount<'info>,

    /// Settlement authority PDA — this program's signing authority for CPI calls.
    /// The Registry program verifies this PDA as a signer with seeds::program = SETTLEMENT_PROGRAM_ID.
    /// CHECK: Derived from this program's ID; seeds verified by Anchor.
    #[account(
        seeds = [b"settlement_authority"],
        bump
    )]
    pub settlement_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RejectMilestone<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    #[account(
        mut,
        has_one = client @ SettlementError::UnauthorizedClient,
    )]
    pub escrow: Account<'info, TaskEscrow>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,

    #[account(
        mut,
        constraint = escrow.client == requester.key() || escrow.provider == requester.key()
            @ SettlementError::UnauthorizedDispute,
    )]
    pub escrow: Account<'info, TaskEscrow>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(mut)]
    pub resolver: Signer<'info>,

    #[account(mut)]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        constraint = escrow_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = escrow_token_account.owner == escrow.key() @ SettlementError::InvalidTokenAccount,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = client_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = client_token_account.owner == escrow.client @ SettlementError::InvalidTokenAccount,
    )]
    pub client_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = provider_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = provider_token_account.owner == escrow.provider @ SettlementError::InvalidTokenAccount,
    )]
    pub provider_token_account: Account<'info, TokenAccount>,

    /// ADR-039: Registry program for slashing reputation on dispute
    /// CHECK: Validated by constraint against AGENT_REGISTRY_PROGRAM_ID.
    #[account(
        executable,
        constraint = registry_program.key() == AGENT_REGISTRY_PROGRAM_ID @ SettlementError::InvalidRegistryProgram
    )]
    pub registry_program: UncheckedAccount<'info>,

    /// CHECK: Provider's AgentProfile PDA. Validated by Registry during CPI.
    #[account(mut)]
    pub provider_profile: UncheckedAccount<'info>,

    /// CHECK: Settlement authority PDA for CPI signing.
    #[account(seeds = [b"settlement_authority"], bump)]
    pub settlement_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

/// ADR-030/050: Context for auto-resolving a dispute after timeout.
/// Includes registry accounts for provider reputation slashing.
#[derive(Accounts)]
pub struct ResolveDisputeTimeout<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        constraint = escrow_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = escrow_token_account.owner == escrow.key() @ SettlementError::InvalidTokenAccount,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = client_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = client_token_account.owner == escrow.client @ SettlementError::InvalidTokenAccount,
    )]
    pub client_token_account: Account<'info, TokenAccount>,

    /// ADR-050: Registry accounts for slashing on timeout
    /// CHECK: Validated by constraint.
    #[account(
        executable,
        constraint = registry_program.key() == AGENT_REGISTRY_PROGRAM_ID @ SettlementError::InvalidRegistryProgram
    )]
    pub registry_program: UncheckedAccount<'info>,

    /// CHECK: Provider's AgentProfile PDA. Validated by Registry during CPI.
    #[account(mut)]
    pub provider_profile: UncheckedAccount<'info>,

    /// CHECK: Settlement authority PDA for CPI signing.
    #[account(seeds = [b"settlement_authority"], bump)]
    pub settlement_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    #[account(
        mut,
        has_one = client @ SettlementError::UnauthorizedClient,
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        constraint = escrow_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = escrow_token_account.owner == escrow.key() @ SettlementError::InvalidTokenAccount,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = client_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = client_token_account.owner == escrow.client @ SettlementError::InvalidTokenAccount,
    )]
    pub client_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExpireEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        constraint = escrow_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = escrow_token_account.owner == escrow.key() @ SettlementError::InvalidTokenAccount,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = client_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = client_token_account.owner == escrow.client @ SettlementError::InvalidTokenAccount,
    )]
    pub client_token_account: Account<'info, TokenAccount>,

    /// Provider's token account for releasing earned milestone funds on expiry.
    #[account(
        mut,
        constraint = provider_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = provider_token_account.owner == escrow.provider @ SettlementError::InvalidTokenAccount,
    )]
    pub provider_token_account: Account<'info, TokenAccount>,

    /// ADR-050: Registry accounts for slashing on expiry with undelivered milestones
    /// CHECK: Validated by constraint.
    #[account(
        executable,
        constraint = registry_program.key() == AGENT_REGISTRY_PROGRAM_ID @ SettlementError::InvalidRegistryProgram
    )]
    pub registry_program: UncheckedAccount<'info>,

    /// CHECK: Provider's AgentProfile PDA. Validated by Registry during CPI.
    #[account(mut)]
    pub provider_profile: UncheckedAccount<'info>,

    /// CHECK: Settlement authority PDA for CPI signing.
    #[account(seeds = [b"settlement_authority"], bump)]
    pub settlement_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}
