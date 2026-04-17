use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

use crate::state::*;
use crate::errors::*;
use crate::events::*;
use crate::contexts::*;
use super::update_provider_reputation;

pub fn raise_dispute(ctx: Context<RaiseDispute>) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;

    require!(escrow.status == EscrowStatus::Active, SettlementError::InvalidStatus);

    escrow.status = EscrowStatus::Disputed;
    escrow.disputed_at = Some(Clock::get()?.unix_timestamp);

    emit!(DisputeRaised {
        escrow: escrow.key(),
        requester: ctx.accounts.requester.key(),
        task_id: escrow.task_id,
    });

    Ok(())
}

pub fn resolve_dispute(
    ctx: Context<ResolveDispute>,
    client_refund: u64,
    provider_refund: u64,
) -> Result<()> {
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

    let escrow = &mut ctx.accounts.escrow;
    escrow.released_amount = escrow
        .released_amount
        .checked_add(client_refund)
        .and_then(|v| v.checked_add(provider_refund))
        .ok_or(SettlementError::AmountOverflow)?;
    escrow.status = EscrowStatus::Completed;

    // A-03: Only slash provider reputation if an external resolver adjudicated.
    // Client self-resolution (no resolver set) is not a neutral judgment —
    // slashing would let clients exploit providers by disputing and self-resolving.
    if client_refund > 0 && is_resolver {
        // rating=0: dispute-loss slash, no user rating applies.
        update_provider_reputation(
            provider_key,
            0,
            REPUTATION_DELTA_DISPUTE_LOSS,
            false,
            0,
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

    // rating=0: dispute-timeout slash, no user rating applies.
    update_provider_reputation(
        provider_key,
        0,
        REPUTATION_DELTA_DISPUTE_LOSS,
        false,
        0,
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
