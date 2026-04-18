use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

use crate::state::*;
use crate::errors::*;
use crate::events::*;
use crate::contexts::*;

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
    // Authority verified by has_one constraint (ADR-041)
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

/// Finding #13/#14: per-mint limits are now set at allowlist-add time.
/// `per_tx_limit` and `daily_limit` are in the token's base units, resolving
/// the old SOL-lamport conflation. Calling with an already-allowlisted mint
/// updates its limits (without resetting `spent_today`).
pub fn add_token_allowlist(
    ctx: Context<ManageAllowlist>,
    token_mint: Pubkey,
    per_tx_limit: u64,
    daily_limit: u64,
) -> Result<()> {
    // Authority verified by has_one constraint (ADR-041)

    require!(
        per_tx_limit > 0 && daily_limit > 0 && per_tx_limit <= daily_limit,
        VaultError::InvalidTokenLimits
    );

    let vault = &mut ctx.accounts.vault;
    let newly_added = !vault.policy.token_allowlist.contains(&token_mint);
    if newly_added {
        require!(
            vault.policy.token_allowlist.len() < MAX_TOKEN_ALLOWLIST,
            VaultError::AllowlistFull
        );
        vault.policy.token_allowlist.push(token_mint);
    }

    // Upsert the TokenSpendRecord carrying the per-mint limits.
    match vault.token_spend_records.iter().position(|r| r.mint == token_mint) {
        Some(idx) => {
            let record = &mut vault.token_spend_records[idx];
            record.per_tx_limit = per_tx_limit;
            record.daily_limit = daily_limit;
        }
        None => {
            require!(
                vault.token_spend_records.len() < MAX_TOKEN_SPEND_RECORDS,
                VaultError::TokenSpendRecordsFull
            );
            vault.token_spend_records.push(TokenSpendRecord {
                mint: token_mint,
                per_tx_limit,
                daily_limit,
                spent_today: 0,
                last_spend_day: 0,
            });
        }
    }

    emit!(AllowlistUpdated {
        vault: ctx.accounts.vault.key(),
        item: token_mint,
        action: if newly_added { "token_add" } else { "token_limits_update" }.to_string(),
    });

    Ok(())
}

pub fn remove_token_allowlist(
    ctx: Context<ManageAllowlist>,
    token_mint: Pubkey,
) -> Result<()> {
    // Authority verified by has_one constraint (ADR-041)

    let vault = &mut ctx.accounts.vault;
    vault.policy.token_allowlist.retain(|&t| t != token_mint);
    // ADR-044: Clean up spend records for removed tokens
    vault.token_spend_records.retain(|r| r.mint != token_mint);

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
    // Authority verified by has_one constraint (ADR-041)

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
    // Authority verified by has_one constraint (ADR-041)

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

    // Finding #15: The vault PDA is program-owned, so we can mutate lamports
    // directly — but draining below the rent-exempt minimum would mark the
    // account as rent-bearing, letting the runtime garbage-collect it on the
    // next epoch. Pre-validate the post-transfer balance against Rent before
    // applying the mutation so the whole tx reverts on insufficient funds.
    let rent_minimum = Rent::get()?.minimum_balance(vault_info.data_len());
    let post_transfer_balance = vault_info
        .lamports()
        .checked_sub(amount_lamports)
        .ok_or(VaultError::InsufficientFunds)?;
    require!(
        post_transfer_balance >= rent_minimum,
        VaultError::BelowRentExemption
    );

    **vault_info.try_borrow_mut_lamports()? = post_transfer_balance;
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

// ADR-050: execute_program_call removed — without vault PDA signing (ADR-038),
// it was a rate-limited invoke wrapper with limited utility.

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

        // Findings #13/#14: Per-mint per-tx + daily enforcement in the token's
        // own base units. The record MUST exist — add_token_allowlist is now
        // the only way to authorize a mint for transfers, and it always
        // creates/updates the TokenSpendRecord with explicit limits.
        let mint = ctx.accounts.vault_token_account.mint;
        let current_day = (clock.unix_timestamp / 86400) as u64;

        let record_idx = vault
            .token_spend_records
            .iter()
            .position(|r| r.mint == mint)
            .ok_or(VaultError::TokenNotConfigured)?;
        let record = &mut vault.token_spend_records[record_idx];

        // Per-tx limit (#13) — enforced in the mint's base units.
        require!(
            amount <= record.per_tx_limit,
            VaultError::PerTxTokenLimitExceeded
        );

        // Daily limit (#14) — reset the window if the day rolled over.
        if current_day > record.last_spend_day {
            record.spent_today = 0;
            record.last_spend_day = current_day;
        }
        require!(
            record.spent_today.saturating_add(amount) <= record.daily_limit,
            VaultError::TokenDailyLimitExceeded
        );
        record.spent_today = record.spent_today.saturating_add(amount);
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
    // Authority verified by has_one constraint (ADR-041)

    let vault = &mut ctx.accounts.vault;
    vault.paused = true;

    emit!(VaultPaused {
        vault: ctx.accounts.vault.key(),
    });

    Ok(())
}

pub fn resume_vault(ctx: Context<ResumeVault>) -> Result<()> {
    // Authority verified by has_one constraint (ADR-041)

    let vault = &mut ctx.accounts.vault;
    vault.paused = false;

    emit!(VaultResumed {
        vault: ctx.accounts.vault.key(),
    });

    Ok(())
}
