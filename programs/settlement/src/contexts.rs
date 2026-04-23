use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::*;
use crate::errors::*;

#[derive(Accounts)]
#[instruction(task_id: u64, total_amount: u64, description_hash: [u8; 32], deadline: i64, milestones_data: Vec<MilestoneData>, dispute_resolver: Option<Pubkey>)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    /// Finding #21: Client's canonical vault PDA, owned by the Agent Vault
    /// program. Seeds `[b"vault", client]` match `InitializeVault` in the
    /// vault program. Anchor enforces the seed constraint, so an attacker
    /// cannot substitute an unrelated Pubkey. The account need not exist
    /// (no `init`, no data read) — we only bind the stored `client_vault`
    /// address to the canonical cross-program derivation.
    ///
    /// CHECK: address is validated by the seeds + seeds::program constraint.
    #[account(
        seeds = [b"vault", client.key().as_ref()],
        bump,
        seeds::program = AGENT_VAULT_PROGRAM_ID,
    )]
    pub client_vault: UncheckedAccount<'info>,

    /// Finding #21: Provider's canonical vault PDA, owned by the Agent Vault
    /// program. Same rationale as `client_vault` — off-chain consumers (MCP,
    /// discovery, indexer) can trust the stored `provider_vault` address
    /// because the runtime enforced its derivation at escrow creation.
    ///
    /// CHECK: address is validated by the seeds + seeds::program constraint.
    #[account(
        seeds = [b"vault", provider.key().as_ref()],
        bump,
        seeds::program = AGENT_VAULT_PROGRAM_ID,
    )]
    pub provider_vault: UncheckedAccount<'info>,

    /// The provider's public key
    /// CHECK: Stored as the task provider identity. Not deserialized.
    pub provider: UncheckedAccount<'info>,

    /// Token mint (e.g., USDC)
    pub token_mint: Account<'info, Mint>,

    /// Client's token account to transfer from
    #[account(mut)]
    pub client_token_account: Account<'info, TokenAccount>,

    /// Escrow state account — dynamically sized based on milestone count.
    ///
    /// Space formula: 298 + (milestones_data.len() * 49)
    /// Fixed: 8 (disc) + 160 (5 pubkeys) + 16 (amounts) + 4 (vec prefix)
    ///   + 1 (status) + 8 (task_id) + 32 (desc_hash) + 16 (timestamps)
    ///   + 33 (dispute_resolver Option) + 9 (disputed_at Option) + 1 (bump)
    ///   + 10 (margin) = 298
    /// Per milestone: 32 (desc_hash) + 8 (amount) + 1 (status)
    ///   + 8 (grace_ends_at u64, ADR-102) = 49
    #[account(
        init,
        payer = client,
        space = 298 + (milestones_data.len() * 49),
        seeds = [b"escrow", client.key().as_ref(), provider.key().as_ref(), &task_id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, TaskEscrow>,

    /// Escrow token account (ATA of escrow PDA)
    #[account(
        init,
        payer = client,
        associated_token::mint = token_mint,
        associated_token::authority = escrow
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// Finding #19: Singleton protocol config. Read to enforce
    /// `min_escrow_amount` without a program upgrade. Must be initialized
    /// via `initialize_protocol_config` before any escrow can be created.
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AcceptTask<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(
        mut,
        has_one = provider @ SettlementError::UnauthorizedProvider,
    )]
    pub escrow: Account<'info, TaskEscrow>,
}

#[derive(Accounts)]
pub struct SubmitMilestone<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(
        mut,
        has_one = provider @ SettlementError::UnauthorizedProvider,
    )]
    pub escrow: Account<'info, TaskEscrow>,
}

#[derive(Accounts)]
pub struct ApproveMilestone<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    #[account(
        mut,
        has_one = client @ SettlementError::UnauthorizedClient,
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        constraint = escrow_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = escrow_token_account.owner == escrow.key() @ SettlementError::InvalidTokenAccount,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = provider_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = provider_token_account.owner == escrow.provider @ SettlementError::InvalidTokenAccount,
    )]
    pub provider_token_account: Account<'info, TokenAccount>,

    /// Agent Registry program for CPI reputation updates.
    /// CHECK: Validated by constraint against AGENT_REGISTRY_PROGRAM_ID.
    #[account(
        executable,
        constraint = registry_program.key() == AGENT_REGISTRY_PROGRAM_ID @ SettlementError::InvalidRegistryProgram
    )]
    pub registry_program: UncheckedAccount<'info>,

    /// CHECK: Provider's AgentProfile PDA — validated via cross-program PDA derivation.
    /// Must match seeds [escrow.provider, "agent-profile"] under the Registry program.
    #[account(
        mut,
        seeds = [escrow.provider.as_ref(), b"agent-profile"],
        bump,
        seeds::program = AGENT_REGISTRY_PROGRAM_ID
    )]
    pub provider_profile: UncheckedAccount<'info>,

    /// SEC-1 (per ADR-068, Accepted 2026-04-23): external authority anchor for the
    /// Registry's `UpdateReputation` CPI. The Registry now pins
    /// `agent_profile` via `has_one = authority` + seeds derived from
    /// `authority.key()` instead of the self-referential
    /// `agent_profile.authority`. Feeding `escrow.provider` here is the
    /// correct match: `provider_profile`'s seeds above are already pinned
    /// to `escrow.provider`, so an attacker cannot substitute a different
    /// profile.
    /// CHECK: address-constrained to `escrow.provider`.
    #[account(address = escrow.provider)]
    pub provider_authority: UncheckedAccount<'info>,

    /// Settlement authority PDA — this program's signing authority for CPI calls.
    /// The Registry program verifies this PDA as a signer with seeds::program = SETTLEMENT_PROGRAM_ID.
    /// SEC-8 (per ADR-074, Accepted 2026-04-23): `seeds::program` is already the
    /// program's own ID by default, but making it explicit blocks any
    /// future refactor from silently changing the derivation surface.
    /// CHECK: Derived from this program's ID; seeds verified by Anchor.
    #[account(
        seeds = [b"settlement_authority"],
        bump,
        seeds::program = crate::ID,
    )]
    pub settlement_authority: UncheckedAccount<'info>,

    /// Finding #19: Reads the governance-owned `reputation_delta_task_completed`.
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RejectMilestone<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    #[account(
        mut,
        has_one = client @ SettlementError::UnauthorizedClient,
    )]
    pub escrow: Account<'info, TaskEscrow>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,

    #[account(
        mut,
        constraint = escrow.client == requester.key() || escrow.provider == requester.key()
            @ SettlementError::UnauthorizedDispute,
    )]
    pub escrow: Account<'info, TaskEscrow>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(mut)]
    pub resolver: Signer<'info>,

    /// Finding #20 + SEC-7 (per ADR-073, in-flight): Authorization hoisted
    /// to account-level constraint for visibility parity with Registry's
    /// `has_one = authority` pattern. Anchor's `has_one` cannot express
    /// OR-logic against an `Option<Pubkey>`, so explicit constraints are
    /// used.
    ///
    /// SEC-7 fix: the pre-fix second branch allowed `resolver == client`
    /// when `dispute_resolver == None`, letting the client unilaterally
    /// call `resolve_dispute(client_refund = remaining, provider_refund =
    /// 0)` to drain the escrow without a neutral resolver. The A-03 guard
    /// in the handler only skipped the slashing in that case — it did not
    /// stop the token transfer. Fix: require `dispute_resolver.is_some()`
    /// (first constraint) AND `resolver == dispute_resolver.unwrap()`
    /// (second). No-resolver disputes are now forced onto
    /// `resolve_dispute_timeout`, which refunds the full remaining balance
    /// symmetrically to the client and does not slash the provider.
    #[account(
        mut,
        constraint = escrow.dispute_resolver.is_some()
            @ SettlementError::NoResolverRequiresTimeout,
        constraint = escrow.dispute_resolver.map(|r| r == resolver.key()).unwrap_or(false)
            @ SettlementError::UnauthorizedResolver,
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        constraint = escrow_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = escrow_token_account.owner == escrow.key() @ SettlementError::InvalidTokenAccount,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = client_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = client_token_account.owner == escrow.client @ SettlementError::InvalidTokenAccount,
    )]
    pub client_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = provider_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = provider_token_account.owner == escrow.provider @ SettlementError::InvalidTokenAccount,
    )]
    pub provider_token_account: Account<'info, TokenAccount>,

    /// ADR-039: Registry program for slashing reputation on dispute
    /// CHECK: Validated by constraint against AGENT_REGISTRY_PROGRAM_ID.
    #[account(
        executable,
        constraint = registry_program.key() == AGENT_REGISTRY_PROGRAM_ID @ SettlementError::InvalidRegistryProgram
    )]
    pub registry_program: UncheckedAccount<'info>,

    /// CHECK: Provider's AgentProfile PDA — validated via cross-program PDA derivation.
    /// Must match seeds [escrow.provider, "agent-profile"] under the Registry program.
    #[account(
        mut,
        seeds = [escrow.provider.as_ref(), b"agent-profile"],
        bump,
        seeds::program = AGENT_REGISTRY_PROGRAM_ID
    )]
    pub provider_profile: UncheckedAccount<'info>,

    /// SEC-1 (per ADR-068, Accepted 2026-04-23): external authority anchor for the
    /// Registry `UpdateReputation` CPI. See `ApproveMilestone` for rationale.
    /// CHECK: address-constrained to `escrow.provider`.
    #[account(address = escrow.provider)]
    pub provider_authority: UncheckedAccount<'info>,

    /// SEC-8 (per ADR-074, Accepted 2026-04-23): explicit `seeds::program = crate::ID`.
    /// CHECK: Settlement authority PDA for CPI signing.
    #[account(
        seeds = [b"settlement_authority"],
        bump,
        seeds::program = crate::ID,
    )]
    pub settlement_authority: UncheckedAccount<'info>,

    /// Finding #19: Reads the governance-owned `reputation_delta_dispute_loss`.
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub token_program: Program<'info, Token>,
}

/// ADR-030/050: Context for auto-resolving a dispute after timeout.
/// Includes registry accounts for provider reputation slashing.
#[derive(Accounts)]
pub struct ResolveDisputeTimeout<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        constraint = escrow_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = escrow_token_account.owner == escrow.key() @ SettlementError::InvalidTokenAccount,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = client_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = client_token_account.owner == escrow.client @ SettlementError::InvalidTokenAccount,
    )]
    pub client_token_account: Account<'info, TokenAccount>,

    /// ADR-050: Registry accounts for slashing on timeout
    /// CHECK: Validated by constraint.
    #[account(
        executable,
        constraint = registry_program.key() == AGENT_REGISTRY_PROGRAM_ID @ SettlementError::InvalidRegistryProgram
    )]
    pub registry_program: UncheckedAccount<'info>,

    /// CHECK: Provider's AgentProfile PDA — validated via cross-program PDA derivation.
    #[account(
        mut,
        seeds = [escrow.provider.as_ref(), b"agent-profile"],
        bump,
        seeds::program = AGENT_REGISTRY_PROGRAM_ID
    )]
    pub provider_profile: UncheckedAccount<'info>,

    /// SEC-1 (per ADR-068, Accepted 2026-04-23): external authority anchor for the
    /// Registry `UpdateReputation` CPI. See `ApproveMilestone` for rationale.
    /// CHECK: address-constrained to `escrow.provider`.
    #[account(address = escrow.provider)]
    pub provider_authority: UncheckedAccount<'info>,

    /// SEC-8 (per ADR-074, Accepted 2026-04-23): explicit `seeds::program = crate::ID`.
    /// CHECK: Settlement authority PDA for CPI signing.
    #[account(
        seeds = [b"settlement_authority"],
        bump,
        seeds::program = crate::ID,
    )]
    pub settlement_authority: UncheckedAccount<'info>,

    /// Finding #19: Reads the governance-owned `dispute_timeout_seconds`
    /// and `reputation_delta_dispute_loss` used here.
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    #[account(
        mut,
        has_one = client @ SettlementError::UnauthorizedClient,
    )]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        constraint = escrow_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = escrow_token_account.owner == escrow.key() @ SettlementError::InvalidTokenAccount,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = client_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = client_token_account.owner == escrow.client @ SettlementError::InvalidTokenAccount,
    )]
    pub client_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExpireEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub escrow: Account<'info, TaskEscrow>,

    #[account(
        mut,
        constraint = escrow_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = escrow_token_account.owner == escrow.key() @ SettlementError::InvalidTokenAccount,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = client_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = client_token_account.owner == escrow.client @ SettlementError::InvalidTokenAccount,
    )]
    pub client_token_account: Account<'info, TokenAccount>,

    /// Provider's token account for releasing earned milestone funds on expiry.
    #[account(
        mut,
        constraint = provider_token_account.mint == escrow.token_mint @ SettlementError::InvalidTokenAccount,
        constraint = provider_token_account.owner == escrow.provider @ SettlementError::InvalidTokenAccount,
    )]
    pub provider_token_account: Account<'info, TokenAccount>,

    /// ADR-050: Registry accounts for slashing on expiry with undelivered milestones
    /// CHECK: Validated by constraint.
    #[account(
        executable,
        constraint = registry_program.key() == AGENT_REGISTRY_PROGRAM_ID @ SettlementError::InvalidRegistryProgram
    )]
    pub registry_program: UncheckedAccount<'info>,

    /// CHECK: Provider's AgentProfile PDA — validated via cross-program PDA derivation.
    #[account(
        mut,
        seeds = [escrow.provider.as_ref(), b"agent-profile"],
        bump,
        seeds::program = AGENT_REGISTRY_PROGRAM_ID
    )]
    pub provider_profile: UncheckedAccount<'info>,

    /// SEC-1 (per ADR-068, Accepted 2026-04-23): external authority anchor for the
    /// Registry `UpdateReputation` CPI. See `ApproveMilestone` for rationale.
    /// CHECK: address-constrained to `escrow.provider`.
    #[account(address = escrow.provider)]
    pub provider_authority: UncheckedAccount<'info>,

    /// SEC-8 (per ADR-074, Accepted 2026-04-23): explicit `seeds::program = crate::ID`.
    /// CHECK: Settlement authority PDA for CPI signing.
    #[account(
        seeds = [b"settlement_authority"],
        bump,
        seeds::program = crate::ID,
    )]
    pub settlement_authority: UncheckedAccount<'info>,

    /// Finding #19: Reads the governance-owned
    /// `reputation_delta_expiry_undelivered` when an expiry slashes.
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub token_program: Program<'info, Token>,
}

/// Finding #19: One-shot context to create the singleton `ProtocolConfig`
/// PDA. Any key may pay for initialization — `authority` is set to the
/// `payer`. After this, only `UpdateProtocolConfig` can mutate the fields.
#[derive(Accounts)]
pub struct InitializeProtocolConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = ProtocolConfig::SPACE,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub system_program: Program<'info, System>,
}

/// Finding #19: Authority-gated update. `has_one = authority` enforces the
/// constraint at the account-deserialization layer, not the handler.
#[derive(Accounts)]
pub struct UpdateProtocolConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ SettlementError::UnauthorizedConfigAuthority,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

/// Close a terminal-state escrow account and reclaim rent to the client.
#[derive(Accounts)]
pub struct CloseEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    #[account(
        mut,
        has_one = client @ SettlementError::UnauthorizedClient,
        close = client,
        constraint = escrow.status == EscrowStatus::Completed
            || escrow.status == EscrowStatus::Cancelled
            || escrow.status == EscrowStatus::Expired
            @ SettlementError::InvalidStatus
    )]
    pub escrow: Account<'info, TaskEscrow>,
}
