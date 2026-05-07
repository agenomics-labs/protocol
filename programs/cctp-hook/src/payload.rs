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

/// IC-4 payload — verbatim layout from the master spec.
///
/// ```rust
/// pub struct ReflexHookPayload {
///     pub escrow_pda: Pubkey,           // AEP Settlement escrow
///     pub milestone_index: u8,          // which milestone to approve
///     pub base_tx_hash: [u8; 32],       // Base-side x402 settle tx
///     pub amount_returned_micros: u64,  // USDC returned to Solana
/// }
/// ```
///
/// Borsh-serialized size: 32 + 1 + 32 + 8 = **73 bytes**.
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
}

impl ReflexHookPayload {
    /// Borsh-serialized byte length.
    pub const SERIALIZED_LEN: usize = 32 + 1 + 32 + 8;
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
        };
        let bytes = payload.try_to_vec().expect("serialize");
        assert_eq!(bytes.len(), ReflexHookPayload::SERIALIZED_LEN);
    }

    #[test]
    fn payload_roundtrip() {
        let original = ReflexHookPayload {
            escrow_pda: Pubkey::new_unique(),
            milestone_index: 3,
            base_tx_hash: [0xCD; 32],
            amount_returned_micros: 42_000_000,
        };
        let bytes = original.try_to_vec().unwrap();
        let decoded = ReflexHookPayload::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded, original);
    }
}
