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
/// `update_protocol_config` (settlement/instructions/protocol_config.rs)
/// caps slash magnitudes at `MIN_REPUTATION_DELTA = -1_000_000`, which is
/// far outside `i16`; the Registry's own per-call cap (`MAX_DELTA_PER_CALL`
/// = 10) will further reject the call if the magnitude is unreasonable.
/// The clamp is therefore a safety net, not the primary policy.
///
/// `_earnings`, `_task_completed`, and `_rating` are retained in the
/// signature so existing callers in `escrow.rs` and `dispute.rs` keep
/// compiling without churn during this PR. A follow-up will trim them.
/// They are unused in the new CPI (Registry no longer folds rating into
/// `avg_rating` here — that side-effect was removed alongside the legacy
/// instruction).
pub fn update_provider_reputation<'info>(
    _provider: Pubkey,
    _earnings: u64,
    reputation_delta: i64,
    task_completed: bool,
    _rating: u8,
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

    // Reason code: positive task-completed deltas map to reason 0, negative
    // task-completed deltas would be a logic bug, and !task_completed
    // (dispute / expiry) maps to reason 1 or 2. Without a third bit of
    // information here we encode the two callers we have:
    //   - approve_milestone → task_completed=true → reason 0
    //   - resolve_dispute / resolve_dispute_timeout → !task_completed → reason 1
    //   - expire_escrow → !task_completed → reason 2 (currently shares
    //     reason 1 because the call site does not differentiate; a follow-up
    //     PR will plumb explicit reason codes through the call sites).
    let reason: u8 = if task_completed { 0 } else { 1 };

    agent_registry::cpi::propose_reputation_delta(cpi_ctx, delta_i16, reason)?;

    Ok(())
}
