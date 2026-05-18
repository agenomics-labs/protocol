use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};
use agent_registry::state::AgentProfile;

use crate::state::*;
use crate::errors::*;
use crate::events::*;
use crate::contexts::*;

/// ADR-138: Zero-hash sentinel for `tool_id_hash`. Callers that have not
/// yet migrated to the tool-id convention may pass this value; indexers
/// MAY surface a `tool_id_zero_count` metric so operators can track
/// migration progress without breaking the happy path.
pub const TOOL_ID_ZERO: [u8; 32] = [0u8; 32];

/// ADR-138: Pull the manifest_hash from an `AgentProfile`. Returns the
/// 32-byte hash verbatim; the all-zeros sentinel means the profile has
/// no manifest registered (ADR-060 pre-manifest registration) — distinct
/// from "no manifest used".
#[inline]
pub fn manifest_hash_from_profile(profile: &AgentProfile) -> [u8; 32] {
    profile.manifest_hash
}

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

/// ADR-124 / AUD-116 (path-a, cycle-3 closure):
///
/// **Threat closed at the protocol level**: pre-ADR-124, `agent_identity`
/// was bound at init from a caller-supplied `Pubkey` argument with NO
/// proof-of-control. A vault initialized with a wrong/spoofed
/// `agent_identity` carried that key permanently; every `execute_transfer`
/// and `execute_token_transfer` accepts a signature from either the vault
/// `authority` OR the bound `agent_identity`, so a mis-bound hot key
/// could drain the vault under spending policy until the authority
/// rotated it via `update_agent_identity`.
///
/// The cycle-2 audit allowed two paths to closure: (a) require an Ed25519
/// signature at init time, or (b) accept the threat in the SECURITY model.
/// Cycle-2 took path-(b) via inline doc; this cycle-3 implementation takes
/// path-(a) per ADR-124.
///
/// **Path-(a) mechanism**:
///
///   1. The caller computes `vault_identity_bind_message(authority,
///      agent_identity)` (a 32-byte SHA-256 over a vault-specific domain
///      tag concatenated with the two pubkeys — see `lib.rs`).
///   2. The holder of `agent_identity`'s private key produces a 64-byte
///      Ed25519 signature over that message.
///   3. The caller prepends an `Ed25519Program::verify` instruction to the
///      transaction with the inline pubkey / signature / message bytes.
///   4. This handler calls `identity_bind::verify_ed25519_precompile`
///      after recording state, which scans the Instructions sysvar for
///      the neighbouring ed25519-program ix and asserts its inline values
///      equal the supplied `agent_identity` / `agent_identity_signature`
///      / `vault_identity_bind_message(authority, agent_identity)`.
///
/// The runtime verifies the precompile signature for free at pre-execution
/// time; the on-chain handler only does the introspection comparison
/// (cheap, no in-program ed25519 verification).
///
/// **Domain separation rationale**: `VAULT_IDENTITY_BIND_DOMAIN`
/// (`b"AEP_VAULT_IDENTITY_BIND_V1\x00"`) MUST differ from the registry's
/// `MANIFEST_HASH_DOMAIN` so a captured manifest signature cannot be
/// replayed as a vault-bind signature. See the
/// `adr_124_domain_differs_from_registry_manifest_domain` test in
/// `lib.rs` for the cross-protocol replay defense pinning.
///
/// **Errors raised**:
///   - `MissingAgentIdentityBindSignature` if no neighbouring ed25519
///     precompile ix is found.
///   - `AgentIdentityBindSignatureMismatch` if the precompile ix is
///     present but its inline pubkey / signature / message bytes do not
///     match the supplied values (or the precompile data is malformed).
pub fn initialize_vault(
    ctx: Context<InitializeVault>,
    agent_identity: Pubkey,
    daily_limit_lamports: u64,
    per_tx_limit_lamports: u64,
    max_txs_per_hour: u32,
    agent_identity_signature: [u8; 64],
) -> Result<()> {
    // ADR-124: Verify proof-of-control over `agent_identity` BEFORE any
    // state mutation. Checks-effects-interactions: a rejected proof must
    // leave no vault PDA on-chain. We compute the expected bind message
    // here (cheap pure hash) and delegate the precompile-introspection
    // comparison to the vendored helper in `lib.rs`.
    let expected_message = crate::vault_identity_bind_message(
        &ctx.accounts.authority.key(),
        &agent_identity,
    );
    crate::identity_bind::verify_ed25519_precompile(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &agent_identity,
        &expected_message,
        &agent_identity_signature,
    )?;

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
    // ADR-138: monotonically-bumped on each `update_policy`. Starts at 0
    // (initial policy installed by `initialize_vault` is implicitly
    // version 0); every `ExecutionAttested` event stamps the current
    // value so a downstream auditor can pin the exact policy revision
    // in force at execution time.
    vault.policy_version = 0;
    // ADR-111: no outstanding delegation grants at vault genesis.
    vault.active_grant_count = 0;

    emit!(VaultInitialized {
        vault: ctx.accounts.vault.key(),
        agent_identity,
        authority: ctx.accounts.authority.key(),
        daily_limit: daily_limit_lamports,
        per_tx_limit: per_tx_limit_lamports,
    });

    Ok(())
}

/// OA-MED-1 (cycle-4): recover from the ADR-097 deregister/re-register ↔
/// vault `profile_nonce` desync. Re-points `vault.profile_nonce` at the
/// live Registry `OwnerNonce` (same authoritative source `initialize_vault`
/// reads). Without this, a legitimate deregister/re-register cycle bumps
/// the Registry nonce, the vault keeps the stale value, and every
/// `execute_*`/grant path re-derives a non-existent `agent_profile` PDA →
/// `AccountNotInitialized`, permanently bricking the vault with no on-chain
/// recovery.
///
/// Safety:
///   * `has_one = authority` + signer — only the vault owner can resync.
///   * `owner_nonce` is PDA-bound to `authority` under
///     `seeds::program = agent_registry::ID` (cross-account-reuse closed).
///   * Monotone: the live nonce must be `>=` the stored one. ADR-097 only
///     ever *bumps* the Registry nonce, so a lower live value means a
///     wrong/foreign account or replay — fail closed.
///   * No funds move; the spend caps / rate limits / policy are untouched.
pub fn resync_profile_nonce(ctx: Context<ResyncProfileNonce>) -> Result<()> {
    let live_nonce = ctx.accounts.owner_nonce.nonce;
    let old_nonce = ctx.accounts.vault.profile_nonce;

    require!(
        live_nonce >= old_nonce,
        VaultError::ProfileNonceNotMonotone
    );

    // No-op resync is allowed (idempotent); only emit/write on change.
    if live_nonce != old_nonce {
        let vault = &mut ctx.accounts.vault;
        vault.profile_nonce = live_nonce;

        emit!(ProfileNonceResynced {
            vault: ctx.accounts.vault.key(),
            authority: ctx.accounts.authority.key(),
            old_profile_nonce: old_nonce,
            new_profile_nonce: live_nonce,
            timestamp: Clock::get()?.unix_timestamp,
        });
    }

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
    let clock = Clock::get()?;
    let vault = &mut ctx.accounts.vault;
    vault.policy.daily_limit_lamports = daily_limit_lamports;
    vault.policy.per_tx_limit_lamports = per_tx_limit_lamports;
    vault.policy.max_txs_per_hour = max_txs_per_hour;
    // ADR-138: monotonic bump. Saturating on the u32 ceiling is a
    // never-hit branch in practice (the policy would have to be updated
    // 4 billion times) but the explicit checked arithmetic keeps the
    // protocol-wide "no silent wraparound" invariant.
    vault.policy_version = vault.policy_version.checked_add(1)
        .ok_or(VaultError::ArithmeticOverflow)?;
    let new_policy_version = vault.policy_version;
    let agent_identity = vault.agent_identity;
    let authority_key = vault.authority;
    let vault_key = ctx.accounts.vault.key();

    emit!(PolicyUpdated {
        vault: vault_key,
        daily_limit: daily_limit_lamports,
        per_tx_limit: per_tx_limit_lamports,
        max_txs_per_hour,
    });

    // ADR-138: `update_policy` carries no manifest binding (the registry
    // profile is not in the accounts list, by design — operators must
    // be able to retune limits even when the profile is mid-migration).
    // The attestation emits the zero-manifest sentinel; consumers MAY
    // join against `manifest_history` by `(authority, slot)` to recover
    // the pin if needed.
    emit!(ExecutionAttested {
        vault: vault_key,
        agent_identity,
        authority: authority_key,
        action_kind: ActionKind::PolicyUpdate,
        tool_id: TOOL_ID_ZERO,
        manifest_hash: [0u8; 32],
        policy_version: new_policy_version,
        delegation_grant: None,
        amount: 0,
        mint: None,
        recipient: None,
        slot: clock.slot,
        timestamp: clock.unix_timestamp,
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
///
/// AUD-200 / ADR-124 (cycle-3, symmetric closure of the init-leg fix):
///
/// **Threat closed at the protocol level**: pre-AUD-200, the rotation
/// handler bound `new_agent_identity` from a caller-supplied `Pubkey` with
/// NO proof-of-control — the same threat ADR-124 closed at
/// `initialize_vault` was wide open at rotation. A compromised authority
/// could wait out the 24h cooldown, rotate to an attacker-controlled key
/// (no key-control proof required), and drain the vault under spending
/// policy via the freshly-bound hot key.
///
/// **Path-(a) mechanism** (mirrors `initialize_vault` exactly):
///
///   1. The caller computes `vault_identity_bind_message(authority,
///      new_agent_identity)` (a 32-byte SHA-256 over the same
///      vault-specific domain tag used at init — see `lib.rs`).
///   2. The holder of `new_agent_identity`'s private key produces a
///      64-byte Ed25519 signature over that message.
///   3. The caller prepends an `Ed25519Program::verify` instruction to
///      the transaction with the inline pubkey / signature / message bytes.
///   4. This handler calls `identity_bind::verify_ed25519_precompile`
///      BEFORE the rate-limit check, scanning the Instructions sysvar for
///      the neighbouring ed25519-program ix and asserting its inline
///      values equal the supplied `new_agent_identity` /
///      `new_agent_identity_signature` /
///      `vault_identity_bind_message(authority, new_agent_identity)`.
///
/// The verify call runs FIRST so a rejected proof-of-control leaves vault
/// state (including `last_rotation_at`) untouched — checks-effects-
/// interactions, and importantly: a failed verify does NOT consume the 24h
/// rotation slot. The runtime verifies the precompile signature itself
/// for free at pre-execution time; the on-chain handler only does the
/// introspection comparison (cheap).
///
/// **Domain tag is identical to init's**: the same
/// `VAULT_IDENTITY_BIND_DOMAIN` byte string covers both init and rotation
/// because both surfaces are binding `(authority, agent_identity)` for
/// the *same* vault. Replay across surfaces is not a concern: an init
/// signature replayed against rotation would still require the original
/// authority's tx-signing key, and rotation only changes
/// `vault.agent_identity` (not authority), so the bound tuple matches the
/// legitimate state transition the signature was produced for.
///
/// **Errors raised** (reused from the init flow — same surface, same
/// failure modes, no new variants):
///   - `MissingAgentIdentityBindSignature` if no neighbouring ed25519
///     precompile ix is found.
///   - `AgentIdentityBindSignatureMismatch` if the precompile ix is
///     present but its inline pubkey / signature / message bytes do not
///     match the supplied values (or the precompile data is malformed).
pub fn update_agent_identity(
    ctx: Context<UpdateAgentIdentity>,
    new_agent_identity: Pubkey,
    new_agent_identity_signature: [u8; 64],
) -> Result<()> {
    /// Minimum interval between two successive `update_agent_identity`
    /// calls on the same vault (24h, expressed in seconds).
    const MIN_ROTATION_INTERVAL_SECS: i64 = 24 * 60 * 60;

    // AUD-200 / ADR-124 (symmetric): proof-of-control over the candidate
    // `new_agent_identity` runs FIRST. A rejected proof leaves vault state
    // untouched — including `last_rotation_at`, so a failed verify does
    // not burn the 24h rotation slot. Cheap pure-hash bind-message
    // construction; precompile-introspection comparison is delegated to
    // the vendored helper in `lib.rs` (same call shape as
    // `initialize_vault`).
    let expected_message = crate::vault_identity_bind_message(
        &ctx.accounts.authority.key(),
        &new_agent_identity,
    );
    crate::identity_bind::verify_ed25519_precompile(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &new_agent_identity,
        &expected_message,
        &new_agent_identity_signature,
    )?;

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
    let new_policy_version = vault.policy_version;
    let authority_key = vault.authority;
    let vault_key = ctx.accounts.vault.key();
    let slot = Clock::get()?.slot;

    emit!(AgentIdentityUpdated {
        vault: vault_key,
        old_identity,
        new_identity: new_agent_identity,
    });

    // ADR-138: identity rotation is an authority change, not a value
    // move. We attest under the NEW identity (post-rotation) because
    // that is the key authorised to sign the next instruction.
    emit!(ExecutionAttested {
        vault: vault_key,
        agent_identity: new_agent_identity,
        authority: authority_key,
        action_kind: ActionKind::IdentityRotation,
        tool_id: TOOL_ID_ZERO,
        manifest_hash: [0u8; 32],
        policy_version: new_policy_version,
        delegation_grant: None,
        amount: 0,
        mint: None,
        recipient: None,
        slot,
        timestamp: now,
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

    let vault_key = ctx.accounts.vault.key();
    let vault_ref = &ctx.accounts.vault;
    let agent_identity = vault_ref.agent_identity;
    let authority_key = vault_ref.authority;
    let policy_version = vault_ref.policy_version;
    let clock = Clock::get()?;

    emit!(AllowlistUpdated {
        vault: vault_key,
        item: token_mint,
        action: if newly_added { "token_add" } else { "token_limits_update" }.to_string(),
    });
    emit_allowlist_attestation(
        vault_key,
        agent_identity,
        authority_key,
        policy_version,
        token_mint,
        &clock,
    );

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

    let vault_key = ctx.accounts.vault.key();
    let vault_ref = &ctx.accounts.vault;
    let agent_identity = vault_ref.agent_identity;
    let authority_key = vault_ref.authority;
    let policy_version = vault_ref.policy_version;
    let clock = Clock::get()?;

    emit!(AllowlistUpdated {
        vault: vault_key,
        item: token_mint,
        action: "token_remove".to_string(),
    });
    emit_allowlist_attestation(
        vault_key,
        agent_identity,
        authority_key,
        policy_version,
        token_mint,
        &clock,
    );

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

    let vault_key = ctx.accounts.vault.key();
    let vault_ref = &ctx.accounts.vault;
    let agent_identity = vault_ref.agent_identity;
    let authority_key = vault_ref.authority;
    let policy_version = vault_ref.policy_version;
    let clock = Clock::get()?;

    emit!(AllowlistUpdated {
        vault: vault_key,
        item: program_id,
        action: "program_add".to_string(),
    });
    emit_allowlist_attestation(
        vault_key,
        agent_identity,
        authority_key,
        policy_version,
        program_id,
        &clock,
    );

    Ok(())
}

pub fn remove_program_allowlist(
    ctx: Context<ManageProgramAllowlist>,
    program_id: Pubkey,
) -> Result<()> {
    // Authority verified by has_one constraint (ADR-041)

    let vault = &mut ctx.accounts.vault;
    vault.policy.program_allowlist.retain(|&p| p != program_id);

    let vault_key = ctx.accounts.vault.key();
    let vault_ref = &ctx.accounts.vault;
    let agent_identity = vault_ref.agent_identity;
    let authority_key = vault_ref.authority;
    let policy_version = vault_ref.policy_version;
    let clock = Clock::get()?;

    emit!(AllowlistUpdated {
        vault: vault_key,
        item: program_id,
        action: "program_remove".to_string(),
    });
    emit_allowlist_attestation(
        vault_key,
        agent_identity,
        authority_key,
        policy_version,
        program_id,
        &clock,
    );

    Ok(())
}

/// ADR-138: shared attestation emitter for the four allowlist surfaces
/// (add/remove token, add/remove program). The `item` is surfaced as the
/// `mint` field on the event when present — the field is named `mint` on
/// the event for SOL/SPL-transfer consistency but carries the affected
/// pubkey here. Indexer-side, the `action_kind` discriminator tells the
/// consumer how to interpret the field.
///
/// Authority-changing surface. No value moves; `amount = 0`, no
/// `recipient`. The allowlist edits do not touch the registry profile,
/// so `manifest_hash` is the zero sentinel — operators MUST be able to
/// retune allowlists even when the profile is mid-migration.
fn emit_allowlist_attestation(
    vault: Pubkey,
    agent_identity: Pubkey,
    authority: Pubkey,
    policy_version: u32,
    item: Pubkey,
    clock: &Clock,
) {
    emit!(ExecutionAttested {
        vault,
        agent_identity,
        authority,
        action_kind: ActionKind::AllowlistManage,
        tool_id: TOOL_ID_ZERO,
        manifest_hash: [0u8; 32],
        policy_version,
        delegation_grant: None,
        amount: 0,
        mint: Some(item),
        recipient: None,
        slot: clock.slot,
        timestamp: clock.unix_timestamp,
    });
}

pub fn execute_transfer(
    ctx: Context<ExecuteTransfer>,
    amount_lamports: u64,
    tool_id_hash: [u8; 32],
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
    let vault_key = vault.key();
    let agent_identity = vault.agent_identity;
    let authority_key_attest = vault.authority;
    let policy_version = vault.policy_version;
    let manifest_hash = manifest_hash_from_profile(&ctx.accounts.agent_profile);
    let recipient_key = ctx.accounts.recipient.key();

    emit!(TransactionExecuted {
        vault: vault_key,
        recipient: recipient_key,
        amount: amount_lamports,
        timestamp: clock.unix_timestamp,
        success: true,
    });

    // ADR-138: bind the SOL transfer to (tool_id, manifest_hash,
    // policy_version, slot). Emitted AFTER the value move completes so a
    // runtime-error rollback drops the attestation alongside the
    // transfer — there can never be an attestation for a transfer that
    // did not happen.
    emit!(ExecutionAttested {
        vault: vault_key,
        agent_identity,
        authority: authority_key_attest,
        action_kind: ActionKind::Transfer,
        tool_id: tool_id_hash,
        manifest_hash,
        policy_version,
        delegation_grant: None,
        amount: amount_lamports,
        mint: None,
        recipient: Some(recipient_key),
        slot: clock.slot,
        timestamp: clock.unix_timestamp,
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
    tool_id_hash: [u8; 32],
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

    let vault_ref = &ctx.accounts.vault;
    let vault_key = vault_ref.key();
    let agent_identity = vault_ref.agent_identity;
    let authority_key_attest = vault_ref.authority;
    let policy_version = vault_ref.policy_version;
    let manifest_hash = manifest_hash_from_profile(&ctx.accounts.agent_profile);
    let mint_key = ctx.accounts.vault_token_account.mint;
    let recipient_key = ctx.accounts.recipient_token_account.key();

    emit!(TokenTransferExecuted {
        vault: vault_key,
        mint: mint_key,
        recipient: recipient_key,
        amount,
        timestamp: clock.unix_timestamp,
    });

    // ADR-138: bind the SPL transfer to (tool_id, manifest_hash,
    // policy_version, slot). Emitted AFTER the CPI returns so a
    // token-program failure rolls back both the transfer and the
    // attestation atomically.
    emit!(ExecutionAttested {
        vault: vault_key,
        agent_identity,
        authority: authority_key_attest,
        action_kind: ActionKind::TokenTransfer,
        tool_id: tool_id_hash,
        manifest_hash,
        policy_version,
        delegation_grant: None,
        amount,
        mint: Some(mint_key),
        recipient: Some(recipient_key),
        slot: clock.slot,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

pub fn pause_vault(ctx: Context<PauseVault>) -> Result<()> {
    // Authority verified by has_one constraint (ADR-041)

    let vault = &mut ctx.accounts.vault;
    vault.paused = true;

    let vault_key = ctx.accounts.vault.key();
    let vault_ref = &ctx.accounts.vault;
    let agent_identity = vault_ref.agent_identity;
    let authority_key = vault_ref.authority;
    let policy_version = vault_ref.policy_version;
    let clock = Clock::get()?;

    emit!(VaultPaused { vault: vault_key });

    // ADR-138: pause is an authority-changing action (it freezes every
    // value-moving surface) so it gets a paired attestation.
    emit!(ExecutionAttested {
        vault: vault_key,
        agent_identity,
        authority: authority_key,
        action_kind: ActionKind::PauseToggle,
        tool_id: TOOL_ID_ZERO,
        manifest_hash: [0u8; 32],
        policy_version,
        delegation_grant: None,
        amount: 0,
        mint: None,
        recipient: None,
        slot: clock.slot,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

pub fn resume_vault(ctx: Context<ResumeVault>) -> Result<()> {
    // Authority verified by has_one constraint (ADR-041)

    let vault = &mut ctx.accounts.vault;
    vault.paused = false;

    let vault_key = ctx.accounts.vault.key();
    let vault_ref = &ctx.accounts.vault;
    let agent_identity = vault_ref.agent_identity;
    let authority_key = vault_ref.authority;
    let policy_version = vault_ref.policy_version;
    let clock = Clock::get()?;

    emit!(VaultResumed { vault: vault_key });

    emit!(ExecutionAttested {
        vault: vault_key,
        agent_identity,
        authority: authority_key,
        action_kind: ActionKind::PauseToggle,
        tool_id: TOOL_ID_ZERO,
        manifest_hash: [0u8; 32],
        policy_version,
        delegation_grant: None,
        amount: 0,
        mint: None,
        recipient: None,
        slot: clock.slot,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

// ============================================================================
// ADR-111: Delegation grant handlers
// ============================================================================

/// ADR-111: Validate that a proposed `allowed_actions` bitmap contains no
/// unknown bits. New action bits MUST be appended in future revisions —
/// reusing a removed bit would silently expand the action surface of
/// historical grants.
#[inline]
pub fn validate_allowed_actions(actions: u8) -> Result<()> {
    require!(
        actions & !grant_actions::ALL_KNOWN == 0,
        VaultError::InvalidGrantParameters
    );
    Ok(())
}

/// ADR-111: Validate the bounded-vec lengths and pin per-tx cap
/// consistency at create/update time. The intent is to fail fast on
/// obviously-bad parameters before any state mutation.
fn validate_grant_caps(
    spend_cap_lamports: u64,
    token_caps: &[GrantTokenCap],
    allowed_recipients: &[Pubkey],
    vault_policy: &VaultPolicy,
    vault_token_records: &[TokenSpendRecord],
) -> Result<()> {
    require!(
        allowed_recipients.len() <= MAX_GRANT_ALLOWED_RECIPIENTS,
        VaultError::InvalidGrantParameters
    );
    require!(
        token_caps.len() <= MAX_GRANT_TOKEN_CAPS,
        VaultError::InvalidGrantParameters
    );
    // ADR-111 §"Enforcement": a grant must never authorize a single-tx
    // amount the vault itself wouldn't allow. We compare the grant's
    // lifetime cap against the vault's per-tx limit — a more permissive
    // grant would let a grantee bypass the per-tx ceiling by splitting
    // their cap across many small transfers and is intentional, but the
    // grant cap MUST NOT itself license a single transfer above per-tx.
    require!(
        spend_cap_lamports <= vault_policy.per_tx_limit_lamports
            || spend_cap_lamports == 0
            // A cap of u64::MAX paired with a daily limit of u64::MAX would
            // be permitted; the daily limit gate still enforces. We only
            // reject grants whose lifetime cap is strictly greater than
            // the vault per-tx cap when both are finite.
            || vault_policy.per_tx_limit_lamports == 0,
        VaultError::InvalidGrantParameters
    );
    // Per-mint cap consistency: each `GrantTokenCap` must correspond to
    // an allowlisted mint with configured per-tx limits on the vault,
    // and the grant cap MUST NOT exceed the vault's per-tx limit for
    // that mint (same rationale as above).
    for cap in token_caps.iter() {
        let vault_record = vault_token_records
            .iter()
            .find(|r| r.mint == cap.mint)
            .ok_or(VaultError::TokenNotConfigured)?;
        require!(
            cap.spent == 0,
            VaultError::InvalidGrantParameters
        );
        require!(
            cap.cap <= vault_record.per_tx_limit || cap.cap == 0,
            VaultError::InvalidGrantParameters
        );
    }
    Ok(())
}

/// ADR-111: `create_delegation_grant` — only vault `authority` may call.
///
/// Gates (in order, fail-fast):
///   1. Vault not paused.
///   2. Vault not suspended (ADR-095 via `agent_profile`).
///   3. `active_grant_count < MAX_ACTIVE_GRANTS_PER_VAULT`.
///   4. `allowed_actions` carries only known bits.
///   5. `allowed_recipients` and `token_spend_caps` within their bounds.
///   6. Grant lifetime caps ≤ vault per-tx caps (per-mint and SOL).
///   7. `expires_at == 0` or `expires_at > now`.
///
/// On success: writes the grant PDA, bumps `vault.active_grant_count`,
/// emits `DelegationGrantCreated`.
pub fn create_delegation_grant(
    ctx: Context<CreateDelegationGrant>,
    grantee: Pubkey,
    nonce: u8,
    allowed_actions: u8,
    spend_cap_lamports: u64,
    token_caps: Vec<GrantTokenCap>,
    allowed_recipients: Vec<Pubkey>,
    expires_at: i64,
) -> Result<()> {
    // ADR-095: suspension gate. A suspended agent must not issue new
    // grants — closing the seam where ADR-095 only covered direct
    // transfers.
    require_not_suspended(&ctx.accounts.agent_profile)?;

    let now = Clock::get()?.unix_timestamp;
    {
        let vault = &ctx.accounts.vault;
        require!(!vault.paused, VaultError::VaultPaused);
        require!(
            vault.active_grant_count < MAX_ACTIVE_GRANTS_PER_VAULT,
            VaultError::TooManyActiveGrants
        );
        validate_allowed_actions(allowed_actions)?;
        require!(
            expires_at == 0 || expires_at > now,
            VaultError::InvalidGrantParameters
        );
        validate_grant_caps(
            spend_cap_lamports,
            &token_caps,
            &allowed_recipients,
            &vault.policy,
            &vault.token_spend_records,
        )?;
    }

    let grant_key = ctx.accounts.grant.key();
    let vault_key = ctx.accounts.vault.key();
    let authority_key = ctx.accounts.authority.key();

    {
        let grant = &mut ctx.accounts.grant;
        grant.vault = vault_key;
        grant.grantor = authority_key;
        grant.grantee = grantee;
        grant.allowed_actions = allowed_actions;
        grant.spend_cap_lamports = spend_cap_lamports;
        grant.spent_lamports = 0;
        // Force `spent = 0` on every cap regardless of caller input
        // (validate_grant_caps already rejected non-zero, but defense in
        // depth at the write site).
        grant.token_spend_caps = token_caps
            .into_iter()
            .map(|c| GrantTokenCap {
                mint: c.mint,
                cap: c.cap,
                spent: 0,
            })
            .collect();
        grant.allowed_recipients = allowed_recipients;
        grant.expires_at = expires_at;
        grant.revoked = false;
        grant.created_at = now;
        grant.nonce = nonce;
        grant.bump = ctx.bumps.grant;
    }

    let new_count = {
        let vault = &mut ctx.accounts.vault;
        vault.active_grant_count = vault.active_grant_count.saturating_add(1);
        vault.active_grant_count
    };
    // Defensive: saturating_add ceilings at u8::MAX; the bound check above
    // already enforces strict-less-than the cap. This second assert is a
    // belt-and-braces guard against a future refactor reordering the
    // checks.
    require!(
        new_count <= MAX_ACTIVE_GRANTS_PER_VAULT,
        VaultError::TooManyActiveGrants
    );

    emit!(DelegationGrantCreated {
        vault: vault_key,
        grant: grant_key,
        grantor: authority_key,
        grantee,
        allowed_actions,
        spend_cap_lamports,
        expires_at,
        nonce,
        timestamp: now,
    });

    Ok(())
}

/// ADR-111: `revoke_delegation_grant` — vault authority OR grantee may
/// revoke. Sets `revoked = true` and decrements `vault.active_grant_count`.
/// Idempotent: revoking an already-revoked grant is a no-op success so
/// off-chain clients can retry safely.
pub fn revoke_delegation_grant(ctx: Context<RevokeDelegationGrant>) -> Result<()> {
    let signer_key = ctx.accounts.signer.key();
    let grant_key = ctx.accounts.grant.key();
    let vault_key = ctx.accounts.vault.key();
    let now = Clock::get()?.unix_timestamp;

    // ADR-111 §"revoke_delegation": either grantor (vault authority at
    // create time) or grantee can revoke. The grantor pubkey is pinned
    // at create time; the current `vault.authority` is also accepted to
    // cover an authority rotation (none today, but governance reserves
    // the right). We compare the signer against BOTH and the live
    // vault.authority so the path stays correct under future rotation.
    {
        let grant = &ctx.accounts.grant;
        let vault = &ctx.accounts.vault;
        require!(
            signer_key == grant.grantee
                || signer_key == grant.grantor
                || signer_key == vault.authority,
            VaultError::Unauthorized
        );
    }

    let already_revoked = ctx.accounts.grant.revoked;
    if !already_revoked {
        let grant = &mut ctx.accounts.grant;
        grant.revoked = true;

        let vault = &mut ctx.accounts.vault;
        vault.active_grant_count = vault.active_grant_count.saturating_sub(1);
    }

    emit!(DelegationGrantRevoked {
        vault: vault_key,
        grant: grant_key,
        revoker: signer_key,
        timestamp: now,
    });

    Ok(())
}

/// ADR-111: `update_delegation_grant` — vault authority only. TIGHTEN-
/// only: every field's new value must be no looser than the stored
/// value. The invariants enforced here are:
///   - `new_allowed_actions ⊆ grant.allowed_actions` (no new bits)
///   - `new_spend_cap_lamports ≤ grant.spend_cap_lamports`
///     AND `new_spend_cap_lamports ≥ grant.spent_lamports`
///     (cap may shrink but not below already-spent)
///   - For every existing `GrantTokenCap`: `new.cap ≤ stored.cap`
///     AND `new.cap ≥ stored.spent` (and the mint must already exist;
///     adding new mints is loosening and is rejected)
///   - `new_allowed_recipients ⊆ grant.allowed_recipients`. Empty
///     `grant.allowed_recipients` is the "any recipient" sentinel; any
///     non-empty `new_allowed_recipients` from an empty stored list is
///     a TIGHTENING (delegating from vault-controls to grant-controls).
///     Conversely, going FROM a non-empty list TO empty is loosening
///     and rejected.
///   - `new_expires_at` MUST NOT extend the window. Two cases:
///       (a) stored `expires_at == 0` (no expiry) → any `new_expires_at`
///           is a tightening.
///       (b) stored `expires_at > 0`  → `new_expires_at != 0` AND
///           `new_expires_at <= grant.expires_at`.
pub fn update_delegation_grant(
    ctx: Context<UpdateDelegationGrant>,
    new_allowed_actions: u8,
    new_spend_cap_lamports: u64,
    new_token_caps: Vec<GrantTokenCap>,
    new_allowed_recipients: Vec<Pubkey>,
    new_expires_at: i64,
) -> Result<()> {
    let grant_key = ctx.accounts.grant.key();
    let vault_key = ctx.accounts.vault.key();
    let now = Clock::get()?.unix_timestamp;

    {
        let grant = &ctx.accounts.grant;
        require!(!grant.revoked, VaultError::GrantRevoked);

        // Actions: subset-only.
        validate_allowed_actions(new_allowed_actions)?;
        require!(
            new_allowed_actions & !grant.allowed_actions == 0,
            VaultError::GrantUpdateCannotLoosen
        );

        // Lamport cap: must not raise above stored, must not drop below
        // already-spent.
        require!(
            new_spend_cap_lamports <= grant.spend_cap_lamports,
            VaultError::GrantUpdateCannotLoosen
        );
        require!(
            new_spend_cap_lamports >= grant.spent_lamports,
            VaultError::GrantUpdateCannotLoosen
        );

        // Token caps: only existing mints, only tightening caps,
        // not below per-mint already-spent.
        require!(
            new_token_caps.len() <= MAX_GRANT_TOKEN_CAPS,
            VaultError::InvalidGrantParameters
        );
        for new_cap in new_token_caps.iter() {
            let stored = grant
                .token_spend_caps
                .iter()
                .find(|c| c.mint == new_cap.mint)
                .ok_or(VaultError::GrantUpdateCannotLoosen)?;
            require!(
                new_cap.cap <= stored.cap,
                VaultError::GrantUpdateCannotLoosen
            );
            require!(
                new_cap.cap >= stored.spent,
                VaultError::GrantUpdateCannotLoosen
            );
        }

        // Recipients: every new entry must already be in the stored list,
        // UNLESS the stored list is empty (the "any recipient" sentinel —
        // moving from that to a constrained set is a tightening).
        require!(
            new_allowed_recipients.len() <= MAX_GRANT_ALLOWED_RECIPIENTS,
            VaultError::InvalidGrantParameters
        );
        if !grant.allowed_recipients.is_empty() {
            for r in new_allowed_recipients.iter() {
                require!(
                    grant.allowed_recipients.contains(r),
                    VaultError::GrantUpdateCannotLoosen
                );
            }
            // Going from a non-empty list to empty is loosening (re-opens
            // the "any recipient" door).
            require!(
                !new_allowed_recipients.is_empty(),
                VaultError::GrantUpdateCannotLoosen
            );
        }

        // Expiry: must shrink, never extend. Past-tense new_expires_at
        // is permitted (it immediately expires the grant — equivalent
        // to a revoke).
        if grant.expires_at == 0 {
            // Any new_expires_at is a tightening (including 0 = no change).
        } else {
            require!(new_expires_at != 0, VaultError::GrantUpdateCannotLoosen);
            require!(
                new_expires_at <= grant.expires_at,
                VaultError::GrantUpdateCannotLoosen
            );
        }
    }

    // Apply.
    {
        let grant = &mut ctx.accounts.grant;
        grant.allowed_actions = new_allowed_actions;
        grant.spend_cap_lamports = new_spend_cap_lamports;
        // Replace token caps by mint — preserving `spent` from the stored
        // record (the per-cap `spent` field on the input is ignored).
        let mut updated: Vec<GrantTokenCap> = Vec::with_capacity(new_token_caps.len());
        for nc in new_token_caps.into_iter() {
            let stored = grant
                .token_spend_caps
                .iter()
                .find(|c| c.mint == nc.mint)
                .expect("validated above");
            updated.push(GrantTokenCap {
                mint: nc.mint,
                cap: nc.cap,
                spent: stored.spent,
            });
        }
        grant.token_spend_caps = updated;
        grant.allowed_recipients = new_allowed_recipients;
        grant.expires_at = new_expires_at;
    }

    emit!(DelegationGrantUpdated {
        vault: vault_key,
        grant: grant_key,
        new_allowed_actions,
        new_spend_cap_lamports,
        new_expires_at,
        timestamp: now,
    });

    Ok(())
}

/// ADR-111: `execute_grant_transfer` — SOL transfer signed by the
/// grantee. Applies BOTH grant-scoped and vault-scoped gates:
///   1. ADR-095 suspension gate on parent vault.
///   2. `!vault.paused`.
///   3. `!grant.revoked && grant.is_within_window(now)`.
///   4. `grant.allows(EXECUTE_TRANSFER)`.
///   5. `grant.is_recipient_allowed(recipient)`.
///   6. `amount > 0`, `amount <= grant.spend_cap_lamports - grant.spent_lamports`.
///   7. Vault per-tx limit, vault daily limit (incl. day rollover),
///      vault rate-limit window — identical semantics to direct
///      `execute_transfer`, NOT bypassed.
///   8. Rent-exempt minimum on the vault PDA post-transfer.
/// On success: lamport mutation, vault counter writes, grant `spent_lamports` bump,
/// `DelegationGrantExecuted` event.
pub fn execute_grant_transfer(
    ctx: Context<ExecuteGrantTransfer>,
    amount_lamports: u64,
) -> Result<()> {
    require!(amount_lamports > 0, VaultError::InvalidAmount);
    require_not_suspended(&ctx.accounts.agent_profile)?;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let new_daily_total;
    let new_last_spend_day;
    let new_rate_limit_window_start;
    let new_txs_in_current_window;
    let new_spent_lamports;
    {
        let vault = &ctx.accounts.vault;
        let grant = &ctx.accounts.grant;

        require!(!vault.paused, VaultError::VaultPaused);
        require!(!grant.revoked, VaultError::GrantRevoked);
        require!(grant.is_within_window(now), VaultError::GrantExpired);
        require!(
            grant.allows(grant_actions::EXECUTE_TRANSFER),
            VaultError::ActionNotAllowed
        );
        require!(
            grant.is_recipient_allowed(&ctx.accounts.recipient.key()),
            VaultError::RecipientNotAllowed
        );

        // OA-MED-2 (cycle-4): ADR-111 §Enforcement (lines 124-126) — "MUST
        // intersect `allowed_recipients` with the base vault
        // `policy.program_allowlist`; the delegation never widens the
        // vault's own allowlist." The SPL path already retains
        // `vault.policy.is_token_allowed(&mint)`
        // (`execute_grant_token_transfer`); the SOL path had NO vault-level
        // recipient/program-allowlist check, so an empty-`allowed_recipients`
        // grant (the documented "delegate the recipient guard to the vault"
        // sentinel — `state.rs` `is_recipient_allowed`) actually meant
        // "unrestricted", letting a grantee send SOL to recipients the
        // vault's own `program_allowlist` would gate on a comparable
        // direct call. When the grant defers to the vault (empty list),
        // enforce the vault's own allowlist so the sentinel genuinely means
        // "subject to the vault's own guards", never "wider than direct".
        // A non-empty grant allowlist is already the tighter, explicit
        // scope and is left as-is (intersection ≡ the explicit list, which
        // the grantor chose at create time within their own authority).
        if grant.allowed_recipients.is_empty() {
            require!(
                vault
                    .policy
                    .is_program_allowed(&ctx.accounts.recipient.key()),
                VaultError::RecipientNotAllowed
            );
        }

        // Grant-scoped lamport cap.
        require!(
            grant.spend_cap_lamports > 0,
            VaultError::GrantHasNoLamportCap
        );
        let projected = grant
            .project_spend(amount_lamports)
            .ok_or(VaultError::ArithmeticOverflow)?;
        require!(
            projected <= grant.spend_cap_lamports,
            VaultError::GrantSpendCapExceeded
        );
        new_spent_lamports = projected;

        // Vault-scoped per-tx limit (NOT bypassed).
        require!(
            amount_lamports <= vault.policy.per_tx_limit_lamports,
            VaultError::PerTxLimitExceeded
        );

        // Vault-scoped daily limit + day rollover.
        let current_day = (now / 86400) as u64;
        let mut spent = vault.spent_today_lamports;
        let mut last_day = vault.last_spend_day;
        if current_day > last_day {
            spent = 0;
            last_day = current_day;
        }
        let projected_day = spent.saturating_add(amount_lamports);
        require!(
            projected_day <= vault.policy.daily_limit_lamports,
            VaultError::DailyLimitExceeded
        );
        new_daily_total = projected_day;
        new_last_spend_day = last_day;

        // Vault-scoped rate-limit window.
        let elapsed = compute_window_elapsed(now, vault.rate_limit_window_start);
        let (window_start, mut txs) = if elapsed > 3600 {
            (now, 0u32)
        } else {
            (vault.rate_limit_window_start, vault.txs_in_current_window)
        };
        require!(txs < vault.policy.max_txs_per_hour, VaultError::RateLimitExceeded);
        txs = txs.saturating_add(1);
        new_rate_limit_window_start = window_start;
        new_txs_in_current_window = txs;
    }

    // Rent / lamport move.
    let vault_info = ctx.accounts.vault.to_account_info();
    let recipient_info = ctx.accounts.recipient.to_account_info();
    let rent_minimum = Rent::get()?.minimum_balance(vault_info.data_len());
    let post_balance = vault_info
        .lamports()
        .checked_sub(amount_lamports)
        .ok_or(VaultError::InsufficientFunds)?;
    require!(post_balance >= rent_minimum, VaultError::BelowRentExemption);
    **vault_info.try_borrow_mut_lamports()? = post_balance;
    **recipient_info.try_borrow_mut_lamports()? = recipient_info
        .lamports()
        .checked_add(amount_lamports)
        .ok_or(VaultError::ArithmeticOverflow)?;

    // State writes.
    {
        let vault = &mut ctx.accounts.vault;
        vault.spent_today_lamports = new_daily_total;
        vault.last_spend_day = new_last_spend_day;
        vault.rate_limit_window_start = new_rate_limit_window_start;
        vault.txs_in_current_window = new_txs_in_current_window;
    }
    {
        let grant = &mut ctx.accounts.grant;
        grant.spent_lamports = new_spent_lamports;
    }

    emit!(DelegationGrantExecuted {
        vault: ctx.accounts.vault.key(),
        grant: ctx.accounts.grant.key(),
        grantee: ctx.accounts.grantee.key(),
        action_kind: grant_actions::EXECUTE_TRANSFER,
        // Convention: Pubkey::default() represents native SOL.
        mint: Pubkey::default(),
        recipient: ctx.accounts.recipient.key(),
        amount: amount_lamports,
        spent_after: new_spent_lamports,
        timestamp: now,
    });

    // OA-HIGH-1 (cycle-4): ADR-138 mandates an `ExecutionAttested` provenance
    // event at the end of *every* value-moving instruction. The ADR-111 grant
    // SOL-transfer path moves real lamports signed by a sub-authority hot key
    // yet previously emitted only `DelegationGrantExecuted` (a separate schema
    // the ADR-138 provenance pipeline does NOT consume). Grant-authorised
    // drains were therefore invisible to every `ExecutionAttested`-keyed
    // detector / SAS correlation / reputation cross-check. Emit it here, AFTER
    // the lamport move (mirroring `execute_transfer`:733 ordering) so a
    // runtime-error rollback atomically drops the attestation alongside the
    // transfer — there can never be an attestation for a move that did not
    // happen. `delegation_grant = Some(grant)` is the grant PDA the ActionKind
    // and field were reserved for (events.rs:101,146). `tool_id` uses the
    // documented `TOOL_ID_ZERO` sentinel: the grant signature is unchanged (no
    // tool_id arg) and ADR-138 explicitly permits the zero sentinel for
    // non-migrated callers (same as `pause_vault` / `update_policy`).
    let grant_vault = &ctx.accounts.vault;
    emit!(ExecutionAttested {
        vault: grant_vault.key(),
        agent_identity: grant_vault.agent_identity,
        authority: grant_vault.authority,
        action_kind: ActionKind::GrantTransfer,
        tool_id: TOOL_ID_ZERO,
        manifest_hash: manifest_hash_from_profile(&ctx.accounts.agent_profile),
        policy_version: grant_vault.policy_version,
        delegation_grant: Some(ctx.accounts.grant.key()),
        amount: amount_lamports,
        mint: None,
        recipient: Some(ctx.accounts.recipient.key()),
        slot: clock.slot,
        timestamp: now,
    });

    Ok(())
}

/// ADR-111: `execute_grant_token_transfer` — SPL transfer signed by the
/// grantee. Same dual-gating shape as `execute_grant_transfer` but
/// against per-mint caps and the vault's `token_spend_records`.
pub fn execute_grant_token_transfer(
    ctx: Context<ExecuteGrantTokenTransfer>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, VaultError::InvalidAmount);
    require_not_suspended(&ctx.accounts.agent_profile)?;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let mint = ctx.accounts.vault_token_account.mint;
    let authority_key;
    let bump;
    let new_grant_token_spent;
    let new_vault_record_spent;
    let new_vault_record_last_day;
    let resets_vault_day;
    let new_window_start;
    let new_window_count;
    let vault_record_idx;
    let grant_cap_idx;

    {
        let vault = &ctx.accounts.vault;
        let grant = &ctx.accounts.grant;
        require!(!vault.paused, VaultError::VaultPaused);
        require!(!grant.revoked, VaultError::GrantRevoked);
        require!(grant.is_within_window(now), VaultError::GrantExpired);
        require!(
            grant.allows(grant_actions::EXECUTE_TOKEN_TRANSFER),
            VaultError::ActionNotAllowed
        );
        require!(
            grant.is_recipient_allowed(&ctx.accounts.recipient_token_account.owner),
            VaultError::RecipientNotAllowed
        );
        // Vault-level allowlist still applies.
        require!(
            vault.policy.is_token_allowed(&mint),
            VaultError::TokenNotAllowed
        );

        // Grant-scoped per-mint cap lookup.
        grant_cap_idx = grant
            .token_spend_caps
            .iter()
            .position(|c| c.mint == mint)
            .ok_or(VaultError::GrantTokenNotConfigured)?;
        let grant_cap = &grant.token_spend_caps[grant_cap_idx];
        require!(grant_cap.cap > 0, VaultError::GrantHasNoLamportCap);
        let projected = grant_cap
            .spent
            .checked_add(amount)
            .ok_or(VaultError::ArithmeticOverflow)?;
        require!(
            projected <= grant_cap.cap,
            VaultError::GrantSpendCapExceeded
        );
        new_grant_token_spent = projected;

        // Vault-scoped per-mint per-tx + daily caps (NOT bypassed).
        vault_record_idx = vault
            .token_spend_records
            .iter()
            .position(|r| r.mint == mint)
            .ok_or(VaultError::TokenNotConfigured)?;
        let record = &vault.token_spend_records[vault_record_idx];
        require!(
            amount <= record.per_tx_limit,
            VaultError::PerTxTokenLimitExceeded
        );
        let current_day = (now / 86400) as u64;
        let effective_spent = if current_day > record.last_spend_day {
            0
        } else {
            record.spent_today
        };
        let projected_record = effective_spent
            .checked_add(amount)
            .ok_or(VaultError::ArithmeticOverflow)?;
        require!(
            projected_record <= record.daily_limit,
            VaultError::TokenDailyLimitExceeded
        );
        new_vault_record_spent = projected_record;
        new_vault_record_last_day = current_day;
        resets_vault_day = current_day > record.last_spend_day;

        // Vault-scoped global rate-limit window.
        let elapsed = compute_window_elapsed(now, vault.rate_limit_window_start);
        let (ws, txs) = if elapsed >= 3600 {
            (now, 0u32)
        } else {
            (vault.rate_limit_window_start, vault.txs_in_current_window)
        };
        require!(txs < vault.policy.max_txs_per_hour, VaultError::RateLimitExceeded);
        new_window_start = ws;
        new_window_count = txs.saturating_add(1);

        authority_key = vault.authority;
        bump = vault.bump;
    }

    // Apply writes.
    {
        let vault = &mut ctx.accounts.vault;
        vault.rate_limit_window_start = new_window_start;
        vault.txs_in_current_window = new_window_count;
        let record = &mut vault.token_spend_records[vault_record_idx];
        if resets_vault_day {
            record.last_spend_day = new_vault_record_last_day;
        }
        record.spent_today = new_vault_record_spent;
    }
    {
        let grant = &mut ctx.accounts.grant;
        grant.token_spend_caps[grant_cap_idx].spent = new_grant_token_spent;
    }

    // CPI transfer — vault PDA signs (same pattern as execute_token_transfer).
    let signer_seeds: &[&[u8]] = &[b"vault", authority_key.as_ref(), &[bump]];
    let cpi = Transfer {
        from: ctx.accounts.vault_token_account.to_account_info(),
        to: ctx.accounts.recipient_token_account.to_account_info(),
        authority: ctx.accounts.vault.to_account_info(),
    };
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi,
            &[signer_seeds],
        ),
        amount,
    )?;

    emit!(DelegationGrantExecuted {
        vault: ctx.accounts.vault.key(),
        grant: ctx.accounts.grant.key(),
        grantee: ctx.accounts.grantee.key(),
        action_kind: grant_actions::EXECUTE_TOKEN_TRANSFER,
        mint,
        recipient: ctx.accounts.recipient_token_account.key(),
        amount,
        spent_after: new_grant_token_spent,
        timestamp: now,
    });

    // OA-HIGH-1 (cycle-4): ADR-138 provenance attestation for the ADR-111 SPL
    // grant-transfer surface — symmetric with `execute_grant_transfer` above
    // and with `execute_token_transfer`:926. Emitted AFTER the SPL CPI returns
    // so a rollback drops the attestation atomically. `mint: Some(mint)` and
    // `recipient` is the recipient *token account* (matching how
    // `execute_token_transfer` reports it). `delegation_grant = Some(grant)`
    // populates the field reserved at events.rs:146 for exactly this path.
    let grant_vault = &ctx.accounts.vault;
    emit!(ExecutionAttested {
        vault: grant_vault.key(),
        agent_identity: grant_vault.agent_identity,
        authority: grant_vault.authority,
        action_kind: ActionKind::GrantTokenTransfer,
        tool_id: TOOL_ID_ZERO,
        manifest_hash: manifest_hash_from_profile(&ctx.accounts.agent_profile),
        policy_version: grant_vault.policy_version,
        delegation_grant: Some(ctx.accounts.grant.key()),
        amount,
        mint: Some(mint),
        recipient: Some(ctx.accounts.recipient_token_account.key()),
        slot: clock.slot,
        timestamp: now,
    });

    Ok(())
}
