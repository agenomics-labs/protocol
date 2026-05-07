//! Error codes for the CCTP Hook program.

use anchor_lang::prelude::*;

#[error_code]
pub enum HookError {
    #[msg("Payload escrow_pda does not match the escrow account passed in.")]
    PayloadEscrowMismatch,

    #[msg("Payload amount_returned_micros must be > 0.")]
    ZeroAmountReturned,

    #[msg("Payload base_tx_hash must be non-zero (probable malformed CCTP message).")]
    InvalidBaseTxHash,

    #[msg(
        "Escrow client field does not equal the hook_signer PDA derived from \
         agent_authority — upstream create_escrow must have used hook_signer \
         as the escrow's client."
    )]
    EscrowClientMismatch,

    #[msg("registry_program account does not match the canonical Agent Registry program ID.")]
    InvalidRegistryProgram,

    #[msg("settlement_program account does not match the canonical Settlement program ID.")]
    InvalidSettlementProgram,

    #[msg("Escrow account is not owned by the Settlement program.")]
    EscrowOwnerMismatch,

    #[msg("Escrow account data is too small to read TaskEscrow.client at offset 8.")]
    EscrowAccountTooSmall,
}
