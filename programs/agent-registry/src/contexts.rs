use anchor_lang::prelude::*;
use crate::state::{AgentProfile, OwnerNonce, AGENT_VAULT_PROGRAM_ID, MIGRATION_HEADROOM, SETTLEMENT_PROGRAM_ID};
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
        // ADR-040 / ADR-060 / ADR-096 / ADR-097: explicit serialized size.
        // Baseline 1243 + 162 bytes (ADR-060 manifest fields) + 1 byte
        // (ADR-096 version field) + 8 bytes (ADR-097 registration_nonce u64)
        // = 1414 bytes (AgentProfile::SPACE). MIGRATION_HEADROOM (64) is
        // reserved for the next 2-3 field additions; accounts begin with the
        // headroom so future `migrate_agent_profile` calls can avoid a realloc.
        // Keep this in lockstep with `AgentProfile::SPACE`.
        space = 8 + AgentProfile::SPACE + MIGRATION_HEADROOM,
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

// AUD-001 / AUD-002 (PR-G): the legacy `UpdateReputation` context has been
// removed. All reputation mutations now flow through `ProposeReputationDelta`
// (defined later in this file), which owns the unified policy: i16 delta,
// [0, 100] clamp, |delta| <= MAX_DELTA_PER_CALL, and the cross-account-reuse
// guard. See docs/audits/DESIGN-DECISIONS-2026-04-25.md (AUD-001 + AUD-002)
// — the "Option A — remove, no escape hatch" path was chosen explicitly over
// a deprecation alias.

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

/// ADR-094 / AUD-001 / AUD-002: Context for `propose_reputation_delta` — the
/// new trust-hierarchy entry point for reputation updates. Settlement (and
/// any future authorized caller) proposes a signed delta; Registry validates
/// and applies it.
///
/// Authorization (three independent layers, all of which must hold):
///   1. `settlement_authority` is a PDA derived under `SETTLEMENT_PROGRAM_ID`
///      and `signer`-checked, so the call must originate from Settlement via
///      `invoke_signed` (SEC-1 pattern, ADR-068).
///   2. `owner_nonce` is the per-owner nonce PDA (ADR-097) seeded by
///      `[authority.key().as_ref(), b"owner-nonce"]` under this program. The
///      seeds constraint binds the account address to `authority.key()`,
///      providing the cross-account-reuse guard — Bob cannot pass Alice's
///      `OwnerNonce` because the seeds-derived PDA address would not match.
///   3. `agent_profile` is seeded by
///      `[authority.key().as_ref(), b"agent-profile", &owner_nonce.nonce.to_le_bytes()]`
///      and `has_one = authority`. Combined with the seeds, this enforces
///      `agent_profile.authority == authority.key()` AND that the PDA was
///      derived from the *current* nonce — closing the cross-account-reuse
///      hole AUD-001 reported.
///
/// AUD-002: this is now the SOLE reputation-mutation entry point. The legacy
/// `update_reputation` instruction was removed in PR-G; Settlement CPIs land
/// here exclusively.
#[derive(Accounts)]
pub struct ProposeReputationDelta<'info> {
    /// ADR-097: Read-only nonce account. Seeded by
    /// `[authority.key().as_ref(), b"owner-nonce"]`. The seeds constraint
    /// binds the account address to `authority.key()`, providing the
    /// cross-account-reuse guard called for in AUD-001.
    #[account(
        seeds = [authority.key().as_ref(), b"owner-nonce"],
        bump,
    )]
    pub owner_nonce: Account<'info, OwnerNonce>,

    #[account(
        mut,
        has_one = authority @ AgentRegistryError::UnauthorizedCaller,
        seeds = [
            authority.key().as_ref(),
            b"agent-profile",
            &owner_nonce.nonce.to_le_bytes(),
        ],
        bump = agent_profile.bump,
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    /// CHECK: Settlement authority PDA — must sign via invoke_signed.
    /// seeds::program ensures this PDA was derived by the Settlement program,
    /// proving the call originated there (SEC-1 pattern from ADR-068).
    #[account(
        signer,
        seeds = [b"settlement_authority"],
        bump,
        seeds::program = SETTLEMENT_PROGRAM_ID
    )]
    pub settlement_authority: UncheckedAccount<'info>,

    /// CHECK: The agent whose reputation is being updated. Used as the
    /// external seed anchor for `owner_nonce` and `agent_profile`, and
    /// constrained equal to `agent_profile.authority` via
    /// `has_one = authority`. Not deserialized; only `.key()` is read.
    pub authority: UncheckedAccount<'info>,
}

/// AUD-001 / AUD-002: Context for `verify_protocol_invariants` — the
/// post-migration sweep instruction. Iterates `remaining_accounts`,
/// deserializes each as `AgentProfile`, and runs `assert_valid_profile`.
/// Any violation reverts the transaction.
///
/// Authorization gates to the existing `ProtocolConfig.authority` (Settlement
/// program) — keeps cross-program coupling minimal (per design-decisions
/// AUD-001/002 §6, "Choose the latter for less coupling"). The handler
/// validates the signer matches the deserialized authority field of the
/// passed `protocol_config` account.
#[derive(Accounts)]
pub struct VerifyProtocolInvariants<'info> {
    pub authority: Signer<'info>,

    /// CHECK: Read-only `ProtocolConfig` PDA from the Settlement program.
    /// Address is bound by `seeds::program = SETTLEMENT_PROGRAM_ID`. We accept
    /// it as `UncheckedAccount` to avoid pulling in a Settlement crate
    /// dependency; the handler reads the `authority: Pubkey` field at the
    /// known offset (8 disc bytes) and asserts it equals the signer.
    #[account(
        seeds = [b"protocol_config"],
        bump,
        seeds::program = SETTLEMENT_PROGRAM_ID,
    )]
    pub protocol_config: UncheckedAccount<'info>,
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

/// ADR-096: Context for `migrate_agent_profile`.
///
/// Resizes an existing `AgentProfile` to the current canonical size
/// (`8 + AgentProfile::SPACE + MIGRATION_HEADROOM`) using Anchor's
/// `realloc` constraint. New bytes are zero-initialized via
/// `realloc::zero = true`, which ensures any new fields added in a
/// future upgrade have a valid default state without explicit writes.
///
/// Only the account's `owner` (authority) may trigger migration; this
/// prevents an adversary from resizing arbitrary accounts and draining
/// the `owner` payer. The instruction is idempotent — calling it when
/// the account is already the right size or when `version` already
/// meets `target_version` is a safe no-op.
#[derive(Accounts)]
pub struct MigrateAgentProfile<'info> {
    /// The authority that owns this `AgentProfile`. Named `owner` here to
    /// keep the signer semantics distinct from the `authority` field name
    /// used in `ProposeReputationDelta` (where `authority` is an
    /// UncheckedAccount).
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        // Explicit constraint: agent_profile.authority must equal owner.key().
        // Using `constraint` (rather than `has_one = authority`) avoids
        // ambiguity when the signer field is named `owner` but the stored
        // field is `authority`.
        constraint = agent_profile.authority == owner.key() @ AgentRegistryError::UnauthorizedCaller,
        seeds = [owner.key().as_ref(), b"agent-profile"],
        bump = agent_profile.bump,
        realloc = 8 + AgentProfile::SPACE + MIGRATION_HEADROOM,
        realloc::payer = owner,
        realloc::zero = true,
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    pub system_program: Program<'info, System>,
}
