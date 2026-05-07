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

    // Q-S3-A: agent CDP-wallet binding gates.
    #[msg(
        "AgentProfile account data could not be deserialized as agent_registry::state::AgentProfile \
         — the Registry layout has drifted or the account is not a profile."
    )]
    AgentProfileDeserializeFailed,
    #[msg(
        "agent_profile.cdp_wallet is None — Surface 4 must call \
         agent_registry::update_cdp_wallet to bind the agent's CDP wallet \
         before CCTP round-trips can auto-approve milestones."
    )]
    CdpWalletNotBound,
    #[msg(
        "agent_profile.cdp_wallet does not match payload.cdp_recipient — the \
         Base-side x402 settle was delivered to a different EVM address than \
         the one bound to this agent."
    )]
    CdpWalletMismatch,
}
