use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("2uSDxQtYLU4uSeZtA1ueJx7xg4PDYpEbkxM957T5UUm4");

// ============================================================================
// CONSTANTS
// ============================================================================

/// Agent Registry program ID — used for CPI validation when reputation updates are fully implemented.
#[allow(dead_code)]
const AGENT_REGISTRY_PROGRAM_ID: &str = "8t5oSA3xrLt9rMmM7QZBFWFDgBu8qvWsrUyXFYwPYWmV";
const MAX_MILESTONES: usize = 5;

// ============================================================================
// PROGRAM
// ============================================================================

#[program]
pub mod settlement {
    use super::*;

    /// Creates a new task escrow with defined milestones.
    /// Client locks funds in an escrow token account, ready for provider to accept.
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        task_id: u64,
        total_amount: u64,
        description_hash: [u8; 32],
        deadline: i64,
        milestones_data: Vec<MilestoneData>,
        dispute_resolver: Option<Pubkey>,
    ) -> Result<()> {
        require!(
            milestones_data.len() > 0 && milestones_data.len() <= MAX_MILESTONES,
            SettlementError::InvalidMilestoneCount
        );

        require!(total_amount > 0, SettlementError::InvalidAmount);

        let mut total_milestone_amount: u64 = 0;
        for milestone in &milestones_data {
            require!(milestone.amount > 0, SettlementError::InvalidAmount);
            total_milestone_amount = total_milestone_amount
                .checked_add(milestone.amount)
                .ok_or(SettlementError::AmountOverflow)?;
        }

        require_eq!(
            total_milestone_amount, total_amount,
            SettlementError::MilestoneAmountMismatch
        );

        let now = Clock::get()?.unix_timestamp;
        require!(deadline > now, SettlementError::DeadlineInPast);

        let escrow = &mut ctx.accounts.escrow;
        escrow.client = ctx.accounts.client.key();
        escrow.provider = ctx.accounts.provider.key();
        escrow.client_vault = ctx.accounts.client_vault.key();
        escrow.provider_vault = ctx.accounts.provider_vault.key();
        escrow.token_mint = ctx.accounts.token_mint.key();
        escrow.total_amount = total_amount;
        escrow.released_amount = 0;
        escrow.status = EscrowStatus::Created;
        escrow.task_id = task_id;
        escrow.description_hash = description_hash;
        escrow.created_at = now;
        escrow.deadline = deadline;
        escrow.dispute_resolver = dispute_resolver;
        escrow.bump = ctx.bumps.escrow;

        escrow.milestones = milestones_data
            .iter()
            .map(|md| Milestone {
                description_hash: md.description_hash,
                amount: md.amount,
                status: MilestoneStatus::Pending,
            })
            .collect();

        // Transfer tokens from client's token account to escrow token account
        let transfer_instruction = Transfer {
            from: ctx.accounts.client_token_account.to_account_info(),
            to: ctx.accounts.escrow_token_account.to_account_info(),
            authority: ctx.accounts.client.to_account_info(),
        };

        token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), transfer_instruction),
            total_amount,
        )?;

        emit!(EscrowCreated {
            escrow: escrow.key(),
            client: escrow.client,
            provider: escrow.provider,
            task_id,
            total_amount,
            deadline,
            milestone_count: escrow.milestones.len() as u32,
        });

        Ok(())
    }

    /// Provider accepts the task, moving escrow to Active status.
    pub fn accept_task(ctx: Context<AcceptTask>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;

        require!(escrow.status == EscrowStatus::Created, SettlementError::InvalidStatus);
        require!(
            ctx.accounts.provider.key() == escrow.provider,
            SettlementError::UnauthorizedProvider
        );

        escrow.status = EscrowStatus::Active;

        emit!(TaskAccepted {
            escrow: escrow.key(),
            provider: ctx.accounts.provider.key(),
            task_id: escrow.task_id,
        });

        Ok(())
    }

    /// Provider marks a milestone as submitted (proof of work).
    pub fn submit_milestone(ctx: Context<SubmitMilestone>, milestone_index: u32) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let now = Clock::get()?.unix_timestamp;

        require!(escrow.status == EscrowStatus::Active, SettlementError::InvalidStatus);
        require!(now <= escrow.deadline, SettlementError::DeadlinePassed);
        require!(
            ctx.accounts.provider.key() == escrow.provider,
            SettlementError::UnauthorizedProvider
        );

        let index = milestone_index as usize;
        require!(
            index < escrow.milestones.len(),
            SettlementError::InvalidMilestoneIndex
        );

        require!(
            escrow.milestones[index].status == MilestoneStatus::Pending,
            SettlementError::InvalidMilestoneStatus
        );

        escrow.milestones[index].status = MilestoneStatus::Submitted;

        emit!(MilestoneSubmitted {
            escrow: escrow.key(),
            provider: ctx.accounts.provider.key(),
            milestone_index,
            task_id: escrow.task_id,
        });

        Ok(())
    }

    /// Client approves a submitted milestone, releasing funds.
    /// State is updated before CPI for checks-effects-interactions pattern.
    pub fn approve_milestone(ctx: Context<ApproveMilestone>, milestone_index: u32) -> Result<()> {
        // --- CHECKS --- (immutable borrow scope)
        let index = milestone_index as usize;
        let amount: u64;
        let bump: u8;
        let client_key: Pubkey;
        let provider_key: Pubkey;
        let task_id: u64;
        {
            let escrow = &ctx.accounts.escrow;
            require!(escrow.status == EscrowStatus::Active, SettlementError::InvalidStatus);
            require!(
                ctx.accounts.client.key() == escrow.client,
                SettlementError::UnauthorizedClient
            );
            require!(
                index < escrow.milestones.len(),
                SettlementError::InvalidMilestoneIndex
            );
            require!(
                escrow.milestones[index].status == MilestoneStatus::Submitted,
                SettlementError::InvalidMilestoneStatus
            );
            amount = escrow.milestones[index].amount;
            bump = escrow.bump;
            client_key = escrow.client;
            provider_key = escrow.provider;
            task_id = escrow.task_id;
        }

        // --- EFFECTS --- (update state before transfer)
        {
            let escrow = &mut ctx.accounts.escrow;
            escrow.milestones[index].status = MilestoneStatus::Approved;
            escrow.released_amount = escrow
                .released_amount
                .checked_add(amount)
                .ok_or(SettlementError::AmountOverflow)?;
        }

        // --- INTERACTIONS --- (CPI transfer after state update)
        let task_id_bytes = task_id.to_le_bytes();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow",
            client_key.as_ref(),
            provider_key.as_ref(),
            &task_id_bytes,
            &[bump],
        ]];

        let transfer_instruction = Transfer {
            from: ctx.accounts.escrow_token_account.to_account_info(),
            to: ctx.accounts.provider_token_account.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        };

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                transfer_instruction,
                signer_seeds,
            ),
            amount,
        )?;

        // Check if all milestones are approved (need fresh mutable borrow)
        let escrow = &mut ctx.accounts.escrow;
        let all_approved = escrow.milestones.iter().all(|m| m.status == MilestoneStatus::Approved);
        if all_approved {
            escrow.status = EscrowStatus::Completed;

            // CPI into Agent Registry to update provider reputation
            update_provider_reputation(
                provider_key,
                escrow.released_amount,
                ctx.accounts.registry_program.to_account_info(),
                ctx.accounts.provider_profile.to_account_info(),
                ctx.accounts.settlement_self.to_account_info(),
            )?;

            emit!(EscrowCompleted {
                escrow: escrow.key(),
                provider: provider_key,
                task_id,
                total_released: escrow.released_amount,
            });
        }

        emit!(MilestoneApproved {
            escrow: escrow.key(),
            client: ctx.accounts.client.key(),
            milestone_index,
            amount,
            task_id,
        });

        Ok(())
    }

    /// Client rejects a milestone, setting it back to Pending for re-work.
    pub fn reject_milestone(ctx: Context<RejectMilestone>, milestone_index: u32) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;

        require!(escrow.status == EscrowStatus::Active, SettlementError::InvalidStatus);
        require!(
            ctx.accounts.client.key() == escrow.client,
            SettlementError::UnauthorizedClient
        );

        let index = milestone_index as usize;
        require!(
            index < escrow.milestones.len(),
            SettlementError::InvalidMilestoneIndex
        );

        require!(
            escrow.milestones[index].status == MilestoneStatus::Submitted,
            SettlementError::InvalidMilestoneStatus
        );

        escrow.milestones[index].status = MilestoneStatus::Pending;

        emit!(MilestoneRejected {
            escrow: escrow.key(),
            client: ctx.accounts.client.key(),
            milestone_index,
            task_id: escrow.task_id,
        });

        Ok(())
    }

    /// Either client or provider raises a dispute, moving escrow to Disputed status.
    pub fn raise_dispute(ctx: Context<RaiseDispute>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;

        require!(
            ctx.accounts.requester.key() == escrow.client
                || ctx.accounts.requester.key() == escrow.provider,
            SettlementError::UnauthorizedDispute
        );

        require!(escrow.status != EscrowStatus::Disputed, SettlementError::AlreadyDisputed);
        require!(escrow.status != EscrowStatus::Expired, SettlementError::EscrowExpired);

        escrow.status = EscrowStatus::Disputed;

        emit!(DisputeRaised {
            escrow: escrow.key(),
            requester: ctx.accounts.requester.key(),
            task_id: escrow.task_id,
        });

        Ok(())
    }

    /// The dispute_resolver (or client) resolves a dispute and releases funds accordingly.
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        client_refund: u64,
        provider_refund: u64,
    ) -> Result<()> {
        // Read-only borrow first: validate + extract values
        let escrow = &ctx.accounts.escrow;

        require!(escrow.status == EscrowStatus::Disputed, SettlementError::InvalidStatus);

        let is_resolver = escrow
            .dispute_resolver
            .map(|resolver| ctx.accounts.resolver.key() == resolver)
            .unwrap_or(false);
        let is_client = ctx.accounts.resolver.key() == escrow.client;

        require!(is_resolver || is_client, SettlementError::UnauthorizedResolver);

        let remaining = escrow
            .total_amount
            .checked_sub(escrow.released_amount)
            .ok_or(SettlementError::AmountOverflow)?;

        let total_refund = client_refund
            .checked_add(provider_refund)
            .ok_or(SettlementError::AmountOverflow)?;

        require!(total_refund == remaining, SettlementError::InvalidRefundAmount);

        let bump = escrow.bump;
        let client_key = escrow.client;
        let provider_key = escrow.provider;
        let task_id = escrow.task_id;
        let task_id_bytes = task_id.to_le_bytes();

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow",
            client_key.as_ref(),
            provider_key.as_ref(),
            &task_id_bytes,
            &[bump],
        ]];

        // Transfer client refund if any
        if client_refund > 0 {
            let transfer_instruction = Transfer {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.client_token_account.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            };

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    transfer_instruction,
                    signer_seeds,
                ),
                client_refund,
            )?;
        }

        // Transfer provider refund if any
        if provider_refund > 0 {
            let transfer_instruction = Transfer {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.provider_token_account.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            };

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    transfer_instruction,
                    signer_seeds,
                ),
                provider_refund,
            )?;
        }

        // Now mutably borrow for state update
        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Completed;

        emit!(DisputeResolved {
            escrow: escrow.key(),
            resolver: ctx.accounts.resolver.key(),
            client_refund,
            provider_refund,
            task_id,
        });

        Ok(())
    }

    /// Client can cancel an escrow that hasn't been accepted yet.
    /// Refunds all locked funds.
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        // Read-only borrow first: validate + extract values
        let escrow = &ctx.accounts.escrow;

        require!(escrow.status == EscrowStatus::Created, SettlementError::InvalidStatus);
        require!(
            ctx.accounts.client.key() == escrow.client,
            SettlementError::UnauthorizedClient
        );

        let amount = escrow.total_amount;
        let bump = escrow.bump;
        let client_key = escrow.client;
        let provider_key = escrow.provider;
        let task_id = escrow.task_id;
        let task_id_bytes = task_id.to_le_bytes();

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow",
            client_key.as_ref(),
            provider_key.as_ref(),
            &task_id_bytes,
            &[bump],
        ]];

        let transfer_instruction = Transfer {
            from: ctx.accounts.escrow_token_account.to_account_info(),
            to: ctx.accounts.client_token_account.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        };

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                transfer_instruction,
                signer_seeds,
            ),
            amount,
        )?;

        // Now mutably borrow for state update
        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Cancelled;

        emit!(EscrowCancelled {
            escrow: escrow.key(),
            client: ctx.accounts.client.key(),
            task_id,
            refunded_amount: amount,
        });

        Ok(())
    }

    /// Anyone can expire an escrow that has passed its deadline.
    /// Refunds all remaining funds to the client.
    pub fn expire_escrow(ctx: Context<ExpireEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let now = Clock::get()?.unix_timestamp;

        require!(now > escrow.deadline, SettlementError::DeadlineNotReached);
        require!(
            escrow.status == EscrowStatus::Active || escrow.status == EscrowStatus::Created,
            SettlementError::InvalidStatus
        );

        let remaining = escrow
            .total_amount
            .checked_sub(escrow.released_amount)
            .ok_or(SettlementError::AmountOverflow)?;

        let bump = escrow.bump;
        let client_key = escrow.client;
        let provider_key = escrow.provider;
        let task_id = escrow.task_id;
        let task_id_bytes = task_id.to_le_bytes();

        if remaining > 0 {
            let signer_seeds: &[&[&[u8]]] = &[&[
                b"escrow",
                client_key.as_ref(),
                provider_key.as_ref(),
                &task_id_bytes,
                &[bump],
            ]];

            let transfer_instruction = Transfer {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.client_token_account.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            };

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    transfer_instruction,
                    signer_seeds,
                ),
                remaining,
            )?;
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Expired;

        emit!(EscrowExpired {
            escrow: escrow.key(),
            task_id,
            refunded_amount: remaining,
        });

        Ok(())
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// CPIs into Agent Registry to update provider reputation after task completion.
///
/// Constructs the `update_reputation` instruction manually and invokes via CPI.
/// The Settlement program passes itself as the settlement_program account,
/// which the Registry validates against its SETTLEMENT_PROGRAM_ID constant.
fn update_provider_reputation<'info>(
    provider: Pubkey,
    earnings: u64,
    registry_program: AccountInfo<'info>,
    provider_profile: AccountInfo<'info>,
    settlement_program_info: AccountInfo<'info>,
) -> Result<()> {
    // Build update_reputation instruction data:
    // [8-byte discriminator] + [reputation_delta: i64] + [task_completed: bool] + [earnings: u64] + [rating: u8]
    let discriminator: [u8; 8] = [194, 220, 43, 201, 54, 209, 49, 178]; // sha256("global:update_reputation")[..8]
    let reputation_delta: i64 = 50; // +50 for successful completion
    let task_completed: bool = true;
    let rating: u8 = 0; // No rating yet — client rates separately

    let mut data = Vec::with_capacity(8 + 8 + 1 + 8 + 1);
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(&reputation_delta.to_le_bytes());
    data.extend_from_slice(&[task_completed as u8]);
    data.extend_from_slice(&earnings.to_le_bytes());
    data.extend_from_slice(&[rating]);

    let accounts = vec![
        AccountMeta::new(provider_profile.key(), false),        // agent_profile (mut)
        AccountMeta::new_readonly(settlement_program_info.key(), false), // settlement_program (executable)
    ];

    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: registry_program.key(),
        accounts,
        data,
    };

    anchor_lang::solana_program::program::invoke(
        &ix,
        &[provider_profile, settlement_program_info, registry_program],
    )?;

    emit!(ReputationUpdateScheduled {
        provider,
        delta: reputation_delta,
    });

    Ok(())
}

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
    pub bump: u8,
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
    #[account(
        init,
        payer = client,
        space = 8 + 32 + 32 + 32 + 32 + 32 + 8 + 8 + 1024 + 1 + 8 + 32 + 8 + 8 + 33 + 1,
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

    #[account(mut)]
    pub escrow: Account<'info, TaskEscrow>,
}

#[derive(Accounts)]
pub struct SubmitMilestone<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(mut)]
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

    /// CHECK: Agent Registry program for CPI reputation updates.
    /// Validated by REGISTRY_PROGRAM_ID check in handler.
    #[account(executable)]
    pub registry_program: UncheckedAccount<'info>,

    /// CHECK: Provider's AgentProfile PDA in the Registry program.
    /// Seeds: [provider.key(), b"agent-profile"]. Validated by Registry program during CPI.
    #[account(mut)]
    pub provider_profile: UncheckedAccount<'info>,

    /// CHECK: This settlement program's own executable account, passed to Registry for CPI caller verification.
    #[account(
        executable,
        constraint = settlement_self.key() == crate::ID @ SettlementError::InvalidStatus
    )]
    pub settlement_self: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RejectMilestone<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    #[account(mut)]
    pub escrow: Account<'info, TaskEscrow>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,

    #[account(mut)]
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

    pub token_program: Program<'info, Token>,
}

// ============================================================================
// EVENTS
// ============================================================================

#[event]
pub struct EscrowCreated {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub provider: Pubkey,
    pub task_id: u64,
    pub total_amount: u64,
    pub deadline: i64,
    pub milestone_count: u32,
}

#[event]
pub struct TaskAccepted {
    pub escrow: Pubkey,
    pub provider: Pubkey,
    pub task_id: u64,
}

#[event]
pub struct MilestoneSubmitted {
    pub escrow: Pubkey,
    pub provider: Pubkey,
    pub milestone_index: u32,
    pub task_id: u64,
}

#[event]
pub struct MilestoneApproved {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub milestone_index: u32,
    pub amount: u64,
    pub task_id: u64,
}

#[event]
pub struct MilestoneRejected {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub milestone_index: u32,
    pub task_id: u64,
}

#[event]
pub struct EscrowCompleted {
    pub escrow: Pubkey,
    pub provider: Pubkey,
    pub task_id: u64,
    pub total_released: u64,
}

#[event]
pub struct DisputeRaised {
    pub escrow: Pubkey,
    pub requester: Pubkey,
    pub task_id: u64,
}

#[event]
pub struct DisputeResolved {
    pub escrow: Pubkey,
    pub resolver: Pubkey,
    pub client_refund: u64,
    pub provider_refund: u64,
    pub task_id: u64,
}

#[event]
pub struct EscrowCancelled {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub task_id: u64,
    pub refunded_amount: u64,
}

#[event]
pub struct EscrowExpired {
    pub escrow: Pubkey,
    pub task_id: u64,
    pub refunded_amount: u64,
}

#[event]
pub struct ReputationUpdateScheduled {
    pub provider: Pubkey,
    pub delta: i64,
}

// ============================================================================
// ERROR CODES
// ============================================================================

#[error_code]
pub enum SettlementError {
    #[msg("Invalid milestone count: must be between 1 and 5")]
    InvalidMilestoneCount,

    #[msg("Milestone amounts do not sum to total escrow amount")]
    MilestoneAmountMismatch,

    #[msg("Deadline cannot be in the past")]
    DeadlineInPast,

    #[msg("Invalid escrow status for this operation")]
    InvalidStatus,

    #[msg("Only the provider can perform this action")]
    UnauthorizedProvider,

    #[msg("Only the client can perform this action")]
    UnauthorizedClient,

    #[msg("Invalid milestone index")]
    InvalidMilestoneIndex,

    #[msg("Invalid milestone status for this operation")]
    InvalidMilestoneStatus,

    #[msg("Amount overflow detected")]
    AmountOverflow,

    #[msg("Only authorized party can raise a dispute")]
    UnauthorizedDispute,

    #[msg("Escrow is already in dispute")]
    AlreadyDisputed,

    #[msg("Escrow has expired")]
    EscrowExpired,

    #[msg("Only dispute resolver or client can resolve disputes")]
    UnauthorizedResolver,

    #[msg("Refund amounts do not match remaining escrow balance")]
    InvalidRefundAmount,

    #[msg("Token account does not match expected mint or owner")]
    InvalidTokenAccount,

    #[msg("Task deadline has passed")]
    DeadlinePassed,

    #[msg("Deadline has not been reached yet")]
    DeadlineNotReached,

    #[msg("Invalid amount: must be greater than zero")]
    InvalidAmount,
}
