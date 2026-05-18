use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

use crate::state::*;
use crate::errors::*;
use crate::events::*;
use crate::contexts::*;
use super::{update_provider_reputation, REASON_DISPUTE_LOSS, REASON_TASK_COMPLETED};

pub fn raise_dispute(ctx: Context<RaiseDispute>) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    let clock = Clock::get()?;

    require!(escrow.status == EscrowStatus::Active, SettlementError::InvalidStatus);

    // AUD-018 / ADR-102: a client must not be able to front-run an approval by
    // raising a dispute the moment the provider's `submit_milestone` lands.
    // The resolver-path slash (`reputation_delta_dispute_loss`) would then
    // sidestep the grace window that `expire_escrow` already honours.
    //
    // Mirror the `expire_escrow` guard exactly: any Submitted milestone with a
    // non-zero grace deadline that has not yet elapsed (`clock.slot <
    // grace_ends_at`) blocks the dispute. `grace_ends_at == 0` means the
    // provider opted out of grace protection at submit time, so the check is
    // a no-op for those milestones.
    for milestone in &escrow.milestones {
        if milestone.status == MilestoneStatus::Submitted
            && milestone.grace_ends_at > 0
            && clock.slot < milestone.grace_ends_at
        {
            return Err(SettlementError::MilestoneInGracePeriod.into());
        }
    }

    escrow.status = EscrowStatus::Disputed;
    escrow.disputed_at = Some(clock.unix_timestamp);

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
        // SEC-1: pass `provider_authority` (= escrow.provider) — see cpi.rs.
        // SEC-7: the `is_resolver` flag is now always true when we reach
        // here (None-resolver disputes can no longer enter resolve_dispute),
        // but the compound check keeps the slash guarded against the
        // `client_refund == 0` case (no slash when provider won).
        let delta = ctx.accounts.protocol_config.reputation_delta_dispute_loss;
        // ADR-097: pass `provider_owner_nonce` for the Registry's nonce-based PDA seed.
        // AUD-109/113 (cycle-2): explicit REASON_DISPUTE_LOSS code.
        update_provider_reputation(
            delta,
            REASON_DISPUTE_LOSS,
            ctx.accounts.registry_program.to_account_info(),
            ctx.accounts.provider_profile.to_account_info(),
            ctx.accounts.provider_authority.to_account_info(),
            ctx.accounts.provider_owner_nonce.to_account_info(),
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

    // C4-OB-06 (cycle-4): reconcile delivered (`Submitted`) milestones on the
    // dispute-timeout rail, exactly as `expire_escrow` does on the expiry
    // rail (C1 "silence = acceptance"). Pre-fix this path refunded the
    // *entire* `remaining` to the client and unconditionally applied
    // `reputation_delta_dispute_loss`, regardless of how much work the
    // provider had legitimately delivered. A provider who completed 4/5
    // milestones then got disputed on the 5th, where the resolver never
    // acts, took the same slash as a total non-deliverer and the client
    // recovered delivered-but-unapproved work — a profitable variant of the
    // C1 stall attack moved onto the dispute rail.
    //
    // New economics, parity with `expire_escrow`:
    //   * Submitted  → auto-paid to provider (delivered; silence = accept)
    //   * Pending    → refunded to client; counts as genuine non-delivery
    //   * Approved   → already paid (in `released_amount`, skipped here)
    //   * Rejected   → refunded to client; not a non-delivery signal
    //   * Disputed   → the milestone(s) the dispute is actually about;
    //                  treated as non-delivery (refund to client + slash).
    let mut provider_earned: u64 = 0;
    let mut has_pending_or_disputed: bool = false;
    for milestone in &escrow.milestones {
        match milestone.status {
            MilestoneStatus::Submitted => {
                provider_earned = provider_earned
                    .checked_add(milestone.amount)
                    .ok_or(SettlementError::AmountOverflow)?;
            }
            MilestoneStatus::Pending | MilestoneStatus::Disputed => {
                has_pending_or_disputed = true;
            }
            MilestoneStatus::Approved | MilestoneStatus::Rejected => {}
        }
    }

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

    let reputation_delta_dispute_loss =
        ctx.accounts.protocol_config.reputation_delta_dispute_loss;
    let reputation_delta_task_completed =
        ctx.accounts.protocol_config.reputation_delta_task_completed;
    let escrow = &mut ctx.accounts.escrow;
    escrow.released_amount = escrow.total_amount;
    // Mark auto-paid Submitted milestones as Approved for audit clarity
    // (mirrors `expire_escrow`'s post-reconciliation sweep).
    for milestone in escrow.milestones.iter_mut() {
        if milestone.status == MilestoneStatus::Submitted {
            milestone.status = MilestoneStatus::Approved;
        }
    }
    escrow.status = EscrowStatus::Completed;

    // C4-OB-06: only slash when at least one milestone was genuinely
    // Pending (never delivered) or is the Disputed milestone itself. If
    // every milestone was delivered (Submitted→auto-paid / already
    // Approved) the provider performed — apply the success-path delta
    // instead of the dispute-loss slash, exactly as `expire_escrow`'s
    // all-Approved branch does. SEC-1: pass `provider_authority`
    // (= escrow.provider). ADR-097: pass `provider_owner_nonce`.
    // AUD-109/113 (cycle-2): explicit reason codes.
    //
    // SEC-7 note: this instruction remains the ONLY exit path for a dispute
    // with `dispute_resolver == None` (`resolve_dispute` rejects those with
    // `NoResolverRequiresTimeout`). It is still economically neutral, but
    // now correctly so: the client only recovers funds for work that was
    // never delivered, and the provider is only slashed for genuine
    // non-delivery.
    if has_pending_or_disputed {
        update_provider_reputation(
            reputation_delta_dispute_loss,
            REASON_DISPUTE_LOSS,
            ctx.accounts.registry_program.to_account_info(),
            ctx.accounts.provider_profile.to_account_info(),
            ctx.accounts.provider_authority.to_account_info(),
            ctx.accounts.provider_owner_nonce.to_account_info(),
            ctx.accounts.settlement_authority.to_account_info(),
            ctx.bumps.settlement_authority,
        )?;
    } else {
        update_provider_reputation(
            reputation_delta_task_completed,
            REASON_TASK_COMPLETED,
            ctx.accounts.registry_program.to_account_info(),
            ctx.accounts.provider_profile.to_account_info(),
            ctx.accounts.provider_authority.to_account_info(),
            ctx.accounts.provider_owner_nonce.to_account_info(),
            ctx.accounts.settlement_authority.to_account_info(),
            ctx.bumps.settlement_authority,
        )?;
    }

    emit!(DisputeResolved {
        escrow: escrow.key(),
        resolver: ctx.accounts.payer.key(),
        client_refund,
        provider_refund: provider_earned,
        task_id,
    });

    Ok(())
}
