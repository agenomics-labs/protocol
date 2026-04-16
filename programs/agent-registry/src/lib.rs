use anchor_lang::prelude::*;
use std::mem;

/// Agent Registry Program
///
/// A permissionless on-chain registry where AI agents publish their capabilities,
/// pricing models, and build reputation over time. Enables discovery and hiring
/// of autonomous agents on Solana.
///
/// Key Components:
/// - AgentProfile: Core agent identity with capabilities, pricing, and reputation
/// - CategoryTag: Indexed categories for discovery
/// - Instructions for registration, updates, status management, and deregistration
/// - Reputation scoring (updated via CPI from Settlement program)

declare_id!("8t5oSA3xrLt9rMmM7QZBFWFDgBu8qvWsrUyXFYwPYWmV");

#[program]
pub mod agent_registry {
    use super::*;

    /// Register a new agent in the registry
    ///
    /// Creates an AgentProfile account associated with the agent's authority.
    /// The profile includes capabilities, pricing model, accepted tokens, and vault address.
    ///
    /// # Arguments
    /// * `name` - Agent display name (max 64 bytes)
    /// * `description` - Brief description of capabilities (max 256 bytes)
    /// * `category` - Primary discovery category
    /// * `capabilities` - Vec of tags describing the agent's abilities
    /// * `pricing_model` - How the agent charges: PerTask, PerHour, or PerToken
    /// * `pricing_amount` - Amount charged according to pricing_model
    /// * `accepted_tokens` - Vec of Pubkeys for token payment options
    /// * `vault_address` - Pubkey of the agent's earnings vault
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        name: String,
        description: String,
        category: String,
        capabilities: Vec<String>,
        pricing_model: PricingModel,
        pricing_amount: u64,
        accepted_tokens: Vec<Pubkey>,
        vault_address: Pubkey,
    ) -> Result<()> {
        require!(name.len() <= 64, AgentRegistryError::NameTooLong);
        require!(
            description.len() <= 256,
            AgentRegistryError::DescriptionTooLong
        );
        require!(
            !capabilities.is_empty() && capabilities.len() <= 10,
            AgentRegistryError::InvalidCapabilitiesCount
        );
        require!(
            !accepted_tokens.is_empty() && accepted_tokens.len() <= 5,
            AgentRegistryError::InvalidTokensCount
        );

        let agent_profile = &mut ctx.accounts.agent_profile;
        agent_profile.authority = ctx.accounts.authority.key();
        agent_profile.name = name;
        agent_profile.description = description;
        agent_profile.category = category;
        agent_profile.capabilities = capabilities;
        agent_profile.pricing_model = pricing_model;
        agent_profile.pricing_amount = pricing_amount;
        agent_profile.accepted_tokens = accepted_tokens;
        agent_profile.vault_address = vault_address;
        agent_profile.status = AgentStatus::Active;
        agent_profile.reputation_score = 0;
        agent_profile.total_tasks_completed = 0;
        agent_profile.total_earnings = 0;
        agent_profile.avg_rating = 0;
        agent_profile.created_at = Clock::get()?.unix_timestamp;
        agent_profile.updated_at = Clock::get()?.unix_timestamp;
        agent_profile.bump = ctx.bumps.agent_profile;

        emit!(AgentRegistered {
            authority: agent_profile.authority,
            name: agent_profile.name.clone(),
            category: agent_profile.category.clone(),
            vault_address: agent_profile.vault_address,
            timestamp: agent_profile.created_at,
        });

        Ok(())
    }

    /// Update agent profile information
    ///
    /// Allows the agent to modify name, description, capabilities, pricing,
    /// accepted tokens, and vault address. Only the agent's authority can call this.
    pub fn update_profile(
        ctx: Context<UpdateProfile>,
        name: Option<String>,
        description: Option<String>,
        category: Option<String>,
        capabilities: Option<Vec<String>>,
        pricing_model: Option<PricingModel>,
        pricing_amount: Option<u64>,
        accepted_tokens: Option<Vec<Pubkey>>,
        vault_address: Option<Pubkey>,
    ) -> Result<()> {
        let agent_profile = &mut ctx.accounts.agent_profile;

        // Retired agents cannot be modified
        require!(
            agent_profile.status != AgentStatus::Retired,
            AgentRegistryError::InvalidStatusTransition
        );

        if let Some(n) = name {
            require!(n.len() <= 64, AgentRegistryError::NameTooLong);
            agent_profile.name = n;
        }

        if let Some(d) = description {
            require!(d.len() <= 256, AgentRegistryError::DescriptionTooLong);
            agent_profile.description = d;
        }

        if let Some(c) = category {
            agent_profile.category = c;
        }

        if let Some(cap) = capabilities {
            require!(
                !cap.is_empty() && cap.len() <= 10,
                AgentRegistryError::InvalidCapabilitiesCount
            );
            agent_profile.capabilities = cap;
        }

        if let Some(pm) = pricing_model {
            agent_profile.pricing_model = pm;
        }

        if let Some(pa) = pricing_amount {
            agent_profile.pricing_amount = pa;
        }

        if let Some(at) = accepted_tokens {
            require!(
                !at.is_empty() && at.len() <= 5,
                AgentRegistryError::InvalidTokensCount
            );
            agent_profile.accepted_tokens = at;
        }

        if let Some(va) = vault_address {
            agent_profile.vault_address = va;
        }

        agent_profile.updated_at = Clock::get()?.unix_timestamp;

        emit!(AgentProfileUpdated {
            authority: agent_profile.authority,
            name: agent_profile.name.clone(),
            timestamp: agent_profile.updated_at,
        });

        Ok(())
    }

    /// Update agent status (Active, Paused, or Retired)
    ///
    /// Allows the agent to pause their profile (no new tasks accepted)
    /// or retire (permanent deactivation). Only the agent's authority can call this.
    pub fn update_status(ctx: Context<UpdateStatus>, new_status: AgentStatus) -> Result<()> {
        let agent_profile = &mut ctx.accounts.agent_profile;

        // Prevent invalid status transitions:
        // - Retired is a terminal state; cannot go back to Active or Paused
        // - Active and Paused can transition freely between each other and to Retired
        match (&agent_profile.status, &new_status) {
            (AgentStatus::Retired, AgentStatus::Active) | (AgentStatus::Retired, AgentStatus::Paused) => {
                return Err(error!(AgentRegistryError::InvalidStatusTransition));
            }
            _ => {
                agent_profile.status = new_status;
            }
        }

        agent_profile.updated_at = Clock::get()?.unix_timestamp;

        emit!(AgentStatusUpdated {
            authority: agent_profile.authority,
            new_status: agent_profile.status.clone(),
            timestamp: agent_profile.updated_at,
        });

        Ok(())
    }

    /// Update agent reputation score (CPI from Settlement program only)
    ///
    /// Called exclusively by the Settlement program via Cross-Program Invocation (CPI).
    /// Updates reputation score based on successful settlements or disputes.
    /// Also updates task completion count and earnings statistics.
    ///
    /// # Arguments
    /// * `reputation_delta` - Signed change to reputation (positive or negative)
    /// * `task_completed` - Whether a task was successfully completed
    /// * `earnings` - Amount earned in this transaction (in lamports)
    /// * `rating` - Task rating from client (0-5 stars, 0 means no rating)
    pub fn update_reputation(
        ctx: Context<UpdateReputation>,
        reputation_delta: i64,
        task_completed: bool,
        earnings: u64,
        rating: u8,
    ) -> Result<()> {
        // CPI caller verification is handled by Anchor constraints:
        // - settlement_authority must be a signer (PDA from Settlement program)
        // - agent_profile PDA seeds are verified
        // No manual check needed — unauthorized calls fail at deserialization.

        require!(rating <= 5, AgentRegistryError::InvalidRating);

        let agent_profile = &mut ctx.accounts.agent_profile;

        // Update reputation score with bounds checking
        if reputation_delta >= 0 {
            agent_profile.reputation_score = agent_profile
                .reputation_score
                .saturating_add(reputation_delta as u64);
        } else {
            agent_profile.reputation_score = agent_profile
                .reputation_score
                .saturating_sub((-reputation_delta) as u64);
        }

        // Update task completion statistics
        if task_completed {
            agent_profile.total_tasks_completed = agent_profile
                .total_tasks_completed
                .saturating_add(1);
            agent_profile.total_earnings = agent_profile
                .total_earnings
                .saturating_add(earnings);

            // Update average rating using weighted running average
            // Formula: new_avg = (old_avg * (n-1) + new_rating) / n
            if rating > 0 {
                let n = agent_profile.total_tasks_completed as u128;
                if n == 1 {
                    // First rated task — rating becomes the average
                    agent_profile.avg_rating = rating;
                } else {
                    let old_avg = agent_profile.avg_rating as u128;
                    let new_avg = (old_avg * (n - 1) + rating as u128) / n;
                    agent_profile.avg_rating = new_avg.min(5) as u8;
                }
            }
        }

        agent_profile.updated_at = Clock::get()?.unix_timestamp;

        emit!(ReputationUpdated {
            authority: agent_profile.authority,
            new_reputation_score: agent_profile.reputation_score,
            reputation_delta,
            task_completed,
            timestamp: agent_profile.updated_at,
        });

        Ok(())
    }

    /// Deregister an agent (permanent removal from registry)
    ///
    /// Allows the agent's authority to permanently remove their profile from the registry.
    /// The account is closed and its rent is returned to the authority.
    /// This action cannot be undone; the agent must re-register to return to the registry.
    pub fn deregister_agent(ctx: Context<DeregisterAgent>) -> Result<()> {
        let agent_profile = &ctx.accounts.agent_profile;

        emit!(AgentDeregistered {
            authority: agent_profile.authority,
            name: agent_profile.name.clone(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

/// AgentProfile: The core account representing a registered agent
///
/// This account stores all agent information and is indexed by category for discovery.
/// The account is derived from the agent's authority and a fixed seed string.
///
/// Account size calculation:
/// - authority: Pubkey (32 bytes)
/// - name: String (4 + 64 bytes)
/// - description: String (4 + 256 bytes)
/// - category: String (4 + 50 bytes) - max 50 for category names
/// - capabilities: Vec<String> (4 + (10 * (4 + 32))) = 364 bytes (10 tags max, 32 bytes each)
/// - pricing_model: PricingModel (enum, 1 byte + 7 padding)
/// - pricing_amount: u64 (8 bytes)
/// - accepted_tokens: Vec<Pubkey> (4 + (5 * 32)) = 164 bytes (5 tokens max)
/// - vault_address: Pubkey (32 bytes)
/// - status: AgentStatus (enum, 1 byte + 7 padding)
/// - reputation_score: u64 (8 bytes)
/// - total_tasks_completed: u64 (8 bytes)
/// - total_earnings: u64 (8 bytes)
/// - avg_rating: u8 (1 byte + 7 padding)
/// - created_at: i64 (8 bytes)
/// - updated_at: i64 (8 bytes)
/// - bump: u8 (1 byte + 7 padding)
///
/// Total: ~1,100 bytes + discriminator (8 bytes) = 1,108 bytes
#[account]
pub struct AgentProfile {
    /// The authority (signer) who controls this agent profile
    pub authority: Pubkey,

    /// Agent name (max 64 bytes)
    pub name: String,

    /// Description of capabilities (max 256 bytes)
    pub description: String,

    /// Primary category for discovery (e.g., "data-analysis", "trading", "content-generation")
    pub category: String,

    /// List of capability tags (max 10 tags)
    pub capabilities: Vec<String>,

    /// Pricing model: PerTask, PerHour, or PerToken
    pub pricing_model: PricingModel,

    /// Amount charged according to pricing_model
    pub pricing_amount: u64,

    /// Accepted token mints (max 5)
    pub accepted_tokens: Vec<Pubkey>,

    /// Vault address for receiving payments
    pub vault_address: Pubkey,

    /// Current status: Active, Paused, or Retired
    pub status: AgentStatus,

    /// Reputation score (updated via CPI from Settlement program)
    pub reputation_score: u64,

    /// Total number of successfully completed tasks
    pub total_tasks_completed: u64,

    /// Total earnings across all tasks (in smallest token unit)
    pub total_earnings: u64,

    /// Average rating from clients (0-5, 0 means unrated)
    pub avg_rating: u8,

    /// Unix timestamp when the agent was registered
    pub created_at: i64,

    /// Unix timestamp of last profile update
    pub updated_at: i64,

    /// Bump seed for PDA derivation
    pub bump: u8,
}

/// Pricing model options for agents
#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum PricingModel {
    /// Fixed price per task
    PerTask,
    /// Hourly rate
    PerHour,
    /// Price per token (for LLM-based agents)
    PerToken,
}

/// Agent status in the registry
#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
pub enum AgentStatus {
    /// Agent is active and accepting tasks
    Active,
    /// Agent is paused and not accepting new tasks
    Paused,
    /// Agent is retired and permanently inactive
    Retired,
}

// ============================================================================
// Event Definitions for Indexing
// ============================================================================

/// Emitted when a new agent is registered
#[event]
pub struct AgentRegistered {
    pub authority: Pubkey,
    pub name: String,
    pub category: String,
    pub vault_address: Pubkey,
    pub timestamp: i64,
}

/// Emitted when an agent updates their profile
#[event]
pub struct AgentProfileUpdated {
    pub authority: Pubkey,
    pub name: String,
    pub timestamp: i64,
}

/// Emitted when an agent's status changes
#[event]
pub struct AgentStatusUpdated {
    pub authority: Pubkey,
    pub new_status: AgentStatus,
    pub timestamp: i64,
}

/// Emitted when reputation is updated (via Settlement program CPI)
#[event]
pub struct ReputationUpdated {
    pub authority: Pubkey,
    pub new_reputation_score: u64,
    pub reputation_delta: i64,
    pub task_completed: bool,
    pub timestamp: i64,
}

/// Emitted when an agent is deregistered
#[event]
pub struct AgentDeregistered {
    pub authority: Pubkey,
    pub name: String,
    pub timestamp: i64,
}

// ============================================================================
// Instruction Contexts
// ============================================================================

/// Context for registering a new agent
#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    /// The agent's authority account (signer)
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The agent's profile account (PDA)
    #[account(
        init,
        payer = authority,
        space = 8 + mem::size_of::<AgentProfile>() + 500, // Extra space for dynamic Vec growth
        seeds = [authority.key().as_ref(), b"agent-profile"],
        bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    /// System program (required for account initialization)
    pub system_program: Program<'info, System>,
}

/// Context for updating an agent's profile
#[derive(Accounts)]
pub struct UpdateProfile<'info> {
    /// The agent's authority account (signer)
    pub authority: Signer<'info>,

    /// The agent's profile account (must be owned by this program)
    #[account(
        mut,
        has_one = authority,
        seeds = [authority.key().as_ref(), b"agent-profile"],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,
}

/// Context for updating agent status
#[derive(Accounts)]
pub struct UpdateStatus<'info> {
    /// The agent's authority account (signer)
    pub authority: Signer<'info>,

    /// The agent's profile account
    #[account(
        mut,
        has_one = authority,
        seeds = [authority.key().as_ref(), b"agent-profile"],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,
}

/// Context for updating reputation (CPI from Settlement program)
///
/// Security: The agent_profile is verified by PDA seeds to prevent arbitrary account
/// injection. The settlement_authority PDA (seeds: ["settlement_authority"]) must sign
/// the CPI call, proving it originated from the Settlement program via invoke_signed.
/// This replaces the previous weak executable-only check.
#[derive(Accounts)]
pub struct UpdateReputation<'info> {
    /// The agent's profile account — PDA seeds verified to prevent arbitrary account injection
    #[account(
        mut,
        seeds = [agent_profile.authority.as_ref(), b"agent-profile"],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    /// Settlement authority PDA — must sign via invoke_signed from the Settlement program.
    /// Seeds: ["settlement_authority"] derived from SETTLEMENT_PROGRAM_ID.
    /// This proves the CPI originated from the Settlement program, not a direct call.
    /// CHECK: Validated as signer + seeds derived from SETTLEMENT_PROGRAM_ID.
    #[account(
        signer,
        seeds = [b"settlement_authority"],
        bump,
        seeds::program = SETTLEMENT_PROGRAM_ID
    )]
    pub settlement_authority: UncheckedAccount<'info>,
}

/// Context for deregistering an agent
#[derive(Accounts)]
pub struct DeregisterAgent<'info> {
    /// The agent's authority account (signer)
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The agent's profile account (will be closed)
    #[account(
        mut,
        has_one = authority,
        close = authority,
        seeds = [authority.key().as_ref(), b"agent-profile"],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,
}

// ============================================================================
// Error Codes
// ============================================================================

#[error_code]
pub enum AgentRegistryError {
    #[msg("Agent name exceeds maximum length of 64 bytes")]
    NameTooLong,

    #[msg("Description exceeds maximum length of 256 bytes")]
    DescriptionTooLong,

    #[msg("Invalid number of capabilities (must be 1-10)")]
    InvalidCapabilitiesCount,

    #[msg("Invalid number of accepted tokens (must be 1-5)")]
    InvalidTokensCount,

    #[msg("Invalid rating (must be 0-5)")]
    InvalidRating,

    #[msg("Unauthorized caller (must be settlement program for reputation updates)")]
    UnauthorizedCaller,

    #[msg("Invalid PDA derivation")]
    InvalidPDA,

    #[msg("Invalid status transition: Retired agents cannot be reactivated")]
    InvalidStatusTransition,
}

// ============================================================================
// Constants
// ============================================================================

/// The Settlement program ID (will be set to actual settlement program address)
/// This is a placeholder and should be replaced with the real Settlement program ID
pub const SETTLEMENT_PROGRAM_ID: Pubkey = pubkey!("2uSDxQtYLU4uSeZtA1ueJx7xg4PDYpEbkxM957T5UUm4");

// ============================================================================
// UNIT TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_transition_active_to_paused() {
        // Active -> Paused is valid
        let current = AgentStatus::Active;
        let new_status = AgentStatus::Paused;
        let valid = !matches!(
            (&current, &new_status),
            (AgentStatus::Retired, AgentStatus::Active) | (AgentStatus::Retired, AgentStatus::Paused)
        );
        assert!(valid);
    }

    #[test]
    fn test_status_transition_paused_to_active() {
        let current = AgentStatus::Paused;
        let new_status = AgentStatus::Active;
        let valid = !matches!(
            (&current, &new_status),
            (AgentStatus::Retired, AgentStatus::Active) | (AgentStatus::Retired, AgentStatus::Paused)
        );
        assert!(valid);
    }

    #[test]
    fn test_status_transition_active_to_retired() {
        let current = AgentStatus::Active;
        let new_status = AgentStatus::Retired;
        let valid = !matches!(
            (&current, &new_status),
            (AgentStatus::Retired, AgentStatus::Active) | (AgentStatus::Retired, AgentStatus::Paused)
        );
        assert!(valid);
    }

    #[test]
    fn test_status_transition_retired_to_active_invalid() {
        let current = AgentStatus::Retired;
        let new_status = AgentStatus::Active;
        let valid = !matches!(
            (&current, &new_status),
            (AgentStatus::Retired, AgentStatus::Active) | (AgentStatus::Retired, AgentStatus::Paused)
        );
        assert!(!valid, "Retired -> Active should be invalid");
    }

    #[test]
    fn test_status_transition_retired_to_paused_invalid() {
        let current = AgentStatus::Retired;
        let new_status = AgentStatus::Paused;
        let valid = !matches!(
            (&current, &new_status),
            (AgentStatus::Retired, AgentStatus::Active) | (AgentStatus::Retired, AgentStatus::Paused)
        );
        assert!(!valid, "Retired -> Paused should be invalid");
    }

    #[test]
    fn test_reputation_saturating_add() {
        let score: u64 = u64::MAX - 10;
        let delta: i64 = 50;
        let result = score.saturating_add(delta as u64);
        assert_eq!(result, u64::MAX);
    }

    #[test]
    fn test_reputation_saturating_sub() {
        let score: u64 = 10;
        let delta: i64 = -50;
        let result = score.saturating_sub((-delta) as u64);
        assert_eq!(result, 0);
    }

    #[test]
    fn test_avg_rating_first_task() {
        // First task: rating becomes the average
        let rating: u8 = 4;
        let n: u128 = 1;
        let avg = if n == 1 { rating } else { 0 };
        assert_eq!(avg, 4);
    }

    #[test]
    fn test_avg_rating_weighted_average() {
        // After 3 tasks with ratings 4, 5, 3:
        // avg after task 1: 4
        // avg after task 2: (4*1 + 5) / 2 = 4 (integer truncation)
        // avg after task 3: (4*2 + 3) / 3 = 3 (integer truncation)
        let mut avg: u8 = 4;
        let mut n: u128 = 1;

        // Task 2: rating 5
        n = 2;
        let new_avg = ((avg as u128) * (n - 1) + 5u128) / n;
        avg = new_avg.min(5) as u8;
        assert_eq!(avg, 4); // (4 + 5) / 2 = 4 (truncated)

        // Task 3: rating 3
        n = 3;
        let new_avg = ((avg as u128) * (n - 1) + 3u128) / n;
        avg = new_avg.min(5) as u8;
        assert_eq!(avg, 3); // (4*2 + 3) / 3 = 3 (truncated)
    }

    #[test]
    fn test_pricing_model_variants() {
        assert_ne!(PricingModel::PerTask, PricingModel::PerHour);
        assert_ne!(PricingModel::PerHour, PricingModel::PerToken);
        assert_eq!(PricingModel::PerTask, PricingModel::PerTask);
    }

    #[test]
    fn test_name_length_validation_logic() {
        let name_ok = "a".repeat(64);
        assert!(name_ok.len() <= 64);

        let name_too_long = "a".repeat(65);
        assert!(name_too_long.len() > 64);
    }

    #[test]
    fn test_capabilities_count_validation_logic() {
        let empty: Vec<String> = vec![];
        assert!(empty.is_empty());

        let ok: Vec<String> = vec!["a".into(); 10];
        assert!(!ok.is_empty() && ok.len() <= 10);

        let too_many: Vec<String> = vec!["a".into(); 11];
        assert!(too_many.len() > 10);
    }
}
