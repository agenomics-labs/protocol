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
/// - `dispute_timeout_seconds` must be > 0.
/// - Positive-reward delta must stay non-negative; slash deltas must stay
///   non-positive. Flipping the sign of a slash delta would turn a slash
///   into a reward and vice-versa — almost always a bug. Authority can
///   still push the magnitudes arbitrarily.
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
        require!(v > 0, SettlementError::InvalidProtocolConfigValue);
        config.dispute_timeout_seconds = v;
    }
    if let Some(v) = reputation_delta_task_completed {
        require!(v >= 0, SettlementError::InvalidProtocolConfigValue);
        config.reputation_delta_task_completed = v;
    }
    if let Some(v) = reputation_delta_dispute_loss {
        require!(v <= 0, SettlementError::InvalidProtocolConfigValue);
        config.reputation_delta_dispute_loss = v;
    }
    if let Some(v) = reputation_delta_expiry_undelivered {
        require!(v <= 0, SettlementError::InvalidProtocolConfigValue);
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
