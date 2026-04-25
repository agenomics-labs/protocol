use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use agent_registry::state::{AgentProfile, AgentStatus, OwnerNonce};

use crate::state::Vault;
use crate::errors::VaultError;

/// ADR-050 + findings #13/#14 + PR-X (AUD-023): Explicit serialized size.
/// 8 (disc) + 32 (agent_id) + 32 (authority) + 1 (paused) + 8 (spent_today) + 8 (last_day)
/// + VaultPolicy: 8+8+4+324+324=668 + 4 (txs_window) + 8 (rate_start)
/// + 4+(10*(32+8+8+8+8))=644 (token_spend_records, now carrying per-mint limits)
/// + 1 (bump) + 8 (profile_nonce, ADR-095/097)
/// + 8 (last_rotation_at, PR-X / AUD-023) = 1430 + 200 margin = 1630
///
/// AUD-008 (PR-J): The `profile_nonce` formerly arrived as a user-supplied
/// `u64` argument and was written verbatim into `vault.profile_nonce`. A
/// caller could pass a stale or wrong value and silently brick downstream
/// `agent_profile` lookups in `execute_transfer` / `execute_token_transfer`.
/// The instruction now reads the nonce from the Registry's authoritative
/// `OwnerNonce` PDA below — register-first is enforced by the seeds
/// constraint (the PDA must already exist). See
/// `docs/audits/DESIGN-DECISIONS-2026-04-25.md` AUD-008 for rationale.
#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = authority,
        space = 1630,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// AUD-008 / ADR-097: MUST exist — vault initialization requires prior
    /// agent registration. Sources `vault.profile_nonce` from the Registry's
    /// authoritative `OwnerNonce` account, eliminating the user-supplied
    /// scalar that could brick transfers.
    ///
    /// The seeds constraint `[authority.key().as_ref(), b"owner-nonce"]`
    /// under `agent_registry::ID` simultaneously:
    /// 1. Enforces existence (Anchor fails to deserialize if the account is
    ///    not initialized, surfacing `AccountNotInitialized`).
    /// 2. Closes cross-account reuse: an attacker cannot pass another
    ///    user's `OwnerNonce` account because PDA derivation is keyed on
    ///    `authority.key()`. Substituting a foreign account fails
    ///    `ConstraintSeeds`.
    ///
    /// `OwnerNonce` has only `nonce: u64`; a field-level
    /// `owner_nonce.authority == authority.key()` check is unavailable and
    /// unnecessary because the seeds derivation already binds the account
    /// to `authority`.
    #[account(
        seeds = [authority.key().as_ref(), b"owner-nonce"],
        seeds::program = agent_registry::ID,
        bump,
    )]
    pub owner_nonce: Account<'info, OwnerNonce>,

    pub system_program: Program<'info, System>,
}

/// ADR-041: All vault mutation contexts use has_one=authority for defense-in-depth.
#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
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
        has_one = authority @ VaultError::Unauthorized,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}

/// ADR-069 (SEC-2): Context for rotating `vault.agent_identity`.
///
/// `agent_identity` is a **hot key**: it is supplied by the authority at
/// `initialize_vault` with no on-chain validation, and it is one of two keys
/// (alongside `authority`) accepted as a signer for `execute_transfer` /
/// `execute_token_transfer`. Compromise of the off-chain agent-runtime key
/// bound to `agent_identity` means an attacker can drain up to the daily cap
/// indefinitely — and the human-custodied `authority` cannot revoke it
/// without this dedicated rotation path.
///
/// Rotation is deliberately unilateral: `has_one = authority` gates the
/// context with no multisig requirement. The threat model assumes `authority`
/// is the human-custodied root of trust; forcing multisig would defeat the
/// fast-rotation design goal (see ADR-069 Alternatives Considered).
#[derive(Accounts)]
pub struct UpdateAgentIdentity<'info> {
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
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
        has_one = authority @ VaultError::Unauthorized,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}

/// ADR-095: `ExecuteTransfer` now includes the `agent_profile` account from
/// the Registry program. An Anchor constraint blocks the transfer if the
/// agent's status is `Suspended` in the Registry.
///
/// The `agent_profile` PDA is derived using the same seeds as the Registry:
/// `[authority.key(), b"agent-profile", vault.profile_nonce.to_le_bytes()]`.
/// The nonce was recorded at `initialize_vault` time from the owner's
/// `OwnerNonce` account (ADR-097), ensuring the vault always points to the
/// live profile PDA, not a stale one from a prior registration cycle.
#[derive(Accounts)]
pub struct ExecuteTransfer<'info> {
    /// The vault PDA — serves as both state account and SOL source.
    /// ADR-029: Removed vestigial vault_account field; the vault PDA itself
    /// holds SOL and is used directly for lamport transfers.
    ///
    /// ADR-093: Seeds use the externally-known `authority` account key rather
    /// than `vault.authority` read from stored account data. This eliminates
    /// the self-referential pattern (needing to load the vault to find the
    /// seeds needed to find the vault). The `has_one` constraint verifies
    /// that `authority` matches `vault.authority`.
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    /// The signer must be the agent authority or the vault authority.
    pub agent: Signer<'info>,

    /// The vault authority — used as a canonical PDA seed (ADR-093).
    /// Not required to be a signer; the `agent` field carries the signature.
    /// CHECK: Verified via `has_one = authority` on the vault account.
    pub authority: UncheckedAccount<'info>,

    /// ADR-095: The agent's Registry profile. Read-only cross-program account.
    /// The constraint enforces that the agent is not suspended. The PDA seed
    /// uses `vault.profile_nonce` (recorded at `initialize_vault` time) so
    /// that the derivation matches the live profile PDA (ADR-097).
    ///
    /// CHECK: PDA derivation is validated by the seeds constraint using
    /// `authority.key()` and `vault.profile_nonce`. The suspension check
    /// is done explicitly in the instruction handler using `AgentStatus`.
    #[account(
        seeds = [
            authority.key().as_ref(),
            b"agent-profile",
            &vault.profile_nonce.to_le_bytes(),
        ],
        seeds::program = agent_registry::ID,
        bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    /// CHECK: The recipient of the SOL transfer; validated in instruction handler.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ADR-050: ExecuteProgramCall removed — see lib.rs comment.

/// ADR-095: `ExecuteTokenTransfer` now includes the `agent_profile` account
/// from the Registry program for the suspension gate (same rationale as
/// `ExecuteTransfer` above).
#[derive(Accounts)]
pub struct ExecuteTokenTransfer<'info> {
    /// ADR-093: Seeds use the externally-known `authority` account key rather
    /// than `vault.authority` read from stored account data. The `has_one`
    /// constraint verifies that `authority` matches `vault.authority`.
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    /// The signer must be the agent authority or the vault authority.
    pub agent: Signer<'info>,

    /// The vault authority — used as a canonical PDA seed (ADR-093).
    /// Not required to be a signer; the `agent` field carries the signature.
    /// CHECK: Verified via `has_one = authority` on the vault account.
    pub authority: UncheckedAccount<'info>,

    /// ADR-095: The agent's Registry profile. Read-only cross-program account.
    /// Suspension check is done in the instruction handler.
    ///
    /// CHECK: PDA derivation is validated by the seeds constraint using
    /// `authority.key()` and `vault.profile_nonce`. The suspension check
    /// is done explicitly in the instruction handler using `AgentStatus`.
    #[account(
        seeds = [
            authority.key().as_ref(),
            b"agent-profile",
            &vault.profile_nonce.to_le_bytes(),
        ],
        seeds::program = agent_registry::ID,
        bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    /// The vault's token account (source of SPL tokens). Must be owned by the vault PDA.
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key() @ VaultError::Unauthorized,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// The recipient's token account.
    ///
    /// Constraints:
    /// - Mint must match `vault_token_account.mint` (already-mitigated per
    ///   DEEP-AUDIT-2026-04-22 Audit 1 finding SEC-6 — retained as-is).
    /// - ADR-072 (SEC-6): The recipient account must NOT be the vault's own
    ///   token account (the exact same account) AND its SPL owner must not
    ///   be the vault PDA. This blocks a self-transfer loop that would
    ///   otherwise let a griefer (or a compromised `agent_identity`) burn
    ///   rate-limit slots and exhaust the hourly window during incident
    ///   response — every self-transfer is a no-op at the token-program
    ///   layer but still increments `txs_in_current_window`.
    ///
    /// Note: the recipient-mint match was already present pre-ADR-072; the
    /// recipient-owner / self-account checks are the net-new SEC-6 fix.
    #[account(
        mut,
        constraint = recipient_token_account.mint == vault_token_account.mint @ VaultError::TokenNotAllowed,
        constraint = recipient_token_account.key() != vault_token_account.key() @ VaultError::SelfTransferNotAllowed,
        constraint = recipient_token_account.owner != vault.key() @ VaultError::SelfTransferNotAllowed,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PauseVault<'info> {
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
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
        has_one = authority @ VaultError::Unauthorized,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}

/// Helper: check that the agent is not suspended. Called at the top of
/// `execute_transfer` and `execute_token_transfer`.
///
/// ADR-095: Suspension check is done in the handler (not as an Anchor
/// `constraint`) because `AgentStatus` is a non-primitive enum that requires
/// a pattern match, not a simple boolean expression.
pub fn require_not_suspended(agent_profile: &AgentProfile) -> Result<()> {
    require!(
        agent_profile.status != AgentStatus::Suspended,
        VaultError::AgentSuspended
    );
    Ok(())
}
