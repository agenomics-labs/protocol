use anchor_lang::prelude::*;
use crate::state::AgentStatus;

#[event]
pub struct AgentRegistered {
    pub authority: Pubkey,
    pub name: String,
    pub category: String,
    pub vault_address: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AgentProfileUpdated {
    pub authority: Pubkey,
    pub name: String,
    pub timestamp: i64,
}

#[event]
pub struct AgentStatusUpdated {
    pub authority: Pubkey,
    pub new_status: AgentStatus,
    pub timestamp: i64,
}

#[event]
pub struct ReputationUpdated {
    pub authority: Pubkey,
    pub new_reputation_score: u64,
    pub reputation_delta: i64,
    pub task_completed: bool,
    pub timestamp: i64,
}

#[event]
pub struct ReputationStaked {
    pub authority: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
    pub timestamp: i64,
}

/// AUD-111 (cycle-2): event field renamed `slash_count: u8` →
/// `total_slashes: u32`. Per DESIGN-DECISIONS-2026-04-25.md § AUD-004
/// step 4, the field-of-record for cumulative slashes was specced as
/// `u32` (the on-disk profile carries a `u8` `reputation_stake.slash_count`
/// for now, but the event surface is the place where indexers project
/// the cumulative count outward — and `u32` provides headroom against
/// any future expansion of the slash mechanic). The cast at emit-time
/// is `as u32`; widening is lossless.
#[event]
pub struct AgentSlashed {
    pub authority: Pubkey,
    pub total_slashes: u32,
    pub suspended: bool,
    pub timestamp: i64,
}

#[event]
pub struct ReputationUnstaked {
    pub authority: Pubkey,
    pub amount: u64,
    pub remaining_staked: u64,
    pub timestamp: i64,
}

#[event]
pub struct AgentDeregistered {
    pub authority: Pubkey,
    pub name: String,
    pub timestamp: i64,
}

#[event]
pub struct SuspensionCleared {
    pub authority: Pubkey,
    pub new_reputation_score: u64,
    /// AUD-004: monotonic counter of how many times `clear_suspension` has run
    /// against this profile. 1 = first clear (score halved), 2 = second clear
    /// (score zeroed), 3+ = terminal Retired.
    pub cleared_count: u8,
    pub timestamp: i64,
}

/// ADR-060: emitted when an agent publishes or rotates their off-chain
/// capability manifest pointer. Subscribers can use this to pin IPFS
/// content, refresh the capability index, or invalidate caches.
#[event]
pub struct ManifestUpdated {
    pub authority: Pubkey,
    pub manifest_cid: [u8; 64],
    pub manifest_hash: [u8; 32],
    pub manifest_version: u16,
    pub timestamp: i64,
}

/// ADR-096: emitted when `migrate_agent_profile` successfully bumps the
/// schema version. Indexers can use this to track which accounts have
/// been migrated and alert when stragglers remain.
#[event]
pub struct AgentMigrated {
    pub authority: Pubkey,
    pub old_version: u8,
    pub new_version: u8,
    pub timestamp: i64,
}

/// Q-S3-A: emitted when `update_cdp_wallet` mutates the CDP-wallet binding
/// read by the Surface-3 CCTP Hook. Indexers can use this to track the
/// agent ↔ CDP-wallet mapping over time and surface rotations on the
/// dashboard. `old_wallet` is `None` for the first binding; `new_wallet`
/// is `None` when the binding is cleared (e.g. session end).
#[event]
pub struct CdpWalletUpdated {
    pub authority: Pubkey,
    pub old_wallet: Option<[u8; 20]>,
    pub new_wallet: Option<[u8; 20]>,
    pub timestamp: i64,
}

/// ADR-094: emitted when `propose_reputation_delta` successfully applies a
/// validated delta. Subscribers (indexers, governance dashboards) can track
/// every reputation change through this single event, regardless of the
/// originating source (Settlement, future slashing circuits, etc.).
#[event]
pub struct ReputationDeltaProposed {
    pub authority: Pubkey,
    pub delta: i16,
    pub reason: u8,
    pub old_score: u8,
    pub new_score: u8,
    pub timestamp: i64,
}
