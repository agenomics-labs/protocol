use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

use crate::state::*;
use crate::errors::*;
use crate::events::*;
use crate::contexts::*;
use super::update_provider_reputation;

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

pub fn accept_task(ctx: Context<AcceptTask>) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;

    require!(escrow.status == EscrowStatus::Created, SettlementError::InvalidStatus);

    escrow.status = EscrowStatus::Active;

    emit!(TaskAccepted {
        escrow: escrow.key(),
        provider: ctx.accounts.provider.key(),
        task_id: escrow.task_id,
    });

    Ok(())
}

pub fn submit_milestone(ctx: Context<SubmitMilestone>, milestone_index: u32) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    let now = Clock::get()?.unix_timestamp;

    require!(escrow.status == EscrowStatus::Active, SettlementError::InvalidStatus);
    require!(now <= escrow.deadline, SettlementError::DeadlinePassed);

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

pub fn approve_milestone(ctx: Context<ApproveMilestone>, milestone_index: u32) -> Result<()> {
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

    {
        let escrow = &mut ctx.accounts.escrow;
        escrow.milestones[index].status = MilestoneStatus::Approved;
        escrow.released_amount = escrow
            .released_amount
            .checked_add(amount)
            .ok_or(SettlementError::AmountOverflow)?;
    }

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

    let escrow = &mut ctx.accounts.escrow;
    let all_approved = escrow.milestones.iter().all(|m| m.status == MilestoneStatus::Approved);
    if all_approved {
        escrow.status = EscrowStatus::Completed;

        update_provider_reputation(
            provider_key,
            escrow.released_amount,
            REPUTATION_DELTA_TASK_COMPLETED,
            true,
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

pub fn reject_milestone(ctx: Context<RejectMilestone>, milestone_index: u32) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;

    require!(escrow.status == EscrowStatus::Active, SettlementError::InvalidStatus);

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

pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
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

pub fn expire_escrow(ctx: Context<ExpireEscrow>) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    let now = Clock::get()?.unix_timestamp;

    require!(now > escrow.deadline, SettlementError::DeadlineNotReached);
    require!(
        escrow.status == EscrowStatus::Active || escrow.status == EscrowStatus::Created,
        SettlementError::InvalidStatus
    );

    let mut provider_earned: u64 = 0;
    for milestone in &escrow.milestones {
        if milestone.status == MilestoneStatus::Approved {
            provider_earned = provider_earned
                .checked_add(milestone.amount)
                .ok_or(SettlementError::AmountOverflow)?;
        }
    }
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

    let has_undelivered = escrow.milestones.iter().any(|m| m.status == MilestoneStatus::Submitted);
    let provider_key_for_slash = escrow.provider;

    let escrow = &mut ctx.accounts.escrow;
    escrow.released_amount = escrow.total_amount;
    escrow.status = EscrowStatus::Expired;

    if has_undelivered {
        update_provider_reputation(
            provider_key_for_slash,
            0,
            REPUTATION_DELTA_EXPIRY_UNDELIVERED,
            false,
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

pub fn close_escrow(_ctx: Context<CloseEscrow>) -> Result<()> {
    Ok(())
}
