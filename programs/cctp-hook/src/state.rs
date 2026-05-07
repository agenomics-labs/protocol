//! On-chain account state for the CCTP Hook program.

use anchor_lang::prelude::*;

/// Replay-guard PDA — initialized once per `(escrow, milestone_index,
/// base_tx_hash)` triple. The mere existence of this account is the
/// idempotency proof; the body is informational so the dashboard / off-chain
/// tooling can audit the historical round-trip without re-fetching the
/// CCTP message.
///
/// Open Q-S3-D: a separate close instruction (TTL-driven, rent reclaim) is
/// not yet scaffolded. Suggested default: 30 days, anyone may close, rent
/// goes to a treasury PDA — but explicit owner sign-off needed.
#[account]
pub struct ReplayRecord {
    /// AEP Settlement escrow PDA from the IC-4 payload.
    pub escrow: Pubkey,
    /// Milestone index from the IC-4 payload.
    pub milestone_index: u8,
    /// Base-side settle / burn transaction hash (idempotency key tail).
    pub base_tx_hash: [u8; 32],
    /// Amount returned to Solana, in USDC micros.
    pub amount_returned_micros: u64,
    /// Unix timestamp the record was opened (= milestone auto-approval time).
    pub created_at: i64,
    /// PDA bump.
    pub bump: u8,
}

impl ReplayRecord {
    /// Account body size (excludes Anchor's 8-byte discriminator).
    /// 32 + 1 + 32 + 8 + 8 + 1 = 82 bytes.
    pub const SPACE: usize = 32 + 1 + 32 + 8 + 8 + 1;
}
