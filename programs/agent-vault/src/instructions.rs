use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

use crate::state::*;
use crate::errors::*;
use crate::events::*;
use crate::contexts::*;

/// AUD-006: Saturating, non-negative elapsed-seconds between two `i64`
/// unix timestamps.
///
/// Previously the rate-limit sites computed `now - window_start` directly,
/// then compared the signed `i64` result against `3600`. If
/// `window_start > now` (clock skew on the validator, a fresh
/// `initialize_vault` whose timestamp leads the next slot's clock, or any
/// future-dated start), the difference is negative and the
/// "still inside window" branch was taken — meaning the window would
/// never reset and the `txs_in_current_window` counter would never roll.
///
/// `saturating_sub` clamps at `i64::MIN` (no UB), and `.max(0)` collapses
/// any negative result to zero. A zero elapsed time is then compared
/// against `3600`, which always falls into the "still in window" branch
/// safely without making the bug worse — but the companion fix is that
/// the window-reset branch in the call site now triggers as soon as the
/// real elapsed time crosses 3600s, rather than depending on a signed
/// comparison succeeding.
///
/// Behavior:
/// - `now > start` → returns `now - start` (positive elapsed)
/// - `now == start` → returns `0`
/// - `now < start` → returns `0` (clock-skew / future-dated start)
#[inline]
pub fn compute_window_elapsed(now: i64, window_start: i64) -> i64 {
    now.saturating_sub(window_start).max(0)
}

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
    // ADR-095 / ADR-097 / AUD-008 (PR-J): record the profile nonce sourced
    // from the Registry's authoritative `OwnerNonce` PDA. Previously the
    // caller supplied this as a `u64` argument, allowing a stale or wrong
    // value to brick downstream `agent_profile` lookups in
    // `execute_transfer` / `execute_token_transfer`. The seeds constraint
    // on `owner_nonce` enforces register-first (the PDA must already exist
    // in Registry) and binds the account to `authority` via PDA derivation.
    vault.profile_nonce = ctx.accounts.owner_nonce.nonce;
    // PR-X / AUD-023: 0 means "never rotated"; the very first call to
    // `update_agent_identity` always succeeds. Subsequent rotations are
    // gated by the 24h sliding window enforced in `update_agent_identity`.
    vault.last_rotation_at = 0;

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
    // Authority verified by has_one constraint (ADR-041).
    // NOTE (ADR-069): `update_policy` intentionally does NOT rotate
    // `agent_identity`. Callers must use `update_agent_identity` for that —
    // rotation is a distinct operation with its own audit event
    // (`AgentIdentityUpdated`) so indexers can distinguish a policy tweak
    // from a hot-key rotation.
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

/// ADR-069 (SEC-2): Rotate the vault's `agent_identity` hot key.
///
/// `agent_identity` is the off-chain agent runtime's signing key and is one
/// of two keys (alongside `authority`) accepted as a signer for
/// `execute_transfer` / `execute_token_transfer`. It is **expected to be
/// rotated** on any of:
///
/// - Suspected compromise of the agent runtime (leaked log, lost device,
///   terminated contractor access).
/// - Routine cadence (ADR-069 suggests 90 days for long-running agents).
/// - Migration of the agent runtime between hosts.
///
/// Rotation is instantaneous: the old key cannot sign the next transfer after
/// this instruction lands. The daily spend window, rate-limit counters, and
/// token spend records are intentionally preserved — rotation is a key-swap,
/// not a vault reset.
///
/// Authority is verified by `has_one = authority` on the context.
///
/// PR-X / AUD-023: Per-day rotation cap. The previous handler let the
/// authority rotate `agent_identity` to any pubkey at any time with no
/// rate limit, so a compromised authority could rotate → drain at the
/// daily cap → rotate to another key → drain again, bypassing the daily
/// limit entirely. We now enforce one rotation per 24h via a sliding
/// window (`last_rotation_at`).
///
/// Migration: vaults deployed before PR-X have `last_rotation_at = 0`
/// (Anchor zero-fills new fields at the end of the account on first
/// post-upgrade deserialize), so their first rotation post-upgrade is
/// unrestricted; subsequent rotations are gated.
pub fn update_agent_identity(
    ctx: Context<UpdateAgentIdentity>,
    new_agent_identity: Pubkey,
) -> Result<()> {
    /// Minimum interval between two successive `update_agent_identity`
    /// calls on the same vault (24h, expressed in seconds).
    const MIN_ROTATION_INTERVAL_SECS: i64 = 24 * 60 * 60;

    let now = Clock::get()?.unix_timestamp;
    let vault = &mut ctx.accounts.vault;

    // Checks-effects-interactions: the rate-limit check runs BEFORE the
    // `agent_identity` write so a rejected rotation leaves vault state
    // untouched. `saturating_sub` handles the (pathological) case where
    // a clock regression would otherwise wrap on a signed subtraction.
    require!(
        now.saturating_sub(vault.last_rotation_at) >= MIN_ROTATION_INTERVAL_SECS,
        VaultError::RotationRateLimited
    );

    let old_identity = vault.agent_identity;
    vault.agent_identity = new_agent_identity;
    vault.last_rotation_at = now;

    emit!(AgentIdentityUpdated {
        vault: ctx.accounts.vault.key(),
        old_identity,
        new_identity: new_agent_identity,
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
        // AUD-006: Use saturating subtraction clamped to >=0 so that
        // `window_start > now` (clock skew, fresh-init drift) does not
        // produce a negative `i64` that incorrectly stays in the window.
        let time_since_window_start =
            compute_window_elapsed(clock.unix_timestamp, vault.rate_limit_window_start);
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

    // ADR-071 (SEC-5): Reordered so all validation that can fail runs BEFORE
    // any counter mutation. Previously the rate-limit window counter was
    // incremented between the allowlist check and the TokenSpendRecord lookup,
    // which meant a tx destined to fail with `TokenNotConfigured` would still
    // burn a rate-limit slot at mid-handler — and while the Solana runtime
    // rolls persistent state back on tx failure today, the ordering is
    // fragile: any future refactor that persists the counter before a later
    // failing read (or adds a CPI that flushes state mid-handler) would
    // reintroduce the DoS.
    //
    // Target ordering now matches the pre-lamport-mutation discipline used
    // in `execute_transfer` above:
    //   1. TokenSpendRecord lookup (fail fast on TokenNotConfigured).
    //   2. Per-tx token limit check.
    //   3. Per-mint daily limit check (pure read).
    //   4. Global rate-limit window check (pure read).
    //   5. All counter mutations (daily spent, window start, window count) —
    //      only after every validation has passed.
    //
    // The default-allow-all allowlist semantics in `state.rs:110-114`
    // (empty allowlist = all mints allowed) is the more severe variant of
    // this finding and is deferred to a separate policy-change ADR (ADR-073
    // track) — this commit preserves existing semantics while fixing the
    // immediate ordering hazard.
    {
        let vault = &mut ctx.accounts.vault;

        let mint = ctx.accounts.vault_token_account.mint;
        let current_day = (clock.unix_timestamp / 86400) as u64;

        // (1) TokenSpendRecord lookup — fail BEFORE touching any counter.
        // Findings #13/#14: Per-mint per-tx + daily enforcement in the token's
        // own base units. The record MUST exist — add_token_allowlist is the
        // only way to authorize a mint for transfers, and it always
        // creates/updates the TokenSpendRecord with explicit limits.
        let record_idx = vault
            .token_spend_records
            .iter()
            .position(|r| r.mint == mint)
            .ok_or(VaultError::TokenNotConfigured)?;

        // (2) Per-tx limit (#13) — pure read against the record.
        {
            let record = &vault.token_spend_records[record_idx];
            require!(
                amount <= record.per_tx_limit,
                VaultError::PerTxTokenLimitExceeded
            );
        }

        // (3) Per-mint daily limit (#14) — compute the projected spent value
        // without mutating yet; the day-rollover reset and the post-spend
        // update both happen in phase (5) below.
        let (projected_spent, resets_day) = {
            let record = &vault.token_spend_records[record_idx];
            let effective_spent = if current_day > record.last_spend_day {
                0
            } else {
                record.spent_today
            };
            let projected = effective_spent.saturating_add(amount);
            require!(
                projected <= record.daily_limit,
                VaultError::TokenDailyLimitExceeded
            );
            (projected, current_day > record.last_spend_day)
        };

        // (4) Global rate-limit window — pure read. Compute the post-window
        // state but defer the write to phase (5).
        // AUD-006: saturating, non-negative elapsed — see
        // `compute_window_elapsed` doc-comment for the clock-skew case.
        let time_since_window_start =
            compute_window_elapsed(clock.unix_timestamp, vault.rate_limit_window_start);
        let (new_window_start, new_window_count) = if time_since_window_start >= 3600 {
            (clock.unix_timestamp, 0u32)
        } else {
            (vault.rate_limit_window_start, vault.txs_in_current_window)
        };
        require!(
            new_window_count < vault.policy.max_txs_per_hour,
            VaultError::RateLimitExceeded
        );

        // (5) Mutations — only after every validation has passed.
        vault.rate_limit_window_start = new_window_start;
        vault.txs_in_current_window = new_window_count.saturating_add(1);

        let record = &mut vault.token_spend_records[record_idx];
        if resets_day {
            record.last_spend_day = current_day;
        }
        record.spent_today = projected_spent;
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
