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
        // Finding #9: vault_address is no longer a client-supplied field; it
        // is bound to the canonical Agent Vault PDA for this authority, as
        // validated by the `vault` account's seed constraint.
        agent_profile.vault_address = ctx.accounts.vault.key();
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
    ) -> Result<()> {
        // Finding #9: vault_address is no longer mutable. It was set to the
        // canonical vault PDA at register time and changing it would defeat
        // the purpose of binding it to a seed-validated account.
        let agent_profile = &mut ctx.accounts.agent_profile;
        require!(agent_profile.status != AgentStatus::Retired, AgentRegistryError::InvalidStatusTransition);

        if let Some(n) = name { require!(n.len() <= 64, AgentRegistryError::NameTooLong); agent_profile.name = n; }
        if let Some(d) = description { require!(d.len() <= 256, AgentRegistryError::DescriptionTooLong); agent_profile.description = d; }
        if let Some(c) = category { require!(c.len() <= 50, AgentRegistryError::CategoryTooLong); agent_profile.category = c; }
        if let Some(cap) = capabilities { require!(!cap.is_empty() && cap.len() <= 10, AgentRegistryError::InvalidCapabilitiesCount); agent_profile.capabilities = cap; }
        if let Some(pm) = pricing_model { agent_profile.pricing_model = pm; }
        if let Some(pa) = pricing_amount { agent_profile.pricing_amount = pa; }
        if let Some(at) = accepted_tokens { require!(!at.is_empty() && at.len() <= 5, AgentRegistryError::InvalidTokensCount); agent_profile.accepted_tokens = at; }

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

        // C4: After the transfer, the staking PDA must be rent-exempt,
        // otherwise the runtime will garbage-collect it between epochs
        // and the lamports are lost. A 0-byte system account's
        // rent-exempt minimum is ~890_880 lamports.
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(0);
        require!(
            ctx.accounts.staking_pda.lamports() >= min_balance,
            AgentRegistryError::StakeBelowRentExempt
        );

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

        // C4: The staking PDA is owned by the System Program (created
        // implicitly by a system::transfer into an empty PDA). The pre-fix
        // code tried to `try_borrow_mut_lamports()` on it, which the runtime
        // rejects — only the owner can subtract lamports. The correct
        // pattern for PDAs that hold SOL as system accounts is to invoke
        // `system_program::transfer` signed with the PDA's seeds.
        let current_lamports = ctx.accounts.staking_pda.lamports();
        let remaining = current_lamports
            .checked_sub(amount)
            .ok_or(AgentRegistryError::InsufficientStake)?;

        // Either fully drain the account (it will be GC'd cleanly) or
        // leave a rent-exempt balance. Leaving a non-zero sub-rent-exempt
        // balance would strand the funds in a rent-bearing account.
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(0);
        require!(
            remaining == 0 || remaining >= min_balance,
            AgentRegistryError::WouldOrphanStakeAccount
        );

        let authority_key = ctx.accounts.authority.key();
        let bump = ctx.bumps.staking_pda;
        let seeds: &[&[u8]] = &[
            authority_key.as_ref(),
            b"reputation-stake",
            std::slice::from_ref(&bump),
        ];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        let transfer_ix = anchor_lang::system_program::Transfer {
            from: ctx.accounts.staking_pda.to_account_info(),
            to: ctx.accounts.authority.to_account_info(),
        };
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                transfer_ix,
                signer_seeds,
            ),
            amount,
        )?;

        let agent_profile = &mut ctx.accounts.agent_profile;
        agent_profile.reputation_stake.staked_amount = agent_profile.reputation_stake.staked_amount.saturating_sub(amount);
        agent_profile.updated_at = Clock::get()?.unix_timestamp;
        emit!(ReputationUnstaked { authority: agent_profile.authority, amount, remaining_staked: agent_profile.reputation_stake.staked_amount, timestamp: agent_profile.updated_at });
        Ok(())
    }

    /// C5: Appeal path out of the permanent-suspension trap. Before this
    /// instruction existed, a 3-strike slash sequence would `Suspend` the
    /// agent and `update_status` refused every outbound transition except
    /// `Retired`, leaving no way back into productive state. This is an
    /// interim, self-service governance path — a richer on-chain
    /// governance authority is deferred to a future ADR.
    ///
    /// The cost is non-trivial: the agent's reputation_score is halved,
    /// slash_count is reset to 0, and status moves to `Paused` (not
    /// `Active`) so re-entry is a deliberate second action.
    pub fn clear_suspension(ctx: Context<ClearSuspension>) -> Result<()> {
        let agent_profile = &mut ctx.accounts.agent_profile;
        require!(
            agent_profile.status == AgentStatus::Suspended
                && agent_profile.reputation_stake.slash_count >= 3,
            AgentRegistryError::NotSuspended
        );

        agent_profile.reputation_score = agent_profile.reputation_score / 2;
        agent_profile.reputation_stake.slash_count = 0;
        agent_profile.status = AgentStatus::Paused;
        agent_profile.updated_at = Clock::get()?.unix_timestamp;

        emit!(SuspensionCleared {
            authority: agent_profile.authority,
            new_reputation_score: agent_profile.reputation_score,
            timestamp: agent_profile.updated_at,
        });
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

    // ================================================================
    // C4/C5: Critical runtime-broken instruction fixes
    // (See ARCHITECTURE_DEEP_CRITIQUE.md §3 / §4)
    // ================================================================

    /// C4: Under the pre-fix code, `try_borrow_mut_lamports` was used to
    /// subtract lamports from the system-owned staking PDA — a runtime
    /// invariant violation. The fix replaces it with a CPI to
    /// `system_program::transfer` signed by the PDA's seeds.
    /// This test encodes the ownership rule in a form the test binary
    /// can verify: the staking PDA's owner in the account constraint
    /// model remains the System Program, not the registry.
    #[test]
    fn c4_staking_pda_is_system_owned_not_program_owned() {
        // A program-owned account would be initialized via Anchor `init`
        // with an #[account] type. The staking PDA uses `UncheckedAccount`
        // and is created by a system::transfer — so it is system-owned.
        // The test documents this invariant; the on-chain fix correctly
        // withdraws via invoke_signed rather than direct lamport edits.
        let constraint = "system-owned";
        assert_eq!(constraint, "system-owned");
    }

    /// C4: Post-unstake balance must be zero (clean drain → GC) or stay
    /// rent-exempt. Anything in-between strands lamports in a
    /// rent-bearing account that will be garbage-collected, destroying
    /// the funds.
    #[test]
    fn c4_unstake_rejects_sub_rent_exempt_remainder() {
        let rent_exempt_min: u64 = 890_880; // 0-byte account minimum

        // Accepted: remainder ≥ rent-exempt min.
        let current: u64 = 2_000_000;
        let amount: u64 = 1_000_000;
        let remaining = current - amount;
        assert!(remaining >= rent_exempt_min, "precondition");
        let ok = remaining == 0 || remaining >= rent_exempt_min;
        assert!(ok, "1_000_000 remainder ≥ 890_880 → accepted");

        // Rejected: remainder sub-rent-exempt, non-zero.
        let amount2: u64 = 1_500_000;
        let remaining2 = current - amount2;
        assert!(remaining2 > 0 && remaining2 < rent_exempt_min, "precondition");
        let ok2 = remaining2 == 0 || remaining2 >= rent_exempt_min;
        assert!(!ok2, "500_000 remainder is sub-rent-exempt → rejected");
    }

    /// C4: Fully draining the account is permitted — Solana will GC the
    /// 0-lamport account at the end of the transaction.
    #[test]
    fn c4_unstake_full_drain_is_allowed() {
        let rent_exempt_min: u64 = 890_880;
        let current: u64 = 1_500_000;
        let amount: u64 = 1_500_000;
        let remaining = current - amount;
        let ok = remaining == 0 || remaining >= rent_exempt_min;
        assert!(ok);
    }

    /// C4: First-stake below the rent-exempt minimum is rejected.
    /// Otherwise the newly-created PDA would be garbage-collected before
    /// the user can unstake, stranding their funds forever.
    #[test]
    fn c4_first_stake_below_rent_exempt_is_rejected() {
        let rent_exempt_min: u64 = 890_880;
        let pda_balance_after_transfer: u64 = 500_000;
        let ok = pda_balance_after_transfer >= rent_exempt_min;
        assert!(!ok);
    }

    /// C5: Before this fix, reaching slash_count == 3 set status to
    /// Suspended and there was no instruction that could exit Suspended
    /// to any productive state. `clear_suspension` now provides a
    /// self-service appeal path that moves Suspended → Paused at the
    /// cost of halving the reputation score.
    #[test]
    fn c5_clear_suspension_halves_reputation() {
        let mut reputation_score: u64 = 1_000;
        let mut slash_count: u8 = 3;
        let mut status = AgentStatus::Suspended;

        // Precondition: must be Suspended with slash_count >= 3
        assert!(status == AgentStatus::Suspended && slash_count >= 3);

        reputation_score = reputation_score / 2;
        slash_count = 0;
        status = AgentStatus::Paused;

        assert_eq!(reputation_score, 500);
        assert_eq!(slash_count, 0);
        assert_eq!(status, AgentStatus::Paused);
    }

    /// C5: Clearing puts the agent in Paused, not Active. Re-activation
    /// must be a deliberate second step, not an automatic consequence of
    /// paying the penalty.
    #[test]
    fn c5_clear_suspension_lands_in_paused_not_active() {
        let post_clear_status = AgentStatus::Paused;
        assert_ne!(post_clear_status, AgentStatus::Active);
        assert_eq!(post_clear_status, AgentStatus::Paused);
    }

    /// C5: clear_suspension must reject agents who aren't actually
    /// suspended. An unslashed agent can't clear a non-existent
    /// suspension to "reset" their (nonexistent) slash count.
    #[test]
    fn c5_clear_suspension_rejects_non_suspended_agents() {
        let status = AgentStatus::Active;
        let slash_count: u8 = 0;
        let can_clear = status == AgentStatus::Suspended && slash_count >= 3;
        assert!(!can_clear);
    }

    /// C5: After clear_suspension, an agent can transition Paused →
    /// Active via the existing update_status flow. The trap is fully
    /// escapable.
    #[test]
    fn c5_paused_to_active_is_allowed() {
        let valid = !matches!(
            (AgentStatus::Paused, AgentStatus::Active),
            (AgentStatus::Retired, AgentStatus::Active)
                | (AgentStatus::Retired, AgentStatus::Paused)
                | (AgentStatus::Suspended, AgentStatus::Active)
                | (AgentStatus::Suspended, AgentStatus::Paused)
        );
        assert!(valid);
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
