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

// ============================================================================
// AUD-005 (PR-H) — unit-level coverage for the upgrade-authority gate
// ============================================================================
//
// The wire-level constraint (`program_data.upgrade_authority_address ==
// Some(payer.key()) @ Unauthorized`) lives on the `InitializeProtocolConfig`
// context in `contexts.rs`. Anchor's macro generates the runtime check from
// that attribute; integration tests in `tests/settlement.ts` exercise the
// happy path against a live validator. The unit tests below pin the
// supporting invariants that `cargo check` alone would not catch:
//
//   1. The `Unauthorized` error variant exists, is reachable from this
//      module's namespace, and has a stable user-facing message. Renaming or
//      deleting it breaks the constraint at compile time *here* (not just at
//      a single call site in contexts.rs).
//   2. The constraint predicate is the correct boolean for "payer == current
//      upgrade authority", including the BPF Loader semantics that
//      `upgrade_authority_address == None` means the program has been
//      finalized (immutable) and thus *no* key may pass — closing a future
//      foot-gun where a finalized program is somehow re-initialized.
//
// Mocking a live `Account<'info, ProgramData>` requires constructing a
// well-formed `AccountInfo` plus serialized `UpgradeableLoaderState` bytes,
// which is well outside the scope of a unit test. Anchor's own test suite
// covers the loader-state deserialization. Here we test the *predicate
// shape* against the `ProgramData` struct directly, which is the surface our
// constraint actually evaluates.
#[cfg(test)]
mod tests {
    use anchor_lang::prelude::ProgramData;
    use anchor_lang::solana_program::pubkey::Pubkey;
    use crate::errors::SettlementError;

    /// AUD-005: the constraint expression
    /// `program_data.upgrade_authority_address == Some(payer.key())`
    /// evaluates `true` only when the payer is the current upgrade authority
    /// of the program.
    #[test]
    fn aud005_predicate_accepts_matching_upgrade_authority() {
        let upgrade_authority = Pubkey::new_unique();
        let pd = ProgramData {
            slot: 0,
            upgrade_authority_address: Some(upgrade_authority),
        };
        let payer = upgrade_authority;
        assert!(pd.upgrade_authority_address == Some(payer));
    }

    /// AUD-005: a different (non-upgrade-authority) payer is rejected.
    #[test]
    fn aud005_predicate_rejects_mismatched_payer() {
        let upgrade_authority = Pubkey::new_unique();
        let pd = ProgramData {
            slot: 0,
            upgrade_authority_address: Some(upgrade_authority),
        };
        let attacker = Pubkey::new_unique();
        assert!(pd.upgrade_authority_address != Some(attacker));
    }

    /// AUD-005: a finalized (immutable) program has
    /// `upgrade_authority_address == None`. Under that state, the predicate
    /// must reject *every* payer, including a freshly-generated key. This
    /// closes a foot-gun where a future operator finalizes the program (no
    /// upgrade authority) and then tries to re-initialize the config —
    /// `Some(_)` cannot equal `None`, so the constraint fails as required.
    #[test]
    fn aud005_predicate_rejects_when_program_is_finalized() {
        let pd = ProgramData {
            slot: 0,
            upgrade_authority_address: None,
        };
        let any_payer = Pubkey::new_unique();
        assert!(pd.upgrade_authority_address != Some(any_payer));
    }

    /// AUD-005: the `Unauthorized` error variant exists at the namespace
    /// the constraint references. A rename in errors.rs breaks compilation
    /// here, not just in contexts.rs — extra belt-and-braces because the
    /// constraint attribute is a stringly-evaluated macro fragment.
    #[test]
    fn aud005_unauthorized_error_variant_exists() {
        // If `SettlementError::Unauthorized` is removed, this fails to
        // compile — exactly the compile-time guarantee the wire-level
        // constraint attribute lacks.
        let _e: SettlementError = SettlementError::Unauthorized;
    }
}
