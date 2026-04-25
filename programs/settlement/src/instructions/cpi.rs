use anchor_lang::prelude::*;

/// CPIs into Agent Registry to update provider reputation after task completion.
///
/// Uses a PDA-signed CPI pattern: the Settlement program derives a "settlement_authority"
/// PDA and signs the CPI with it. The Registry program verifies this PDA as a signer
/// with seeds::program = SETTLEMENT_PROGRAM_ID, cryptographically proving the call
/// originated from this program.
///
/// Finding #17 (ARCHITECTURE_DEEP_CRITIQUE): the previous implementation built the
/// `Instruction` by hand with a hard-coded discriminator
/// `[194, 220, 43, 201, 54, 209, 49, 178]` and manually-encoded args. If the
/// registry renamed `update_reputation` or reordered its arguments, the
/// discriminator would silently mismatch at runtime. This version uses the
/// Anchor-generated `agent_registry::cpi::update_reputation` helper, which is
/// regenerated from the Registry's `#[program]` module on every build — any
/// rename/reorder becomes a compile error, not a runtime break.
///
/// ADR-039: Accepts `reputation_delta` and `task_completed` as parameters,
/// enabling both positive reputation (task completion) and negative reputation
/// (dispute/expiry slashing).
///
/// Finding #8 (ARCHITECTURE_DEEP_CRITIQUE): pre-fix, `rating` was hard-coded to 0
/// here, and `update_reputation` in the registry only folds rating into
/// `avg_rating` when it's non-zero — so `avg_rating` was always 0 for every
/// agent. The CPI now surfaces `rating` as a real caller argument; only
/// `approve_milestone` (the client's explicit ratification step) supplies a
/// non-zero value. Slash/expire/dispute paths pass 0 because no rating
/// judgment exists on those paths.
///
/// SEC-1 (per ADR-068, Accepted 2026-04-23): the Registry's `UpdateReputation`
/// account struct now requires an explicit `authority` account whose
/// `.key()` anchors the `agent_profile` PDA derivation. Callers pass
/// `escrow.provider` (via a new `provider_authority: UncheckedAccount`
/// constrained with `address = escrow.provider`). This closes the
/// self-referential-seed hole in the pre-fix Registry context.
/// ADR-097: `owner_nonce` is now a required account in the Registry's
/// `UpdateReputation` context (used to re-derive the profile PDA with the
/// nonce component). Settlement CPI callers must pass the provider's
/// `OwnerNonce` account alongside the authority and profile accounts.
///
/// AUD-032 (2026-04-25 audit): pre-fix this function emitted a
/// `ReputationUpdateScheduled` event after the synchronous CPI returned.
/// The name implied async/queued semantics that don't exist — by the
/// time the event was emitted, the Registry had already processed the
/// update and emitted its own canonical `ReputationUpdated` event.
/// Indexers double-counted the change. The Registry's event is the
/// single source of truth, so the Settlement-side emit (and the
/// `ReputationUpdateScheduled` struct in `events.rs`) have been removed.
/// The `_provider` argument stays in the signature so existing callers
/// in `escrow.rs` and `dispute.rs` continue to compile without churn.
// TODO(ADR-094): Replace `update_provider_reputation` with a call to
// `Registry::propose_reputation_delta` via CPI. The new instruction owns the
// reputation policy ([0, 100], |delta| <= MAX_DELTA_PER_CALL = 10), so
// Settlement no longer needs to reason about valid ranges — it only proposes
// deltas and supplies a reason code. Full CPI re-wiring (new account struct
// + updated caller sites in escrow.rs) is tracked as a follow-up to ADR-094.
pub fn update_provider_reputation<'info>(
    _provider: Pubkey,
    earnings: u64,
    reputation_delta: i64,
    task_completed: bool,
    rating: u8,
    registry_program: AccountInfo<'info>,
    provider_profile: AccountInfo<'info>,
    provider_authority: AccountInfo<'info>,
    provider_owner_nonce: AccountInfo<'info>,
    settlement_authority: AccountInfo<'info>,
    settlement_authority_bump: u8,
) -> Result<()> {
    let signer_seeds: &[&[u8]] = &[b"settlement_authority", &[settlement_authority_bump]];
    let cpi_signer: &[&[&[u8]]] = &[signer_seeds];

    let cpi_accounts = agent_registry::cpi::accounts::UpdateReputation {
        authority: provider_authority,
        owner_nonce: provider_owner_nonce,
        agent_profile: provider_profile,
        settlement_authority,
    };

    let cpi_ctx = CpiContext::new_with_signer(registry_program, cpi_accounts, cpi_signer);

    agent_registry::cpi::update_reputation(
        cpi_ctx,
        reputation_delta,
        task_completed,
        earnings,
        rating,
    )?;

    Ok(())
}
