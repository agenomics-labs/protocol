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

    // Finding #20: The `(is_resolver || is_client)` authorization gate has
    // been hoisted to `ResolveDispute`'s account-level constraint (see
    // contexts.rs). We still compute `is_resolver` here to drive the A-03
    // slash decision below (client self-resolution must NOT slash provider
    // reputation). Anchor has already rejected the tx if neither role matched.
    let is_resolver = escrow
        .dispute_resolver
        .map(|resolver| ctx.accounts.resolver.key() == resolver)
        .unwrap_or(false);

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
        // Finding #19: governance-owned delta, not the compile-time const.
        // rating=0: dispute-loss slash, no user rating applies.
        let delta = ctx.accounts.protocol_config.reputation_delta_dispute_loss;
        update_provider_reputation(
            provider_key,
            0,
            delta,
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
    // Finding #19: governance-owned timeout, not the compile-time const.
    // S-onchain-01 (2026-04 re-audit): `checked_add` guards against a
    // pathological `dispute_timeout_seconds`. `update_protocol_config`
    // already caps this at MAX_DISPUTE_TIMEOUT_SECONDS, so the add can't
    // overflow under any reachable config — belt-and-braces for defense
    // in depth.
    let timeout_deadline = disputed_at
        .checked_add(ctx.accounts.protocol_config.dispute_timeout_seconds)
        .ok_or(SettlementError::AmountOverflow)?;
    require!(now >= timeout_deadline, SettlementError::DisputeTimeoutNotReached);

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

    let reputation_delta_dispute_loss =
        ctx.accounts.protocol_config.reputation_delta_dispute_loss;
    let escrow = &mut ctx.accounts.escrow;
    escrow.released_amount = escrow.total_amount;
    escrow.status = EscrowStatus::Completed;

    // Finding #19: governance-owned delta; rating=0 — timeout slash, no user rating.
    update_provider_reputation(
        provider_key,
        0,
        reputation_delta_dispute_loss,
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
