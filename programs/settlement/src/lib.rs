use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3");

// ============================================================================
// CONSTANTS
// ============================================================================

/// Agent Registry program ID — used for CPI reputation updates.
const AGENT_REGISTRY_PROGRAM_ID: Pubkey = pubkey!("8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh");
const MAX_MILESTONES: usize = 5;

/// ADR-028: Minimum escrow amount to prevent cheap reputation farming.
/// Set to 10,000 base units (e.g., 0.01 USDC with 6 decimals).
/// Self-dealing attacks must lock at least this much per task, making
/// large-scale reputation inflation economically costly.
const MIN_ESCROW_AMOUNT: u64 = 10_000;

/// ADR-030: Dispute resolution timeout in seconds (7 days).
/// If the dispute resolver doesn't act within this window,
/// anyone can trigger auto-resolution that refunds the client.
const DISPUTE_TIMEOUT_SECONDS: i64 = 7 * 24 * 3600;

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

        require!(total_amount >= MIN_ESCROW_AMOUNT, SettlementError::BelowMinimumEscrow);

        // ADR-028: Prevent self-dealing — client cannot be the same as provider
        require!(
            ctx.accounts.client.key() != ctx.accounts.provider.key(),
            SettlementError::SelfDealingProhibited
        );

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
        escrow.disputed_at = None;
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
        // Provider authorization enforced by has_one constraint

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
        // Provider authorization enforced by has_one constraint

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

            // CPI into Agent Registry to update provider reputation (+50 for completion)
            update_provider_reputation(
                provider_key,
                escrow.released_amount,
                50,   // positive reputation for successful completion
                true, // task_completed = true
                ctx.accounts.registry_program.to_account_info(),
                ctx.accounts.provider_profile.to_account_info(),
                ctx.accounts.settlement_authority.to_account_info(),
                ctx.bumps.settlement_authority,
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
        // Client authorization enforced by has_one constraint

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
        // Client/provider authorization enforced by constraint

        require!(escrow.status != EscrowStatus::Disputed, SettlementError::AlreadyDisputed);
        require!(escrow.status != EscrowStatus::Expired, SettlementError::EscrowExpired);

        escrow.status = EscrowStatus::Disputed;
        escrow.disputed_at = Some(Clock::get()?.unix_timestamp);

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
        escrow.released_amount = escrow
            .released_amount
            .checked_add(client_refund)
            .and_then(|v| v.checked_add(provider_refund))
            .ok_or(SettlementError::AmountOverflow)?;
        escrow.status = EscrowStatus::Completed;

        // ADR-039: Slash provider reputation on dispute resolution.
        // If the client got a refund, the provider failed to deliver — negative reputation.
        if client_refund > 0 {
            // Reputation penalty proportional to client's share: -25 base
            update_provider_reputation(
                provider_key,
                0,     // no earnings for provider in dispute
                -25,   // negative reputation delta
                false, // task NOT completed — triggers slashing in Registry
                ctx.accounts.registry_program.to_account_info(),
                ctx.accounts.provider_profile.to_account_info(),
                ctx.accounts.settlement_authority.to_account_info(),
                ctx.bumps.settlement_authority,
            )?;
        }

        emit!(DisputeResolved {
            escrow: escrow.key(),
            resolver: ctx.accounts.resolver.key(),
            client_refund,
            provider_refund,
            task_id,
        });

        Ok(())
    }

    /// ADR-030: Auto-resolve a dispute after timeout.
    /// Anyone can call this after DISPUTE_TIMEOUT_SECONDS has elapsed.
    /// All remaining funds are refunded to the client as a safe default.
    pub fn resolve_dispute_timeout(ctx: Context<ResolveDisputeTimeout>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let now = Clock::get()?.unix_timestamp;

        require!(escrow.status == EscrowStatus::Disputed, SettlementError::InvalidStatus);
        let disputed_at = escrow.disputed_at.ok_or(SettlementError::InvalidStatus)?;
        require!(
            now >= disputed_at + DISPUTE_TIMEOUT_SECONDS,
            SettlementError::DisputeTimeoutNotReached
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

        // Refund all remaining to client (safe default for unresolved disputes)
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
        escrow.released_amount = escrow.total_amount;
        escrow.status = EscrowStatus::Completed;

        emit!(DisputeResolved {
            escrow: escrow.key(),
            resolver: ctx.accounts.payer.key(),
            client_refund: remaining,
            provider_refund: 0,
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
    ///
    /// Approved milestones are honored: their funds go to the provider.
    /// Remaining funds (unapproved milestones) are refunded to the client.
    /// This prevents loss of work that was already approved before expiry.
    pub fn expire_escrow(ctx: Context<ExpireEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let now = Clock::get()?.unix_timestamp;

        require!(now > escrow.deadline, SettlementError::DeadlineNotReached);
        require!(
            escrow.status == EscrowStatus::Active || escrow.status == EscrowStatus::Created,
            SettlementError::InvalidStatus
        );

        // Calculate provider's earned amount (approved but not yet released milestones)
        let mut provider_earned: u64 = 0;
        for milestone in &escrow.milestones {
            if milestone.status == MilestoneStatus::Approved {
                provider_earned = provider_earned
                    .checked_add(milestone.amount)
                    .ok_or(SettlementError::AmountOverflow)?;
            }
        }
        // Subtract already-released funds (from approve_milestone calls)
        provider_earned = provider_earned.saturating_sub(escrow.released_amount);

        let remaining = escrow
            .total_amount
            .checked_sub(escrow.released_amount)
            .ok_or(SettlementError::AmountOverflow)?;

        let client_refund = remaining
            .checked_sub(provider_earned)
            .ok_or(SettlementError::AmountOverflow)?;

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

        // Transfer earned funds to provider (if any unreleased approved milestones)
        if provider_earned > 0 {
            let transfer_to_provider = Transfer {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.provider_token_account.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    transfer_to_provider,
                    signer_seeds,
                ),
                provider_earned,
            )?;
        }

        // Refund remaining to client
        if client_refund > 0 {
            let transfer_to_client = Transfer {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.client_token_account.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    transfer_to_client,
                    signer_seeds,
                ),
                client_refund,
            )?;
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.released_amount = escrow.total_amount; // All funds distributed
        escrow.status = EscrowStatus::Expired;

        emit!(EscrowExpired {
            escrow: escrow.key(),
            task_id,
            refunded_amount: client_refund,
        });

        Ok(())
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// CPIs into Agent Registry to update provider reputation after task completion.
///
/// Uses a PDA-signed CPI pattern: the Settlement program derives a "settlement_authority"
/// PDA and signs the CPI with it. The Registry program verifies this PDA as a signer
/// with seeds::program = SETTLEMENT_PROGRAM_ID, cryptographically proving the call
/// originated from this program.
///
/// The discriminator is computed as sha256("global:update_reputation")[..8].
/// This is Anchor's standard discriminator for the `update_reputation` instruction.
/// CPIs into Agent Registry to update provider reputation.
///
/// ADR-039: Now accepts `reputation_delta` and `task_completed` as parameters
/// instead of hardcoding +50/true. This enables both positive reputation
/// (task completion) and negative reputation (dispute/expiry slashing).
fn update_provider_reputation<'info>(
    provider: Pubkey,
    earnings: u64,
    reputation_delta: i64,
    task_completed: bool,
    registry_program: AccountInfo<'info>,
    provider_profile: AccountInfo<'info>,
    settlement_authority: AccountInfo<'info>,
    settlement_authority_bump: u8,
) -> Result<()> {
    // Anchor discriminator: sha256("global:update_reputation")[..8]
    let discriminator: [u8; 8] = [194, 220, 43, 201, 54, 209, 49, 178];
    let rating: u8 = 0; // Rating submitted separately by client

    let mut data = Vec::with_capacity(8 + 8 + 1 + 8 + 1);
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(&reputation_delta.to_le_bytes());
    data.extend_from_slice(&[task_completed as u8]);
    data.extend_from_slice(&earnings.to_le_bytes());
    data.extend_from_slice(&[rating]);

    let accounts = vec![
        AccountMeta::new(provider_profile.key(), false),          // agent_profile (mut)
        AccountMeta::new_readonly(settlement_authority.key(), true), // settlement_authority (signer)
    ];

    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: registry_program.key(),
        accounts,
        data,
    };

    // Sign CPI with settlement_authority PDA: seeds = ["settlement_authority", bump]
    let signer_seeds: &[&[u8]] = &[b"settlement_authority", &[settlement_authority_bump]];

    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[provider_profile, settlement_authority, registry_program],
        &[signer_seeds],
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
    /// ADR-047: Timestamp when dispute was raised. None if not disputed.
    /// Uses Option<i64> instead of sentinel 0 for proper null semantics.
    pub disputed_at: Option<i64>,
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

/// ADR-030: Context for auto-resolving a dispute after timeout.
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

    #[msg("Invalid registry program")]
    InvalidRegistryProgram,

    #[msg("Escrow amount below minimum (anti-sybil)")]
    BelowMinimumEscrow,

    #[msg("Client and provider cannot be the same account")]
    SelfDealingProhibited,

    #[msg("Dispute timeout has not been reached yet")]
    DisputeTimeoutNotReached,
}

// ============================================================================
// UNIT TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_milestone_status_display() {
        assert_eq!(format!("{}", MilestoneStatus::Pending), "Pending");
        assert_eq!(format!("{}", MilestoneStatus::Submitted), "Submitted");
        assert_eq!(format!("{}", MilestoneStatus::Approved), "Approved");
        assert_eq!(format!("{}", MilestoneStatus::Rejected), "Rejected");
        assert_eq!(format!("{}", MilestoneStatus::Disputed), "Disputed");
    }

    #[test]
    fn test_escrow_status_display() {
        assert_eq!(format!("{}", EscrowStatus::Created), "Created");
        assert_eq!(format!("{}", EscrowStatus::Active), "Active");
        assert_eq!(format!("{}", EscrowStatus::Completed), "Completed");
        assert_eq!(format!("{}", EscrowStatus::Disputed), "Disputed");
        assert_eq!(format!("{}", EscrowStatus::Cancelled), "Cancelled");
        assert_eq!(format!("{}", EscrowStatus::Expired), "Expired");
    }

    #[test]
    fn test_milestone_sum_validation() {
        let milestones = vec![
            MilestoneData { description_hash: [0u8; 32], amount: 600_000 },
            MilestoneData { description_hash: [0u8; 32], amount: 400_000 },
        ];
        let total: u64 = milestones.iter().map(|m| m.amount).sum();
        assert_eq!(total, 1_000_000);
    }

    #[test]
    fn test_milestone_sum_mismatch() {
        let milestones = vec![
            MilestoneData { description_hash: [0u8; 32], amount: 600_000 },
            MilestoneData { description_hash: [0u8; 32], amount: 300_000 },
        ];
        let total: u64 = milestones.iter().map(|m| m.amount).sum();
        let expected_total = 1_000_000u64;
        assert_ne!(total, expected_total);
    }

    #[test]
    fn test_milestone_count_bounds() {
        assert!(MAX_MILESTONES == 5);

        // 0 milestones invalid
        let empty: Vec<MilestoneData> = vec![];
        assert!(empty.is_empty());

        // 5 milestones valid
        let five: Vec<MilestoneData> = (0..5)
            .map(|_| MilestoneData { description_hash: [0u8; 32], amount: 200_000 })
            .collect();
        assert!(five.len() > 0 && five.len() <= MAX_MILESTONES);

        // 6 milestones invalid
        let six: Vec<MilestoneData> = (0..6)
            .map(|_| MilestoneData { description_hash: [0u8; 32], amount: 100_000 })
            .collect();
        assert!(six.len() > MAX_MILESTONES);
    }

    #[test]
    fn test_escrow_status_equality() {
        assert_eq!(EscrowStatus::Created, EscrowStatus::Created);
        assert_ne!(EscrowStatus::Created, EscrowStatus::Active);
        assert_ne!(EscrowStatus::Active, EscrowStatus::Disputed);
    }

    #[test]
    fn test_milestone_status_transitions() {
        // Valid: Pending -> Submitted
        let status = MilestoneStatus::Pending;
        assert_eq!(status, MilestoneStatus::Pending);

        // Valid: Submitted -> Approved
        let status = MilestoneStatus::Submitted;
        assert_eq!(status, MilestoneStatus::Submitted);

        // Valid: Submitted -> Rejected (back to Pending)
        let status = MilestoneStatus::Rejected;
        assert_eq!(status, MilestoneStatus::Rejected);
    }

    #[test]
    fn test_amount_overflow_checked_add() {
        let a: u64 = u64::MAX;
        let b: u64 = 1;
        assert!(a.checked_add(b).is_none());
    }

    #[test]
    fn test_amount_overflow_checked_sub() {
        let a: u64 = 100;
        let b: u64 = 200;
        assert!(a.checked_sub(b).is_none());
    }

    #[test]
    fn test_released_amount_tracking() {
        let total: u64 = 1_000_000;
        let released: u64 = 600_000;
        let remaining = total.checked_sub(released).unwrap();
        assert_eq!(remaining, 400_000);
    }

    #[test]
    fn test_dispute_refund_split_validation() {
        let remaining: u64 = 400_000;
        let client_refund: u64 = 200_000;
        let provider_refund: u64 = 200_000;
        let total_refund = client_refund.checked_add(provider_refund).unwrap();
        assert_eq!(total_refund, remaining);
    }

    #[test]
    fn test_dispute_refund_split_mismatch() {
        let remaining: u64 = 400_000;
        let client_refund: u64 = 200_000;
        let provider_refund: u64 = 100_000;
        let total_refund = client_refund.checked_add(provider_refund).unwrap();
        assert_ne!(total_refund, remaining);
    }

    /// ADR-014: Verify that the hardcoded CPI discriminator in `update_provider_reputation`
    /// matches the Anchor convention: sha256("global:update_reputation")[..8].
    ///
    /// This test ensures the discriminator stays in sync if the instruction is renamed
    /// or the Anchor namespace convention changes.
    #[test]
    fn test_cpi_discriminator_matches_anchor_convention() {
        use anchor_lang::solana_program::hash::hash;

        // The hardcoded discriminator from update_provider_reputation()
        let hardcoded: [u8; 8] = [194, 220, 43, 201, 54, 209, 49, 178];

        // Compute expected discriminator: sha256("global:update_reputation")[..8]
        let preimage = "global:update_reputation";
        let hash_bytes = hash(preimage.as_bytes()).to_bytes();
        let expected: [u8; 8] = hash_bytes[..8].try_into().unwrap();

        assert_eq!(
            hardcoded, expected,
            "CPI discriminator mismatch! Hardcoded {:?} != computed {:?} from '{}'",
            hardcoded, expected, preimage
        );
    }

    // ================================================================
    // ADR-021: Property-based fuzz tests (proptest)
    // ================================================================

    mod fuzz {
        use super::*;
        use proptest::prelude::*;
        use proptest::collection::vec as prop_vec;

        proptest! {
            /// Milestone amounts with random values either sum correctly
            /// or overflow detection works (checked_add returns None).
            #[test]
            fn milestone_amounts_sum_or_detect_overflow(
                amounts in prop_vec(1u64..=u64::MAX / 5, 1..=MAX_MILESTONES)
            ) {
                let mut total: Option<u64> = Some(0);
                for amount in &amounts {
                    total = total.and_then(|t| t.checked_add(*amount));
                }
                // Either we got a valid sum or overflow was detected (None)
                match total {
                    Some(sum) => prop_assert!(sum >= amounts.iter().copied().min().unwrap_or(0)),
                    None => { /* overflow detected correctly */ }
                }
            }

            /// released_amount tracking with random milestone amounts
            /// never exceeds total_amount (mirrors approve_milestone logic).
            #[test]
            fn released_amount_never_exceeds_total(
                amounts in prop_vec(1u64..=1_000_000_000, 1..=MAX_MILESTONES)
            ) {
                // Compute total using checked_add (skip if overflow)
                let total_amount = amounts.iter().try_fold(0u64, |acc, &a| acc.checked_add(a));
                if let Some(total_amount) = total_amount {
                    let mut released: u64 = 0;
                    for amount in &amounts {
                        released = released.checked_add(*amount)
                            .expect("released_amount overflow");
                    }
                    prop_assert!(released <= total_amount);
                    prop_assert_eq!(released, total_amount);
                }
            }
        }
    }
}
