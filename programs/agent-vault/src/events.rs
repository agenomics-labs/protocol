use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub agent_identity: Pubkey,
    pub authority: Pubkey,
    pub daily_limit: u64,
    pub per_tx_limit: u64,
}

#[event]
pub struct PolicyUpdated {
    pub vault: Pubkey,
    pub daily_limit: u64,
    pub per_tx_limit: u64,
    pub max_txs_per_hour: u32,
}

#[event]
pub struct TransactionExecuted {
    pub vault: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
    pub success: bool,
}

#[event]
pub struct ProgramCallExecuted {
    pub vault: Pubkey,
    pub program_id: Pubkey,
    pub instruction_hash: [u8; 32],
    pub timestamp: i64,
    pub success: bool,
}

#[event]
pub struct TokenTransferExecuted {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct AllowlistUpdated {
    pub vault: Pubkey,
    pub item: Pubkey,
    pub action: String,
}

#[event]
pub struct VaultPaused {
    pub vault: Pubkey,
}

#[event]
pub struct VaultResumed {
    pub vault: Pubkey,
}
