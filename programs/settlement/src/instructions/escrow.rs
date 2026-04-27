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

    // Finding #19: read the governance-owned floor instead of the compile-time const.
    require!(
        total_amount >= ctx.accounts.protocol_config.min_escrow_amount,
        SettlementError::BelowMinimumEscrow
    );

    require!(
        ctx.accounts.client.key() != ctx.accounts.provider.key(),
        SettlementError::SelfDealingProhibited
    );

    // C3: Dispute resolver must be a neutral third party. A client who names
    // themselves as resolver can flip `is_resolver = true` in resolve_dispute
    // and trigger provider reputation slashing unilaterally, bypassing the
    // A-03 guard. Similarly, provider-as-resolver is self-judgment.
    if let Some(resolver) = dispute_resolver {
        require!(
            resolver != ctx.accounts.client.key()
                && resolver != ctx.accounts.provider.key(),
            SettlementError::InvalidDisputeResolver
        );
    }

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

    // AUD-024: cap `deadline` at `now + MAX_ESCROW_DEADLINE_SECS` (365 days).
    // Without this, a client could pass `deadline = i64::MAX` and lock the
    // escrow funds effectively forever — `expire_escrow` only fires once
    // `now > deadline`. The cap is computed via `checked_add` so a
    // pathologically large `now` (year ~292e9) cannot overflow into a
    // negative i64 and silently re-admit the unbounded value.
    let max_deadline = now
        .checked_add(MAX_ESCROW_DEADLINE_SECS)
        .ok_or(SettlementError::AmountOverflow)?;
    require!(deadline <= max_deadline, SettlementError::DeadlineTooFar);

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
            grace_ends_at: 0, // ADR-102: no grace protection until submit_milestone sets it
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

    // AUD-009: Reject acceptance after the deadline has already passed.
    // Without this guard, a provider can accept an already-expired escrow,
    // transitioning it from Created → Active. Once Active, `cancel_escrow`
    // (which is Created-only) is no longer available to the client, so the
    // client's funds are locked until `expire_escrow` fires — and the
    // provider has done zero work. This is a pure grief vector: it lets a
    // provider strand client funds for the deadline window and forces the
    // expire path to do the cleanup. Refuse the transition here.
    //
    // AUD-105 (cycle-2): use strict-less-than (`now < deadline`) rather than
    // inclusive (`now <= deadline`). At exactly `now == deadline` the
    // provider has zero seconds of execution headroom — the very next slot
    // has `now > deadline` and `submit_milestone` would reject with
    // `DeadlinePassed`. Strict comparison forces at least one second of
    // headroom and closes the residual grief vector at the boundary.
    // `submit_milestone` retains `<=` so a provider who accepted strictly
    // before the deadline can still land submissions in the deadline-block
    // itself.
    let now = Clock::get()?.unix_timestamp;
    require!(now < escrow.deadline, SettlementError::DeadlinePassed);

    escrow.status = EscrowStatus::Active;

    emit!(TaskAccepted {
        escrow: escrow.key(),
        provider: ctx.accounts.provider.key(),
        task_id: escrow.task_id,
    });

    Ok(())
}

/// ADR-102: `grace_period_slots` closes the mempool front-running window.
/// A non-zero value sets `milestone.grace_ends_at = current_slot + grace_period_slots`.
/// Any slash (expire_escrow) that executes while `clock.slot < grace_ends_at` returns
/// `MilestoneInGracePeriod` instead of applying the penalty.
/// Pass 0 to opt out (no grace protection, default behaviour).
pub fn submit_milestone(
    ctx: Context<SubmitMilestone>,
    milestone_index: u32,
    grace_period_slots: u64,
) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

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
    // ADR-102: record the slot after which slashing is permitted.
    escrow.milestones[index].grace_ends_at = clock.slot.saturating_add(grace_period_slots);

    emit!(MilestoneSubmitted {
        escrow: escrow.key(),
        provider: ctx.accounts.provider.key(),
        milestone_index,
        task_id: escrow.task_id,
    });

    Ok(())
}

pub fn approve_milestone(
    ctx: Context<ApproveMilestone>,
    milestone_index: u32,
    rating: u8,
) -> Result<()> {
    // Finding #8 (legacy) / AUD-007 (PR-Q): rating used to be plumbed to
    // the registry CPI so `avg_rating` populated. PR-G removed the only
    // writer (`update_reputation`), and PR-Q removed `avg_rating` from the
    // on-chain `AgentProfile`. The arg is kept for forward-compat with a
    // future rating ix; we still reject out-of-band values (>5) so a
    // future consumer can rely on the validation, but no aggregate is
    // mutated today.
    require!(rating <= 5, SettlementError::InvalidRating);

    let index = milestone_index as usize;
    let amount: u64;
    let bump: u8;
    let client_key: Pubkey;
    let provider_key: Pubkey;
    let task_id: u64;
    let now = Clock::get()?.unix_timestamp;
    {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Active, SettlementError::InvalidStatus);
        // C2: Approval must happen before deadline, symmetric with submit_milestone.
        // After deadline, Submitted milestones are auto-paid by expire_escrow
        // (silence = acceptance), so provider still gets paid without a manual
        // approval path. This prevents a client from ratifying a Submitted
        // milestone well past the deadline to bypass the expire flow.
        require!(now <= escrow.deadline, SettlementError::DeadlinePassed);
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

    let reputation_delta_task_completed =
        ctx.accounts.protocol_config.reputation_delta_task_completed;
    let escrow = &mut ctx.accounts.escrow;
    let all_approved = escrow.milestones.iter().all(|m| m.status == MilestoneStatus::Approved);
    if all_approved {
        escrow.status = EscrowStatus::Completed;

        // Finding #19: use governance-owned delta, not the compile-time const.
        // SEC-1: pass `provider_authority` (= escrow.provider, address-
        // constrained) so the Registry's new external-seed anchor is satisfied.
        // ADR-097: pass `provider_owner_nonce` for the Registry's nonce-based PDA seed.
        update_provider_reputation(
            provider_key,
            escrow.released_amount,
            reputation_delta_task_completed,
            true,
            rating,
            ctx.accounts.registry_program.to_account_info(),
            ctx.accounts.provider_profile.to_account_info(),
            ctx.accounts.provider_authority.to_account_info(),
            ctx.accounts.provider_owner_nonce.to_account_info(),
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
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    require!(now > escrow.deadline, SettlementError::DeadlineNotReached);
    require!(
        escrow.status == EscrowStatus::Active || escrow.status == EscrowStatus::Created,
        SettlementError::InvalidStatus
    );

    // ADR-102: Guard against front-running. If any Submitted milestone is still
    // within its grace window, the slash is premature — the provider's
    // `submit_milestone` tx may have only recently landed and needs time to
    // be recognised before a slash can fire. grace_ends_at == 0 means the
    // provider opted out of grace protection; skip the check in that case.
    for milestone in &escrow.milestones {
        if milestone.status == MilestoneStatus::Submitted
            && milestone.grace_ends_at > 0
            && clock.slot < milestone.grace_ends_at
        {
            return Err(SettlementError::MilestoneInGracePeriod.into());
        }
    }

    // C1: On expiry, a Submitted milestone is implicitly approved — "silence
    // equals acceptance." This closes the attack where a client accepts
    // submitted work but stalls on approval to extract a full refund after
    // the deadline, while also slashing the provider's reputation.
    //
    // Settlement on expiry:
    //   * Approved   → already paid (counted in released_amount, skipped here)
    //   * Submitted  → paid to provider (auto-approve)
    //   * Pending    → refunded to client; counts as non-delivery
    //   * Rejected   → refunded to client; not a non-delivery signal (client
    //                   explicitly rejected, provider had a chance to re-submit)
    //   * Disputed   → unreachable: RaiseDispute transitions escrow.status to
    //                   Disputed, which fails the EscrowStatus guard above.
    let mut provider_earned: u64 = 0;
    let mut has_pending: bool = false;
    for milestone in &escrow.milestones {
        match milestone.status {
            MilestoneStatus::Submitted => {
                provider_earned = provider_earned
                    .checked_add(milestone.amount)
                    .ok_or(SettlementError::AmountOverflow)?;
            }
            MilestoneStatus::Pending => {
                has_pending = true;
            }
            MilestoneStatus::Approved
            | MilestoneStatus::Rejected
            | MilestoneStatus::Disputed => {}
        }
    }

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
    // Slash the provider only when they accepted the task (status == Active)
    // and then failed to submit work for at least one milestone by the
    // deadline. A never-accepted task (status == Created) is not a
    // non-delivery — the provider never committed.
    let prior_status = escrow.status.clone();

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

    let should_slash = prior_status == EscrowStatus::Active && has_pending;
    let reputation_delta_expiry_undelivered =
        ctx.accounts.protocol_config.reputation_delta_expiry_undelivered;
    // AUD-010: When the auto-approval loop leaves every milestone in the
    // `Approved` state (i.e. the escrow effectively completed via the
    // timeout path), the success-path reputation CPI must fire — otherwise
    // the provider loses the +task_completed reward simply because the
    // client was slow to approve before the deadline. We snapshot the
    // governance-owned delta here, before the `&mut` reborrow below, to
    // avoid an immutable/mutable borrow overlap on `ctx.accounts`.
    let reputation_delta_task_completed =
        ctx.accounts.protocol_config.reputation_delta_task_completed;

    let escrow = &mut ctx.accounts.escrow;
    escrow.released_amount = escrow
        .released_amount
        .checked_add(provider_earned)
        .and_then(|v| v.checked_add(client_refund))
        .ok_or(SettlementError::AmountOverflow)?;
    // Mark auto-paid Submitted milestones as Approved for audit clarity.
    for milestone in escrow.milestones.iter_mut() {
        if milestone.status == MilestoneStatus::Submitted {
            milestone.status = MilestoneStatus::Approved;
        }
    }

    // AUD-010: Determine the final escrow status AFTER the auto-approval
    // sweep above. If every milestone is now `Approved`, the escrow
    // genuinely completed (just on the timeout rail rather than the manual
    // approve_milestone rail), so it should land in `Completed` and fire
    // the success-path reputation CPI — same as `approve_milestone`'s
    // final-milestone branch. Mixed Pending/Submitted state remains
    // `Expired` and continues to take the slash path below.
    let all_approved = escrow
        .milestones
        .iter()
        .all(|m| m.status == MilestoneStatus::Approved);

    if all_approved {
        escrow.status = EscrowStatus::Completed;
    } else {
        escrow.status = EscrowStatus::Expired;
    }

    if all_approved {
        // AUD-010: Success-path CPI mirrors `approve_milestone`'s
        // final-milestone branch. `rating = 0` because the expiry path has
        // no client-supplied rating; PR-G removed `avg_rating` from the
        // on-chain profile so this is informational only. `task_completed
        // = true` selects reason code 0 (= task_completed) inside
        // `update_provider_reputation`.
        update_provider_reputation(
            provider_key,
            escrow.released_amount,
            reputation_delta_task_completed,
            true,
            0,
            ctx.accounts.registry_program.to_account_info(),
            ctx.accounts.provider_profile.to_account_info(),
            ctx.accounts.provider_authority.to_account_info(),
            ctx.accounts.provider_owner_nonce.to_account_info(),
            ctx.accounts.settlement_authority.to_account_info(),
            ctx.bumps.settlement_authority,
        )?;

        emit!(EscrowCompleted {
            escrow: escrow.key(),
            provider: provider_key,
            task_id,
            total_released: escrow.released_amount,
        });
    } else if should_slash {
        // Finding #19: governance-owned delta; rating=0 — expiry is an auto-slash.
        // SEC-1: pass `provider_authority` (= escrow.provider) — see cpi.rs.
        // ADR-097: pass `provider_owner_nonce` for the Registry's nonce-based PDA seed.
        update_provider_reputation(
            provider_key,
            0,
            reputation_delta_expiry_undelivered,
            false,
            0,
            ctx.accounts.registry_program.to_account_info(),
            ctx.accounts.provider_profile.to_account_info(),
            ctx.accounts.provider_authority.to_account_info(),
            ctx.accounts.provider_owner_nonce.to_account_info(),
            ctx.accounts.settlement_authority.to_account_info(),
            ctx.bumps.settlement_authority,
        )?;
    }

    // AUD-010: Emit the terminal-status event matching the new
    // `escrow.status`. The all-Approved branch above already emitted
    // `EscrowCompleted`; the slash/mixed branch emits `EscrowExpired` so
    // off-chain indexers see exactly one terminal event per escrow and
    // their event-to-status invariant remains consistent.
    if !all_approved {
        emit!(EscrowExpired {
            escrow: escrow.key(),
            task_id,
            refunded_amount: client_refund,
        });
    }

    Ok(())
}

pub fn close_escrow(_ctx: Context<CloseEscrow>) -> Result<()> {
    Ok(())
}
