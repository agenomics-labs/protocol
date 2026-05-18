//! IC-4 — `ReflexHookPayload`.
//!
//! Verbatim from `docs/aep-reflex-tech-spec.md` §"Surface 3 — Interface
//! contract — IC-4". The struct is the wire format the post-CCTP hook
//! receives. Encoding is Anchor/Borsh on the Solana side; the corresponding
//! bytes on the Base side (constructed by Surface 2/4 when building the CCTP
//! V2 burn message) MUST be byte-equivalent.
//!
//! **Open question Q-S3-C:** the Base-side encoding (Borsh? raw concatenation?
//! ABI-encoded?) is not pinned by the master spec. This file declares Borsh
//! as the Solana-side authoritative encoding; Surface 4 owner is responsible
//! for matching it on Base before IC-4 is frozen on Day 2.

use anchor_lang::prelude::*;

/// IC-4 payload — extended layout (Q-S3-A).
///
/// Master spec (frozen day 1):
/// ```rust
/// # use anchor_lang::prelude::*;
/// pub struct ReflexHookPayload {
///     pub escrow_pda: Pubkey,           // AEP Settlement escrow
///     pub milestone_index: u8,          // which milestone to approve
///     pub base_tx_hash: [u8; 32],       // Base-side x402 settle tx
///     pub amount_returned_micros: u64,  // USDC returned to Solana
/// }
/// ```
///
/// Q-S3-A extension: `cdp_recipient: [u8; 20]` carries the Base-side EVM
/// address the burn message was destined for. The Hook compares this
/// value to the agent's on-chain `agent_profile.cdp_wallet` binding before
/// CPI'ing into Settlement. Adding the field is a coordinated change with
/// Surface 4 (which constructs the burn message on Base) — the master
/// spec's IC-4 freeze rule (master line 77) requires a written ADR + sign-
/// off from affected owners; this code is the Solana side of that ADR.
/// Until Surface 4 ships the matching encoder, the field is supplied by
/// the relayer fallback as the agent's CDP wallet bytes.
///
/// Borsh-serialized size: 32 + 1 + 32 + 8 + 20 = **93 bytes**.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ReflexHookPayload {
    /// PDA of the AEP Settlement escrow whose milestone is being approved.
    pub escrow_pda: Pubkey,

    /// Index of the milestone to approve. `u8` per IC-4 — note Settlement's
    /// public `approve_milestone(milestone_index: u32, ...)` is wider; the
    /// Hook handler widens at the CPI boundary.
    pub milestone_index: u8,

    /// Hash of the Base-side x402 settle / CCTP burn transaction. Used as the
    /// idempotency key together with `(escrow_pda, milestone_index)`.
    pub base_tx_hash: [u8; 32],

    /// Amount of USDC (in 6-decimal "micros") returned to Solana via the
    /// CCTP V2 round-trip. Recorded for dashboard observability and replay
    /// audit; the actual on-chain release amount is what `Settlement`
    /// already records on the milestone — this field does not authorize a
    /// different number.
    pub amount_returned_micros: u64,

    /// Q-S3-A: the Base-side EVM address that received the x402 settle
    /// payment. The Hook reads `agent_profile.cdp_wallet` from Registry
    /// and requires it equals this value before approving the milestone.
    /// 20 bytes is the canonical EVM address width.
    pub cdp_recipient: [u8; 20],

    /// ADR-145: the full Circle CCTP V2 message bytes (the `message`
    /// argument that was passed to `MessageTransmitterV2::receive_message`
    /// for the Base→Solana USDC return leg). This is NOT trusted on its
    /// own — the Hook recomputes the canonical `used_nonce` PDA from
    /// `message[NONCE_INDEX..SENDER_INDEX]` and asserts that PDA exists,
    /// is owned by MessageTransmitterV2, and has `UsedNonce.is_used ==
    /// true`. Because `receive_message` only initializes that PDA after
    /// `verify_attestation_signatures` passes, a `used_nonce` whose
    /// address derives from THESE exact bytes is unforgeable proof that
    /// Circle's attester signed over THIS message. The Hook then parses
    /// the BurnMessage body to bind `amount_returned_micros`.
    ///
    /// Empty (`vec![]`) is permitted only on the default / fund-bearing
    /// build where the HARD DEPLOY GUARD makes the instruction
    /// unreachable; on a `cctp_attestation_verified` build the handler
    /// hard-requires non-empty, well-formed CCTP V2 message bytes.
    pub cctp_message: Vec<u8>,
}

impl ReflexHookPayload {
    /// Borsh-serialized byte length of the FIXED prefix (everything
    /// except the trailing `cctp_message: Vec<u8>`, whose Borsh encoding
    /// is a 4-byte LE length + the bytes). Pre-ADR-145 callers that send
    /// only the IC-4 fields must additionally append a 4-byte zero length
    /// for `cctp_message` (Borsh empty-vec encoding) — see ADR-145.
    pub const FIXED_PREFIX_LEN: usize = 32 + 1 + 32 + 8 + 20;

    /// Borsh-serialized byte length when `cctp_message` is empty.
    pub const SERIALIZED_LEN: usize = Self::FIXED_PREFIX_LEN + 4;
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AnchorSerialize;

    #[test]
    fn payload_serialized_len_matches_constant() {
        let payload = ReflexHookPayload {
            escrow_pda: Pubkey::new_unique(),
            milestone_index: 7,
            base_tx_hash: [0xAB; 32],
            amount_returned_micros: 80_000,
            cdp_recipient: [0x11; 20],
            cctp_message: vec![],
        };
        let bytes = payload.try_to_vec().expect("serialize");
        // Empty cctp_message => fixed prefix (93) + 4-byte Borsh vec len.
        assert_eq!(bytes.len(), ReflexHookPayload::SERIALIZED_LEN);
        assert_eq!(ReflexHookPayload::FIXED_PREFIX_LEN, 93);
        assert_eq!(ReflexHookPayload::SERIALIZED_LEN, 97);
    }

    #[test]
    fn payload_roundtrip() {
        let original = ReflexHookPayload {
            escrow_pda: Pubkey::new_unique(),
            milestone_index: 3,
            base_tx_hash: [0xCD; 32],
            amount_returned_micros: 42_000_000,
            cdp_recipient: [0xEE; 20],
            cctp_message: vec![0x07; 248],
        };
        let bytes = original.try_to_vec().unwrap();
        let decoded = ReflexHookPayload::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded, original);
    }
}
