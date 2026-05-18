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

/// C4-OB-04 (cycle-4): Settlement-side defense-in-depth read of the provider
/// profile's Registry suspension flag *before* the positive-reputation CPI.
///
/// The Registry's `propose_reputation_delta` handler today rejects only the
/// terminal `Retired` status (AUD-206); it does NOT reject `Suspended`
/// (`agent-registry/src/lib.rs` — the slash path *writes* `Suspended`, but
/// no entry guard rejects an inbound delta on an already-`Suspended`
/// profile). That means a suspended provider can still accrue
/// `+task_completed` reputation through Settlement's `approve_milestone` /
/// all-Approved `expire_escrow` paths, defeating ADR-095/097.
///
/// Rather than rely entirely on the cross-program callee (a Registry
/// refactor would silently re-open this — there was no Settlement-side
/// pin, unlike the AUD-117/AUD-202 layout pins), Settlement now reads the
/// `AgentProfile.status` byte at the Registry-owned profile account it has
/// already re-derived (AUD-117 seeds defense-in-depth, `contexts.rs`) and
/// refuses to *reward* a suspended provider. Negative (slash) deltas are
/// intentionally still allowed through — a suspended provider must keep
/// taking dispute/expiry penalties.
///
/// The check decodes only the discriminator (8) + the `authority: Pubkey`
/// (32) prefix to reach the `status` enum tag. `AgentStatus` derives in
/// declaration order `Active=0, Paused=1, Retired=2, Suspended=3`
/// (`agent-registry/src/state.rs`); `Suspended` is tag byte `3`. This
/// offset is layout-pinned by the Registry's own `state.rs` byte-offset
/// test and re-asserted here by `test_agent_profile_status_offset` so a
/// Registry struct reorder fails Settlement's suite, not silently in prod.
pub(crate) const AGENT_PROFILE_STATUS_OFFSET: usize = 8 + 32;
pub(crate) const AGENT_STATUS_SUSPENDED_TAG: u8 = 3;

fn require_provider_not_suspended(provider_profile: &AccountInfo) -> Result<()> {
    let data = provider_profile.try_borrow_data()?;
    // Defense-in-depth: a too-short / uninitialized account cannot be a
    // valid AgentProfile; the Registry CPI will reject it regardless, but
    // fail closed here rather than index a garbage byte.
    require!(
        data.len() > AGENT_PROFILE_STATUS_OFFSET,
        crate::errors::SettlementError::InvalidStatus
    );
    let status_tag = data[AGENT_PROFILE_STATUS_OFFSET];
    require!(
        status_tag != AGENT_STATUS_SUSPENDED_TAG,
        crate::errors::SettlementError::ProviderSuspended
    );
    Ok(())
}

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
    // C4-OB-04: never *reward* a Registry-suspended provider from the
    // Settlement boundary, regardless of whether the Registry callee
    // currently gates `Suspended` on its side. Slash reasons (1, 2) are
    // deliberately exempt — a suspended provider must keep taking
    // dispute-loss / expiry-undelivered penalties.
    if reason == REASON_TASK_COMPLETED {
        require_provider_not_suspended(&provider_profile)?;
    }

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
