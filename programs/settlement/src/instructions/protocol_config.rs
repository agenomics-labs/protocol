use anchor_lang::prelude::*;

use crate::state::*;
use crate::errors::*;
use crate::events::*;
use crate::contexts::*;

/// Finding #19 (ARCHITECTURE_DEEP_CRITIQUE): Creates the singleton
/// `ProtocolConfig` PDA and seeds it with the current compile-time default
/// values. Idempotent by virtue of the `init` constraint — calling this
/// twice fails at the Anchor layer with an already-initialized error.
///
/// `payer` becomes the initial `authority`. Projects that want a stronger
/// setup can immediately call `update_protocol_config` from a new
/// timelock/multisig to rotate the authority.
pub fn initialize_protocol_config(ctx: Context<InitializeProtocolConfig>) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    config.authority = ctx.accounts.payer.key();
    config.min_escrow_amount = DEFAULT_MIN_ESCROW_AMOUNT;
    config.dispute_timeout_seconds = DEFAULT_DISPUTE_TIMEOUT_SECONDS;
    config.reputation_delta_task_completed = DEFAULT_REPUTATION_DELTA_TASK_COMPLETED;
    config.reputation_delta_dispute_loss = DEFAULT_REPUTATION_DELTA_DISPUTE_LOSS;
    config.reputation_delta_expiry_undelivered = DEFAULT_REPUTATION_DELTA_EXPIRY_UNDELIVERED;
    config.bump = ctx.bumps.protocol_config;

    emit!(ProtocolConfigInitialized {
        authority: config.authority,
        min_escrow_amount: config.min_escrow_amount,
        dispute_timeout_seconds: config.dispute_timeout_seconds,
        reputation_delta_task_completed: config.reputation_delta_task_completed,
        reputation_delta_dispute_loss: config.reputation_delta_dispute_loss,
        reputation_delta_expiry_undelivered: config.reputation_delta_expiry_undelivered,
    });

    Ok(())
}

/// Finding #19: Authority-gated update. Any `Option<T>::None` field is
/// left unchanged — callers pass only what they want to mutate.
///
/// Sanity bounds (enforced here, not in the context, so error messages are
/// actionable for governance callers):
/// - `min_escrow_amount` must be > 0.
/// - `dispute_timeout_seconds` must be > 0, <= MAX_DISPUTE_TIMEOUT_SECONDS.
/// - Positive-reward delta must stay non-negative; slash deltas must stay
///   non-positive. Flipping the sign of a slash delta would turn a slash
///   into a reward and vice-versa — almost always a bug.
/// - SEC-11 (per ADR-075, in-flight): slash deltas also have a lower
///   bound. The registry's slashing path negates the delta and applies it
///   via `saturating_sub`; a delta of `i64::MIN` panics the negation in
///   debug and is nonsensical in any mode. `MIN_REPUTATION_DELTA` caps the
///   magnitude far below `i64::MIN` so the registry-side `checked_neg` is
///   never actually exercised on a reachable config — belt-and-braces.
pub fn update_protocol_config(
    ctx: Context<UpdateProtocolConfig>,
    min_escrow_amount: Option<u64>,
    dispute_timeout_seconds: Option<i64>,
    reputation_delta_task_completed: Option<i64>,
    reputation_delta_dispute_loss: Option<i64>,
    reputation_delta_expiry_undelivered: Option<i64>,
) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;

    if let Some(v) = min_escrow_amount {
        require!(v > 0, SettlementError::InvalidProtocolConfigValue);
        config.min_escrow_amount = v;
    }
    if let Some(v) = dispute_timeout_seconds {
        // S-onchain-01: enforce an upper bound so downstream `disputed_at +
        // dispute_timeout_seconds` arithmetic in `resolve_dispute_timeout`
        // cannot overflow. See `MAX_DISPUTE_TIMEOUT_SECONDS` in state.rs.
        require!(
            v > 0 && v <= MAX_DISPUTE_TIMEOUT_SECONDS,
            SettlementError::InvalidProtocolConfigValue
        );
        config.dispute_timeout_seconds = v;
    }
    if let Some(v) = reputation_delta_task_completed {
        require!(v >= 0, SettlementError::InvalidProtocolConfigValue);
        config.reputation_delta_task_completed = v;
    }
    if let Some(v) = reputation_delta_dispute_loss {
        // SEC-11: close the lower-bound hole. `v <= 0` alone admits
        // `i64::MIN`, which the registry's negation panics on in debug.
        require!(
            v <= 0 && v >= MIN_REPUTATION_DELTA,
            SettlementError::InvalidProtocolConfigValue
        );
        config.reputation_delta_dispute_loss = v;
    }
    if let Some(v) = reputation_delta_expiry_undelivered {
        // SEC-11: same rationale as `reputation_delta_dispute_loss`.
        require!(
            v <= 0 && v >= MIN_REPUTATION_DELTA,
            SettlementError::InvalidProtocolConfigValue
        );
        config.reputation_delta_expiry_undelivered = v;
    }

    emit!(ProtocolConfigUpdated {
        authority: config.authority,
        min_escrow_amount: config.min_escrow_amount,
        dispute_timeout_seconds: config.dispute_timeout_seconds,
        reputation_delta_task_completed: config.reputation_delta_task_completed,
        reputation_delta_dispute_loss: config.reputation_delta_dispute_loss,
        reputation_delta_expiry_undelivered: config.reputation_delta_expiry_undelivered,
    });

    Ok(())
}
