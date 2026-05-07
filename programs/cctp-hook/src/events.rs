//! Anchor events emitted by the CCTP Hook program. Surfaced to the dashboard
//! at `app.agenomics.xyz` via Helius webhook (per master §"Cross-cutting —
//! Observability").

use anchor_lang::prelude::*;

/// Emitted from `auto_approve_milestone` after the CPI into Settlement
/// returns successfully.
///
/// Spec verbatim (master §"Hook program"):
///   `MilestoneAutoApproved { escrow, milestone_index, base_tx_hash }`
///
/// Two extra fields (`amount_returned_micros`, `agent_authority`) are
/// included for observability — they are derived from the on-chain payload
/// and the signer-PDA derivation, not new authoritative state.
#[event]
pub struct MilestoneAutoApproved {
    /// AEP Settlement escrow PDA.
    pub escrow: Pubkey,
    /// Milestone index that was auto-approved.
    pub milestone_index: u8,
    /// Base-side settle / burn transaction hash (cross-chain link).
    pub base_tx_hash: [u8; 32],
    /// Amount of USDC (micros) returned to Solana via the CCTP round-trip.
    pub amount_returned_micros: u64,
    /// Agent authority pubkey the `hook_signer` PDA was derived from.
    pub agent_authority: Pubkey,
}
