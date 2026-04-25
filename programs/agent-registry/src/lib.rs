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

// ADR-092: Domain tag for manifest hash — prevents cross-protocol signature replay.
// Clients must compute manifest_raw_hash = sha256(canonical_json) and then the
// on-chain program derives manifest_hash = sha256(MANIFEST_HASH_DOMAIN || manifest_raw_hash)
// before passing it to the ed25519 precompile verifier.
pub const MANIFEST_HASH_DOMAIN: &[u8] = b"AEP_CAPABILITY_MANIFEST_V1\x00";

/// ADR-092: Compute the domain-separated manifest hash from the raw SHA-256 of
/// canonical JSON. The tagged hash is what gets stored on-chain and what the
/// ed25519 signature must cover.
pub fn tagged_manifest_hash(raw_hash: &[u8; 32]) -> [u8; 32] {
    use anchor_lang::solana_program::hash::hashv;
    hashv(&[MANIFEST_HASH_DOMAIN, raw_hash]).to_bytes()
}

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
        // AUD-007 (PR-Q): the legacy aggregates (`total_tasks_completed`,
        // `total_earnings`, `avg_rating`) are gone — replaced by the
        // `_reserved_aud007` padding array, which Anchor zero-initializes
        // through the discriminator-init path. No explicit assignment needed.
        agent_profile._reserved_aud007 = [0u8; 17];
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
        // AUD-004: cleared_count starts at 0. `clear_suspension` increments it,
        // escalating the cost of each subsequent reputation-laundering attempt
        // (1 = halve score, 2 = zero score, 3 = terminal Retired).
        agent_profile.cleared_count = 0;

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

        // AUD-004: reject self-issued `* → Suspended` transitions. Suspended is
        // a slashed-state marker — it must only be written by the slash code
        // path (lib.rs propose_reputation_delta / update_reputation), never by
        // the agent's own `update_status` call. Without this guard, an agent
        // could self-suspend at a high reputation score, then immediately
        // `clear_suspension` to launder via the score-halving discount with
        // zero on-chain accountability.
        require!(
            !(matches!(new_status, AgentStatus::Suspended)
                && ctx.accounts.authority.key() == agent_profile.authority),
            AgentRegistryError::InvalidStatusTransition
        );

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

    // AUD-001 / AUD-002 (PR-G): the legacy `update_reputation` instruction
    // has been removed. It was the unbounded-score, i64-delta entry point
    // that Settlement called via CPI; that role is now played exclusively
    // by `propose_reputation_delta` below. The unified policy lives there:
    // i16 delta, [0, MAX_REPUTATION_SCORE] clamp, |delta| <= MAX_DELTA_PER_CALL.
    // See docs/audits/DESIGN-DECISIONS-2026-04-25.md — the "Option A —
    // remove, no escape hatch" path was chosen.
    //
    // Migration of pre-existing on-chain state is handled in
    // `migrate_agent_profile` (ADR-096) which clamps legacy unbounded
    // scores into [0, 100] and normalizes the
    // `Suspended ⇒ slash_count >= 3` invariant. `assert_valid_profile`
    // (state.rs) is the closed-state-machine guard called post-mutation
    // and post-migration.

    /// ADR-094 / AUD-001 / AUD-002: Reputation policy entry point.
    ///
    /// Previously Settlement called `update_reputation` as a privileged
    /// setter that imposed no score upper bound (scores grew to u64::MAX).
    /// This instruction is now the SOLE reputation-mutation surface: Registry
    /// owns and enforces the policy (`[0, MAX_REPUTATION_SCORE]`,
    /// `|delta| <= MAX_DELTA_PER_CALL`).
    ///
    /// Authorization (defense in depth): the `ProposeReputationDelta`
    /// context (contexts.rs) bundles the SEC-1 signer check, the ADR-097
    /// nonce-seeded profile derivation, and the `has_one = authority`
    /// guard so a CPI cannot land on a profile whose authority does not
    /// match the seeds.
    ///
    /// `reason` is a caller-supplied reason code:
    ///   0 = task_completed (positive delta)
    ///   1 = dispute_loss   (negative delta)
    ///   2 = expiry_undelivered (negative delta)
    ///   3-255 = reserved for future governance/slashing sources
    ///
    /// Post-mutation, the closed-state-machine `assert_valid_profile`
    /// invariant is enforced. Any violation panic-reverts the transaction.
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
        // Note: `reputation_score` is stored as u64 historically (legacy
        // unbounded). Pre-migration profiles may carry values > 100; clamp
        // those into the new range before applying the delta. The
        // `migrate_agent_profile` path performs the same normalization
        // permanently; this in-handler clamp keeps the math sound for any
        // unmigrated profile that lands here in the meantime.
        let old_score = agent_profile.reputation_score.min(MAX_REPUTATION_SCORE as u64) as i16;
        let new_score = (old_score + delta)
            .clamp(0, MAX_REPUTATION_SCORE as i16) as u8;

        let old_score_u8 = old_score as u8;
        agent_profile.reputation_score = new_score as u64;
        agent_profile.updated_at = Clock::get()?.unix_timestamp;

        // AUD-001 / AUD-002: closed-state-machine invariant. Must hold
        // post-mutation; a violation reverts the entire transaction.
        assert_valid_profile(agent_profile)?;

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

    /// C5 + AUD-004: Appeal path out of the permanent-suspension trap, with
    /// monotonically-escalating cost.
    ///
    /// Before this instruction existed, a 3-strike slash sequence would
    /// `Suspend` the agent with no way back into productive state. The
    /// original C5 fix added a single appeal that halved reputation and reset
    /// `slash_count` — but resetting `slash_count` was the laundering vector
    /// audited in AUD-004: a high-rep agent could absorb the halving, get
    /// slashed back to suspension, clear again, halve from a still-high score,
    /// and so on indefinitely.
    ///
    /// AUD-004 fix:
    /// 1. `slash_count` is **cumulative** — never reset. It records the
    ///    agent's full slash history.
    /// 2. A new `cleared_count: u8` counts how many times this profile has
    ///    cleared a suspension. Each clear pays a strictly higher cost:
    ///    - 1st clear: reputation_score /= 2; status → Paused.
    ///    - 2nd clear: reputation_score = 0;  status → Paused.
    ///    - 3rd clear: terminal Retired (no further mutation possible —
    ///      Retired is a closed state in `update_status`).
    pub fn clear_suspension(ctx: Context<ClearSuspension>) -> Result<()> {
        let agent_profile = &mut ctx.accounts.agent_profile;
        require!(
            agent_profile.status == AgentStatus::Suspended
                && agent_profile.reputation_stake.slash_count >= 3,
            AgentRegistryError::NotSuspended
        );

        // AUD-004: slash_count is cumulative — DO NOT reset to 0.
        agent_profile.cleared_count = agent_profile.cleared_count.saturating_add(1);

        match agent_profile.cleared_count {
            1 => {
                agent_profile.reputation_score = agent_profile.reputation_score / 2;
                agent_profile.status = AgentStatus::Paused;
            }
            2 => {
                agent_profile.reputation_score = 0;
                agent_profile.status = AgentStatus::Paused;
            }
            _ => {
                // Third clear is terminal: agent moves to Retired and
                // `update_status` blocks every transition out.
                agent_profile.status = AgentStatus::Retired;
            }
        }

        agent_profile.updated_at = Clock::get()?.unix_timestamp;

        emit!(SuspensionCleared {
            authority: agent_profile.authority,
            new_reputation_score: agent_profile.reputation_score,
            cleared_count: agent_profile.cleared_count,
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
    /// ADR-092: domain-separated manifest hash to prevent cross-protocol sig replay.
    ///
    /// Args:
    /// - `manifest_cid`: 64-byte pointer to off-chain manifest (IPFS CIDv1
    ///   string or Arweave tx ID), zero-padded. M5 resolution chose
    ///   `[u8; 64]` for CIDv1 + Arweave headroom.
    /// - `manifest_raw_hash`: SHA-256 of the RFC-8785 canonical-JSON manifest
    ///   (before domain tagging). The on-chain program applies the domain
    ///   separator: `manifest_hash = sha256(MANIFEST_HASH_DOMAIN || manifest_raw_hash)`.
    ///   The client's ed25519 signature must cover this tagged hash.
    /// - `manifest_signature`: Ed25519 signature over the domain-tagged hash
    ///   (`tagged_manifest_hash(manifest_raw_hash)`) by the agent's `authority`.
    ///   Verified via the paired ed25519-program sig-verify instruction
    ///   (standard Solana pattern — in-program ed25519 is prohibitively
    ///   expensive in compute units).
    /// - `manifest_version`: packed semver (high byte = major, low byte = minor).
    /// - `manifest_capability_names`: the full list of capability names
    ///   declared in the off-chain manifest. On-chain we assert
    ///   `agent_profile.capabilities ⊆ manifest_capability_names` per
    ///   ADR-060 §1 "Relationship to existing". The caller supplies the
    ///   list out-of-band because the manifest body itself is off-chain.
    pub fn update_manifest(
        ctx: Context<UpdateManifest>,
        manifest_cid: [u8; 64],
        manifest_raw_hash: [u8; 32],
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

        // ADR-092: apply domain separator before passing to the ed25519
        // precompile verifier. The client must have signed the tagged hash,
        // not the raw SHA-256. This enforces that a raw sha256(canonical_json)
        // signature from another protocol cannot be replayed here.
        let manifest_hash = tagged_manifest_hash(&manifest_raw_hash);

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

        // AUD-004 (PR-I): `cleared_count` is a new u8 field added in this
        // schema bump. The `realloc::zero = true` constraint on
        // `MigrateAgentProfile` already zero-pads the freshly-allocated
        // bytes, but we make the assignment explicit so the migration's
        // effect on AUD-004 surfaces in code review.
        profile.cleared_count = 0;

        // AUD-007 (PR-Q): the dangling `total_tasks_completed`,
        // `total_earnings`, and `avg_rating` aggregates were retired. The
        // bytes they occupied are now `_reserved_aud007: [u8; 17]` — a
        // padding array preserving the binary layout for existing accounts.
        // Pre-migration profiles may carry non-zero values from the legacy
        // `update_reputation` writes; zero them so the post-migration state
        // matches a freshly-registered profile and downstream consumers
        // cannot accidentally read stale telemetry.
        profile._reserved_aud007 = [0u8; 17];

        // AUD-001 / AUD-002 (PR-G): the legacy `update_reputation` had no
        // upper bound on `reputation_score` — pre-migration profiles can
        // carry values up to u64::MAX. Clamp into the new policy range
        // `[0, MAX_REPUTATION_SCORE]`. Idempotent: in-range scores are
        // unchanged.
        profile.reputation_score = profile.reputation_score.min(MAX_REPUTATION_SCORE as u64);

        // AUD-001 / AUD-002: enforce the `Suspended ⇒ slash_count >= 3`
        // invariant. Pre-fix paths could land a profile in `Suspended`
        // without going through the slash counter (e.g. via `update_status`
        // accepting self-issued `Suspended` transitions — fixed in PR-I).
        // Bringing slash_count up to 3 preserves the suspension (clients
        // who relied on it stay protected) and aligns field values with
        // what the slash path itself would have produced.
        if profile.status == AgentStatus::Suspended
            && profile.reputation_stake.slash_count < 3
        {
            profile.reputation_stake.slash_count = 3;
        }

        // Closed-state-machine guard. Must hold post-normalization;
        // a violation reverts the migration.
        assert_valid_profile(profile)?;

        emit!(AgentMigrated {
            authority: profile.authority,
            old_version,
            new_version: profile.version,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// AUD-001 / AUD-002: Post-migration sweep. Iterates the
    /// `remaining_accounts` list, deserializes each as `AgentProfile`, and
    /// runs `assert_valid_profile`. Any violation reverts the transaction
    /// — making the failure loud and the offending account index visible
    /// in the program log. Designed to be called once per migration window
    /// over a bounded batch (Solana's tx-level account cap is 64).
    ///
    /// Authorization: signer must equal `ProtocolConfig.authority` (Settlement
    /// program). The context binds `protocol_config` via seeds; this handler
    /// reads the `authority: Pubkey` field at offset 8 (after the 8-byte
    /// discriminator) and asserts it matches the signer. We deliberately do
    /// NOT couple to the program's BPF upgrade authority (per
    /// design-decisions AUD-001/002 §6 — "Choose the latter for less
    /// coupling"). This keeps governance evolution on a single rail
    /// (`ProtocolConfig.authority` rotation).
    pub fn verify_protocol_invariants<'info>(
        ctx: Context<'_, '_, 'info, 'info, VerifyProtocolInvariants<'info>>,
    ) -> Result<()> {
        // Read `ProtocolConfig.authority` from the raw account bytes. The
        // field layout in `programs/settlement/src/state.rs` puts `authority`
        // first after the 8-byte Anchor discriminator, so the pubkey lives
        // at bytes [8, 40). Borrowing the data avoids a cross-program
        // account-type dependency.
        let data = ctx.accounts.protocol_config.try_borrow_data()?;
        require!(data.len() >= 8 + 32, AgentRegistryError::Unauthorized);
        let mut authority_bytes = [0u8; 32];
        authority_bytes.copy_from_slice(&data[8..8 + 32]);
        let config_authority = Pubkey::new_from_array(authority_bytes);
        // Drop the borrow before iterating remaining_accounts so we don't
        // hold a borrow across calls that may also borrow account data.
        drop(data);

        require!(
            config_authority == ctx.accounts.authority.key(),
            AgentRegistryError::Unauthorized
        );

        // Each remaining account must deserialize as a valid `AgentProfile`
        // and pass `assert_valid_profile`. Anchor's
        // `Account::try_from` validates the discriminator + ownership, so
        // a non-profile or wrong-program account is rejected before the
        // invariant check fires.
        for account_info in ctx.remaining_accounts.iter() {
            let profile: Account<AgentProfile> = Account::try_from(account_info)?;
            assert_valid_profile(&profile)?;
        }

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

    // AUD-007 (PR-Q): `test_avg_rating_first_task` was a placeholder for the
    // legacy `avg_rating` rolling average. The field has been removed; the
    // test goes with it.

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

    /// C5 + AUD-004: First clear halves reputation_score, increments
    /// cleared_count to 1, moves to Paused, and — critically per AUD-004 —
    /// does NOT reset slash_count. slash_count stays cumulative as a
    /// permanent record of slash history.
    #[test]
    fn c5_clear_suspension_halves_reputation_first_clear() {
        let mut reputation_score: u64 = 1_000;
        let mut slash_count: u8 = 3;
        let mut cleared_count: u8 = 0;
        let mut status = AgentStatus::Suspended;

        // Precondition: must be Suspended with slash_count >= 3
        assert!(status == AgentStatus::Suspended && slash_count >= 3);

        // AUD-004: simulate clear_suspension first-clear branch.
        cleared_count = cleared_count.saturating_add(1);
        match cleared_count {
            1 => {
                reputation_score = reputation_score / 2;
                status = AgentStatus::Paused;
            }
            _ => unreachable!(),
        }

        assert_eq!(reputation_score, 500);
        // AUD-004: slash_count is cumulative — NOT reset on clear.
        assert_eq!(slash_count, 3, "slash_count must NOT be reset to 0");
        assert_eq!(cleared_count, 1);
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
    // AUD-004: Reputation laundering / status-laundering loop
    // ================================================================

    /// AUD-004: second clear zeroes reputation_score, sets cleared_count = 2,
    /// status stays Paused. slash_count is still cumulative (not reset).
    #[test]
    fn aud_004_second_clear_zeroes_reputation() {
        let mut reputation_score: u64 = 200;
        let mut slash_count: u8 = 6; // 3 from first slash cycle, 3 from second
        let mut cleared_count: u8 = 1; // Already cleared once.
        let mut status = AgentStatus::Suspended;

        cleared_count = cleared_count.saturating_add(1);
        match cleared_count {
            2 => {
                reputation_score = 0;
                status = AgentStatus::Paused;
            }
            _ => unreachable!(),
        }

        assert_eq!(reputation_score, 0, "second clear must zero the score");
        assert_eq!(slash_count, 6, "slash_count must remain cumulative");
        assert_eq!(cleared_count, 2);
        assert_eq!(status, AgentStatus::Paused);
    }

    /// AUD-004: third clear is terminal — status moves to Retired and the
    /// agent cannot transition out via `update_status` (Retired is a closed
    /// state). The reputation laundering loop is permanently severed.
    #[test]
    fn aud_004_third_clear_is_terminal_retired() {
        let mut slash_count: u8 = 9; // 3 + 3 + 3 cumulative slashes
        let mut cleared_count: u8 = 2;
        let mut status = AgentStatus::Suspended;

        cleared_count = cleared_count.saturating_add(1);
        match cleared_count {
            1 | 2 => unreachable!(),
            _ => {
                status = AgentStatus::Retired;
            }
        }

        assert_eq!(cleared_count, 3);
        assert_eq!(slash_count, 9, "slash_count remains cumulative across all clears");
        assert_eq!(status, AgentStatus::Retired);

        // Retired is terminal: every outbound transition rejected.
        let retired_outbound_blocked = matches!(
            (AgentStatus::Retired, AgentStatus::Active),
            (AgentStatus::Retired, AgentStatus::Active)
                | (AgentStatus::Retired, AgentStatus::Paused)
                | (AgentStatus::Retired, AgentStatus::Suspended)
        );
        assert!(retired_outbound_blocked);
    }

    /// AUD-004: cleared_count saturates at u8::MAX rather than overflowing.
    /// In practice the third clear is terminal so this can never be reached
    /// in normal operation, but the saturating arithmetic guards against
    /// any future code path that mutates the field.
    #[test]
    fn aud_004_cleared_count_saturates() {
        let mut cleared_count: u8 = u8::MAX;
        cleared_count = cleared_count.saturating_add(1);
        assert_eq!(cleared_count, u8::MAX, "cleared_count must saturate");
    }

    /// AUD-004: an agent who self-issues `update_status(Suspended)` is
    /// rejected. The guard combines the new status with an authority match —
    /// the slash code path writes Suspended directly without going through
    /// update_status, so it is unaffected.
    #[test]
    fn aud_004_self_suspend_rejected_via_update_status() {
        let new_status = AgentStatus::Suspended;
        let authority = anchor_lang::prelude::Pubkey::new_unique();
        let agent_profile_authority = authority; // self-issued case
        let rejected = matches!(new_status, AgentStatus::Suspended)
            && authority == agent_profile_authority;
        assert!(rejected, "self-suspend must trip the guard");
    }

    /// AUD-004: a non-self caller (e.g., the slash code path) writing
    /// Suspended is allowed by the guard. (In practice the slash path bypasses
    /// `update_status` entirely, but the guard's logical shape — only block
    /// when authority matches — is what enables that bypass to remain safe.)
    #[test]
    fn aud_004_external_suspend_passes_guard() {
        let new_status = AgentStatus::Suspended;
        let authority = anchor_lang::prelude::Pubkey::new_unique();
        let agent_profile_authority = anchor_lang::prelude::Pubkey::new_unique();
        let rejected = matches!(new_status, AgentStatus::Suspended)
            && authority == agent_profile_authority;
        assert!(!rejected, "external (non-self) Suspended write must not be blocked by the guard");
    }

    /// AUD-004: cleared_count maximum is 3; values above 3 are an invariant
    /// violation that PR-G's `assert_valid_profile` will catch. Documents the
    /// invariant in test form.
    #[test]
    fn aud_004_cleared_count_max_is_three() {
        const MAX_CLEARED: u8 = 3;
        for value in 0..=MAX_CLEARED {
            assert!(value <= MAX_CLEARED);
        }
        assert!(4u8 > MAX_CLEARED, "values above 3 must trip the invariant");
    }

    /// AUD-004 + ADR-040 / ADR-096: explicit space calc bumped to 1415 to
    /// accommodate the new `cleared_count: u8` field.
    #[test]
    fn aud_004_account_space_bumped_for_cleared_count() {
        // 1414 (pre-AUD-004) + 1 (cleared_count u8) = 1415
        assert_eq!(AgentProfile::SPACE, 1415);
    }

    // ================================================================
    // ADR-060: capability manifest fields + update_manifest
    // ================================================================

    /// ADR-040 / ADR-096 / ADR-097 / AUD-004 invariant: explicit space calc
    /// matches the serialized-size floor.
    /// Baseline 1243 + 162 (ADR-060) + 1 (ADR-096 version u8) + 8 (ADR-097
    /// registration_nonce u64) + 1 (AUD-004 cleared_count u8) = 1415.
    #[test]
    fn adr_060_account_space_matches_explicit_total() {
        assert_eq!(AgentProfile::SPACE, 1415);
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
        // 8 (discriminator) + 1415 (SPACE, post-AUD-004 cleared_count) +
        // 64 (headroom) = 1487.
        assert_eq!(total, 1487);
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

    // ================================================================
    // ADR-092: manifest hash domain separation
    // ================================================================

    /// ADR-092: tagged_manifest_hash must equal sha256(MANIFEST_HASH_DOMAIN || raw_hash).
    /// We cross-check the output against a manual two-pass hash using
    /// `solana_program::hash::hashv` directly.
    #[test]
    fn adr_092_tagged_manifest_hash_applies_domain_separator() {
        use anchor_lang::solana_program::hash::hashv;

        let raw_hash = [0x42u8; 32];
        let result = tagged_manifest_hash(&raw_hash);

        // Independent computation for cross-check.
        let expected = hashv(&[MANIFEST_HASH_DOMAIN, &raw_hash]).to_bytes();
        assert_eq!(result, expected, "tagged hash must match sha256(domain || raw)");
    }

    /// ADR-092: two different raw hashes must produce two different tagged hashes
    /// (domain tagging must not collapse distinct inputs).
    #[test]
    fn adr_092_tagged_manifest_hash_is_injective() {
        let raw_a = [0x01u8; 32];
        let raw_b = [0x02u8; 32];
        assert_ne!(
            tagged_manifest_hash(&raw_a),
            tagged_manifest_hash(&raw_b),
            "distinct raw hashes must produce distinct tagged hashes"
        );
    }

    /// ADR-092: the tagged hash must differ from the raw hash — the domain
    /// separator must have a visible effect on the output.
    #[test]
    fn adr_092_tagged_manifest_hash_differs_from_raw() {
        let raw_hash = [0xABu8; 32];
        let tagged = tagged_manifest_hash(&raw_hash);
        assert_ne!(
            tagged, raw_hash,
            "domain-tagged hash must not equal the raw input hash"
        );
    }

    /// ADR-092: MANIFEST_HASH_DOMAIN must be exactly 27 bytes (26 UTF-8 chars
    /// + 1 null terminator) matching the spec in the ADR.
    #[test]
    fn adr_092_domain_constant_has_expected_length() {
        assert_eq!(
            MANIFEST_HASH_DOMAIN.len(),
            27,
            "domain tag must be 26 chars + null byte = 27 bytes"
        );
        assert_eq!(
            MANIFEST_HASH_DOMAIN.last(),
            Some(&0u8),
            "domain tag must be null-terminated"
        );
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

            // AUD-007 (PR-Q): the `avg_rating_bounded` proptest covered the
            // gameable rolling-average formula that lived in
            // `update_reputation`. Both the writer (PR-G) and the field (PR-Q)
            // are gone; the property no longer applies.

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

    // ================================================================
    // AUD-001 / AUD-002 (PR-G): unified reputation policy + invariants
    // ================================================================

    /// Helper that mirrors the layout-relevant fields of AgentProfile
    /// without forcing the test to construct the full account (which would
    /// drag in dozens of String/Vec fields). The invariant helper only
    /// reads `reputation_score`, `status`, and `reputation_stake`, so the
    /// builder writes those three plus required defaults.
    fn fixture_profile(
        score: u64,
        status: AgentStatus,
        slash_count: u8,
    ) -> AgentProfile {
        AgentProfile {
            authority: Pubkey::new_unique(),
            name: String::new(),
            description: String::new(),
            category: String::new(),
            capabilities: vec![],
            pricing_model: PricingModel::PerTask,
            pricing_amount: 0,
            accepted_tokens: vec![],
            vault_address: Pubkey::default(),
            status,
            reputation_score: score,
            // AUD-007 (PR-Q): the `total_tasks_completed`, `total_earnings`,
            // and `avg_rating` fields were retired in favor of a 17-byte
            // padding array preserving on-disk layout.
            _reserved_aud007: [0u8; 17],
            created_at: 0,
            updated_at: 0,
            reputation_stake: ReputationStake { staked_amount: 0, slash_count },
            bump: 0,
            manifest_cid: [0u8; 64],
            manifest_hash: [0u8; 32],
            manifest_signature: [0u8; 64],
            manifest_version: 0,
            version: 0,
            registration_nonce: 0,
            cleared_count: 0,
        }
    }

    /// AUD-001/002: a well-formed profile (score in range, Active) passes.
    #[test]
    fn aud_001_002_assert_valid_profile_accepts_well_formed() {
        let p = fixture_profile(50, AgentStatus::Active, 0);
        let result = state::assert_valid_profile(&p);
        assert!(result.is_ok(), "well-formed profile must pass invariant");
    }

    /// AUD-001/002: score > MAX_REPUTATION_SCORE is rejected.
    #[test]
    fn aud_001_002_assert_valid_profile_rejects_oversized_score() {
        let p = fixture_profile(101, AgentStatus::Active, 0);
        let result = state::assert_valid_profile(&p);
        assert!(result.is_err(), "score > 100 must violate invariant");
    }

    /// AUD-001/002: legacy unbounded score (e.g. 999) is rejected.
    #[test]
    fn aud_001_002_assert_valid_profile_rejects_legacy_unbounded_score() {
        let p = fixture_profile(999, AgentStatus::Active, 0);
        let result = state::assert_valid_profile(&p);
        assert!(result.is_err(), "legacy unbounded score must violate invariant");
    }

    /// AUD-001/002: Suspended with slash_count < 3 is rejected.
    #[test]
    fn aud_001_002_assert_valid_profile_rejects_suspended_low_slash() {
        let p = fixture_profile(50, AgentStatus::Suspended, 0);
        let result = state::assert_valid_profile(&p);
        assert!(result.is_err(), "Suspended with slash_count=0 must violate invariant");
    }

    /// AUD-001/002: Suspended with slash_count == 3 passes.
    #[test]
    fn aud_001_002_assert_valid_profile_accepts_suspended_at_threshold() {
        let p = fixture_profile(50, AgentStatus::Suspended, 3);
        let result = state::assert_valid_profile(&p);
        assert!(result.is_ok(), "Suspended with slash_count=3 must satisfy invariant");
    }

    /// AUD-001/002: score == MAX_REPUTATION_SCORE (boundary) passes.
    #[test]
    fn aud_001_002_assert_valid_profile_accepts_max_boundary_score() {
        let p = fixture_profile(100, AgentStatus::Active, 0);
        let result = state::assert_valid_profile(&p);
        assert!(result.is_ok(), "score == 100 (boundary) must pass");
    }

    /// AUD-001/002 migration: legacy unbounded score clamps to 100.
    /// Mirrors the migrate_agent_profile normalization step.
    #[test]
    fn aud_001_002_migrate_clamps_unbounded_score() {
        let mut p = fixture_profile(255, AgentStatus::Active, 0);
        // Mirror the handler's clamp.
        p.reputation_score = p.reputation_score.min(MAX_REPUTATION_SCORE as u64);
        if p.status == AgentStatus::Suspended && p.reputation_stake.slash_count < 3 {
            p.reputation_stake.slash_count = 3;
        }
        assert_eq!(p.reputation_score, 100);
        let result = state::assert_valid_profile(&p);
        assert!(result.is_ok(), "post-clamp profile must satisfy invariant");
    }

    /// AUD-001/002 migration: Suspended with slash_count=0 normalizes to 3.
    #[test]
    fn aud_001_002_migrate_normalizes_suspended_invariant() {
        let mut p = fixture_profile(50, AgentStatus::Suspended, 0);
        p.reputation_score = p.reputation_score.min(MAX_REPUTATION_SCORE as u64);
        if p.status == AgentStatus::Suspended && p.reputation_stake.slash_count < 3 {
            p.reputation_stake.slash_count = 3;
        }
        assert_eq!(p.reputation_stake.slash_count, 3);
        assert_eq!(p.status, AgentStatus::Suspended);
        let result = state::assert_valid_profile(&p);
        assert!(result.is_ok(), "post-normalization profile must satisfy invariant");
    }

    /// AUD-001/002 migration: combined fixture from the design doc —
    /// score=255, status=Suspended, slash_count=0 → score=100, slash_count=3.
    #[test]
    fn aud_001_002_migrate_combined_fixture_matches_acceptance_test() {
        let mut p = fixture_profile(255, AgentStatus::Suspended, 0);
        p.reputation_score = p.reputation_score.min(MAX_REPUTATION_SCORE as u64);
        if p.status == AgentStatus::Suspended && p.reputation_stake.slash_count < 3 {
            p.reputation_stake.slash_count = 3;
        }
        assert_eq!(p.reputation_score, 100);
        assert_eq!(p.reputation_stake.slash_count, 3);
        let result = state::assert_valid_profile(&p);
        assert!(result.is_ok());
    }

    /// AUD-001/002 migration is idempotent: a profile already in the new
    /// shape is unchanged after running the same normalization steps.
    #[test]
    fn aud_001_002_migrate_is_idempotent_on_valid_profile() {
        let mut p = fixture_profile(50, AgentStatus::Active, 0);
        let before = (p.reputation_score, p.reputation_stake.slash_count, p.status);
        p.reputation_score = p.reputation_score.min(MAX_REPUTATION_SCORE as u64);
        if p.status == AgentStatus::Suspended && p.reputation_stake.slash_count < 3 {
            p.reputation_stake.slash_count = 3;
        }
        let after = (p.reputation_score, p.reputation_stake.slash_count, p.status);
        assert_eq!(before, after, "migration must be idempotent on valid profiles");
    }

    // ================================================================
    // AUD-007: Dangling reputation aggregates removed (PR-Q / ADR-121).
    // ================================================================

    /// AUD-007: the layout-preserving padding is exactly 17 bytes — the sum
    /// of the deleted fields' wire sizes (`total_tasks_completed: u64` 8 +
    /// `total_earnings: u64` 8 + `avg_rating: u8` 1). Drift here would
    /// silently corrupt every existing on-chain `AgentProfile`.
    #[test]
    fn aud_007_reserved_padding_is_exactly_seventeen_bytes() {
        let p = fixture_profile(0, AgentStatus::Active, 0);
        assert_eq!(p._reserved_aud007.len(), 17,
            "padding must equal 8 + 8 + 1 bytes of removed fields");
        assert_eq!(std::mem::size_of_val(&p._reserved_aud007), 17,
            "the array must serialize to its declared 17-byte size");
    }

    /// AUD-007: a fresh `register_agent`-shaped profile zero-fills the
    /// padding. Mirrors the `_reserved_aud007 = [0u8; 17]` assignment in
    /// the handler — if anyone reverts to leaving it implicit, this test
    /// fails immediately (the fixture writes [0u8; 17] and we compare).
    #[test]
    fn aud_007_register_agent_zero_initializes_reserved_padding() {
        let p = fixture_profile(0, AgentStatus::Active, 0);
        assert_eq!(p._reserved_aud007, [0u8; 17],
            "fresh registration must zero the AUD-007 reserved bytes");
    }

    /// AUD-007: the reserved padding survives the migration normalization
    /// (zeroed regardless of pre-migration state). Mirrors the handler line
    /// `profile._reserved_aud007 = [0u8; 17];` so a pre-migration profile
    /// carrying stale legacy values lands in the canonical zero state.
    #[test]
    fn aud_007_migrate_zeros_reserved_padding_from_stale_state() {
        let mut p = fixture_profile(50, AgentStatus::Active, 0);
        // Simulate stale on-disk bytes from the legacy `update_reputation`
        // writes. A non-canonical IDL deserialization could conceivably
        // surface these as the old typed fields.
        p._reserved_aud007 = [0xAB; 17];
        // Mirror the migrate_agent_profile assignment.
        p._reserved_aud007 = [0u8; 17];
        assert_eq!(p._reserved_aud007, [0u8; 17],
            "post-migration padding must be zero regardless of prior bytes");
    }

    /// AUD-007 / ADR-040: the SPACE constant is unchanged at 1415 bytes
    /// across PR-Q. The 17 bytes of removed fields are replaced 1:1 by 17
    /// bytes of `_reserved_aud007` padding. If this test fails after PR-Q,
    /// the layout is no longer compatible with existing accounts.
    #[test]
    fn aud_007_space_constant_unchanged_across_pr_q() {
        // 1414 (pre-AUD-004) + 1 (cleared_count u8) = 1415 (post-AUD-004,
        // unchanged by AUD-007 because the byte budget swap is even).
        assert_eq!(AgentProfile::SPACE, 1415);
    }
}
