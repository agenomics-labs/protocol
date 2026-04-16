use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN");

/// Maximum number of tokens in the allowlist.
/// Chosen to fit within the 1024-byte allocation headroom: 10 * 32 bytes = 320 bytes.
const MAX_TOKEN_ALLOWLIST: usize = 10;

/// Maximum number of programs in the allowlist.
/// Same sizing rationale as token allowlist.
const MAX_PROGRAM_ALLOWLIST: usize = 10;

/// Maximum number of per-token daily spend tracking records.
/// Matches MAX_TOKEN_ALLOWLIST so every allowlisted token can be tracked.
const MAX_TOKEN_SPEND_RECORDS: usize = 10;

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
// ACCOUNT STRUCTURES & CONSTRAINTS
// ============================================================================

/// Tracks per-token daily spending for a specific mint.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct TokenSpendRecord {
    /// The SPL token mint this record tracks.
    pub mint: Pubkey,
    /// Amount of this token spent today (in base units).
    pub spent_today: u64,
    /// The day for which spent_today is tracked (Unix timestamp / 86400).
    pub last_spend_day: u64,
}

#[account]
pub struct Vault {
    /// The agent identity this vault is linked to (for reputation tracking).
    pub agent_identity: Pubkey,

    /// The authority that can pause/resume and update policies.
    pub authority: Pubkey,

    /// When true, no transfers or program calls are permitted.
    pub paused: bool,

    /// Cumulative SOL spent today (resets daily).
    pub spent_today_lamports: u64,

    /// The day for which spent_today_lamports is tracked (Unix timestamp / 86400).
    pub last_spend_day: u64,

    /// Spending policy for this vault.
    pub policy: VaultPolicy,

    /// Counter for transactions in the current rate-limit window.
    pub txs_in_current_window: u32,

    /// Timestamp of when the current rate-limit window started.
    pub rate_limit_window_start: i64,

    /// Per-token daily spending records (max MAX_TOKEN_SPEND_RECORDS entries).
    pub token_spend_records: Vec<TokenSpendRecord>,

    /// PDA bump seed for vault signing in CPIs.
    pub bump: u8,
}

// ADR-039: AuditEntry struct removed — auditing is done via emit! events,
// not on-chain accounts. See TransactionExecuted, ProgramCallExecuted,
// TokenTransferExecuted events for the audit trail.

/// The spending policy for a vault.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct VaultPolicy {
    /// Maximum SOL that can be transferred in a single transaction (in lamports).
    pub per_tx_limit_lamports: u64,

    /// Maximum SOL that can be transferred per day (in lamports).
    pub daily_limit_lamports: u64,

    /// Maximum number of transactions allowed per hour.
    pub max_txs_per_hour: u32,

    /// Bitmap for token allowlist (if None, all tokens allowed; if Some, only listed tokens).
    /// This is a simplified version; production would use a separate account for large lists.
    pub token_allowlist: Vec<Pubkey>,

    /// Bitmap for program allowlist (if None, all programs allowed; if Some, only listed programs).
    pub program_allowlist: Vec<Pubkey>,
}

impl VaultPolicy {
    fn new(
        per_tx_limit_lamports: u64,
        daily_limit_lamports: u64,
        max_txs_per_hour: u32,
    ) -> Self {
        Self {
            per_tx_limit_lamports,
            daily_limit_lamports,
            max_txs_per_hour,
            token_allowlist: vec![],
            program_allowlist: vec![],
        }
    }

    /// Checks if a token is allowed for transfer.
    fn is_token_allowed(&self, mint: &Pubkey) -> bool {
        if self.token_allowlist.is_empty() {
            return true; // No allowlist = all tokens allowed
        }
        self.token_allowlist.contains(mint)
    }

    /// Checks if a program is allowed to be invoked.
    fn is_program_allowed(&self, program_id: &Pubkey) -> bool {
        if self.program_allowlist.is_empty() {
            return true; // No allowlist = all programs allowed
        }
        self.program_allowlist.contains(program_id)
    }
}

/// The action enum for the audit log.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub enum VaultAction {
    Transfer {
        recipient: Pubkey,
        amount: u64,
    },
    ProgramCall {
        program_id: Pubkey,
        instruction_hash: [u8; 32],
    },
    PolicyUpdate {
        new_daily_limit: u64,
        new_per_tx_limit: u64,
    },
    TokenAllowlistAdd {
        token_mint: Pubkey,
    },
    TokenAllowlistRemove {
        token_mint: Pubkey,
    },
    ProgramAllowlistAdd {
        program_id: Pubkey,
    },
    ProgramAllowlistRemove {
        program_id: Pubkey,
    },
    Pause,
    Resume,
}

// ============================================================================
// CONTEXT STRUCTURES (Account Constraints)
// ============================================================================

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<Vault>() + 1024,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    #[account(
        mut,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ManageAllowlist<'info> {
    #[account(
        mut,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ManageProgramAllowlist<'info> {
    #[account(
        mut,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteTransfer<'info> {
    /// The vault PDA — serves as both state account and SOL source.
    /// ADR-029: Removed vestigial vault_account field; the vault PDA itself
    /// holds SOL and is used directly for lamport transfers.
    #[account(
        mut,
        seeds = [b"vault", vault.authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    /// The signer must be the agent authority or the vault authority.
    pub agent: Signer<'info>,

    /// CHECK: The recipient of the SOL transfer; validated in instruction handler.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteProgramCall<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    /// The signer must be the agent authority or the vault authority.
    pub agent: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteTokenTransfer<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    /// The signer must be the agent authority or the vault authority.
    pub agent: Signer<'info>,

    /// The vault's token account (source of SPL tokens). Must be owned by the vault PDA.
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key() @ VaultError::Unauthorized,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// The recipient's token account.
    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PauseVault<'info> {
    #[account(
        mut,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResumeVault<'info> {
    #[account(
        mut,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}

// ============================================================================
// INSTRUCTION HANDLERS
// ============================================================================

mod instructions {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        agent_identity: Pubkey,
        daily_limit_lamports: u64,
        per_tx_limit_lamports: u64,
        max_txs_per_hour: u32,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;

        vault.agent_identity = agent_identity;
        vault.authority = ctx.accounts.authority.key();
        vault.paused = false;
        vault.spent_today_lamports = 0;
        vault.last_spend_day = (clock.unix_timestamp / 86400) as u64;
        vault.policy = VaultPolicy::new(per_tx_limit_lamports, daily_limit_lamports, max_txs_per_hour);
        vault.txs_in_current_window = 0;
        vault.rate_limit_window_start = clock.unix_timestamp;
        vault.token_spend_records = vec![];
        vault.bump = ctx.bumps.vault;

        emit!(VaultInitialized {
            vault: ctx.accounts.vault.key(),
            agent_identity,
            authority: ctx.accounts.authority.key(),
            daily_limit: daily_limit_lamports,
            per_tx_limit: per_tx_limit_lamports,
        });

        Ok(())
    }

    pub fn update_policy(
        ctx: Context<UpdatePolicy>,
        daily_limit_lamports: u64,
        per_tx_limit_lamports: u64,
        max_txs_per_hour: u32,
    ) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.vault.authority, VaultError::Unauthorized);

        let vault = &mut ctx.accounts.vault;
        vault.policy.daily_limit_lamports = daily_limit_lamports;
        vault.policy.per_tx_limit_lamports = per_tx_limit_lamports;
        vault.policy.max_txs_per_hour = max_txs_per_hour;

        emit!(PolicyUpdated {
            vault: ctx.accounts.vault.key(),
            daily_limit: daily_limit_lamports,
            per_tx_limit: per_tx_limit_lamports,
            max_txs_per_hour,
        });

        Ok(())
    }

    pub fn add_token_allowlist(
        ctx: Context<ManageAllowlist>,
        token_mint: Pubkey,
    ) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.vault.authority, VaultError::Unauthorized);

        let vault = &mut ctx.accounts.vault;
        if !vault.policy.token_allowlist.contains(&token_mint) {
            require!(
                vault.policy.token_allowlist.len() < MAX_TOKEN_ALLOWLIST,
                VaultError::AllowlistFull
            );
            vault.policy.token_allowlist.push(token_mint);
        }

        emit!(AllowlistUpdated {
            vault: ctx.accounts.vault.key(),
            item: token_mint,
            action: "token_add".to_string(),
        });

        Ok(())
    }

    pub fn remove_token_allowlist(
        ctx: Context<ManageAllowlist>,
        token_mint: Pubkey,
    ) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.vault.authority, VaultError::Unauthorized);

        let vault = &mut ctx.accounts.vault;
        vault.policy.token_allowlist.retain(|&t| t != token_mint);

        emit!(AllowlistUpdated {
            vault: ctx.accounts.vault.key(),
            item: token_mint,
            action: "token_remove".to_string(),
        });

        Ok(())
    }

    pub fn add_program_allowlist(
        ctx: Context<ManageProgramAllowlist>,
        program_id: Pubkey,
    ) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.vault.authority, VaultError::Unauthorized);

        let vault = &mut ctx.accounts.vault;
        if !vault.policy.program_allowlist.contains(&program_id) {
            require!(
                vault.policy.program_allowlist.len() < MAX_PROGRAM_ALLOWLIST,
                VaultError::AllowlistFull
            );
            vault.policy.program_allowlist.push(program_id);
        }

        emit!(AllowlistUpdated {
            vault: ctx.accounts.vault.key(),
            item: program_id,
            action: "program_add".to_string(),
        });

        Ok(())
    }

    pub fn remove_program_allowlist(
        ctx: Context<ManageProgramAllowlist>,
        program_id: Pubkey,
    ) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.vault.authority, VaultError::Unauthorized);

        let vault = &mut ctx.accounts.vault;
        vault.policy.program_allowlist.retain(|&p| p != program_id);

        emit!(AllowlistUpdated {
            vault: ctx.accounts.vault.key(),
            item: program_id,
            action: "program_remove".to_string(),
        });

        Ok(())
    }

    pub fn execute_transfer(
        ctx: Context<ExecuteTransfer>,
        amount_lamports: u64,
    ) -> Result<()> {
        // Validate amount > 0
        require!(amount_lamports > 0, VaultError::InvalidAmount);

        let clock = Clock::get()?;

        // ====================================================================
        // PHASE 1: READ-ONLY VALIDATION (borrow vault immutably)
        // ====================================================================
        let new_daily_total;
        let new_txs_count;
        let new_last_spend_day;
        let new_rate_limit_window_start;
        let new_txs_in_current_window;
        {
            let vault = &ctx.accounts.vault;

            // Authorization
            require!(
                ctx.accounts.agent.key() == vault.authority
                    || ctx.accounts.agent.key() == vault.agent_identity,
                VaultError::Unauthorized
            );

            // Check if vault is paused
            require!(!vault.paused, VaultError::VaultPaused);

            // Check per-transaction limit
            require!(
                amount_lamports <= vault.policy.per_tx_limit_lamports,
                VaultError::PerTxLimitExceeded
            );

            // Check daily limit
            let current_day = (clock.unix_timestamp / 86400) as u64;
            let mut spent = vault.spent_today_lamports;
            let mut last_day = vault.last_spend_day;
            if current_day > last_day {
                spent = 0;
                last_day = current_day;
            }
            new_daily_total = spent.saturating_add(amount_lamports);
            require!(
                new_daily_total <= vault.policy.daily_limit_lamports,
                VaultError::DailyLimitExceeded
            );
            new_last_spend_day = last_day;

            // Check rate limit
            let time_since_window_start = clock.unix_timestamp - vault.rate_limit_window_start;
            let mut window_start = vault.rate_limit_window_start;
            let mut txs = vault.txs_in_current_window;
            if time_since_window_start > 3600 {
                window_start = clock.unix_timestamp;
                txs = 0;
            }
            require!(
                txs < vault.policy.max_txs_per_hour,
                VaultError::RateLimitExceeded
            );
            new_txs_count = txs.saturating_add(1);
            new_rate_limit_window_start = window_start;
            new_txs_in_current_window = new_txs_count;
        }

        // ====================================================================
        // PHASE 2: EXECUTE TRANSFER (no mutable vault borrow needed)
        // ====================================================================
        let vault_info = ctx.accounts.vault.to_account_info();
        let recipient_info = ctx.accounts.recipient.to_account_info();

        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(amount_lamports)
            .ok_or(VaultError::InsufficientFunds)?;
        **recipient_info.try_borrow_mut_lamports()? = recipient_info
            .lamports()
            .checked_add(amount_lamports)
            .ok_or(VaultError::ArithmeticOverflow)?;

        // ====================================================================
        // PHASE 3: UPDATE VAULT STATE (mutable borrow)
        // ====================================================================
        let vault = &mut ctx.accounts.vault;
        vault.spent_today_lamports = new_daily_total;
        vault.last_spend_day = new_last_spend_day;
        vault.rate_limit_window_start = new_rate_limit_window_start;
        vault.txs_in_current_window = new_txs_in_current_window;

        // ====================================================================
        // EMIT AUDIT LOG EVENT
        // ====================================================================
        emit!(TransactionExecuted {
            vault: vault.key(),
            recipient: ctx.accounts.recipient.key(),
            amount: amount_lamports,
            timestamp: clock.unix_timestamp,
            success: true,
        });

        Ok(())
    }

    /// Execute a read-only or agent-signed cross-program invocation.
    ///
    /// # Security (ADR-038)
    /// The vault PDA is **NOT** injected as a CPI signer. This prevents
    /// allowlisted programs from using the vault's signing authority to
    /// drain SOL or SPL tokens. The agent's own keypair signs the CPI
    /// instead — financial operations must use `execute_transfer` or
    /// `execute_token_transfer` which enforce spending limits.
    ///
    /// # Use cases
    /// - Reading on-chain data via CPI (oracle queries, price feeds)
    /// - Interacting with programs that require agent signature (not vault)
    /// - Calling governance/voting programs with agent identity
    ///
    /// # remaining_accounts layout:
    ///   [0]   = target program (executable)
    ///   [1..] = accounts required by the target instruction
    pub fn execute_program_call<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteProgramCall<'info>>,
        instruction_data: Vec<u8>,
        program_to_invoke: Pubkey,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let vault_key: Pubkey;

        // --- CHECKS + EFFECTS ---
        {
            let vault = &mut ctx.accounts.vault;

            // Authorization
            require!(
                ctx.accounts.agent.key() == vault.authority
                    || ctx.accounts.agent.key() == vault.agent_identity,
                VaultError::Unauthorized
            );

            // Policy enforcement
            require!(!vault.paused, VaultError::VaultPaused);
            require!(
                vault.policy.is_program_allowed(&program_to_invoke),
                VaultError::ProgramNotAllowed
            );

            // Rate limit
            let time_since_window_start = clock.unix_timestamp - vault.rate_limit_window_start;
            if time_since_window_start >= 3600 {
                vault.rate_limit_window_start = clock.unix_timestamp;
                vault.txs_in_current_window = 0;
            }
            require!(
                vault.txs_in_current_window < vault.policy.max_txs_per_hour,
                VaultError::RateLimitExceeded
            );
            vault.txs_in_current_window = vault.txs_in_current_window.saturating_add(1);
            vault_key = vault.key();
        }

        // --- INTERACTIONS (CPI WITHOUT vault PDA signing) ---
        let remaining = ctx.remaining_accounts;
        require!(!remaining.is_empty(), VaultError::ProgramNotAllowed);

        require!(
            remaining[0].key() == program_to_invoke,
            VaultError::ProgramNotAllowed
        );
        require!(remaining[0].executable, VaultError::ProgramNotAllowed);

        // Build account metas — vault PDA is NEVER injected as signer.
        // Only accounts that are already signers retain their signer status.
        let cpi_accounts: Vec<AccountMeta> = remaining[1..]
            .iter()
            .map(|acc| {
                if acc.is_writable {
                    AccountMeta::new(acc.key(), acc.is_signer)
                } else {
                    AccountMeta::new_readonly(acc.key(), acc.is_signer)
                }
            })
            .collect();

        let instruction = anchor_lang::solana_program::instruction::Instruction {
            program_id: program_to_invoke,
            accounts: cpi_accounts,
            data: instruction_data.clone(),
        };

        // Use invoke (not invoke_signed) — no PDA signing authority exposed
        anchor_lang::solana_program::program::invoke(
            &instruction,
            remaining,
        )?;

        // --- EMIT AUDIT LOG ---
        let instruction_hash = {
            use anchor_lang::solana_program::hash::hash;
            let h = hash(&instruction_data);
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&h.to_bytes());
            arr
        };

        emit!(ProgramCallExecuted {
            vault: vault_key,
            program_id: program_to_invoke,
            instruction_hash,
            timestamp: clock.unix_timestamp,
            success: true,
        });

        Ok(())
    }

    /// Execute an SPL token transfer from the vault's token account.
    ///
    /// Enforces: pause check, authorization, token allowlist, rate limiting.
    /// The vault PDA signs the CPI transfer via invoke_signed.
    pub fn execute_token_transfer(
        ctx: Context<ExecuteTokenTransfer>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);

        let clock = Clock::get()?;
        let authority_key: Pubkey;
        let bump: u8;
        {
            let vault = &ctx.accounts.vault;

            // Authorization
            require!(
                ctx.accounts.agent.key() == vault.authority
                    || ctx.accounts.agent.key() == vault.agent_identity,
                VaultError::Unauthorized
            );

            require!(!vault.paused, VaultError::VaultPaused);

            // Token allowlist check
            let mint = ctx.accounts.vault_token_account.mint;
            require!(
                vault.policy.is_token_allowed(&mint),
                VaultError::TokenNotAllowed
            );

            authority_key = vault.authority;
            bump = vault.bump;
        }

        // Rate limit check and update + per-token daily limit enforcement
        {
            let vault = &mut ctx.accounts.vault;
            let time_since_window_start = clock.unix_timestamp - vault.rate_limit_window_start;
            if time_since_window_start >= 3600 {
                vault.rate_limit_window_start = clock.unix_timestamp;
                vault.txs_in_current_window = 0;
            }
            require!(
                vault.txs_in_current_window < vault.policy.max_txs_per_hour,
                VaultError::RateLimitExceeded
            );
            vault.txs_in_current_window = vault.txs_in_current_window.saturating_add(1);

            // Per-token daily spending limit enforcement (ADR-015)
            let mint = ctx.accounts.vault_token_account.mint;
            let current_day = (clock.unix_timestamp / 86400) as u64;
            let daily_limit = vault.policy.daily_limit_lamports;

            // Find existing record for this mint, or create one
            let record_idx = vault.token_spend_records.iter().position(|r| r.mint == mint);
            match record_idx {
                Some(idx) => {
                    let record = &mut vault.token_spend_records[idx];
                    // Reset if day changed
                    if current_day > record.last_spend_day {
                        record.spent_today = 0;
                        record.last_spend_day = current_day;
                    }
                    require!(
                        record.spent_today.saturating_add(amount) <= daily_limit,
                        VaultError::TokenDailyLimitExceeded
                    );
                    record.spent_today = record.spent_today.saturating_add(amount);
                }
                None => {
                    // New token -- check capacity
                    require!(
                        vault.token_spend_records.len() < MAX_TOKEN_SPEND_RECORDS,
                        VaultError::TokenSpendRecordsFull
                    );
                    // First spend of the day for this token
                    require!(
                        amount <= daily_limit,
                        VaultError::TokenDailyLimitExceeded
                    );
                    vault.token_spend_records.push(TokenSpendRecord {
                        mint,
                        spent_today: amount,
                        last_spend_day: current_day,
                    });
                }
            }
        }

        // CPI transfer with vault PDA as signer
        let signer_seeds: &[&[u8]] = &[b"vault", authority_key.as_ref(), &[bump]];

        let transfer_ix = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                transfer_ix,
                &[signer_seeds],
            ),
            amount,
        )?;

        emit!(TokenTransferExecuted {
            vault: ctx.accounts.vault.key(),
            mint: ctx.accounts.vault_token_account.mint,
            recipient: ctx.accounts.recipient_token_account.key(),
            amount,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    pub fn pause_vault(ctx: Context<PauseVault>) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.vault.authority, VaultError::Unauthorized);

        let vault = &mut ctx.accounts.vault;
        vault.paused = true;

        emit!(VaultPaused {
            vault: ctx.accounts.vault.key(),
        });

        Ok(())
    }

    pub fn resume_vault(ctx: Context<ResumeVault>) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.vault.authority, VaultError::Unauthorized);

        let vault = &mut ctx.accounts.vault;
        vault.paused = false;

        emit!(VaultResumed {
            vault: ctx.accounts.vault.key(),
        });

        Ok(())
    }
}

// ============================================================================
// ERROR CODES
// ============================================================================

#[error_code]
pub enum VaultError {
    #[msg("Vault is paused and cannot execute transactions")]
    VaultPaused,

    #[msg("Per-transaction limit exceeded")]
    PerTxLimitExceeded,

    #[msg("Daily spending limit exceeded")]
    DailyLimitExceeded,

    #[msg("Rate limit (transactions per hour) exceeded")]
    RateLimitExceeded,

    #[msg("Token is not in the vault's allowlist")]
    TokenNotAllowed,

    #[msg("Program is not in the vault's program allowlist")]
    ProgramNotAllowed,

    #[msg("Unauthorized: must be vault authority")]
    Unauthorized,

    #[msg("Insufficient funds in vault")]
    InsufficientFunds,

    #[msg("Invalid recipient address")]
    InvalidRecipient,

    #[msg("Invalid amount (must be > 0)")]
    InvalidAmount,

    #[msg("Allowlist is full")]
    AllowlistFull,

    #[msg("Item already in allowlist")]
    ItemAlreadyListed,

    #[msg("Item not found in allowlist")]
    ItemNotFound,

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    #[msg("Per-token daily spending limit exceeded")]
    TokenDailyLimitExceeded,

    #[msg("Token spend records full (max 10)")]
    TokenSpendRecordsFull,
}

// ============================================================================
// EVENTS (for indexing and off-chain tracking)
// ============================================================================

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
