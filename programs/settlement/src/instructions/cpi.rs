use anchor_lang::prelude::*;

use crate::events::*;

/// CPIs into Agent Registry to update provider reputation after task completion.
///
/// Uses a PDA-signed CPI pattern: the Settlement program derives a "settlement_authority"
/// PDA and signs the CPI with it. The Registry program verifies this PDA as a signer
/// with seeds::program = SETTLEMENT_PROGRAM_ID, cryptographically proving the call
/// originated from this program.
///
/// The discriminator is computed as sha256("global:update_reputation")[..8].
/// This is Anchor's standard discriminator for the `update_reputation` instruction.
///
/// ADR-039: Accepts `reputation_delta` and `task_completed` as parameters,
/// enabling both positive reputation (task completion) and negative reputation
/// (dispute/expiry slashing).
pub fn update_provider_reputation<'info>(
    provider: Pubkey,
    earnings: u64,
    reputation_delta: i64,
    task_completed: bool,
    registry_program: AccountInfo<'info>,
    provider_profile: AccountInfo<'info>,
    settlement_authority: AccountInfo<'info>,
    settlement_authority_bump: u8,
) -> Result<()> {
    use anchor_lang::solana_program::instruction::Instruction;
    use anchor_lang::solana_program::program::invoke_signed;

    let discriminator: [u8; 8] = [194, 220, 43, 201, 54, 209, 49, 178];
    let rating: u8 = 0;

    let mut data = Vec::with_capacity(8 + 8 + 1 + 8 + 1);
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(&reputation_delta.to_le_bytes());
    data.extend_from_slice(&[task_completed as u8]);
    data.extend_from_slice(&earnings.to_le_bytes());
    data.extend_from_slice(&[rating]);

    let accounts = vec![
        AccountMeta::new(provider_profile.key(), false),
        AccountMeta::new_readonly(settlement_authority.key(), true),
    ];

    let ix = Instruction {
        program_id: registry_program.key(),
        accounts,
        data,
    };

    let signer_seeds: &[&[u8]] = &[b"settlement_authority", &[settlement_authority_bump]];

    invoke_signed(
        &ix,
        &[provider_profile, settlement_authority, registry_program],
        &[signer_seeds],
    )?;

    emit!(ReputationUpdateScheduled {
        provider,
        delta: reputation_delta,
    });

    Ok(())
}
