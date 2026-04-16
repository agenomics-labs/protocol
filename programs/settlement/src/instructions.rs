use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

use crate::state::*;
use crate::errors::*;
use crate::events::*;
use crate::contexts::*;

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

    // ADR-050: Slash provider on timeout — 100% refund to client means full failure
    update_provider_reputation(
        provider_key,
        0,
        -25,
        false, // triggers slashing in Registry
        ctx.accounts.registry_program.to_account_info(),
        ctx.accounts.provider_profile.to_account_info(),
        ctx.accounts.settlement_authority.to_account_info(),
        ctx.bumps.settlement_authority,
    )?;

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

    // ADR-050: Slash provider if they had submitted-but-unapproved milestones
    // This means they claimed work was done but it wasn't approved before expiry
    let has_undelivered = escrow.milestones.iter().any(|m| m.status == MilestoneStatus::Submitted);
    let provider_key_for_slash = escrow.provider;

    let escrow = &mut ctx.accounts.escrow;
    escrow.released_amount = escrow.total_amount; // All funds distributed
    escrow.status = EscrowStatus::Expired;

    if has_undelivered {
        update_provider_reputation(
            provider_key_for_slash,
            0,
            -10,   // lighter penalty than dispute (-25)
            false,  // triggers slashing in Registry
            ctx.accounts.registry_program.to_account_info(),
            ctx.accounts.provider_profile.to_account_info(),
            ctx.accounts.settlement_authority.to_account_info(),
            ctx.bumps.settlement_authority,
        )?;
    }

    emit!(EscrowExpired {
        escrow: escrow.key(),
        task_id,
        refunded_amount: client_refund,
    });

    Ok(())
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
///
/// ADR-039: Now accepts `reputation_delta` and `task_completed` as parameters
/// instead of hardcoding +50/true. This enables both positive reputation
/// (task completion) and negative reputation (dispute/expiry slashing).
pub fn update_provider_reputation<'info>(
    provider: Pubkey,
    earnings: u64,
    reputation_delta: i64,
    task_completed: bool,
    registry_program: AccountInfo<'info>,
    provider_profile: AccountInfo<'info>,
    settlement_authority: AccountInfo<'info>,
    settlement_authority_bump: u8,
) -> Result<()> {
    use anchor_lang::solana_program::instruction::Instruction;
    use anchor_lang::solana_program::program::invoke_signed;

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

    let ix = Instruction {
        program_id: registry_program.key(),
        accounts,
        data,
    };

    // Sign CPI with settlement_authority PDA: seeds = ["settlement_authority", bump]
    let signer_seeds: &[&[u8]] = &[b"settlement_authority", &[settlement_authority_bump]];

    invoke_signed(
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
