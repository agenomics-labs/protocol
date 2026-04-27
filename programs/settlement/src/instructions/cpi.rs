use anchor_lang::prelude::*;

/// AUD-001 / AUD-002 (PR-G): CPI into Agent Registry's
/// `propose_reputation_delta`. Replaces the legacy `update_reputation` call.
///
/// The Registry program owns the unified reputation policy:
///   - score is bounded to `[0, 100]` (Registry constant `MAX_REPUTATION_SCORE`)
///   - `|delta| <= MAX_DELTA_PER_CALL` (= 10)
///   - signature is `i16` delta + `u8` reason code
///
/// Settlement no longer reasons about score ranges; it only proposes deltas
/// (clamped to the i16 range) and supplies a reason code. Caller-side
/// reasons:
///   0 = task_completed (positive delta)
///   1 = dispute_loss   (negative delta)
///   2 = expiry_undelivered (negative delta)
///
/// Authorization (defense in depth):
///   - The Settlement program's `settlement_authority` PDA signs the CPI
///     via `invoke_signed`; Registry's `ProposeReputationDelta` context
///     verifies the signer with `seeds::program = SETTLEMENT_PROGRAM_ID`
///     (SEC-1 pattern, ADR-068).
///   - Registry's context binds `agent_profile` to the supplied
///     `provider_authority` via `has_one = authority` AND seeds derived
///     from `[authority.key(), b"agent-profile", owner_nonce.nonce.to_le_bytes()]`,
///     closing the cross-account-reuse hole AUD-001 reported.
///
/// Note on `delta` clamping: the Settlement-level `reputation_delta`
/// parameter is `i64` (governance-controlled via `ProtocolConfig`); the
/// Registry-side parameter is `i16`. We clamp into the `i16` range here.
/// AUD-102 (cycle-2): `update_protocol_config` now caps governance values
/// at `[MIN_REPUTATION_DELTA, MAX_REPUTATION_DELTA] = [-10, +10]`,
/// matching the Registry's `MAX_DELTA_PER_CALL = 10` per-call cap exactly.
/// Pre-fix the bounds were `[-1_000_000, +i64::MAX]`, so a "valid"
/// governance value beyond ±10 would have reached this CPI and reverted
/// at the Registry's i16 magnitude check; tightening at governance time
/// turns that runtime revert into a config-time reject. The i16 clamp
/// here remains as a safety net for any future signature mismatch.
///
/// AUD-109 + AUD-113 (cycle-2): explicit `reason` parameter replaces the
/// `task_completed: bool` derivation, and the three unused parameters
/// (`_provider`, `_earnings`, `_rating`) are dropped. Each call site now
/// passes its own reason code:
///   * `escrow.rs::approve_milestone`            → `REASON_TASK_COMPLETED` (0)
///   * `escrow.rs::expire_escrow` (all-approved) → `REASON_TASK_COMPLETED` (0)
///   * `escrow.rs::expire_escrow` (undelivered)  → `REASON_EXPIRY_UNDELIVERED` (2)
///   * `dispute.rs::resolve_dispute`             → `REASON_DISPUTE_LOSS` (1)
///   * `dispute.rs::resolve_dispute_timeout`     → `REASON_DISPUTE_LOSS` (1)
///
/// Pre-fix the helper conflated `dispute_loss` and `expiry_undelivered`
/// into reason 1 because the boolean signal didn't carry enough
/// information; downstream indexers couldn't distinguish the two. The
/// constants below are the canonical reason codes.
pub const REASON_TASK_COMPLETED: u8 = 0;
pub const REASON_DISPUTE_LOSS: u8 = 1;
pub const REASON_EXPIRY_UNDELIVERED: u8 = 2;

pub fn update_provider_reputation<'info>(
    reputation_delta: i64,
    reason: u8,
    registry_program: AccountInfo<'info>,
    provider_profile: AccountInfo<'info>,
    provider_authority: AccountInfo<'info>,
    provider_owner_nonce: AccountInfo<'info>,
    settlement_authority: AccountInfo<'info>,
    settlement_authority_bump: u8,
) -> Result<()> {
    let signer_seeds: &[&[u8]] = &[b"settlement_authority", &[settlement_authority_bump]];
    let cpi_signer: &[&[&[u8]]] = &[signer_seeds];

    let cpi_accounts = agent_registry::cpi::accounts::ProposeReputationDelta {
        owner_nonce: provider_owner_nonce,
        agent_profile: provider_profile,
        settlement_authority,
        authority: provider_authority,
    };

    let cpi_ctx = CpiContext::new_with_signer(registry_program, cpi_accounts, cpi_signer);

    // Map governance i64 delta into the policy i16 range. Clamping below
    // i16::MIN / above i16::MAX would have masked a configuration bug; we
    // clamp explicitly so the Registry's per-call magnitude check fires
    // visibly rather than silently truncating.
    let delta_i16: i16 = reputation_delta
        .clamp(i16::MIN as i64, i16::MAX as i64) as i16;

    agent_registry::cpi::propose_reputation_delta(cpi_ctx, delta_i16, reason)?;

    Ok(())
}
