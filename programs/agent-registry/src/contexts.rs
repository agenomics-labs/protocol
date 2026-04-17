use anchor_lang::prelude::*;
use crate::state::{AgentProfile, SETTLEMENT_PROGRAM_ID};

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 1243, // ADR-040: explicit serialized size
        seeds = [authority.key().as_ref(), b"agent-profile"],
        bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateProfile<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        seeds = [authority.key().as_ref(), b"agent-profile"],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,
}

#[derive(Accounts)]
pub struct UpdateStatus<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        seeds = [authority.key().as_ref(), b"agent-profile"],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,
}

#[derive(Accounts)]
pub struct UpdateReputation<'info> {
    #[account(
        mut,
        seeds = [agent_profile.authority.as_ref(), b"agent-profile"],
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

#[derive(Accounts)]
pub struct StakeReputation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        seeds = [authority.key().as_ref(), b"agent-profile"],
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

#[derive(Accounts)]
pub struct UnstakeReputation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        seeds = [authority.key().as_ref(), b"agent-profile"],
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
#[derive(Accounts)]
pub struct ClearSuspension<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        seeds = [authority.key().as_ref(), b"agent-profile"],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,
}

#[derive(Accounts)]
pub struct DeregisterAgent<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        close = authority,
        seeds = [authority.key().as_ref(), b"agent-profile"],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,
}
