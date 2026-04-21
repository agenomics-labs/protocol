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

#[event]
pub struct AgentSlashed {
    pub authority: Pubkey,
    pub slash_count: u8,
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
