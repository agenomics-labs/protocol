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

    // ---- C4-OB-01 (cycle-4): risk-containment hotfix ----
    #[msg(
        "C4-OB-01: payload.amount_returned_micros does not equal the \
         milestone amount recorded on the escrow account — the CCTP \
         round-trip returned a different number than the escrow authorizes \
         to release."
    )]
    AmountReconciliationMismatch,

    #[msg(
        "C4-OB-01: milestone_index is out of range for the escrow's \
         milestones vector (raw-bytes read)."
    )]
    MilestoneIndexOutOfRange,

    #[msg(
        "C4-OB-01: escrow account data could not be parsed far enough to \
         read the milestone amount for reconciliation."
    )]
    EscrowMilestoneParseFailed,

    #[msg(
        "C4-OB-05: escrow account discriminator does not match the \
         settlement TaskEscrow Anchor discriminator \
         (sha256(\"account:TaskEscrow\")[..8])."
    )]
    EscrowDiscriminatorMismatch,

    #[msg(
        "C4-OB-01: the transaction payer is not the canonical CCTP receiver \
         authority permitted to drive auto-approval."
    )]
    UnauthorizedCctpReceiver,

    #[msg(
        "C4-OB-01 / ADR-145: auto_approve_milestone is hard-disabled until \
         on-chain CCTP attestation verification (ADR-145) lands. Build with \
         the `cctp_attestation_verified` feature ONLY on a non-fund-bearing \
         cluster for integration testing."
    )]
    CctpAttestationNotVerified,

    // ---- ADR-145: genuine on-chain CCTP V2 attestation verification ----
    #[msg(
        "ADR-145: the cctp_message_transmitter account is not the canonical \
         Circle CCTP V2 MessageTransmitterV2 program ID."
    )]
    InvalidCctpMessageTransmitter,

    #[msg(
        "ADR-145: the used_nonce account is not owned by the Circle CCTP V2 \
         MessageTransmitterV2 program — it cannot be a genuine consumed-nonce \
         PDA."
    )]
    UsedNonceOwnerMismatch,

    #[msg(
        "ADR-145: the supplied used_nonce account address does not equal the \
         canonical [b\"used_nonce\", message[12..44]] PDA derived from the \
         CCTP message under MessageTransmitterV2 — the message does not \
         correspond to this nonce account."
    )]
    UsedNonceAddressMismatch,

    #[msg(
        "ADR-145: the used_nonce PDA exists but UsedNonce.is_used is false — \
         the Circle CCTP V2 message was not actually consumed (no attested \
         mint occurred for this nonce)."
    )]
    CctpNonceNotConsumed,

    #[msg(
        "ADR-145: the CCTP V2 message header is malformed or shorter than \
         MESSAGE_BODY_INDEX (148) — cannot parse nonce/source/body."
    )]
    CctpMessageMalformed,

    #[msg(
        "ADR-145: the CCTP V2 message destination_domain does not equal the \
         Solana CCTP domain (5)."
    )]
    CctpWrongDestinationDomain,

    #[msg(
        "ADR-145: the CCTP V2 message source_domain does not equal the \
         expected Base CCTP domain (6)."
    )]
    CctpWrongSourceDomain,

    #[msg(
        "ADR-145: the CCTP V2 BurnMessage body is malformed or shorter than \
         the minimum burn-payload length (228 bytes)."
    )]
    CctpBurnBodyMalformed,

    #[msg(
        "ADR-145: the verified CCTP V2 BurnMessage `amount` does not equal \
         payload.amount_returned_micros — the attested mint is for a \
         different number than the payload claims."
    )]
    CctpAmountBindingMismatch,

    #[msg(
        "ADR-145: payload.base_tx_hash does not equal keccak-bound digest of \
         the verified CCTP V2 message (source_domain || nonce) — base_tx_hash \
         is not bound to the attested message."
    )]
    CctpBaseTxBindingMismatch,
}
