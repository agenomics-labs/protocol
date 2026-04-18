use anchor_lang::prelude::*;

use crate::events::*;

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
pub fn update_provider_reputation<'info>(
    provider: Pubkey,
    earnings: u64,
    reputation_delta: i64,
    task_completed: bool,
    rating: u8,
    registry_program: AccountInfo<'info>,
    provider_profile: AccountInfo<'info>,
    settlement_authority: AccountInfo<'info>,
    settlement_authority_bump: u8,
) -> Result<()> {
    let signer_seeds: &[&[u8]] = &[b"settlement_authority", &[settlement_authority_bump]];
    let cpi_signer: &[&[&[u8]]] = &[signer_seeds];

    let cpi_accounts = agent_registry::cpi::accounts::UpdateReputation {
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

    emit!(ReputationUpdateScheduled {
        provider,
        delta: reputation_delta,
    });

    Ok(())
}
