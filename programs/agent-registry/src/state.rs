use anchor_lang::prelude::*;

/// The Settlement program ID — used to verify CPI caller for reputation updates.
pub const SETTLEMENT_PROGRAM_ID: Pubkey = pubkey!("GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3");

/// The Agent Vault program ID — used to validate that `AgentProfile.vault_address`
/// is the canonical vault PDA for the registering authority.
///
/// Finding #9: Before this, `vault_address` was a free-form `Pubkey` argument
/// with no on-chain check; a malicious provider could point at an attacker-
/// controlled account and off-chain consumers (discovery, MCP) would trust it.
/// Now the field is derived from a seed-constrained account, so impersonation
/// is rejected at transaction construction time.
pub const AGENT_VAULT_PROGRAM_ID: Pubkey = pubkey!("4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN");

/// AgentProfile: The core account representing a registered agent.
///
/// ADR-040: Account space is explicitly calculated as 1243 bytes
/// (1043 serialized max + 200 safety margin).
#[account]
pub struct AgentProfile {
    pub authority: Pubkey,
    pub name: String,
    pub description: String,
    pub category: String,
    pub capabilities: Vec<String>,
    pub pricing_model: PricingModel,
    pub pricing_amount: u64,
    pub accepted_tokens: Vec<Pubkey>,
    pub vault_address: Pubkey,
    pub status: AgentStatus,
    pub reputation_score: u64,
    pub total_tasks_completed: u64,
    pub total_earnings: u64,
    pub avg_rating: u8,
    pub created_at: i64,
    pub updated_at: i64,
    pub reputation_stake: ReputationStake,
    pub bump: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum PricingModel {
    PerTask,
    PerHour,
    PerToken,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum AgentStatus {
    Active,
    Paused,
    Retired,
    Suspended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub struct ReputationStake {
    pub staked_amount: u64,
    pub slash_count: u8,
}
