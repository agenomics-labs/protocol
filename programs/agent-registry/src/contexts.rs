use anchor_lang::prelude::*;
use crate::state::{AgentProfile, OwnerNonce, AGENT_VAULT_PROGRAM_ID, SETTLEMENT_PROGRAM_ID};
use crate::errors::AgentRegistryError;

/// ADR-097: `RegisterAgent` now includes the `owner_nonce` account.
///
/// `owner_nonce` is initialized on the first registration (via
/// `init_if_needed`) so callers do not need a separate "create nonce" step.
/// The current `nonce` value is consumed as the third PDA seed for
/// `agent_profile`, preventing Sybil address reuse after close-then-reopen.
#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// ADR-097: Per-owner nonce counter. `init_if_needed` creates it on
    /// the first registration; subsequent registrations (after a deregister)
    /// find it already initialized with an incremented `nonce` value.
    ///
    /// Space: 8 (discriminator) + 8 (nonce u64) = 16 bytes.
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + 8,
        seeds = [authority.key().as_ref(), b"owner-nonce"],
        bump
    )]
    pub owner_nonce: Account<'info, OwnerNonce>,

    #[account(
        init,
        payer = authority,
        // ADR-040 / ADR-060 / ADR-097: explicit serialized size.
        // Baseline 1243 + 162 bytes (ADR-060 manifest fields) +
        // 8 bytes (ADR-097 registration_nonce u64) = 1413 bytes.
        // Keep this in lockstep with `AgentProfile::SPACE`.
        space = AgentProfile::SPACE,
        seeds = [authority.key().as_ref(), b"agent-profile", &owner_nonce.nonce.to_le_bytes()],
        bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    /// Finding #9: The agent's canonical vault PDA, owned by the Agent Vault
    /// program. Seeds `[b"vault", authority]` match `InitializeVault` in the
    /// vault program. Anchor enforces the seed constraint at deserialization,
    /// so an attacker cannot substitute an unrelated Pubkey. The account is
    /// passed as `UncheckedAccount` because the registry doesn't need to read
    /// its state — it only needs the runtime to prove the address is the
    /// correct cross-program derivation.
    ///
    /// CHECK: address is validated by the seeds + seeds::program constraint.
    /// The vault does not need to exist (initialize_vault may run later or
    /// never); we only bind the stored vault_address to the canonical PDA.
    #[account(
        seeds = [b"vault", authority.key().as_ref()],
        bump,
        seeds::program = AGENT_VAULT_PROGRAM_ID,
    )]
    pub vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// ADR-097: `UpdateProfile` includes `owner_nonce` to re-derive the profile
/// PDA with the nonce component.
#[derive(Accounts)]
pub struct UpdateProfile<'info> {
    pub authority: Signer<'info>,

    /// ADR-097: Read-only nonce account. Provides the nonce component for the
    /// `agent_profile` PDA seed derivation.
    #[account(
        seeds = [authority.key().as_ref(), b"owner-nonce"],
        bump
    )]
    pub owner_nonce: Account<'info, OwnerNonce>,

    #[account(
        mut,
        has_one = authority,
        seeds = [authority.key().as_ref(), b"agent-profile", &owner_nonce.nonce.to_le_bytes()],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,
}

/// ADR-097: `UpdateStatus` includes `owner_nonce` for PDA derivation.
#[derive(Accounts)]
pub struct UpdateStatus<'info> {
    pub authority: Signer<'info>,

    /// ADR-097: Read-only nonce account for `agent_profile` PDA seed.
    #[account(
        seeds = [authority.key().as_ref(), b"owner-nonce"],
        bump
    )]
    pub owner_nonce: Account<'info, OwnerNonce>,

    #[account(
        mut,
        has_one = authority,
        seeds = [authority.key().as_ref(), b"agent-profile", &owner_nonce.nonce.to_le_bytes()],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,
}

/// SEC-1 (per ADR-068, Accepted 2026-04-23): the `UpdateReputation` context pins the
/// target `agent_profile` to an externally-supplied `authority` account. The
/// pre-fix version derived the PDA from `agent_profile.authority.as_ref()`
/// — a self-reference that let Anchor "validate" the seed against the very
/// field stored inside the account it was meant to be checking, which is no
/// check at all. Any well-formed `AgentProfile` would pass.
///
/// The fix has two layers:
///   1. `authority` is now an `UncheckedAccount` whose `.key()` seeds the
///      PDA derivation, so the seed anchor is outside the account being
///      validated.
///   2. `has_one = authority` enforces `agent_profile.authority ==
///      authority.key()` at account-deserialization time.
///
/// Both checks must pass simultaneously, so a caller can only update the
/// profile whose stored `authority` matches the PDA derivation — the exact
/// invariant the old code pretended to enforce. The Settlement CPI layer
/// supplies `authority = escrow.provider`, which is already enforced equal
/// to the seed of `provider_profile` on the Settlement side (belt-and-
/// braces across programs).
///
/// ADR-097: `owner_nonce` is included to re-derive the PDA with the nonce
/// component. Settlement CPI callers must also pass this account.
#[derive(Accounts)]
pub struct UpdateReputation<'info> {
    /// CHECK: The authority whose profile is being updated. Used as the
    /// external seed anchor for `agent_profile` and constrained equal to
    /// `agent_profile.authority` via `has_one = authority`.
    pub authority: UncheckedAccount<'info>,

    /// ADR-097: Read-only nonce account for `agent_profile` PDA seed.
    /// Seeded by `[authority.key(), b"owner-nonce"]`.
    #[account(
        seeds = [authority.key().as_ref(), b"owner-nonce"],
        bump
    )]
    pub owner_nonce: Account<'info, OwnerNonce>,

    #[account(
        mut,
        has_one = authority @ AgentRegistryError::UnauthorizedCaller,
        seeds = [authority.key().as_ref(), b"agent-profile", &owner_nonce.nonce.to_le_bytes()],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    /// CHECK: Settlement authority PDA — must sign via invoke_signed.
    #[account(
        signer,
        seeds = [b"settlement_authority"],
        bump,
        seeds::program = SETTLEMENT_PROGRAM_ID
    )]
    pub settlement_authority: UncheckedAccount<'info>,
}

/// ADR-097: `StakeReputation` includes `owner_nonce` for PDA derivation.
#[derive(Accounts)]
pub struct StakeReputation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// ADR-097: Read-only nonce account for `agent_profile` PDA seed.
    #[account(
        seeds = [authority.key().as_ref(), b"owner-nonce"],
        bump
    )]
    pub owner_nonce: Account<'info, OwnerNonce>,

    #[account(
        mut,
        has_one = authority,
        seeds = [authority.key().as_ref(), b"agent-profile", &owner_nonce.nonce.to_le_bytes()],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    /// CHECK: Staking PDA; validated by seeds. Not initialized with `init` —
    /// the system program transfer implicitly creates it. Minimum stake must
    /// exceed rent exemption (~0.00089 SOL) to avoid garbage collection.
    #[account(
        mut,
        seeds = [authority.key().as_ref(), b"reputation-stake"],
        bump
    )]
    pub staking_pda: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// ADR-097: `UnstakeReputation` includes `owner_nonce` for PDA derivation.
#[derive(Accounts)]
pub struct UnstakeReputation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// ADR-097: Read-only nonce account for `agent_profile` PDA seed.
    #[account(
        seeds = [authority.key().as_ref(), b"owner-nonce"],
        bump
    )]
    pub owner_nonce: Account<'info, OwnerNonce>,

    #[account(
        mut,
        has_one = authority,
        seeds = [authority.key().as_ref(), b"agent-profile", &owner_nonce.nonce.to_le_bytes()],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    /// CHECK: Staking PDA; validated by seeds. System-owned 0-byte account.
    /// C4: Withdrawals use `invoke_signed(system_program::transfer)` with
    /// these seeds as the signer. Direct lamport manipulation is illegal
    /// here because the account is owned by the System Program, not this
    /// program — only the owner can subtract lamports.
    #[account(
        mut,
        seeds = [authority.key().as_ref(), b"reputation-stake"],
        bump
    )]
    pub staking_pda: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// C5: Context for `clear_suspension` — the governance-style appeal path
/// that breaks the permanent-suspension trap. The authority self-signs
/// but pays with half their reputation score. After clearing, the agent
/// is moved to `Paused` (not `Active`) so re-activation is deliberate.
///
/// ADR-097: `owner_nonce` included for PDA derivation.
#[derive(Accounts)]
pub struct ClearSuspension<'info> {
    pub authority: Signer<'info>,

    /// ADR-097: Read-only nonce account for `agent_profile` PDA seed.
    #[account(
        seeds = [authority.key().as_ref(), b"owner-nonce"],
        bump
    )]
    pub owner_nonce: Account<'info, OwnerNonce>,

    #[account(
        mut,
        has_one = authority,
        seeds = [authority.key().as_ref(), b"agent-profile", &owner_nonce.nonce.to_le_bytes()],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,
}

/// ADR-097: `DeregisterAgent` closes `agent_profile` and increments
/// `owner_nonce.nonce` so the next registration uses a different PDA address.
/// The `owner_nonce` account is mutable because the handler increments it.
#[derive(Accounts)]
pub struct DeregisterAgent<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// ADR-097: Mutable nonce account. The handler increments `nonce` after
    /// closing the profile, ensuring the next `register_agent` produces a
    /// different PDA address.
    #[account(
        mut,
        seeds = [authority.key().as_ref(), b"owner-nonce"],
        bump
    )]
    pub owner_nonce: Account<'info, OwnerNonce>,

    #[account(
        mut,
        has_one = authority,
        close = authority,
        seeds = [authority.key().as_ref(), b"agent-profile", &owner_nonce.nonce.to_le_bytes()],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,
}

/// ADR-060: Publish or rotate the off-chain capability manifest pointer.
///
/// The `authority` signer constraint guarantees that only the registered
/// agent can mutate its own manifest fields. The context exposes the
/// Instructions sysvar so the handler can verify the paired
/// ed25519-precompile signature-verification instruction appears in the
/// same transaction (standard Solana pattern for Ed25519 verification —
/// in-program verification is prohibitively expensive in compute units).
///
/// ADR-097: `owner_nonce` included for PDA derivation.
#[derive(Accounts)]
pub struct UpdateManifest<'info> {
    pub authority: Signer<'info>,

    /// ADR-097: Read-only nonce account for `agent_profile` PDA seed.
    #[account(
        seeds = [authority.key().as_ref(), b"owner-nonce"],
        bump
    )]
    pub owner_nonce: Account<'info, OwnerNonce>,

    #[account(
        mut,
        has_one = authority,
        seeds = [authority.key().as_ref(), b"agent-profile", &owner_nonce.nonce.to_le_bytes()],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    /// CHECK: Instructions sysvar — read-only, address checked against the
    /// canonical sysvar pubkey. Used to locate the paired ed25519-program
    /// sig-verify instruction in the current transaction.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}
