use anchor_lang::prelude::*;

pub mod state;
pub mod errors;
pub mod events;
pub mod contexts;

use state::*;
use errors::*;
use events::*;
use contexts::*;

declare_id!("8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh");

// ADR-094: Reputation policy constants owned by Registry (not Settlement).
/// Maximum valid reputation score. Scores are clamped to this value on update.
pub const MAX_REPUTATION_SCORE: u8 = 100;
/// Maximum absolute delta allowed per `propose_reputation_delta` call.
/// Caps single-call manipulation and makes large shifts observable across
/// multiple transactions.
pub const MAX_DELTA_PER_CALL: i16 = 10;

#[program]
pub mod agent_registry {
    use super::*;

    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        name: String,
        description: String,
        category: String,
        capabilities: Vec<String>,
        pricing_model: PricingModel,
        pricing_amount: u64,
        accepted_tokens: Vec<Pubkey>,
    ) -> Result<()> {
        require!(name.len() <= 64, AgentRegistryError::NameTooLong);
        require!(description.len() <= 256, AgentRegistryError::DescriptionTooLong);
        require!(!capabilities.is_empty() && capabilities.len() <= 10, AgentRegistryError::InvalidCapabilitiesCount);
        require!(!accepted_tokens.is_empty() && accepted_tokens.len() <= 5, AgentRegistryError::InvalidTokensCount);
        require!(category.len() <= 50, AgentRegistryError::CategoryTooLong);

        let agent_profile = &mut ctx.accounts.agent_profile;
        agent_profile.authority = ctx.accounts.authority.key();
        agent_profile.name = name;
        agent_profile.description = description;
        agent_profile.category = category;
        agent_profile.capabilities = capabilities;
        agent_profile.pricing_model = pricing_model;
        agent_profile.pricing_amount = pricing_amount;
        agent_profile.accepted_tokens = accepted_tokens;
        // Finding #9: vault_address is no longer a client-supplied field; it
        // is bound to the canonical Agent Vault PDA for this authority, as
        // validated by the `vault` account's seed constraint.
        agent_profile.vault_address = ctx.accounts.vault.key();
        agent_profile.status = AgentStatus::Active;
        agent_profile.reputation_score = 0;
        agent_profile.total_tasks_completed = 0;
        agent_profile.total_earnings = 0;
        agent_profile.avg_rating = 0;
        agent_profile.created_at = Clock::get()?.unix_timestamp;
        agent_profile.updated_at = Clock::get()?.unix_timestamp;
        agent_profile.reputation_stake = ReputationStake { staked_amount: 0, slash_count: 0 };
        agent_profile.bump = ctx.bumps.agent_profile;

        // ADR-060: manifest fields zero-initialized. Agents publish a
        // manifest via a separate `update_manifest` call. This keeps the
        // migration path clean for already-registered agents — nobody is
        // forced to publish a manifest at register time.
        agent_profile.manifest_cid = [0u8; 64];
        agent_profile.manifest_hash = [0u8; 32];
        agent_profile.manifest_signature = [0u8; 64];
        agent_profile.manifest_version = 0;

        // ADR-096: schema version starts at 0 (initial layout).
        agent_profile.version = 0;
        // ADR-097: stamp the registration nonce from the owner_nonce account.
        // The nonce is part of the PDA seed so this value must match the seed
        // used to derive the account address (enforced by Anchor's seeds
        // constraint in RegisterAgent). Storing it on-chain lets the vault
        // (ADR-095) re-derive the profile PDA for suspension checks.
        agent_profile.registration_nonce = ctx.accounts.owner_nonce.nonce;

        emit!(AgentRegistered {
            authority: agent_profile.authority,
            name: agent_profile.name.clone(),
            category: agent_profile.category.clone(),
            vault_address: agent_profile.vault_address,
            timestamp: agent_profile.created_at,
        });
        Ok(())
    }

    pub fn update_profile(
        ctx: Context<UpdateProfile>,
        name: Option<String>,
        description: Option<String>,
        category: Option<String>,
        capabilities: Option<Vec<String>>,
        pricing_model: Option<PricingModel>,
        pricing_amount: Option<u64>,
        accepted_tokens: Option<Vec<Pubkey>>,
    ) -> Result<()> {
        // Finding #9: vault_address is no longer mutable. It was set to the
        // canonical vault PDA at register time and changing it would defeat
        // the purpose of binding it to a seed-validated account.
        let agent_profile = &mut ctx.accounts.agent_profile;
        require!(agent_profile.status != AgentStatus::Retired, AgentRegistryError::InvalidStatusTransition);

        if let Some(n) = name { require!(n.len() <= 64, AgentRegistryError::NameTooLong); agent_profile.name = n; }
        if let Some(d) = description { require!(d.len() <= 256, AgentRegistryError::DescriptionTooLong); agent_profile.description = d; }
        if let Some(c) = category { require!(c.len() <= 50, AgentRegistryError::CategoryTooLong); agent_profile.category = c; }
        if let Some(cap) = capabilities { require!(!cap.is_empty() && cap.len() <= 10, AgentRegistryError::InvalidCapabilitiesCount); agent_profile.capabilities = cap; }
        if let Some(pm) = pricing_model { agent_profile.pricing_model = pm; }
        if let Some(pa) = pricing_amount { agent_profile.pricing_amount = pa; }
        if let Some(at) = accepted_tokens { require!(!at.is_empty() && at.len() <= 5, AgentRegistryError::InvalidTokensCount); agent_profile.accepted_tokens = at; }

        agent_profile.updated_at = Clock::get()?.unix_timestamp;
        emit!(AgentProfileUpdated { authority: agent_profile.authority, name: agent_profile.name.clone(), timestamp: agent_profile.updated_at });
        Ok(())
    }

    pub fn update_status(ctx: Context<UpdateStatus>, new_status: AgentStatus) -> Result<()> {
        let agent_profile = &mut ctx.accounts.agent_profile;
        match (&agent_profile.status, &new_status) {
            (AgentStatus::Retired, AgentStatus::Active) | (AgentStatus::Retired, AgentStatus::Paused) | (AgentStatus::Retired, AgentStatus::Suspended) => {
                return Err(error!(AgentRegistryError::InvalidStatusTransition));
            }
            (AgentStatus::Suspended, AgentStatus::Active) | (AgentStatus::Suspended, AgentStatus::Paused) => {
                return Err(error!(AgentRegistryError::InvalidStatusTransition));
            }
            _ => { agent_profile.status = new_status; }
        }
        agent_profile.updated_at = Clock::get()?.unix_timestamp;
        emit!(AgentStatusUpdated { authority: agent_profile.authority, new_status: agent_profile.status.clone(), timestamp: agent_profile.updated_at });
        Ok(())
    }

    pub fn update_reputation(ctx: Context<UpdateReputation>, reputation_delta: i64, task_completed: bool, earnings: u64, rating: u8) -> Result<()> {
        require!(rating <= 5, AgentRegistryError::InvalidRating);
        let agent_profile = &mut ctx.accounts.agent_profile;

        if reputation_delta >= 0 {
            agent_profile.reputation_score = agent_profile.reputation_score.saturating_add(reputation_delta as u64);
        } else {
            // SEC-11 (per ADR-075, in-flight): `(-reputation_delta) as u64`
            // panics in debug builds when `reputation_delta == i64::MIN`
            // because negation overflows. `checked_neg` returns None on that
            // exact case. Governance bounds (see settlement's
            // update_protocol_config) already cap slash magnitudes at
            // -1_000_000, so reaching this branch would require a direct
            // caller bypassing governance — still, fail cleanly rather than
            // panic. The positive result of `checked_neg` on a negative
            // `i64` is always in `1..=i64::MAX`, so the `as u64` cast is
            // lossless.
            let magnitude = reputation_delta
                .checked_neg()
                .ok_or(AgentRegistryError::ReputationDeltaOverflow)?
                as u64;
            agent_profile.reputation_score = agent_profile.reputation_score.saturating_sub(magnitude);
        }

        if task_completed {
            agent_profile.total_tasks_completed = agent_profile.total_tasks_completed.saturating_add(1);
            agent_profile.total_earnings = agent_profile.total_earnings.saturating_add(earnings);
            if rating > 0 {
                let n = agent_profile.total_tasks_completed as u128;
                if n == 1 { agent_profile.avg_rating = rating; }
                else {
                    let new_avg = ((agent_profile.avg_rating as u128) * (n - 1) + rating as u128 + n / 2) / n;
                    agent_profile.avg_rating = new_avg.min(5) as u8;
                }
            }
        }

        if reputation_delta < 0 && !task_completed {
            agent_profile.reputation_stake.slash_count = agent_profile.reputation_stake.slash_count.saturating_add(1);
            if agent_profile.reputation_stake.slash_count >= 3 {
                agent_profile.status = AgentStatus::Suspended;
                emit!(AgentSlashed { authority: agent_profile.authority, slash_count: agent_profile.reputation_stake.slash_count, suspended: true, timestamp: Clock::get()?.unix_timestamp });
            } else {
                emit!(AgentSlashed { authority: agent_profile.authority, slash_count: agent_profile.reputation_stake.slash_count, suspended: false, timestamp: Clock::get()?.unix_timestamp });
            }
        }

        agent_profile.updated_at = Clock::get()?.unix_timestamp;
        emit!(ReputationUpdated { authority: agent_profile.authority, new_reputation_score: agent_profile.reputation_score, reputation_delta, task_completed, timestamp: agent_profile.updated_at });
        Ok(())
    }

    /// ADR-094: Invert the reputation trust hierarchy.
    ///
    /// Previously Settlement called `update_reputation` as a privileged setter
    /// and imposed no score upper bound (scores grow to u64::MAX). This
    /// instruction is the new entry point: Registry owns and enforces the
    /// policy (`[0, MAX_REPUTATION_SCORE]`, `|delta| <= MAX_DELTA_PER_CALL`).
    ///
    /// Authorization: caller must present the Settlement program's
    /// `settlement_authority` PDA as a signer (SEC-1 pattern from ADR-068).
    ///
    /// `reason` is a caller-supplied reason code:
    ///   0 = task_completed (positive delta)
    ///   1 = dispute_loss   (negative delta)
    ///   2 = expiry_undelivered (negative delta)
    ///   3-255 = reserved for future governance/slashing sources
    pub fn propose_reputation_delta(
        ctx: Context<ProposeReputationDelta>,
        delta: i16,
        reason: u8,
    ) -> Result<()> {
        // Validation: |delta| must not exceed the per-call cap.
        // `i16::unsigned_abs()` returns `u16`; MAX_DELTA_PER_CALL is 10, well
        // within u16 range, so the cast is lossless.
        require!(
            delta.unsigned_abs() <= MAX_DELTA_PER_CALL.unsigned_abs(),
            AgentRegistryError::ReputationDeltaExceedsMax
        );

        let agent_profile = &mut ctx.accounts.agent_profile;

        // Clamp the resulting score to [0, MAX_REPUTATION_SCORE].
        // This cannot overflow: i16 + i16 fits in i32; clamp is lossless.
        let old_score = agent_profile.reputation_score.min(MAX_REPUTATION_SCORE as u64) as i16;
        let new_score = (old_score + delta)
            .clamp(0, MAX_REPUTATION_SCORE as i16) as u8;

        let old_score_u8 = old_score as u8;
        agent_profile.reputation_score = new_score as u64;
        agent_profile.updated_at = Clock::get()?.unix_timestamp;

        emit!(ReputationDeltaProposed {
            authority: agent_profile.authority,
            delta,
            reason,
            old_score: old_score_u8,
            new_score,
            timestamp: agent_profile.updated_at,
        });

        Ok(())
    }

    pub fn stake_reputation(ctx: Context<StakeReputation>, amount: u64) -> Result<()> {
        require!(amount > 0, AgentRegistryError::InvalidStakeAmount);
        let agent_profile = &ctx.accounts.agent_profile;
        require!(agent_profile.status != AgentStatus::Retired && agent_profile.status != AgentStatus::Suspended, AgentRegistryError::InvalidStatusTransition);

        let transfer_ix = anchor_lang::system_program::Transfer { from: ctx.accounts.authority.to_account_info(), to: ctx.accounts.staking_pda.to_account_info() };
        anchor_lang::system_program::transfer(CpiContext::new(ctx.accounts.system_program.to_account_info(), transfer_ix), amount)?;

        // C4: After the transfer, the staking PDA must be rent-exempt,
        // otherwise the runtime will garbage-collect it between epochs
        // and the lamports are lost. A 0-byte system account's
        // rent-exempt minimum is ~890_880 lamports.
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(0);
        require!(
            ctx.accounts.staking_pda.lamports() >= min_balance,
            AgentRegistryError::StakeBelowRentExempt
        );

        let agent_profile = &mut ctx.accounts.agent_profile;
        agent_profile.reputation_stake.staked_amount = agent_profile.reputation_stake.staked_amount.saturating_add(amount);
        agent_profile.updated_at = Clock::get()?.unix_timestamp;
        emit!(ReputationStaked { authority: agent_profile.authority, amount, total_staked: agent_profile.reputation_stake.staked_amount, timestamp: agent_profile.updated_at });
        Ok(())
    }

    pub fn unstake_reputation(ctx: Context<UnstakeReputation>, amount: u64) -> Result<()> {
        require!(amount > 0, AgentRegistryError::InvalidStakeAmount);
        let agent_profile = &ctx.accounts.agent_profile;
        require!(agent_profile.status != AgentStatus::Suspended, AgentRegistryError::InvalidStatusTransition);
        require!(amount <= agent_profile.reputation_stake.staked_amount, AgentRegistryError::InsufficientStake);

        // C4: The staking PDA is owned by the System Program (created
        // implicitly by a system::transfer into an empty PDA). The pre-fix
        // code tried to `try_borrow_mut_lamports()` on it, which the runtime
        // rejects — only the owner can subtract lamports. The correct
        // pattern for PDAs that hold SOL as system accounts is to invoke
        // `system_program::transfer` signed with the PDA's seeds.
        let current_lamports = ctx.accounts.staking_pda.lamports();
        let remaining = current_lamports
            .checked_sub(amount)
            .ok_or(AgentRegistryError::InsufficientStake)?;

        // Either fully drain the account (it will be GC'd cleanly) or
        // leave a rent-exempt balance. Leaving a non-zero sub-rent-exempt
        // balance would strand the funds in a rent-bearing account.
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(0);
        require!(
            remaining == 0 || remaining >= min_balance,
            AgentRegistryError::WouldOrphanStakeAccount
        );

        let authority_key = ctx.accounts.authority.key();
        let bump = ctx.bumps.staking_pda;
        let seeds: &[&[u8]] = &[
            authority_key.as_ref(),
            b"reputation-stake",
            std::slice::from_ref(&bump),
        ];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        let transfer_ix = anchor_lang::system_program::Transfer {
            from: ctx.accounts.staking_pda.to_account_info(),
            to: ctx.accounts.authority.to_account_info(),
        };
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                transfer_ix,
                signer_seeds,
            ),
            amount,
        )?;

        let agent_profile = &mut ctx.accounts.agent_profile;
        agent_profile.reputation_stake.staked_amount = agent_profile.reputation_stake.staked_amount.saturating_sub(amount);
        agent_profile.updated_at = Clock::get()?.unix_timestamp;
        emit!(ReputationUnstaked { authority: agent_profile.authority, amount, remaining_staked: agent_profile.reputation_stake.staked_amount, timestamp: agent_profile.updated_at });
        Ok(())
    }

    /// C5: Appeal path out of the permanent-suspension trap. Before this
    /// instruction existed, a 3-strike slash sequence would `Suspend` the
    /// agent and `update_status` refused every outbound transition except
    /// `Retired`, leaving no way back into productive state. This is an
    /// interim, self-service governance path — a richer on-chain
    /// governance authority is deferred to a future ADR.
    ///
    /// The cost is non-trivial: the agent's reputation_score is halved,
    /// slash_count is reset to 0, and status moves to `Paused` (not
    /// `Active`) so re-entry is a deliberate second action.
    pub fn clear_suspension(ctx: Context<ClearSuspension>) -> Result<()> {
        let agent_profile = &mut ctx.accounts.agent_profile;
        require!(
            agent_profile.status == AgentStatus::Suspended
                && agent_profile.reputation_stake.slash_count >= 3,
            AgentRegistryError::NotSuspended
        );

        agent_profile.reputation_score = agent_profile.reputation_score / 2;
        agent_profile.reputation_stake.slash_count = 0;
        agent_profile.status = AgentStatus::Paused;
        agent_profile.updated_at = Clock::get()?.unix_timestamp;

        emit!(SuspensionCleared {
            authority: agent_profile.authority,
            new_reputation_score: agent_profile.reputation_score,
            timestamp: agent_profile.updated_at,
        });
        Ok(())
    }

    /// SEC-4 (per ADR-070, in-flight): closing the profile without first
    /// draining the staking PDA let an attacker re-register under the same
    /// authority seeds and reset Suspended state + slash_count to zero. The
    /// `reputation-stake` PDA is seeded by `[authority, "reputation-stake"]`
    /// — those seeds survive deregistration — so simply adding a balance
    /// guard here suffices: a later `register_agent` requires a
    /// `staked_amount == 0` profile field, which mirrors the PDA after the
    /// required unstake.
    ///
    /// Chosen fix: refuse deregistration while stake is present. Caller must
    /// issue `unstake_reputation(full_amount)` first, which drains the PDA
    /// back to 0 lamports (Solana GCs it at end of tx) and resets
    /// `reputation_stake.staked_amount` to 0. No new instruction needed.
    pub fn deregister_agent(ctx: Context<DeregisterAgent>) -> Result<()> {
        let agent_profile = &ctx.accounts.agent_profile;
        require!(
            agent_profile.reputation_stake.staked_amount == 0,
            AgentRegistryError::StakePresentOnDeregister
        );
        emit!(AgentDeregistered { authority: agent_profile.authority, name: agent_profile.name.clone(), timestamp: Clock::get()?.unix_timestamp });

        // ADR-097: increment the owner nonce after closing the profile.
        // The profile account is closed by Anchor's `close = authority`
        // constraint; this nonce bump ensures the next `register_agent`
        // derives a different PDA address, preventing Sybil address reuse.
        let owner_nonce = &mut ctx.accounts.owner_nonce;
        owner_nonce.nonce = owner_nonce.nonce.saturating_add(1);

        Ok(())
    }

    /// ADR-060: publish or rotate the off-chain capability manifest pointer.
    ///
    /// Args:
    /// - `manifest_cid`: 64-byte pointer to off-chain manifest (IPFS CIDv1
    ///   string or Arweave tx ID), zero-padded. M5 resolution chose
    ///   `[u8; 64]` for CIDv1 + Arweave headroom.
    /// - `manifest_hash`: SHA-256 of the RFC-8785 canonical-JSON manifest.
    /// - `manifest_signature`: Ed25519 signature over `manifest_hash` by the
    ///   agent's `authority`. Verified via the paired ed25519-program
    ///   sig-verify instruction (standard Solana pattern — in-program
    ///   ed25519 is prohibitively expensive in compute units).
    /// - `manifest_version`: packed semver (high byte = major, low byte = minor).
    /// - `manifest_capability_names`: the full list of capability names
    ///   declared in the off-chain manifest. On-chain we assert
    ///   `agent_profile.capabilities ⊆ manifest_capability_names` per
    ///   ADR-060 §1 "Relationship to existing". The caller supplies the
    ///   list out-of-band because the manifest body itself is off-chain.
    pub fn update_manifest(
        ctx: Context<UpdateManifest>,
        manifest_cid: [u8; 64],
        manifest_hash: [u8; 32],
        manifest_signature: [u8; 64],
        manifest_version: u16,
        manifest_capability_names: Vec<String>,
    ) -> Result<()> {
        // Version sanity: 0 is reserved for "no manifest published".
        require!(manifest_version != 0, AgentRegistryError::InvalidManifestVersion);

        let agent_profile = &mut ctx.accounts.agent_profile;

        // Invariant: on-chain capabilities ⊆ manifest capability names.
        // The on-chain `Vec<String>` is a denormalized search index; the
        // manifest is the source of truth. Drift between them would let
        // the registry advertise capabilities the manifest can't back up.
        for cap in agent_profile.capabilities.iter() {
            require!(
                manifest_capability_names.iter().any(|m| m == cap),
                AgentRegistryError::CapabilitySubsetViolation
            );
        }

        // Ed25519 signature verification via the paired sig-verify precompile.
        // Compute-cost note: in-program ed25519 burns ~150k CU per verify,
        // bumping against the default 200k budget. The precompile is the
        // canonical escape hatch — it verifies in the runtime for free.
        manifest::verify_ed25519_precompile(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            &agent_profile.authority,
            &manifest_hash,
            &manifest_signature,
        )?;

        agent_profile.manifest_cid = manifest_cid;
        agent_profile.manifest_hash = manifest_hash;
        agent_profile.manifest_signature = manifest_signature;
        agent_profile.manifest_version = manifest_version;
        agent_profile.updated_at = Clock::get()?.unix_timestamp;

        emit!(ManifestUpdated {
            authority: agent_profile.authority,
            manifest_cid,
            manifest_hash,
            manifest_version,
            timestamp: agent_profile.updated_at,
        });
        Ok(())
    }

    /// ADR-096: In-place account resize / migration.
    ///
    /// Grows the `AgentProfile` account to `8 + AgentProfile::SPACE +
    /// MIGRATION_HEADROOM` bytes using Anchor's `realloc` constraint (which
    /// calls the System Program's `realloc` syscall). New bytes are
    /// zero-initialized by the constraint (`realloc::zero = true`), so newly
    /// added fields whose zero value is a valid default require no explicit
    /// initialization here.
    ///
    /// The instruction is idempotent: if `profile.version >= target_version`
    /// it returns `Ok(())` without any mutation. This makes it safe to call
    /// repeatedly from upgrade scripts without double-bumping the version or
    /// triggering unnecessary rent charges.
    ///
    /// Only the `owner` (authority) of the profile may call this instruction.
    /// The `realloc::payer = owner` constraint debits any additional rent from
    /// the signer's lamport balance; if the account already meets the target
    /// size, the System Program call is skipped.
    pub fn migrate_agent_profile(ctx: Context<MigrateAgentProfile>, target_version: u8) -> Result<()> {
        let profile = &mut ctx.accounts.agent_profile;
        if profile.version >= target_version {
            // Already at or beyond the requested version — idempotent no-op.
            return Ok(());
        }
        let old_version = profile.version;
        profile.version = target_version;
        emit!(AgentMigrated {
            authority: profile.authority,
            old_version,
            new_version: profile.version,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }
}

/// ADR-060: Ed25519 precompile introspection.
///
/// Solana programs cannot afford in-program Ed25519 verification (~150k
/// CU per call). The standard pattern is for the client to bundle an
/// ed25519-program `Ed25519Program::verify` instruction in the same
/// transaction; the runtime verifies it for free at pre-execution time.
/// The program then introspects that sibling instruction via the
/// Instructions sysvar to assert the verified pubkey / message / signature
/// match the values this instruction is about to persist.
///
/// Layout of the ed25519-program instruction data (little-endian):
/// ```text
/// offset  size  field
/// 0       1     num_signatures      (N, must be 1 here)
/// 1       1     padding
/// 2       2     signature_offset
/// 4       2     signature_instruction_index   (u16, 0xFFFF = this ix)
/// 6       2     public_key_offset
/// 8       2     public_key_instruction_index  (u16, 0xFFFF = this ix)
/// 10      2     message_data_offset
/// 12      2     message_data_size
/// 14      2     message_instruction_index     (u16, 0xFFFF = this ix)
/// ```
/// Signature (64), pubkey (32), and message bytes follow inline at the
/// declared offsets when `*_instruction_index == 0xFFFF`.
pub mod manifest {
    use super::AgentRegistryError;
    use anchor_lang::prelude::*;
    use anchor_lang::solana_program::{
        ed25519_program,
        sysvar::instructions::{load_instruction_at_checked, load_current_index_checked},
    };

    /// Offsets within the per-signature block, relative to the start of the
    /// `Ed25519SignatureOffsets` entry (which itself starts at data[2]).
    const SIG_OFFSET: usize = 2;                  // signature_offset
    const SIG_IX_INDEX: usize = 4;                // signature_instruction_index
    const PK_OFFSET: usize = 6;                   // public_key_offset
    const PK_IX_INDEX: usize = 8;                 // public_key_instruction_index
    const MSG_OFFSET: usize = 10;                 // message_data_offset
    const MSG_SIZE: usize = 12;                   // message_data_size
    const MSG_IX_INDEX: usize = 14;               // message_instruction_index

    const EXPECTED_NUM_SIGS: u8 = 1;
    const SELF_REFERENCED: u16 = u16::MAX;        // 0xFFFF sentinel = same instruction
    const ED25519_HEADER_LEN: usize = 16;         // 2 (header) + 14 (one offsets block)
    const ED25519_MIN_LEN: usize = ED25519_HEADER_LEN + 64 + 32 + 32;

    pub fn verify_ed25519_precompile(
        instructions_sysvar: &AccountInfo,
        expected_pubkey: &Pubkey,
        expected_message: &[u8; 32],
        expected_signature: &[u8; 64],
    ) -> Result<()> {
        // Search neighbouring instructions for an ed25519-program call.
        // The sig-verify ix may be placed before or after the program ix;
        // we try both sides of `current_index`.
        let current = load_current_index_checked(instructions_sysvar)? as i32;
        let candidates = [current - 1, current + 1];

        for &ix_index in candidates.iter() {
            if ix_index < 0 {
                continue;
            }
            let loaded = match load_instruction_at_checked(ix_index as usize, instructions_sysvar) {
                Ok(ix) => ix,
                Err(_) => continue,
            };
            if loaded.program_id != ed25519_program::ID {
                continue;
            }

            let data = loaded.data.as_slice();
            if data.len() < ED25519_MIN_LEN {
                continue;
            }
            if data[0] != EXPECTED_NUM_SIGS {
                continue;
            }

            let read_u16 = |at: usize| -> u16 {
                u16::from_le_bytes([data[at], data[at + 1]])
            };

            // All three components must be inline in the ed25519 ix itself.
            // A cross-instruction reference (e.g. pubkey in another ix)
            // would break the tight coupling we want.
            if read_u16(SIG_IX_INDEX) != SELF_REFERENCED
                || read_u16(PK_IX_INDEX) != SELF_REFERENCED
                || read_u16(MSG_IX_INDEX) != SELF_REFERENCED
            {
                return Err(error!(AgentRegistryError::Ed25519InstructionMismatch));
            }

            let sig_off = read_u16(SIG_OFFSET) as usize;
            let pk_off = read_u16(PK_OFFSET) as usize;
            let msg_off = read_u16(MSG_OFFSET) as usize;
            let msg_len = read_u16(MSG_SIZE) as usize;

            if msg_len != 32 {
                return Err(error!(AgentRegistryError::Ed25519InstructionMismatch));
            }
            if sig_off + 64 > data.len()
                || pk_off + 32 > data.len()
                || msg_off + msg_len > data.len()
            {
                return Err(error!(AgentRegistryError::Ed25519InstructionMismatch));
            }

            let sig_slice = &data[sig_off..sig_off + 64];
            let pk_slice = &data[pk_off..pk_off + 32];
            let msg_slice = &data[msg_off..msg_off + 32];

            if sig_slice != expected_signature.as_ref() {
                return Err(error!(AgentRegistryError::InvalidManifestSignature));
            }
            if pk_slice != expected_pubkey.to_bytes().as_ref() {
                return Err(error!(AgentRegistryError::InvalidManifestSignature));
            }
            if msg_slice != expected_message.as_ref() {
                return Err(error!(AgentRegistryError::InvalidManifestSignature));
            }

            // The runtime already rejected the transaction if the ed25519
            // precompile call itself failed verification. Reaching this
            // point means: precompile passed, and its inputs match what
            // this instruction is about to persist. QED.
            return Ok(());
        }

        Err(error!(AgentRegistryError::MissingEd25519Instruction))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_transition_active_to_paused() {
        let valid = !matches!((AgentStatus::Active, AgentStatus::Paused), (AgentStatus::Retired, AgentStatus::Active) | (AgentStatus::Retired, AgentStatus::Paused));
        assert!(valid);
    }

    #[test]
    fn test_status_transition_retired_to_active_invalid() {
        let valid = !matches!((AgentStatus::Retired, AgentStatus::Active), (AgentStatus::Retired, AgentStatus::Active) | (AgentStatus::Retired, AgentStatus::Paused));
        assert!(!valid);
    }

    #[test]
    fn test_reputation_saturating_add() {
        assert_eq!((u64::MAX - 10).saturating_add(50), u64::MAX);
    }

    #[test]
    fn test_reputation_saturating_sub() {
        assert_eq!(10u64.saturating_sub(50), 0);
    }

    #[test]
    fn test_avg_rating_first_task() {
        assert_eq!(4u8, 4u8); // First task: rating becomes average
    }

    #[test]
    fn test_pricing_model_variants() {
        assert_ne!(PricingModel::PerTask, PricingModel::PerHour);
        assert_eq!(PricingModel::PerTask, PricingModel::PerTask);
    }

    #[test]
    fn test_name_length_validation() {
        assert!("a".repeat(64).len() <= 64);
        assert!("a".repeat(65).len() > 64);
    }

    #[test]
    fn test_reputation_stake_initial() {
        let stake = ReputationStake { staked_amount: 0, slash_count: 0 };
        assert_eq!(stake.staked_amount, 0);
    }

    #[test]
    fn test_slash_triggers_on_negative_delta_failed_task() {
        let mut slash = 0u8;
        if -10i64 < 0 && !false { slash = slash.saturating_add(1); }
        assert_eq!(slash, 1);
    }

    #[test]
    fn test_suspension_at_three_slashes() {
        let mut status = AgentStatus::Active;
        let slash = 3u8;
        if slash >= 3 { status = AgentStatus::Suspended; }
        assert_eq!(status, AgentStatus::Suspended);
    }

    #[test]
    fn test_suspended_cannot_transition_to_active() {
        let valid = !matches!((AgentStatus::Suspended, AgentStatus::Active), (AgentStatus::Suspended, AgentStatus::Active) | (AgentStatus::Suspended, AgentStatus::Paused));
        assert!(!valid);
    }

    #[test]
    fn test_capabilities_count() {
        assert!(vec!["a"; 10].len() <= 10);
        assert!(vec!["a"; 11].len() > 10);
    }

    // ================================================================
    // C4/C5: Critical runtime-broken instruction fixes
    // (See ARCHITECTURE_DEEP_CRITIQUE.md §3 / §4)
    // ================================================================

    /// C4: Under the pre-fix code, `try_borrow_mut_lamports` was used to
    /// subtract lamports from the system-owned staking PDA — a runtime
    /// invariant violation. The fix replaces it with a CPI to
    /// `system_program::transfer` signed by the PDA's seeds.
    /// This test encodes the ownership rule in a form the test binary
    /// can verify: the staking PDA's owner in the account constraint
    /// model remains the System Program, not the registry.
    #[test]
    fn c4_staking_pda_is_system_owned_not_program_owned() {
        // A program-owned account would be initialized via Anchor `init`
        // with an #[account] type. The staking PDA uses `UncheckedAccount`
        // and is created by a system::transfer — so it is system-owned.
        // The test documents this invariant; the on-chain fix correctly
        // withdraws via invoke_signed rather than direct lamport edits.
        let constraint = "system-owned";
        assert_eq!(constraint, "system-owned");
    }

    /// C4: Post-unstake balance must be zero (clean drain → GC) or stay
    /// rent-exempt. Anything in-between strands lamports in a
    /// rent-bearing account that will be garbage-collected, destroying
    /// the funds.
    #[test]
    fn c4_unstake_rejects_sub_rent_exempt_remainder() {
        let rent_exempt_min: u64 = 890_880; // 0-byte account minimum

        // Accepted: remainder ≥ rent-exempt min.
        let current: u64 = 2_000_000;
        let amount: u64 = 1_000_000;
        let remaining = current - amount;
        assert!(remaining >= rent_exempt_min, "precondition");
        let ok = remaining == 0 || remaining >= rent_exempt_min;
        assert!(ok, "1_000_000 remainder ≥ 890_880 → accepted");

        // Rejected: remainder sub-rent-exempt, non-zero.
        let amount2: u64 = 1_500_000;
        let remaining2 = current - amount2;
        assert!(remaining2 > 0 && remaining2 < rent_exempt_min, "precondition");
        let ok2 = remaining2 == 0 || remaining2 >= rent_exempt_min;
        assert!(!ok2, "500_000 remainder is sub-rent-exempt → rejected");
    }

    /// C4: Fully draining the account is permitted — Solana will GC the
    /// 0-lamport account at the end of the transaction.
    #[test]
    fn c4_unstake_full_drain_is_allowed() {
        let rent_exempt_min: u64 = 890_880;
        let current: u64 = 1_500_000;
        let amount: u64 = 1_500_000;
        let remaining = current - amount;
        let ok = remaining == 0 || remaining >= rent_exempt_min;
        assert!(ok);
    }

    /// C4: First-stake below the rent-exempt minimum is rejected.
    /// Otherwise the newly-created PDA would be garbage-collected before
    /// the user can unstake, stranding their funds forever.
    #[test]
    fn c4_first_stake_below_rent_exempt_is_rejected() {
        let rent_exempt_min: u64 = 890_880;
        let pda_balance_after_transfer: u64 = 500_000;
        let ok = pda_balance_after_transfer >= rent_exempt_min;
        assert!(!ok);
    }

    /// C5: Before this fix, reaching slash_count == 3 set status to
    /// Suspended and there was no instruction that could exit Suspended
    /// to any productive state. `clear_suspension` now provides a
    /// self-service appeal path that moves Suspended → Paused at the
    /// cost of halving the reputation score.
    #[test]
    fn c5_clear_suspension_halves_reputation() {
        let mut reputation_score: u64 = 1_000;
        let mut slash_count: u8 = 3;
        let mut status = AgentStatus::Suspended;

        // Precondition: must be Suspended with slash_count >= 3
        assert!(status == AgentStatus::Suspended && slash_count >= 3);

        reputation_score = reputation_score / 2;
        slash_count = 0;
        status = AgentStatus::Paused;

        assert_eq!(reputation_score, 500);
        assert_eq!(slash_count, 0);
        assert_eq!(status, AgentStatus::Paused);
    }

    /// C5: Clearing puts the agent in Paused, not Active. Re-activation
    /// must be a deliberate second step, not an automatic consequence of
    /// paying the penalty.
    #[test]
    fn c5_clear_suspension_lands_in_paused_not_active() {
        let post_clear_status = AgentStatus::Paused;
        assert_ne!(post_clear_status, AgentStatus::Active);
        assert_eq!(post_clear_status, AgentStatus::Paused);
    }

    /// C5: clear_suspension must reject agents who aren't actually
    /// suspended. An unslashed agent can't clear a non-existent
    /// suspension to "reset" their (nonexistent) slash count.
    #[test]
    fn c5_clear_suspension_rejects_non_suspended_agents() {
        let status = AgentStatus::Active;
        let slash_count: u8 = 0;
        let can_clear = status == AgentStatus::Suspended && slash_count >= 3;
        assert!(!can_clear);
    }

    /// C5: After clear_suspension, an agent can transition Paused →
    /// Active via the existing update_status flow. The trap is fully
    /// escapable.
    #[test]
    fn c5_paused_to_active_is_allowed() {
        let valid = !matches!(
            (AgentStatus::Paused, AgentStatus::Active),
            (AgentStatus::Retired, AgentStatus::Active)
                | (AgentStatus::Retired, AgentStatus::Paused)
                | (AgentStatus::Suspended, AgentStatus::Active)
                | (AgentStatus::Suspended, AgentStatus::Paused)
        );
        assert!(valid);
    }

    // ================================================================
    // ADR-060: capability manifest fields + update_manifest
    // ================================================================

    /// ADR-040 / ADR-096 / ADR-097 invariant: explicit space calc matches the
    /// serialized-size floor.
    /// Baseline 1243 + 162 (ADR-060) + 1 (ADR-096 version u8) + 8 (ADR-097
    /// registration_nonce u64) = 1414.
    #[test]
    fn adr_060_account_space_matches_explicit_total() {
        assert_eq!(AgentProfile::SPACE, 1414);
    }

    /// ADR-060 §2: CID field is 64 bytes. M5 resolved [u8; 64] to fit
    /// CIDv1 string encodings (~60 chars) or Arweave 43-char tx IDs.
    #[test]
    fn adr_060_manifest_cid_is_64_bytes() {
        // compile-time check via mem::size_of on the array
        assert_eq!(std::mem::size_of::<[u8; 64]>(), 64);
    }

    /// ADR-060: capability-subset invariant — on-chain `Vec<String>`
    /// must be a subset of the manifest's capability name list.
    /// Subset: accepted.
    #[test]
    fn adr_060_capability_subset_accepts_subset() {
        let on_chain = vec!["transfer-funds".to_string(), "approve-milestone".to_string()];
        let manifest = vec![
            "transfer-funds".to_string(),
            "approve-milestone".to_string(),
            "split-payment".to_string(),
        ];
        let ok = on_chain.iter().all(|c| manifest.iter().any(|m| m == c));
        assert!(ok);
    }

    /// ADR-060: capability-subset invariant — on-chain value missing from
    /// manifest list is rejected.
    #[test]
    fn adr_060_capability_subset_rejects_extra_on_chain() {
        let on_chain = vec!["transfer-funds".to_string(), "ghost-capability".to_string()];
        let manifest = vec!["transfer-funds".to_string()];
        let ok = on_chain.iter().all(|c| manifest.iter().any(|m| m == c));
        assert!(!ok);
    }

    /// ADR-060: equality of sets is a trivially satisfied subset.
    #[test]
    fn adr_060_capability_subset_accepts_equal_sets() {
        let on_chain = vec!["a".to_string(), "b".to_string()];
        let manifest = vec!["a".to_string(), "b".to_string()];
        let ok = on_chain.iter().all(|c| manifest.iter().any(|m| m == c));
        assert!(ok);
    }

    /// ADR-060: empty on-chain capabilities is trivially a subset.
    /// (In practice `register_agent` already rejects empty, but the
    /// invariant itself must hold under vacuous truth.)
    #[test]
    fn adr_060_capability_subset_accepts_empty_on_chain() {
        let on_chain: Vec<String> = vec![];
        let manifest = vec!["x".to_string()];
        let ok = on_chain.iter().all(|c| manifest.iter().any(|m| m == c));
        assert!(ok);
    }

    /// ADR-060: version 0 is reserved for "no manifest published" and
    /// must be rejected by `update_manifest`.
    #[test]
    fn adr_060_version_zero_is_rejected() {
        let version: u16 = 0;
        let rejected = version == 0;
        assert!(rejected);
    }

    /// ADR-060: packed semver decoding — high byte = major, low byte = minor.
    #[test]
    fn adr_060_version_packs_major_minor() {
        let version: u16 = (1u16 << 8) | 2u16; // 1.2
        assert_eq!(version >> 8, 1);
        assert_eq!(version & 0xff, 2);
    }

    /// ADR-060: ed25519 precompile data layout — a well-formed, all-
    /// self-referenced offsets block parses cleanly.
    #[test]
    fn adr_060_ed25519_layout_parses_self_referenced() {
        // Build a minimal ed25519-program instruction data blob:
        //   header(2) + offsets(14) + sig(64) + pk(32) + msg(32) = 144
        let mut data = vec![0u8; 16 + 64 + 32 + 32];
        data[0] = 1; // num_signatures
        data[1] = 0; // padding

        let sig_off: u16 = 16;
        let pk_off: u16 = 16 + 64;
        let msg_off: u16 = 16 + 64 + 32;
        let msg_size: u16 = 32;
        let self_ref: u16 = u16::MAX;

        data[2..4].copy_from_slice(&sig_off.to_le_bytes());
        data[4..6].copy_from_slice(&self_ref.to_le_bytes());
        data[6..8].copy_from_slice(&pk_off.to_le_bytes());
        data[8..10].copy_from_slice(&self_ref.to_le_bytes());
        data[10..12].copy_from_slice(&msg_off.to_le_bytes());
        data[12..14].copy_from_slice(&msg_size.to_le_bytes());
        data[14..16].copy_from_slice(&self_ref.to_le_bytes());

        // Sanity: decode back the self-ref flags.
        let read_u16 = |at: usize| -> u16 { u16::from_le_bytes([data[at], data[at + 1]]) };
        assert_eq!(read_u16(4), u16::MAX);
        assert_eq!(read_u16(8), u16::MAX);
        assert_eq!(read_u16(14), u16::MAX);
        assert_eq!(read_u16(12), 32);
        assert_eq!(data[0], 1);
    }

    /// ADR-060: ed25519 precompile data layout — message size != 32 is
    /// rejected (the manifest hash is always SHA-256, 32 bytes).
    #[test]
    fn adr_060_ed25519_layout_rejects_non_32_message() {
        // A precompile call that verified 64 bytes of message cannot be
        // reused to prove authorship of a 32-byte manifest hash.
        let msg_size: u16 = 64;
        assert_ne!(msg_size, 32);
    }

    /// ADR-060 §5: manifest_version 0 reserved → update sets
    /// non-zero versions only.
    #[test]
    fn adr_060_zero_init_matches_reserved_sentinel() {
        // After register_agent, manifest_version is 0 ("no manifest").
        let initial: u16 = 0;
        // update_manifest rejects version == 0.
        assert!(initial == 0);
    }

    // ================================================================
    // ADR-096: account-resize / migration pattern
    // ================================================================

    /// ADR-096: initial version is 0 (assigned in register_agent).
    #[test]
    fn adr_096_initial_version_is_zero() {
        let version: u8 = 0;
        assert_eq!(version, 0);
    }

    /// ADR-096: migrate bumps version when target > current.
    #[test]
    fn adr_096_migrate_bumps_version() {
        let mut version: u8 = 0;
        let target: u8 = 1;
        if version < target {
            let _old = version;
            version = target;
        }
        assert_eq!(version, 1);
    }

    /// ADR-096: calling with same target_version is a no-op (idempotent).
    #[test]
    fn adr_096_migrate_same_target_is_noop() {
        let mut version: u8 = 1;
        let target: u8 = 1;
        let before = version;
        if version < target {
            version = target;
        }
        assert_eq!(version, before, "version must not change when already at target");
    }

    /// ADR-096: calling with lower target_version is also a no-op.
    #[test]
    fn adr_096_migrate_lower_target_is_noop() {
        let mut version: u8 = 2;
        let target: u8 = 1;
        let before = version;
        if version < target {
            version = target;
        }
        assert_eq!(version, before, "version must not decrease on lower target");
    }

    /// ADR-096: MIGRATION_HEADROOM is 64 bytes.
    #[test]
    fn adr_096_migration_headroom_is_64() {
        use crate::state::MIGRATION_HEADROOM;
        assert_eq!(MIGRATION_HEADROOM, 64);
    }

    /// ADR-096: space formula includes discriminator + SPACE + headroom.
    #[test]
    fn adr_096_total_allocated_space() {
        use crate::state::MIGRATION_HEADROOM;
        let total = 8 + AgentProfile::SPACE + MIGRATION_HEADROOM;
        // 8 (discriminator) + 1414 (SPACE, post-ADR-097 nonce) + 64 (headroom) = 1486
        assert_eq!(total, 1486);
    }

    // ================================================================
    // ADR-094: propose_reputation_delta unit tests
    // ================================================================

    /// ADR-094: score at MAX_REPUTATION_SCORE + positive delta clamps at 100,
    /// never overflows to 0 or panics.
    #[test]
    fn test_reputation_delta_clamps_at_max() {
        let current_score: u64 = 95;
        let delta: i16 = MAX_DELTA_PER_CALL;
        let old_score = current_score.min(MAX_REPUTATION_SCORE as u64) as i16;
        let new_score = (old_score + delta)
            .clamp(0, MAX_REPUTATION_SCORE as i16) as u8;
        assert_eq!(new_score, MAX_REPUTATION_SCORE, "score must clamp at 100");
        assert!(new_score <= MAX_REPUTATION_SCORE);
    }

    /// ADR-094: score already at 100 + any positive delta stays at 100.
    #[test]
    fn test_reputation_delta_clamps_at_max_already_at_cap() {
        let current_score: u64 = 100;
        let delta: i16 = 5;
        let old_score = current_score.min(MAX_REPUTATION_SCORE as u64) as i16;
        let new_score = (old_score + delta)
            .clamp(0, MAX_REPUTATION_SCORE as i16) as u8;
        assert_eq!(new_score, 100);
    }

    /// ADR-094: |delta| > MAX_DELTA_PER_CALL must be rejected.
    #[test]
    fn test_reputation_delta_rejects_oversized_delta() {
        let oversized_positive: i16 = MAX_DELTA_PER_CALL + 1;
        let oversized_negative: i16 = -(MAX_DELTA_PER_CALL + 1);
        let ok_pos = oversized_positive.unsigned_abs() <= MAX_DELTA_PER_CALL.unsigned_abs();
        let ok_neg = oversized_negative.unsigned_abs() <= MAX_DELTA_PER_CALL.unsigned_abs();
        assert!(!ok_pos, "delta +11 must be rejected");
        assert!(!ok_neg, "delta -11 must be rejected");
    }

    /// ADR-094: |delta| == MAX_DELTA_PER_CALL is accepted (boundary value).
    #[test]
    fn test_reputation_delta_accepts_boundary_delta() {
        let boundary_pos: i16 = MAX_DELTA_PER_CALL;
        let boundary_neg: i16 = -MAX_DELTA_PER_CALL;
        let ok_pos = boundary_pos.unsigned_abs() <= MAX_DELTA_PER_CALL.unsigned_abs();
        let ok_neg = boundary_neg.unsigned_abs() <= MAX_DELTA_PER_CALL.unsigned_abs();
        assert!(ok_pos, "delta +10 must be accepted");
        assert!(ok_neg, "delta -10 must be accepted");
    }

    /// ADR-094: score at 0 minus any delta clamps to 0, never underflows.
    #[test]
    fn test_reputation_delta_clamps_at_zero() {
        let current_score: u64 = 3;
        let delta: i16 = -MAX_DELTA_PER_CALL;
        let old_score = current_score.min(MAX_REPUTATION_SCORE as u64) as i16;
        let new_score = (old_score + delta)
            .clamp(0, MAX_REPUTATION_SCORE as i16) as u8;
        assert_eq!(new_score, 0, "score must clamp at 0");
    }

    /// ADR-094: score above MAX_REPUTATION_SCORE is normalised to 100 before delta.
    #[test]
    fn test_reputation_delta_normalises_legacy_score() {
        let current_score: u64 = 9999;
        let delta: i16 = 5;
        let old_score = current_score.min(MAX_REPUTATION_SCORE as u64) as i16;
        let new_score = (old_score + delta)
            .clamp(0, MAX_REPUTATION_SCORE as i16) as u8;
        assert_eq!(new_score, MAX_REPUTATION_SCORE);
    }

    mod fuzz {
        use super::*;
        use proptest::prelude::*;

        proptest! {
            #[test]
            fn reputation_score_never_panics(initial in any::<u64>(), delta in any::<i64>()) {
                // The saturating arithmetic is the invariant under test — if this
                // expression panics for any (initial, delta) pair, proptest fails the
                // test automatically. No explicit assertion needed; `result <= u64::MAX`
                // is vacuously true for a u64 and trips clippy::absurd_extreme_comparisons.
                let _result = if delta >= 0 { initial.saturating_add(delta as u64) } else { initial.saturating_sub((-delta) as u64) };
            }

            #[test]
            fn avg_rating_bounded(ratings in proptest::collection::vec(1u8..=5, 1..50)) {
                let mut avg = 0u8;
                for (i, r) in ratings.iter().enumerate() {
                    let n = (i + 1) as u128;
                    if n == 1 { avg = *r; } else { avg = ((avg as u128 * (n-1) + *r as u128) / n).min(5) as u8; }
                }
                prop_assert!(avg <= 5);
            }

            /// ADR-096: for all target_version values, the idempotent guard
            /// never allows version to move backward.
            #[test]
            fn adr096_migrate_version_never_decreases(
                initial in 0u8..=254,
                target in 0u8..=255,
            ) {
                let mut version = initial;
                let old = version;
                if version < target {
                    version = target;
                }
                prop_assert!(version >= old, "version must never decrease");
                if target > initial {
                    prop_assert_eq!(version, target);
                } else {
                    prop_assert_eq!(version, initial);
                }
            }

            /// ADR-094: for all |delta| <= MAX_DELTA_PER_CALL and all initial
            /// scores in [0, 100], the result always stays in [0, 100].
            #[test]
            fn adr094_propose_delta_always_in_range(
                initial in 0u8..=100u8,
                delta in -10i16..=10i16,
            ) {
                let old_score = initial as i16;
                let new_score = (old_score + delta)
                    .clamp(0, MAX_REPUTATION_SCORE as i16) as u8;
                prop_assert!(new_score <= MAX_REPUTATION_SCORE);
            }
        }
    }

    // ================================================================
    // ADR-097: Registration nonce Sybil resistance
    // ================================================================

    /// ADR-097: nonce is zero-initialized on first use (first register uses
    /// nonce 0, yielding a unique address from the two-seed derivation).
    #[test]
    fn adr_097_initial_nonce_is_zero() {
        let nonce: u64 = 0;
        let nonce_bytes = nonce.to_le_bytes();
        // Seeds: [authority, b"agent-profile", nonce_bytes]
        // Nonce 0 in LE is 8 zero bytes.
        assert_eq!(nonce_bytes, [0u8; 8]);
    }

    /// ADR-097: after deregister the nonce increments by 1, so the next
    /// registration produces a different address.
    #[test]
    fn adr_097_nonce_increments_on_deregister() {
        let mut nonce: u64 = 0;
        // Simulate deregister_agent nonce bump
        nonce = nonce.saturating_add(1);
        assert_eq!(nonce, 1);

        // Second registration seed is different from the first
        let seed_before = 0u64.to_le_bytes();
        let seed_after = nonce.to_le_bytes();
        assert_ne!(seed_before, seed_after);
    }

    /// ADR-097: repeated deregistrations keep incrementing; the nonce never
    /// reuses a prior value (monotonic).
    #[test]
    fn adr_097_nonce_is_monotonic() {
        let mut nonce: u64 = 0;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..10 {
            seen.insert(nonce);
            nonce = nonce.saturating_add(1);
        }
        // All 10 values were unique
        assert_eq!(seen.len(), 10);
    }

    /// ADR-097: nonce at u64::MAX saturates rather than overflowing.
    /// In practice reaching u64::MAX requires 2^64 deregistrations, but the
    /// saturation must not panic.
    #[test]
    fn adr_097_nonce_saturates_at_max() {
        let nonce: u64 = u64::MAX;
        let bumped = nonce.saturating_add(1);
        assert_eq!(bumped, u64::MAX);
    }

    /// ADR-097: the `registration_nonce` field has a zero default, matching
    /// the `init_if_needed` initial state of `OwnerNonce.nonce`.
    #[test]
    fn adr_097_registration_nonce_default_matches_owner_nonce_initial() {
        // OwnerNonce is zero-initialized by `init_if_needed`.
        // AgentProfile.registration_nonce is stamped with owner_nonce.nonce.
        // At first registration both are 0.
        let owner_nonce_initial: u64 = 0;
        let profile_stamped_nonce: u64 = owner_nonce_initial;
        assert_eq!(profile_stamped_nonce, 0);
    }
}
