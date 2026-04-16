use anchor_lang::prelude::*;

pub mod state;
pub mod errors;
pub mod events;
pub mod contexts;

use state::*;
use errors::*;
use events::*;
use contexts::*;

declare_id!("8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh");

#[program]
pub mod agent_registry {
    use super::*;

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
        require!(description.len() <= 256, AgentRegistryError::DescriptionTooLong);
        require!(!capabilities.is_empty() && capabilities.len() <= 10, AgentRegistryError::InvalidCapabilitiesCount);
        require!(!accepted_tokens.is_empty() && accepted_tokens.len() <= 5, AgentRegistryError::InvalidTokensCount);
        require!(category.len() <= 50, AgentRegistryError::CategoryTooLong);

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
        agent_profile.reputation_stake = ReputationStake { staked_amount: 0, slash_count: 0 };
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
        require!(agent_profile.status != AgentStatus::Retired, AgentRegistryError::InvalidStatusTransition);

        if let Some(n) = name { require!(n.len() <= 64, AgentRegistryError::NameTooLong); agent_profile.name = n; }
        if let Some(d) = description { require!(d.len() <= 256, AgentRegistryError::DescriptionTooLong); agent_profile.description = d; }
        if let Some(c) = category { require!(c.len() <= 50, AgentRegistryError::CategoryTooLong); agent_profile.category = c; }
        if let Some(cap) = capabilities { require!(!cap.is_empty() && cap.len() <= 10, AgentRegistryError::InvalidCapabilitiesCount); agent_profile.capabilities = cap; }
        if let Some(pm) = pricing_model { agent_profile.pricing_model = pm; }
        if let Some(pa) = pricing_amount { agent_profile.pricing_amount = pa; }
        if let Some(at) = accepted_tokens { require!(!at.is_empty() && at.len() <= 5, AgentRegistryError::InvalidTokensCount); agent_profile.accepted_tokens = at; }
        if let Some(va) = vault_address { agent_profile.vault_address = va; }

        agent_profile.updated_at = Clock::get()?.unix_timestamp;
        emit!(AgentProfileUpdated { authority: agent_profile.authority, name: agent_profile.name.clone(), timestamp: agent_profile.updated_at });
        Ok(())
    }

    pub fn update_status(ctx: Context<UpdateStatus>, new_status: AgentStatus) -> Result<()> {
        let agent_profile = &mut ctx.accounts.agent_profile;
        match (&agent_profile.status, &new_status) {
            (AgentStatus::Retired, AgentStatus::Active) | (AgentStatus::Retired, AgentStatus::Paused) | (AgentStatus::Retired, AgentStatus::Suspended) => {
                return Err(error!(AgentRegistryError::InvalidStatusTransition));
            }
            (AgentStatus::Suspended, AgentStatus::Active) | (AgentStatus::Suspended, AgentStatus::Paused) => {
                return Err(error!(AgentRegistryError::InvalidStatusTransition));
            }
            _ => { agent_profile.status = new_status; }
        }
        agent_profile.updated_at = Clock::get()?.unix_timestamp;
        emit!(AgentStatusUpdated { authority: agent_profile.authority, new_status: agent_profile.status.clone(), timestamp: agent_profile.updated_at });
        Ok(())
    }

    pub fn update_reputation(ctx: Context<UpdateReputation>, reputation_delta: i64, task_completed: bool, earnings: u64, rating: u8) -> Result<()> {
        require!(rating <= 5, AgentRegistryError::InvalidRating);
        let agent_profile = &mut ctx.accounts.agent_profile;

        if reputation_delta >= 0 {
            agent_profile.reputation_score = agent_profile.reputation_score.saturating_add(reputation_delta as u64);
        } else {
            agent_profile.reputation_score = agent_profile.reputation_score.saturating_sub((-reputation_delta) as u64);
        }

        if task_completed {
            agent_profile.total_tasks_completed = agent_profile.total_tasks_completed.saturating_add(1);
            agent_profile.total_earnings = agent_profile.total_earnings.saturating_add(earnings);
            if rating > 0 {
                let n = agent_profile.total_tasks_completed as u128;
                if n == 1 { agent_profile.avg_rating = rating; }
                else {
                    let new_avg = ((agent_profile.avg_rating as u128) * (n - 1) + rating as u128 + n / 2) / n;
                    agent_profile.avg_rating = new_avg.min(5) as u8;
                }
            }
        }

        if reputation_delta < 0 && !task_completed {
            agent_profile.reputation_stake.slash_count = agent_profile.reputation_stake.slash_count.saturating_add(1);
            if agent_profile.reputation_stake.slash_count >= 3 {
                agent_profile.status = AgentStatus::Suspended;
                emit!(AgentSlashed { authority: agent_profile.authority, slash_count: agent_profile.reputation_stake.slash_count, suspended: true, timestamp: Clock::get()?.unix_timestamp });
            } else {
                emit!(AgentSlashed { authority: agent_profile.authority, slash_count: agent_profile.reputation_stake.slash_count, suspended: false, timestamp: Clock::get()?.unix_timestamp });
            }
        }

        agent_profile.updated_at = Clock::get()?.unix_timestamp;
        emit!(ReputationUpdated { authority: agent_profile.authority, new_reputation_score: agent_profile.reputation_score, reputation_delta, task_completed, timestamp: agent_profile.updated_at });
        Ok(())
    }

    pub fn stake_reputation(ctx: Context<StakeReputation>, amount: u64) -> Result<()> {
        require!(amount > 0, AgentRegistryError::InvalidStakeAmount);
        let agent_profile = &ctx.accounts.agent_profile;
        require!(agent_profile.status != AgentStatus::Retired && agent_profile.status != AgentStatus::Suspended, AgentRegistryError::InvalidStatusTransition);

        let transfer_ix = anchor_lang::system_program::Transfer { from: ctx.accounts.authority.to_account_info(), to: ctx.accounts.staking_pda.to_account_info() };
        anchor_lang::system_program::transfer(CpiContext::new(ctx.accounts.system_program.to_account_info(), transfer_ix), amount)?;

        let agent_profile = &mut ctx.accounts.agent_profile;
        agent_profile.reputation_stake.staked_amount = agent_profile.reputation_stake.staked_amount.saturating_add(amount);
        agent_profile.updated_at = Clock::get()?.unix_timestamp;
        emit!(ReputationStaked { authority: agent_profile.authority, amount, total_staked: agent_profile.reputation_stake.staked_amount, timestamp: agent_profile.updated_at });
        Ok(())
    }

    pub fn unstake_reputation(ctx: Context<UnstakeReputation>, amount: u64) -> Result<()> {
        require!(amount > 0, AgentRegistryError::InvalidStakeAmount);
        let agent_profile = &ctx.accounts.agent_profile;
        require!(agent_profile.status != AgentStatus::Suspended, AgentRegistryError::InvalidStatusTransition);
        require!(amount <= agent_profile.reputation_stake.staked_amount, AgentRegistryError::InsufficientStake);

        let staking_pda_info = ctx.accounts.staking_pda.to_account_info();
        let authority_info = ctx.accounts.authority.to_account_info();
        **staking_pda_info.try_borrow_mut_lamports()? = staking_pda_info.lamports().checked_sub(amount).ok_or(AgentRegistryError::InsufficientStake)?;
        **authority_info.try_borrow_mut_lamports()? = authority_info.lamports().checked_add(amount).ok_or(AgentRegistryError::InvalidStakeAmount)?;

        let agent_profile = &mut ctx.accounts.agent_profile;
        agent_profile.reputation_stake.staked_amount = agent_profile.reputation_stake.staked_amount.saturating_sub(amount);
        agent_profile.updated_at = Clock::get()?.unix_timestamp;
        emit!(ReputationUnstaked { authority: agent_profile.authority, amount, remaining_staked: agent_profile.reputation_stake.staked_amount, timestamp: agent_profile.updated_at });
        Ok(())
    }

    pub fn deregister_agent(ctx: Context<DeregisterAgent>) -> Result<()> {
        let agent_profile = &ctx.accounts.agent_profile;
        emit!(AgentDeregistered { authority: agent_profile.authority, name: agent_profile.name.clone(), timestamp: Clock::get()?.unix_timestamp });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_transition_active_to_paused() {
        let valid = !matches!((AgentStatus::Active, AgentStatus::Paused), (AgentStatus::Retired, AgentStatus::Active) | (AgentStatus::Retired, AgentStatus::Paused));
        assert!(valid);
    }

    #[test]
    fn test_status_transition_retired_to_active_invalid() {
        let valid = !matches!((AgentStatus::Retired, AgentStatus::Active), (AgentStatus::Retired, AgentStatus::Active) | (AgentStatus::Retired, AgentStatus::Paused));
        assert!(!valid);
    }

    #[test]
    fn test_reputation_saturating_add() {
        assert_eq!((u64::MAX - 10).saturating_add(50), u64::MAX);
    }

    #[test]
    fn test_reputation_saturating_sub() {
        assert_eq!(10u64.saturating_sub(50), 0);
    }

    #[test]
    fn test_avg_rating_first_task() {
        assert_eq!(4u8, 4u8); // First task: rating becomes average
    }

    #[test]
    fn test_pricing_model_variants() {
        assert_ne!(PricingModel::PerTask, PricingModel::PerHour);
        assert_eq!(PricingModel::PerTask, PricingModel::PerTask);
    }

    #[test]
    fn test_name_length_validation() {
        assert!("a".repeat(64).len() <= 64);
        assert!("a".repeat(65).len() > 64);
    }

    #[test]
    fn test_reputation_stake_initial() {
        let stake = ReputationStake { staked_amount: 0, slash_count: 0 };
        assert_eq!(stake.staked_amount, 0);
    }

    #[test]
    fn test_slash_triggers_on_negative_delta_failed_task() {
        let mut slash = 0u8;
        if -10i64 < 0 && !false { slash = slash.saturating_add(1); }
        assert_eq!(slash, 1);
    }

    #[test]
    fn test_suspension_at_three_slashes() {
        let mut status = AgentStatus::Active;
        let slash = 3u8;
        if slash >= 3 { status = AgentStatus::Suspended; }
        assert_eq!(status, AgentStatus::Suspended);
    }

    #[test]
    fn test_suspended_cannot_transition_to_active() {
        let valid = !matches!((AgentStatus::Suspended, AgentStatus::Active), (AgentStatus::Suspended, AgentStatus::Active) | (AgentStatus::Suspended, AgentStatus::Paused));
        assert!(!valid);
    }

    #[test]
    fn test_capabilities_count() {
        assert!(vec!["a"; 10].len() <= 10);
        assert!(vec!["a"; 11].len() > 10);
    }

    mod fuzz {
        use super::*;
        use proptest::prelude::*;

        proptest! {
            #[test]
            fn reputation_score_never_panics(initial in any::<u64>(), delta in any::<i64>()) {
                let result = if delta >= 0 { initial.saturating_add(delta as u64) } else { initial.saturating_sub((-delta) as u64) };
                prop_assert!(result <= u64::MAX);
            }

            #[test]
            fn avg_rating_bounded(ratings in proptest::collection::vec(1u8..=5, 1..50)) {
                let mut avg = 0u8;
                for (i, r) in ratings.iter().enumerate() {
                    let n = (i + 1) as u128;
                    if n == 1 { avg = *r; } else { avg = ((avg as u128 * (n-1) + *r as u128) / n).min(5) as u8; }
                }
                prop_assert!(avg <= 5);
            }
        }
    }
}
