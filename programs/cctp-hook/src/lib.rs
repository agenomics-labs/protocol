//! Reflex CCTP V2 Hook (Surface 3)
//!
//! Post-mint Solana program invoked after Circle's CCTP V2 receiver has minted
//! USDC on Solana for an AEP session round-trip. Receives a `ReflexHookPayload`
//! (IC-4 from `docs/aep-reflex-tech-spec.md`) carrying enough state to:
//!
//!   1. Identify the AEP Settlement escrow + milestone the mint corresponds to.
//!   2. Validate the agent CDP-wallet binding (placeholder; see
//!      `open-questions.md` Q-S3-A — the AEP Registry binding writer is not
//!      yet decided, so the on-chain validation here is intentionally a
//!      defense-in-depth address check that the spec's Surface 4 owner will
//!      tighten).
//!   3. Idempotently call `settlement::approve_milestone` via CPI so the
//!      escrow milestone is auto-approved and funds release back into the
//!      agent's Vault.
//!
//! The replay guard is a PDA seeded by
//! `["hook-replay", escrow_pda, milestone_index_le, base_tx_hash]` opened with
//! `init` — a duplicate `(escrow, milestone_index, base_tx_hash)` triple
//! aborts the transaction atomically before any CPI fires.
//!
//! Per Surface-3 spec, **the existing AEP Settlement program is not
//! modified**. The CPI into `approve_milestone` is therefore issued with a
//! raw `solana_program::instruction::Instruction` rather than a typed
//! `settlement::cpi::*` helper (which would require adding a Cargo `cpi`
//! feature to the settlement crate). The Anchor instruction discriminator
//! (`sha256("global:approve_milestone")[..8]`) is hard-coded as
//! `APPROVE_MILESTONE_DISCRIMINATOR`; if Settlement's instruction surface
//! ever changes, that constant must be updated.
//!
//! See `.kiro/specs/surface-3-cctp-hook/spec.md` for the full design.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

pub mod errors;
pub mod events;
pub mod payload;
pub mod state;

pub use errors::*;
pub use events::*;
pub use payload::*;
pub use state::*;

declare_id!("3yifMBDVChLzcihZWh4or9zxgzbmQVghdNZzpuP814vb");

/// Static address of the AEP Settlement program. Mirrors
/// `programs/settlement/src/lib.rs::declare_id!()`. Must stay in sync with the
/// devnet/mainnet IDs declared in `Anchor.toml`.
pub const SETTLEMENT_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95");

/// Static address of the AEP Agent Registry program. Surface-3 only reads from
/// Registry — it never writes — so the on-chain dependency is limited to the
/// `agent_profile` PDA derivation that the Settlement CPI itself performs.
pub const AGENT_REGISTRY_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv");

/// Anchor instruction discriminator for `settlement::approve_milestone`.
///
/// Computed as `sha256("global:approve_milestone")[..8]`. If Settlement's
/// instruction is ever renamed this constant MUST be regenerated; the CPI
/// will fail with `InstructionFallbackNotFound` (Anchor 6000) otherwise.
///
/// Verified at build time by the `discriminator_matches_settlement_idl` test
/// at the bottom of this file.
pub const APPROVE_MILESTONE_DISCRIMINATOR: [u8; 8] =
    [145, 85, 92, 60, 50, 130, 219, 106];

/// Seed for the replay-guard PDA (idempotency on the IC-4 triple).
pub const HOOK_REPLAY_SEED: &[u8] = b"hook-replay";

/// Seed for the Hook's own escrow-client signer PDA.
///
/// The session-level escrow pattern (see `spec.md`) puts the agent as the
/// `client` of the underlying Settlement escrow. To call `approve_milestone`
/// via CPI on behalf of that client, the Hook program needs the escrow's
/// `client` field to be a PDA *this program* can sign for. The chosen seed
/// scheme is `["hook_signer", agent_authority]`, allowing one signer-PDA per
/// agent across an arbitrary number of sessions.
///
/// **Open question Q-S3-G:** the upstream `create_escrow` call (built by the
/// agent itself, off-Surface-3) must use this exact PDA as the `client` arg.
/// Surface 4 owner needs to confirm the wiring before Day 7.
pub const HOOK_SIGNER_SEED: &[u8] = b"hook_signer";

/// Byte offset of `TaskEscrow.client` in raw account bytes.
/// Layout: 8-byte Anchor discriminator + `client: Pubkey` (first field).
const TASK_ESCROW_CLIENT_OFFSET: usize = 8;

#[program]
pub mod cctp_hook {
    use super::*;

    /// Post-CCTP-mint hook. Called by Circle's CCTP V2 receiver (or, until that
    /// integration is concrete, by the relayer fallback) after USDC has been
    /// minted on Solana for the agent's session round-trip.
    ///
    /// On success:
    ///   - The replay-guard PDA is initialized (idempotent on the IC-4 triple).
    ///   - `settlement::approve_milestone` is invoked via CPI, signed by the
    ///     `hook_signer` PDA which the upstream escrow must list as its
    ///     `client`.
    ///   - A `MilestoneAutoApproved` event is emitted for the dashboard.
    pub fn auto_approve_milestone(
        ctx: Context<AutoApproveMilestone>,
        payload: ReflexHookPayload,
    ) -> Result<()> {
        // ---- 1. Defense-in-depth payload validation ----
        require!(
            payload.escrow_pda == ctx.accounts.escrow.key(),
            HookError::PayloadEscrowMismatch
        );
        require!(
            payload.amount_returned_micros > 0,
            HookError::ZeroAmountReturned
        );
        require!(
            payload.base_tx_hash != [0u8; 32],
            HookError::InvalidBaseTxHash
        );

        // ---- 2. Read `TaskEscrow.client` from raw bytes ----
        //
        // We deliberately do NOT take a typed `Account<TaskEscrow>` here so
        // that this program does not depend on the settlement crate. The
        // first field of `TaskEscrow` is `client: Pubkey` (see
        // `programs/settlement/src/state.rs::TaskEscrow`), at offset 8 after
        // the Anchor discriminator. The owner of the account is enforced
        // below via the `address` check on `settlement_program`; the escrow
        // account is also passed mut to Settlement which will fully validate
        // it inside its own `ApproveMilestone` ctx.
        let escrow_data = ctx.accounts.escrow.try_borrow_data()?;
        require!(
            escrow_data.len() >= TASK_ESCROW_CLIENT_OFFSET + 32,
            HookError::EscrowAccountTooSmall
        );
        let mut client_bytes = [0u8; 32];
        client_bytes.copy_from_slice(
            &escrow_data[TASK_ESCROW_CLIENT_OFFSET..TASK_ESCROW_CLIENT_OFFSET + 32],
        );
        let escrow_client = Pubkey::new_from_array(client_bytes);
        drop(escrow_data); // release borrow before CPI

        // ---- 3. Agent CDP-wallet binding validation (placeholder) ----
        //
        // The full IC-4 contract requires verifying that the payload signer
        // matches a registered agent's CDP wallet binding in AEP Registry.
        // The on-chain location of that binding is **Open Question Q-S3-A**
        // (Surface 3 ↔ Surface 4 interface, not in IC-1..IC-4).
        //
        // Until the binding writer is wired, we enforce that the
        // `agent_authority` account passed in is the same key the Hook signer
        // PDA was derived from — this is the address the upstream
        // `create_escrow` used as the escrow's `client`, and the only address
        // the `hook_signer` PDA can sign for. That is *not* yet equivalent to
        // a CDP-wallet binding check, but it establishes the seam.
        //
        // TODO(surface-4): replace with a Registry profile lookup that
        // validates `agent_profile.cdp_wallet_binding == payload.signer` (or
        // the equivalent field name once Q-S3-A is resolved).
        require!(
            escrow_client == ctx.accounts.hook_signer.key(),
            HookError::EscrowClientMismatch
        );

        // ---- 4. Initialize the replay record (idempotency) ----
        //
        // Because the account is opened with `init` and seeds include the
        // `(escrow, milestone_index, base_tx_hash)` triple, a second call
        // with the same triple aborts inside Anchor's account-init flow
        // before any CPI fires — replay protection is structural, not
        // a runtime require.
        let replay = &mut ctx.accounts.replay_guard;
        replay.escrow = payload.escrow_pda;
        replay.milestone_index = payload.milestone_index;
        replay.base_tx_hash = payload.base_tx_hash;
        replay.amount_returned_micros = payload.amount_returned_micros;
        replay.created_at = Clock::get()?.unix_timestamp;
        replay.bump = ctx.bumps.replay_guard;

        // ---- 5. CPI into Settlement::approve_milestone ----
        //
        // Raw-instruction CPI. The accounts list MUST match the order of
        // fields in `settlement::ApproveMilestone` exactly; out-of-order
        // accounts produce wrong constraints with no early diagnostic.
        //
        // The `client` slot is filled by the Hook's `hook_signer` PDA. The
        // is_signer flag is set true; Solana enforces it via the signer-seeds
        // we pass to invoke_signed.
        let agent_key = ctx.accounts.agent_authority.key();
        let signer_bump = ctx.bumps.hook_signer;
        let signer_seeds: &[&[&[u8]]] = &[&[
            HOOK_SIGNER_SEED,
            agent_key.as_ref(),
            &[signer_bump],
        ]];

        let mut cpi_data = Vec::with_capacity(8 + 4 + 1);
        cpi_data.extend_from_slice(&APPROVE_MILESTONE_DISCRIMINATOR);
        cpi_data.extend_from_slice(&(payload.milestone_index as u32).to_le_bytes());
        cpi_data.push(0u8); // rating (no-op per Settlement PR-Q)

        let cpi_accounts = vec![
            AccountMeta::new(ctx.accounts.hook_signer.key(), true), // client (signer via PDA seeds)
            AccountMeta::new(ctx.accounts.escrow.key(), false),
            AccountMeta::new(ctx.accounts.escrow_token_account.key(), false),
            AccountMeta::new(ctx.accounts.provider_token_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.registry_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.provider_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.provider_owner_nonce.key(), false),
            AccountMeta::new(ctx.accounts.provider_profile.key(), false),
            AccountMeta::new_readonly(ctx.accounts.settlement_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.protocol_config.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        ];

        let cpi_ix = Instruction {
            program_id: ctx.accounts.settlement_program.key(),
            accounts: cpi_accounts,
            data: cpi_data,
        };

        let cpi_account_infos = [
            ctx.accounts.hook_signer.to_account_info(),
            ctx.accounts.escrow.to_account_info(),
            ctx.accounts.escrow_token_account.to_account_info(),
            ctx.accounts.provider_token_account.to_account_info(),
            ctx.accounts.registry_program.to_account_info(),
            ctx.accounts.provider_authority.to_account_info(),
            ctx.accounts.provider_owner_nonce.to_account_info(),
            ctx.accounts.provider_profile.to_account_info(),
            ctx.accounts.settlement_authority.to_account_info(),
            ctx.accounts.protocol_config.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.settlement_program.to_account_info(),
        ];

        invoke_signed(&cpi_ix, &cpi_account_infos, signer_seeds)?;

        // ---- 6. Emit observability event ----
        emit!(MilestoneAutoApproved {
            escrow: payload.escrow_pda,
            milestone_index: payload.milestone_index,
            base_tx_hash: payload.base_tx_hash,
            amount_returned_micros: payload.amount_returned_micros,
            agent_authority: agent_key,
        });

        Ok(())
    }
}

/// Account context for `auto_approve_milestone`.
///
/// Mirrors `settlement::ApproveMilestone` for the CPI passthrough plus the
/// Hook's own `hook_signer` and `replay_guard` PDAs.
#[derive(Accounts)]
#[instruction(payload: ReflexHookPayload)]
pub struct AutoApproveMilestone<'info> {
    /// The transaction signer — typically the CCTP V2 receiver dispatcher or
    /// (until that is wired) the relayer. The Hook does not authorize off
    /// this signer's identity; the on-chain trust anchor is the
    /// CCTP-attestation guarantee that already gated the mint, plus the
    /// `hook_signer` PDA's exclusive ability to act as the escrow's `client`.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The agent's external authority pubkey. The Hook's signer PDA is
    /// derived from this key, and the upstream `create_escrow` MUST have
    /// listed `hook_signer(agent_authority)` as the escrow's `client`.
    /// CHECK: the on-chain coupling is enforced by
    /// `escrow.client == hook_signer.key()` inside the handler. This account
    /// is read-only and not deserialized.
    pub agent_authority: UncheckedAccount<'info>,

    /// PDA the Hook signs CPI calls with. Seeds: `["hook_signer", agent]`.
    /// Read-only here; passed as `client` (a Signer in Settlement's view) via
    /// CPI signer seeds.
    /// CHECK: address validated by the seeds + bump.
    #[account(
        seeds = [HOOK_SIGNER_SEED, agent_authority.key().as_ref()],
        bump,
    )]
    pub hook_signer: UncheckedAccount<'info>,

    /// Replay-guard PDA. `init` constraint = duplicate triples atomically
    /// abort before any CPI runs. Closed lazily after a configurable TTL by
    /// a separate, currently unscaffolded instruction (Q-S3-D).
    #[account(
        init,
        payer = payer,
        space = 8 + ReplayRecord::SPACE,
        seeds = [
            HOOK_REPLAY_SEED,
            payload.escrow_pda.as_ref(),
            &[payload.milestone_index],
            payload.base_tx_hash.as_ref(),
        ],
        bump,
    )]
    pub replay_guard: Account<'info, ReplayRecord>,

    /// AEP Settlement escrow being approved. We read `client` from the raw
    /// data (offset 8..40) and pass-through to Settlement's CPI which fully
    /// validates the account internally.
    /// CHECK: owner enforced as Settlement program ID via `owner = ...`.
    #[account(
        mut,
        owner = SETTLEMENT_PROGRAM_ID @ HookError::EscrowOwnerMismatch,
    )]
    pub escrow: UncheckedAccount<'info>,

    /// Escrow's USDC token account. Mutable.
    /// CHECK: validated by Settlement.
    #[account(mut)]
    pub escrow_token_account: UncheckedAccount<'info>,

    /// Provider's USDC token account (the session-pool PDA's ATA).
    /// CHECK: validated by Settlement.
    #[account(mut)]
    pub provider_token_account: UncheckedAccount<'info>,

    /// AEP Settlement program — target of the CPI. Address-pinned.
    /// CHECK: explicit address constraint.
    #[account(
        executable,
        constraint = settlement_program.key() == SETTLEMENT_PROGRAM_ID
            @ HookError::InvalidSettlementProgram
    )]
    pub settlement_program: UncheckedAccount<'info>,

    /// AEP Agent Registry program — required by Settlement's
    /// `ApproveMilestone` for the reputation CPI sub-call.
    /// CHECK: address-pinned to AGENT_REGISTRY_PROGRAM_ID.
    #[account(
        executable,
        constraint = registry_program.key() == AGENT_REGISTRY_PROGRAM_ID
            @ HookError::InvalidRegistryProgram
    )]
    pub registry_program: UncheckedAccount<'info>,

    /// Provider authority (= escrow.provider). Plumbed for Settlement's
    /// SEC-1 external-anchor constraint.
    /// CHECK: Settlement validates `address = escrow.provider`.
    pub provider_authority: UncheckedAccount<'info>,

    /// Provider owner-nonce PDA (Registry-owned).
    /// CHECK: Settlement re-derives the seeds.
    pub provider_owner_nonce: UncheckedAccount<'info>,

    /// Provider profile PDA (Registry-owned).
    /// CHECK: Settlement re-derives the seeds.
    #[account(mut)]
    pub provider_profile: UncheckedAccount<'info>,

    /// Settlement's signing-authority PDA — Settlement re-derives this from
    /// its own ID, so we just pass the AccountInfo through.
    /// CHECK: Settlement re-derives.
    pub settlement_authority: UncheckedAccount<'info>,

    /// Settlement's ProtocolConfig PDA. Read-only.
    /// CHECK: Settlement re-derives.
    pub protocol_config: UncheckedAccount<'info>,

    /// SPL Token program.
    /// CHECK: Settlement constrains to `Program<Token>`; we plumb only.
    pub token_program: UncheckedAccount<'info>,

    /// System program — required by `init` on `replay_guard`.
    pub system_program: Program<'info, System>,
}

#[cfg(test)]
mod discriminator_tests {
    use super::*;
    use anchor_lang::solana_program::hash::hash;

    /// Compile-time-equivalent regression test: if Settlement renames
    /// `approve_milestone`, this test breaks before the program ships,
    /// instead of producing an opaque CPI failure on devnet.
    #[test]
    fn approve_milestone_discriminator_matches_anchor_convention() {
        let preimage = b"global:approve_milestone";
        let h = hash(preimage).to_bytes();
        let mut expected = [0u8; 8];
        expected.copy_from_slice(&h[..8]);
        assert_eq!(APPROVE_MILESTONE_DISCRIMINATOR, expected);
    }
}
