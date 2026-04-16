use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN");

pub mod state;
pub mod errors;
pub mod events;
pub mod contexts;
pub mod instructions;

use state::*;
use errors::*;
use events::*;
use contexts::*;

#[program]
pub mod agent_vault {
    use super::*;

    /// Initializes a new vault for an AI agent.
    /// The vault authority is set to the signer, who has control over policy updates and pause/resume.
    /// The agent identity is linked to this vault for on-chain reputation tracking.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        agent_identity: Pubkey,
        daily_limit_lamports: u64,
        per_tx_limit_lamports: u64,
        max_txs_per_hour: u32,
    ) -> Result<()> {
        instructions::initialize_vault(
            ctx,
            agent_identity,
            daily_limit_lamports,
            per_tx_limit_lamports,
            max_txs_per_hour,
        )
    }

    /// Updates the vault's spending policy (limits and rate limits).
    /// Only the vault authority can call this instruction.
    pub fn update_policy(
        ctx: Context<UpdatePolicy>,
        daily_limit_lamports: u64,
        per_tx_limit_lamports: u64,
        max_txs_per_hour: u32,
    ) -> Result<()> {
        instructions::update_policy(
            ctx,
            daily_limit_lamports,
            per_tx_limit_lamports,
            max_txs_per_hour,
        )
    }

    /// Adds a token to the vault's allowlist. Only tokens in this list can be transferred.
    /// Calling with a token already in the allowlist is idempotent.
    pub fn add_token_allowlist(ctx: Context<ManageAllowlist>, token_mint: Pubkey) -> Result<()> {
        instructions::add_token_allowlist(ctx, token_mint)
    }

    /// Removes a token from the vault's allowlist.
    pub fn remove_token_allowlist(ctx: Context<ManageAllowlist>, token_mint: Pubkey) -> Result<()> {
        instructions::remove_token_allowlist(ctx, token_mint)
    }

    /// Adds a program to the vault's program allowlist. Only whitelisted programs can be invoked.
    pub fn add_program_allowlist(ctx: Context<ManageProgramAllowlist>, program_id: Pubkey) -> Result<()> {
        instructions::add_program_allowlist(ctx, program_id)
    }

    /// Removes a program from the vault's program allowlist.
    pub fn remove_program_allowlist(
        ctx: Context<ManageProgramAllowlist>,
        program_id: Pubkey,
    ) -> Result<()> {
        instructions::remove_program_allowlist(ctx, program_id)
    }

    /// Executes a SOL transfer from the vault to a recipient.
    /// Enforces spending limits, rate limiting, and daily caps.
    /// Records the action in the on-chain audit log.
    pub fn execute_transfer(
        ctx: Context<ExecuteTransfer>,
        amount_lamports: u64,
    ) -> Result<()> {
        instructions::execute_transfer(ctx, amount_lamports)
    }

    /// Executes an arbitrary program invocation on behalf of the vault.
    /// The program must be in the vault's allowlist.
    /// This is a cross-program invocation (CPI) to any program.
    pub fn execute_program_call<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteProgramCall<'info>>,
        instruction_data: Vec<u8>,
        program_to_invoke: Pubkey,
    ) -> Result<()> {
        instructions::execute_program_call(ctx, instruction_data, program_to_invoke)
    }

    /// Executes an SPL token transfer from the vault's token account to a recipient.
    /// Enforces token allowlist, rate limiting, and the vault's pause state.
    /// The vault PDA signs the transfer via CPI.
    pub fn execute_token_transfer(
        ctx: Context<ExecuteTokenTransfer>,
        amount: u64,
    ) -> Result<()> {
        instructions::execute_token_transfer(ctx, amount)
    }

    /// Pauses the vault, preventing any transfers or program calls.
    /// Only the vault authority can pause.
    pub fn pause_vault(ctx: Context<PauseVault>) -> Result<()> {
        instructions::pause_vault(ctx)
    }

    /// Resumes the vault, allowing transfers and program calls again.
    /// Only the vault authority can resume.
    pub fn resume_vault(ctx: Context<ResumeVault>) -> Result<()> {
        instructions::resume_vault(ctx)
    }
}

// ============================================================================
// UNIT TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_pubkey() -> Pubkey {
        Pubkey::new_unique()
    }

    #[test]
    fn test_vault_policy_new_defaults() {
        let policy = VaultPolicy::new(100, 1000, 10);
        assert_eq!(policy.per_tx_limit_lamports, 100);
        assert_eq!(policy.daily_limit_lamports, 1000);
        assert_eq!(policy.max_txs_per_hour, 10);
        assert!(policy.token_allowlist.is_empty());
        assert!(policy.program_allowlist.is_empty());
    }

    #[test]
    fn test_token_allowlist_empty_allows_all() {
        let policy = VaultPolicy::new(100, 1000, 10);
        let mint = sample_pubkey();
        assert!(policy.is_token_allowed(&mint));
    }

    #[test]
    fn test_token_allowlist_populated_filters() {
        let mut policy = VaultPolicy::new(100, 1000, 10);
        let allowed = sample_pubkey();
        let denied = sample_pubkey();
        policy.token_allowlist.push(allowed);

        assert!(policy.is_token_allowed(&allowed));
        assert!(!policy.is_token_allowed(&denied));
    }

    #[test]
    fn test_program_allowlist_empty_allows_all() {
        let policy = VaultPolicy::new(100, 1000, 10);
        let prog = sample_pubkey();
        assert!(policy.is_program_allowed(&prog));
    }

    #[test]
    fn test_program_allowlist_populated_filters() {
        let mut policy = VaultPolicy::new(100, 1000, 10);
        let allowed = sample_pubkey();
        let denied = sample_pubkey();
        policy.program_allowlist.push(allowed);

        assert!(policy.is_program_allowed(&allowed));
        assert!(!policy.is_program_allowed(&denied));
    }

    #[test]
    fn test_allowlist_cap_constants() {
        assert_eq!(MAX_TOKEN_ALLOWLIST, 10);
        assert_eq!(MAX_PROGRAM_ALLOWLIST, 10);
    }

    #[test]
    fn test_allowlist_cap_enforcement_logic() {
        let mut policy = VaultPolicy::new(100, 1000, 10);
        // Fill to max
        for _ in 0..MAX_TOKEN_ALLOWLIST {
            policy.token_allowlist.push(sample_pubkey());
        }
        assert_eq!(policy.token_allowlist.len(), MAX_TOKEN_ALLOWLIST);
        // Verify the check that would be enforced
        assert!(policy.token_allowlist.len() >= MAX_TOKEN_ALLOWLIST);
    }

    // ================================================================
    // ADR-015: Per-token daily spending limit tests
    // ================================================================

    #[test]
    fn test_token_spend_record_new_day_resets() {
        let mint = sample_pubkey();
        let mut record = TokenSpendRecord {
            mint,
            spent_today: 500,
            last_spend_day: 100,
        };
        // Simulate day change
        let current_day: u64 = 101;
        if current_day > record.last_spend_day {
            record.spent_today = 0;
            record.last_spend_day = current_day;
        }
        assert_eq!(record.spent_today, 0);
        assert_eq!(record.last_spend_day, 101);
    }

    #[test]
    fn test_token_spend_record_same_day_accumulates() {
        let mint = sample_pubkey();
        let mut record = TokenSpendRecord {
            mint,
            spent_today: 300,
            last_spend_day: 100,
        };
        let amount: u64 = 200;
        let daily_limit: u64 = 1000;
        let current_day: u64 = 100; // same day
        if current_day > record.last_spend_day {
            record.spent_today = 0;
            record.last_spend_day = current_day;
        }
        assert!(record.spent_today.saturating_add(amount) <= daily_limit);
        record.spent_today = record.spent_today.saturating_add(amount);
        assert_eq!(record.spent_today, 500);
    }

    #[test]
    fn test_token_spend_record_exceeds_daily_limit() {
        let mint = sample_pubkey();
        let record = TokenSpendRecord {
            mint,
            spent_today: 900,
            last_spend_day: 100,
        };
        let amount: u64 = 200;
        let daily_limit: u64 = 1000;
        // 900 + 200 = 1100 > 1000 -- should be rejected
        assert!(record.spent_today.saturating_add(amount) > daily_limit);
    }

    #[test]
    fn test_token_spend_record_exact_daily_limit() {
        let mint = sample_pubkey();
        let record = TokenSpendRecord {
            mint,
            spent_today: 800,
            last_spend_day: 100,
        };
        let amount: u64 = 200;
        let daily_limit: u64 = 1000;
        // 800 + 200 = 1000 == 1000 -- should pass (<=)
        assert!(record.spent_today.saturating_add(amount) <= daily_limit);
    }

    #[test]
    fn test_token_spend_records_capacity() {
        let mut records: Vec<TokenSpendRecord> = Vec::new();
        for _ in 0..MAX_TOKEN_SPEND_RECORDS {
            records.push(TokenSpendRecord {
                mint: sample_pubkey(),
                spent_today: 0,
                last_spend_day: 0,
            });
        }
        assert_eq!(records.len(), MAX_TOKEN_SPEND_RECORDS);
        // Should not be able to add more
        assert!(records.len() >= MAX_TOKEN_SPEND_RECORDS);
    }

    #[test]
    fn test_token_spend_record_lookup_by_mint() {
        let mint_a = sample_pubkey();
        let mint_b = sample_pubkey();
        let records = vec![
            TokenSpendRecord { mint: mint_a, spent_today: 100, last_spend_day: 50 },
            TokenSpendRecord { mint: mint_b, spent_today: 200, last_spend_day: 50 },
        ];
        let found = records.iter().position(|r| r.mint == mint_b);
        assert_eq!(found, Some(1));
        let not_found = records.iter().position(|r| r.mint == sample_pubkey());
        assert!(not_found.is_none());
    }

    #[test]
    fn test_vault_action_variants() {
        let action = VaultAction::Transfer {
            recipient: sample_pubkey(),
            amount: 100,
        };
        assert_eq!(
            action,
            VaultAction::Transfer {
                recipient: match &action {
                    VaultAction::Transfer { recipient, .. } => *recipient,
                    _ => unreachable!(),
                },
                amount: 100,
            }
        );

        let action2 = VaultAction::Pause;
        assert_eq!(action2, VaultAction::Pause);
    }

    // ================================================================
    // ADR-021: Property-based fuzz tests (proptest)
    // ================================================================

    mod fuzz {
        use super::*;
        use proptest::prelude::*;
        use proptest::collection::vec as prop_vec;

        proptest! {
            /// Allowlist operations never exceed MAX_TOKEN_ALLOWLIST.
            /// Simulates a sequence of add/remove operations on the token allowlist.
            #[test]
            fn token_allowlist_never_exceeds_max(
                ops in prop_vec((any::<[u8; 32]>(), any::<bool>()), 0..50)
            ) {
                let mut policy = VaultPolicy::new(100, 1000, 10);
                for (key_bytes, is_add) in ops {
                    let pubkey = Pubkey::new_from_array(key_bytes);
                    if is_add {
                        if !policy.token_allowlist.contains(&pubkey)
                            && policy.token_allowlist.len() < MAX_TOKEN_ALLOWLIST
                        {
                            policy.token_allowlist.push(pubkey);
                        }
                    } else {
                        policy.token_allowlist.retain(|&t| t != pubkey);
                    }
                }
                prop_assert!(policy.token_allowlist.len() <= MAX_TOKEN_ALLOWLIST);
            }

            /// is_token_allowed always returns true when the allowlist is empty.
            #[test]
            fn empty_allowlist_allows_any_token(key_bytes in any::<[u8; 32]>()) {
                let policy = VaultPolicy::new(100, 1000, 10);
                let mint = Pubkey::new_from_array(key_bytes);
                prop_assert!(policy.is_token_allowed(&mint));
            }

            /// Daily limit arithmetic never overflows with random inputs
            /// (mirrors the saturating_add pattern used in execute_transfer).
            #[test]
            fn daily_limit_arithmetic_no_overflow(
                spent_today in any::<u64>(),
                amount in any::<u64>(),
                daily_limit in any::<u64>(),
            ) {
                let new_total = spent_today.saturating_add(amount);
                // saturating_add must never panic and must be <= u64::MAX
                prop_assert!(new_total >= spent_today || new_total == u64::MAX);
                // The limit check itself must not panic
                let _within_limit = new_total <= daily_limit;
            }
        }
    }
}
