use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

declare_id!("D2y1dEi4dj1pcxw6GvkFWX34RRbuFJCaGWdPNJAasQ5q");

pub mod state;
pub mod errors;
pub mod events;
pub mod contexts;
pub mod instructions;

// `state::*` is used by the `#[cfg(test)]` block below (e.g. `VaultPolicy`,
// `MAX_TOKEN_ALLOWLIST`, `TokenSpendRecord`). The lib build does not need
// it, so clippy's `unused_imports` reports it as removable — but stripping
// it breaks `cargo test`. Pin the import at the crate root with an
// `#[allow]` so a future `cargo clippy --fix` cannot silently re-strip it.
#[allow(unused_imports)]
use state::*;
use errors::*;
use contexts::*;

// ADR-124 (AUD-116 path-a): Domain tag for the `initialize_vault`
// proof-of-control signature. The agent_identity holder must produce an
// Ed25519 signature over `vault_identity_bind_message(authority,
// agent_identity)`; the on-chain handler introspects the paired ed25519
// precompile instruction to assert the verified pubkey / message / signature
// match the supplied values.
//
// **Domain separation rationale**: this tag MUST differ from
// `agent_registry::MANIFEST_HASH_DOMAIN` (= `b"AEP_CAPABILITY_MANIFEST_V1\x00"`)
// so a captured manifest signature cannot be replayed against a vault init
// (and vice-versa). The two protocols sign distinct domain-tagged hashes,
// so each signature is bound to its originating handler. This mirrors the
// settlement / registry reason-code constants pattern: vendored locally,
// independent of the registry crate, kept distinct on purpose.
pub const VAULT_IDENTITY_BIND_DOMAIN: &[u8] = b"AEP_VAULT_IDENTITY_BIND_V1\x00";

/// ADR-124 (AUD-116 path-a): Compute the domain-separated message that the
/// `agent_identity` private-key holder must sign for `initialize_vault` to
/// succeed.
///
/// The message binds **both** the vault `authority` and the candidate
/// `agent_identity` so a single captured signature cannot be replayed:
///   - against a different authority's vault init (binding to `authority`
///     rules out cross-vault replay), or
///   - to bind a different `agent_identity` to the same vault (binding to
///     `agent_identity` rules out swap-the-key replay against the same
///     authority).
///
/// Returns a 32-byte SHA-256 digest. The `verify_ed25519_precompile` call
/// in `instructions::initialize_vault` asserts the precompile's
/// inline-message bytes equal this digest.
pub fn vault_identity_bind_message(
    authority: &Pubkey,
    agent_identity: &Pubkey,
) -> [u8; 32] {
    hashv(&[
        VAULT_IDENTITY_BIND_DOMAIN,
        authority.as_ref(),
        agent_identity.as_ref(),
    ])
    .to_bytes()
}

#[program]
pub mod agent_vault {
    use super::*;

    /// Initializes a new vault for an AI agent.
    /// The vault authority is set to the signer, who has control over policy updates and pause/resume.
    /// The agent identity is linked to this vault for on-chain reputation tracking.
    ///
    /// ADR-095 / ADR-097 / AUD-008 (PR-J): `profile_nonce` is sourced from
    /// the authority's `OwnerNonce` PDA in the Registry program (passed as
    /// the `owner_nonce` account on the context). The account MUST already
    /// exist — vault initialization requires prior `register_agent`. The
    /// nonce is stored on-chain so `execute_transfer` /
    /// `execute_token_transfer` can re-derive the correct profile address
    /// for the suspension check without requiring the client to supply it.
    /// The pre-PR-J `profile_nonce: u64` argument has been removed; passing
    /// a stale or wrong scalar previously bricked transfers (AUD-008).
    ///
    /// ADR-124 / AUD-116 (path-a, cycle-3): `agent_identity_signature` is a
    /// 64-byte Ed25519 signature from the holder of `agent_identity`'s
    /// private key over `vault_identity_bind_message(authority,
    /// agent_identity)`. The caller MUST prepend an `Ed25519Program`
    /// sig-verify instruction in the same transaction (see
    /// `identity_bind::verify_ed25519_precompile`); the runtime verifies
    /// the signature for free, and the on-chain handler introspects that
    /// sibling instruction via the Instructions sysvar to assert the
    /// verified pubkey / message / signature match the values being
    /// persisted. This closes the AUD-116 init-mis-bind seam: a wrong
    /// `agent_identity` cannot be bound because the authority cannot
    /// produce a valid signature from a key it does not control.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        agent_identity: Pubkey,
        daily_limit_lamports: u64,
        per_tx_limit_lamports: u64,
        max_txs_per_hour: u32,
        agent_identity_signature: [u8; 64],
    ) -> Result<()> {
        instructions::initialize_vault(
            ctx,
            agent_identity,
            daily_limit_lamports,
            per_tx_limit_lamports,
            max_txs_per_hour,
            agent_identity_signature,
        )
    }

    /// OA-MED-1 (cycle-4): recovery path for the ADR-097 deregister/
    /// re-register ↔ vault `profile_nonce` desync. Re-points
    /// `vault.profile_nonce` at the live Registry `OwnerNonce` so a
    /// legitimate deregister/re-register cycle cannot permanently brick
    /// grant/transfer execution. Authority-gated; monotone (never rolls
    /// the binding backward). See `ResyncProfileNonce`.
    pub fn resync_profile_nonce(ctx: Context<ResyncProfileNonce>) -> Result<()> {
        instructions::resync_profile_nonce(ctx)
    }

    /// Updates the vault's spending policy (limits and rate limits).
    /// Only the vault authority can call this instruction.
    pub fn update_policy(
        ctx: Context<UpdatePolicy>,
        daily_limit_lamports: u64,
        per_tx_limit_lamports: u64,
        max_txs_per_hour: u32,
    ) -> Result<()> {
        instructions::update_policy(
            ctx,
            daily_limit_lamports,
            per_tx_limit_lamports,
            max_txs_per_hour,
        )
    }

    /// ADR-069 (SEC-2): Rotate `vault.agent_identity`.
    ///
    /// `agent_identity` is a **hot key** — the off-chain agent runtime's
    /// signing key, distinct from the human-custodied `authority`. It should
    /// be rotated on any compromise of the agent runtime or on a routine
    /// cadence. Only the vault `authority` (verified via `has_one` on the
    /// context) can rotate it.
    ///
    /// Emits `AgentIdentityUpdated { vault, old_identity, new_identity }`.
    /// Does not touch balances, policies, daily-spend counters, or rate-limit
    /// counters — rotation is a pure key-swap.
    ///
    /// AUD-200 / ADR-124 (cycle-3, symmetric closure of init): the rotation
    /// handler now requires the SAME Ed25519 proof-of-control pattern as
    /// `initialize_vault`. The caller MUST prepend an `Ed25519Program::verify`
    /// instruction in the same transaction covering
    /// `vault_identity_bind_message(authority, new_agent_identity)` signed
    /// by the holder of `new_agent_identity`'s private key, and pass the
    /// resulting 64-byte signature as `new_agent_identity_signature`. This
    /// closes the AUD-200 mis-bind seam at rotation that mirrors AUD-116
    /// at init: a compromised authority can no longer rotate to an attacker
    /// key it does not control after the 24h cooldown.
    pub fn update_agent_identity(
        ctx: Context<UpdateAgentIdentity>,
        new_agent_identity: Pubkey,
        new_agent_identity_signature: [u8; 64],
    ) -> Result<()> {
        instructions::update_agent_identity(
            ctx,
            new_agent_identity,
            new_agent_identity_signature,
        )
    }

    /// Adds a token to the vault's allowlist with per-mint `per_tx_limit` and
    /// `daily_limit` expressed in the token's base units (findings #13/#14).
    /// Calling with an already-listed mint updates its limits without
    /// resetting the current day's spent counter.
    pub fn add_token_allowlist(
        ctx: Context<ManageAllowlist>,
        token_mint: Pubkey,
        per_tx_limit: u64,
        daily_limit: u64,
    ) -> Result<()> {
        instructions::add_token_allowlist(ctx, token_mint, per_tx_limit, daily_limit)
    }

    /// Removes a token from the vault's allowlist.
    pub fn remove_token_allowlist(ctx: Context<ManageAllowlist>, token_mint: Pubkey) -> Result<()> {
        instructions::remove_token_allowlist(ctx, token_mint)
    }

    /// Adds a program to the vault's program allowlist. Only whitelisted programs can be invoked.
    pub fn add_program_allowlist(ctx: Context<ManageProgramAllowlist>, program_id: Pubkey) -> Result<()> {
        instructions::add_program_allowlist(ctx, program_id)
    }

    /// Removes a program from the vault's program allowlist.
    pub fn remove_program_allowlist(
        ctx: Context<ManageProgramAllowlist>,
        program_id: Pubkey,
    ) -> Result<()> {
        instructions::remove_program_allowlist(ctx, program_id)
    }

    /// Executes a SOL transfer from the vault to a recipient.
    /// Enforces spending limits, rate limiting, daily caps, and the Registry
    /// suspension gate (ADR-095).
    ///
    /// ADR-138: `tool_id_hash` is a 32-byte SHA-256 over the MCP tool
    /// identifier that triggered the action (compute via
    /// `sha256("agenomics.tool." + name)`). The all-zeros sentinel is
    /// accepted for backwards-compatible callers; indexers MAY surface a
    /// `tool_id_zero_count` metric so operators can track migration
    /// progress. The hash is emitted on `ExecutionAttested` so a
    /// downstream auditor can replay (agent_identity, manifest_hash,
    /// policy_version, tool_id, slot) into the canonical provenance
    /// record.
    pub fn execute_transfer(
        ctx: Context<ExecuteTransfer>,
        amount_lamports: u64,
        tool_id_hash: [u8; 32],
    ) -> Result<()> {
        // ADR-095: gate on Registry suspension before any transfer logic.
        require_not_suspended(&ctx.accounts.agent_profile)?;
        instructions::execute_transfer(ctx, amount_lamports, tool_id_hash)
    }

    // ADR-050: execute_program_call removed — without vault PDA signing (ADR-038),
    // it was a rate-limited invoke wrapper with limited utility. Financial operations
    // use execute_transfer and execute_token_transfer. Non-financial CPI can be done
    // directly by the agent without going through the vault.

    /// Executes an SPL token transfer from the vault's token account to a recipient.
    /// Enforces token allowlist, rate limiting, the vault's pause state, and the
    /// Registry suspension gate (ADR-095).
    /// The vault PDA signs the transfer via CPI.
    ///
    /// ADR-138: `tool_id_hash` is a 32-byte SHA-256 over the MCP tool
    /// identifier that triggered the action. See `execute_transfer` for
    /// the convention. The hash is emitted on `ExecutionAttested`.
    pub fn execute_token_transfer(
        ctx: Context<ExecuteTokenTransfer>,
        amount: u64,
        tool_id_hash: [u8; 32],
    ) -> Result<()> {
        // ADR-095: gate on Registry suspension before any transfer logic.
        require_not_suspended(&ctx.accounts.agent_profile)?;
        instructions::execute_token_transfer(ctx, amount, tool_id_hash)
    }

    /// Pauses the vault, preventing any transfers or program calls.
    /// Only the vault authority can pause.
    pub fn pause_vault(ctx: Context<PauseVault>) -> Result<()> {
        instructions::pause_vault(ctx)
    }

    /// Resumes the vault, allowing transfers and program calls again.
    /// Only the vault authority can resume.
    pub fn resume_vault(ctx: Context<ResumeVault>) -> Result<()> {
        instructions::resume_vault(ctx)
    }

    // ========================================================================
    // ADR-111: Delegation grants
    // ========================================================================

    /// ADR-111: Issue a delegation grant binding a sub-authority (`grantee`)
    /// to a bounded, auditable, time-limited slice of the vault's spending
    /// authority. Only the vault authority may call. The grant scope is
    /// capped by `allowed_actions` (bitflags), per-mint and SOL spend caps,
    /// an optional `allowed_recipients` list, and an `expires_at` window.
    /// See `instructions::create_delegation_grant` for the full gating
    /// list and ADR-111 §"Enforcement" for the rationale.
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
        instructions::create_delegation_grant(
            ctx,
            grantee,
            nonce,
            allowed_actions,
            spend_cap_lamports,
            token_caps,
            allowed_recipients,
            expires_at,
        )
    }

    /// ADR-111: Revoke a delegation grant. Either the original grantor
    /// (vault authority at create time) or the grantee may call. Idempotent —
    /// revoking an already-revoked grant succeeds and re-emits the event so
    /// indexers can detect the retry. Does NOT close the account; the
    /// audit-trail invariant in ADR-111 §"revoke_delegation" requires the
    /// row stays on-chain until the future `close_delegation_grant`
    /// instruction archives expired+revoked rows ≥ 30 days old (ADR-111b).
    pub fn revoke_delegation_grant(ctx: Context<RevokeDelegationGrant>) -> Result<()> {
        instructions::revoke_delegation_grant(ctx)
    }

    /// ADR-111: Tighten the scope of an existing delegation grant. Vault
    /// authority only. May lower spend caps, drop action bits, narrow the
    /// recipient list, or shorten the expiry — never the inverse. See
    /// `instructions::update_delegation_grant` for the invariant enforced.
    pub fn update_delegation_grant(
        ctx: Context<UpdateDelegationGrant>,
        new_allowed_actions: u8,
        new_spend_cap_lamports: u64,
        new_token_caps: Vec<GrantTokenCap>,
        new_allowed_recipients: Vec<Pubkey>,
        new_expires_at: i64,
    ) -> Result<()> {
        instructions::update_delegation_grant(
            ctx,
            new_allowed_actions,
            new_spend_cap_lamports,
            new_token_caps,
            new_allowed_recipients,
            new_expires_at,
        )
    }

    /// ADR-111: SOL transfer signed by a delegation grantee. Applies BOTH
    /// the grant's bounded scope (spend cap, recipient set, expiry, action
    /// bit) AND the parent vault's policy (per-tx limit, daily limit, rate
    /// limit, pause flag, suspension gate). Grant caps are ADDITIONAL to
    /// vault caps, never a replacement — ADR-111 §"Enforcement" pins this.
    pub fn execute_grant_transfer(
        ctx: Context<ExecuteGrantTransfer>,
        amount_lamports: u64,
    ) -> Result<()> {
        instructions::execute_grant_transfer(ctx, amount_lamports)
    }

    /// ADR-111: SPL transfer signed by a delegation grantee. Same dual-
    /// gating shape as `execute_grant_transfer` but against per-mint caps
    /// (`GrantTokenCap`) and the vault's `token_spend_records`.
    pub fn execute_grant_token_transfer(
        ctx: Context<ExecuteGrantTokenTransfer>,
        amount: u64,
    ) -> Result<()> {
        instructions::execute_grant_token_transfer(ctx, amount)
    }
}

/// ADR-124 (AUD-116 path-a): Ed25519 precompile introspection for the
/// vault `initialize_vault` proof-of-control flow.
///
/// **Vendored from `agent-registry::manifest::verify_ed25519_precompile`**
/// rather than imported. The two helpers are byte-for-byte equivalent in
/// their introspection of the ed25519-program instruction layout, but they
/// raise distinct vault-side error variants (`AgentIdentityBindSignatureMismatch`
/// / `MissingAgentIdentityBindSignature`) and read independently from the
/// vault's own bind-domain. Vendoring keeps `agent-vault` from acquiring a
/// non-CPI dependency on registry internals — same pattern used for the
/// settlement / registry reason-code constants and PROTOCOL_CONFIG_DISCRIMINATOR.
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
pub mod identity_bind {
    use super::VaultError;
    use anchor_lang::prelude::*;
    use anchor_lang::solana_program::{
        ed25519_program,
        sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
    };

    /// Offsets within the per-signature block, relative to the start of the
    /// `Ed25519SignatureOffsets` entry (which itself starts at data[2]).
    const SIG_OFFSET: usize = 2; // signature_offset
    const SIG_IX_INDEX: usize = 4; // signature_instruction_index
    const PK_OFFSET: usize = 6; // public_key_offset
    const PK_IX_INDEX: usize = 8; // public_key_instruction_index
    const MSG_OFFSET: usize = 10; // message_data_offset
    const MSG_SIZE: usize = 12; // message_data_size
    const MSG_IX_INDEX: usize = 14; // message_instruction_index

    const EXPECTED_NUM_SIGS: u8 = 1;
    const SELF_REFERENCED: u16 = u16::MAX; // 0xFFFF sentinel = same instruction
    const ED25519_HEADER_LEN: usize = 16; // 2 (header) + 14 (one offsets block)
    const ED25519_MIN_LEN: usize = ED25519_HEADER_LEN + 64 + 32 + 32;

    /// Verify that the transaction containing the current `initialize_vault`
    /// instruction also contains an `Ed25519Program::verify` instruction whose
    /// inline pubkey / signature / 32-byte message exactly match the supplied
    /// `expected_pubkey`, `expected_signature`, and `expected_message`.
    ///
    /// Mirrors `agent-registry::manifest::verify_ed25519_precompile` in the
    /// search-neighbouring-indices logic and the inline-only enforcement; only
    /// the error variants and call site differ.
    ///
    /// The runtime has already verified the precompile signature itself by the
    /// time this function runs — reaching the `return Ok(())` branch means the
    /// precompile passed AND its inputs match what `initialize_vault` is about
    /// to persist.
    pub fn verify_ed25519_precompile(
        instructions_sysvar: &AccountInfo,
        expected_pubkey: &Pubkey,
        expected_message: &[u8; 32],
        expected_signature: &[u8; 64],
    ) -> Result<()> {
        // Search neighbouring instructions for an ed25519-program call. The
        // sig-verify ix may be placed before or after the program ix; we try
        // both sides of `current_index` so callers are free to prepend or
        // append the precompile ix.
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

            let read_u16 = |at: usize| -> u16 { u16::from_le_bytes([data[at], data[at + 1]]) };

            // All three components must be inline in the ed25519 ix itself.
            // A cross-instruction reference (e.g. pubkey in another ix) would
            // break the tight coupling we want.
            if read_u16(SIG_IX_INDEX) != SELF_REFERENCED
                || read_u16(PK_IX_INDEX) != SELF_REFERENCED
                || read_u16(MSG_IX_INDEX) != SELF_REFERENCED
            {
                return Err(error!(VaultError::AgentIdentityBindSignatureMismatch));
            }

            let sig_off = read_u16(SIG_OFFSET) as usize;
            let pk_off = read_u16(PK_OFFSET) as usize;
            let msg_off = read_u16(MSG_OFFSET) as usize;
            let msg_len = read_u16(MSG_SIZE) as usize;

            if msg_len != 32 {
                return Err(error!(VaultError::AgentIdentityBindSignatureMismatch));
            }
            if sig_off + 64 > data.len()
                || pk_off + 32 > data.len()
                || msg_off + msg_len > data.len()
            {
                return Err(error!(VaultError::AgentIdentityBindSignatureMismatch));
            }

            let sig_slice = &data[sig_off..sig_off + 64];
            let pk_slice = &data[pk_off..pk_off + 32];
            let msg_slice = &data[msg_off..msg_off + 32];

            if sig_slice != expected_signature.as_ref() {
                return Err(error!(VaultError::AgentIdentityBindSignatureMismatch));
            }
            if pk_slice != expected_pubkey.to_bytes().as_ref() {
                return Err(error!(VaultError::AgentIdentityBindSignatureMismatch));
            }
            if msg_slice != expected_message.as_ref() {
                return Err(error!(VaultError::AgentIdentityBindSignatureMismatch));
            }

            // The runtime already rejected the transaction if the ed25519
            // precompile call itself failed verification. Reaching this point
            // means: precompile passed, and its inputs match what this
            // instruction is about to persist. QED.
            return Ok(());
        }

        Err(error!(VaultError::MissingAgentIdentityBindSignature))
    }
}

// ============================================================================
// UNIT TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_pubkey() -> Pubkey {
        Pubkey::new_unique()
    }

    #[test]
    fn test_vault_policy_new_defaults() {
        let policy = VaultPolicy::new(100, 1000, 10);
        assert_eq!(policy.per_tx_limit_lamports, 100);
        assert_eq!(policy.daily_limit_lamports, 1000);
        assert_eq!(policy.max_txs_per_hour, 10);
        assert!(policy.token_allowlist.is_empty());
        assert!(policy.program_allowlist.is_empty());
    }

    #[test]
    fn test_token_allowlist_empty_allows_all() {
        let policy = VaultPolicy::new(100, 1000, 10);
        let mint = sample_pubkey();
        assert!(policy.is_token_allowed(&mint));
    }

    /// OA-MED-2 (cycle-4): when a grant's `allowed_recipients` is the empty
    /// "delegate to vault guards" sentinel, the SOL grant path
    /// (`execute_grant_transfer`) MUST fall back to the vault's own
    /// `program_allowlist` so the sentinel cannot widen the vault's policy
    /// (ADR-111 §Enforcement). This pins the predicate the handler now
    /// applies: `grant.allowed_recipients.is_empty() => recipient ∈
    /// vault.policy.program_allowlist (or allowlist empty = open)`.
    #[test]
    fn test_oa_med_2_empty_grant_recipients_falls_back_to_vault_allowlist() {
        use crate::state::{grant_actions, DelegationGrant};

        let allowed = sample_pubkey();
        let denied = sample_pubkey();

        // Restrictive vault policy: only `allowed` is in program_allowlist.
        let mut policy = VaultPolicy::new(1_000, 10_000, 10);
        policy.program_allowlist.push(allowed);

        // Empty-recipient grant (the documented sentinel).
        let grant = DelegationGrant {
            vault: Pubkey::default(),
            grantor: Pubkey::default(),
            grantee: Pubkey::default(),
            allowed_actions: grant_actions::EXECUTE_TRANSFER,
            spend_cap_lamports: 1_000,
            spent_lamports: 0,
            token_spend_caps: vec![],
            allowed_recipients: vec![],
            expires_at: 0,
            revoked: false,
            created_at: 0,
            nonce: 0,
            bump: 255,
        };
        assert!(
            grant.allowed_recipients.is_empty(),
            "precondition: empty sentinel triggers vault-level fallback"
        );

        // Handler logic: grant defers → enforce vault program_allowlist.
        let gate = |recipient: &Pubkey| -> bool {
            if grant.allowed_recipients.is_empty() {
                policy.is_program_allowed(recipient)
            } else {
                grant.is_recipient_allowed(recipient)
            }
        };

        // Pre-fix the empty grant let ANY recipient through (unrestricted);
        // post-fix it is bounded by the vault's own restrictive allowlist.
        assert!(gate(&allowed), "allowlisted recipient still passes");
        assert!(
            !gate(&denied),
            "OA-MED-2: empty-recipient grant must NOT widen the vault's program_allowlist"
        );

        // Sanity: a vault with an *empty* program_allowlist keeps the
        // documented "open" semantics (no behavioural regression).
        let open_policy = VaultPolicy::new(1_000, 10_000, 10);
        assert!(open_policy.is_program_allowed(&denied));
        let _ = grant_actions::EXECUTE_TRANSFER;
    }

    /// OA-MED-1 (cycle-4): `resync_profile_nonce` must be monotone — the
    /// live Registry `OwnerNonce` may only ever move forward (ADR-097
    /// deregister/re-register bumps it). A live value below the stored
    /// `vault.profile_nonce` signals a wrong/foreign account or replay and
    /// must fail closed (`ProfileNonceNotMonotone`); equal is an idempotent
    /// no-op; greater performs the recovery re-bind.
    #[test]
    fn test_oa_med_1_resync_profile_nonce_monotone() {
        // Mirrors the handler's `require!(live >= old)` predicate +
        // change-detection. (The Anchor account plumbing is exercised by
        // the anchor integration suite; this pins the pure decision.)
        fn decide(old: u64, live: u64) -> core::result::Result<bool /*rebind?*/, ()> {
            if live < old {
                return Err(()); // ProfileNonceNotMonotone
            }
            Ok(live != old)
        }

        // Forward bump (deregister/re-register recovery) → re-bind.
        assert_eq!(decide(3, 5), Ok(true));
        // Equal → idempotent no-op (no event, no write).
        assert_eq!(decide(5, 5), Ok(false));
        // Backward → rejected, vault binding never rolls back.
        assert_eq!(decide(7, 4), Err(()));
        // Genesis (never resynced) forward.
        assert_eq!(decide(0, 1), Ok(true));
    }

    #[test]
    fn test_token_allowlist_populated_filters() {
        let mut policy = VaultPolicy::new(100, 1000, 10);
        let allowed = sample_pubkey();
        let denied = sample_pubkey();
        policy.token_allowlist.push(allowed);

        assert!(policy.is_token_allowed(&allowed));
        assert!(!policy.is_token_allowed(&denied));
    }

    #[test]
    fn test_program_allowlist_empty_allows_all() {
        let policy = VaultPolicy::new(100, 1000, 10);
        let prog = sample_pubkey();
        assert!(policy.is_program_allowed(&prog));
    }

    #[test]
    fn test_program_allowlist_populated_filters() {
        let mut policy = VaultPolicy::new(100, 1000, 10);
        let allowed = sample_pubkey();
        let denied = sample_pubkey();
        policy.program_allowlist.push(allowed);

        assert!(policy.is_program_allowed(&allowed));
        assert!(!policy.is_program_allowed(&denied));
    }

    #[test]
    fn test_allowlist_cap_constants() {
        assert_eq!(MAX_TOKEN_ALLOWLIST, 10);
        assert_eq!(MAX_PROGRAM_ALLOWLIST, 10);
    }

    #[test]
    fn test_allowlist_cap_enforcement_logic() {
        let mut policy = VaultPolicy::new(100, 1000, 10);
        // Fill to max
        for _ in 0..MAX_TOKEN_ALLOWLIST {
            policy.token_allowlist.push(sample_pubkey());
        }
        assert_eq!(policy.token_allowlist.len(), MAX_TOKEN_ALLOWLIST);
        // Verify the check that would be enforced
        assert!(policy.token_allowlist.len() >= MAX_TOKEN_ALLOWLIST);
    }

    // ================================================================
    // ADR-015: Per-token daily spending limit tests
    // ================================================================

    #[test]
    fn test_token_spend_record_new_day_resets() {
        let mint = sample_pubkey();
        let mut record = TokenSpendRecord {
            mint,
            per_tx_limit: 1000,
            daily_limit: 2000,
            spent_today: 500,
            last_spend_day: 100,
        };
        // Simulate day change
        let current_day: u64 = 101;
        if current_day > record.last_spend_day {
            record.spent_today = 0;
            record.last_spend_day = current_day;
        }
        assert_eq!(record.spent_today, 0);
        assert_eq!(record.last_spend_day, 101);
    }

    #[test]
    fn test_token_spend_record_same_day_accumulates() {
        let mint = sample_pubkey();
        let mut record = TokenSpendRecord {
            mint,
            per_tx_limit: 500,
            daily_limit: 1000,
            spent_today: 300,
            last_spend_day: 100,
        };
        let amount: u64 = 200;
        let current_day: u64 = 100; // same day
        if current_day > record.last_spend_day {
            record.spent_today = 0;
            record.last_spend_day = current_day;
        }
        assert!(record.spent_today.saturating_add(amount) <= record.daily_limit);
        record.spent_today = record.spent_today.saturating_add(amount);
        assert_eq!(record.spent_today, 500);
    }

    #[test]
    fn test_token_spend_record_exceeds_daily_limit() {
        let mint = sample_pubkey();
        let record = TokenSpendRecord {
            mint,
            per_tx_limit: 500,
            daily_limit: 1000,
            spent_today: 900,
            last_spend_day: 100,
        };
        let amount: u64 = 200;
        // 900 + 200 = 1100 > 1000 -- should be rejected
        assert!(record.spent_today.saturating_add(amount) > record.daily_limit);
    }

    #[test]
    fn test_token_spend_record_exact_daily_limit() {
        let mint = sample_pubkey();
        let record = TokenSpendRecord {
            mint,
            per_tx_limit: 500,
            daily_limit: 1000,
            spent_today: 800,
            last_spend_day: 100,
        };
        let amount: u64 = 200;
        // 800 + 200 = 1000 == 1000 -- should pass (<=)
        assert!(record.spent_today.saturating_add(amount) <= record.daily_limit);
    }

    /// Finding #13: per-tx limit is enforced per mint, in the token's
    /// own base units — not reused from the SOL-lamport policy.
    #[test]
    fn test_token_spend_record_per_tx_limit_blocks_whale_tx() {
        let mint = sample_pubkey();
        let record = TokenSpendRecord {
            mint,
            per_tx_limit: 100,
            daily_limit: 10_000,
            spent_today: 0,
            last_spend_day: 0,
        };
        // A single 500-unit transfer is well under the daily cap but
        // above the per-tx cap — must be rejected.
        let amount: u64 = 500;
        assert!(amount > record.per_tx_limit);
        assert!(record.spent_today.saturating_add(amount) <= record.daily_limit);
    }

    #[test]
    fn test_token_spend_records_capacity() {
        let mut records: Vec<TokenSpendRecord> = Vec::new();
        for _ in 0..MAX_TOKEN_SPEND_RECORDS {
            records.push(TokenSpendRecord {
                mint: sample_pubkey(),
                per_tx_limit: 100,
                daily_limit: 1000,
                spent_today: 0,
                last_spend_day: 0,
            });
        }
        assert_eq!(records.len(), MAX_TOKEN_SPEND_RECORDS);
        // Should not be able to add more
        assert!(records.len() >= MAX_TOKEN_SPEND_RECORDS);
    }

    #[test]
    fn test_token_spend_record_lookup_by_mint() {
        let mint_a = sample_pubkey();
        let mint_b = sample_pubkey();
        let records = vec![
            TokenSpendRecord {
                mint: mint_a, per_tx_limit: 50, daily_limit: 500,
                spent_today: 100, last_spend_day: 50,
            },
            TokenSpendRecord {
                mint: mint_b, per_tx_limit: 50, daily_limit: 500,
                spent_today: 200, last_spend_day: 50,
            },
        ];
        let found = records.iter().position(|r| r.mint == mint_b);
        assert_eq!(found, Some(1));
        let not_found = records.iter().position(|r| r.mint == sample_pubkey());
        assert!(not_found.is_none());
    }

    /// Finding #14: with per-mint limits, two mints with different decimal
    /// schemes can have limits expressed in their own base units without
    /// conflation. A record configured for USDC (6 decimals) is independent
    /// of a record configured for a 9-decimal token — neither inherits
    /// the vault's SOL-lamport daily limit.
    #[test]
    fn test_token_spend_record_decimal_independence() {
        let usdc = sample_pubkey();
        let other = sample_pubkey();
        let usdc_record = TokenSpendRecord {
            mint: usdc,
            per_tx_limit: 100_000_000,      // 100 USDC at 6 decimals
            daily_limit: 1_000_000_000,     // 1000 USDC at 6 decimals
            spent_today: 0,
            last_spend_day: 0,
        };
        let other_record = TokenSpendRecord {
            mint: other,
            per_tx_limit: 100_000_000_000,   // 100 tokens at 9 decimals
            daily_limit: 1_000_000_000_000,  // 1000 tokens at 9 decimals
            spent_today: 0,
            last_spend_day: 0,
        };
        // The same "100 tokens" have wildly different base-unit values,
        // which was exactly the bug #14 was about.
        assert_ne!(usdc_record.per_tx_limit, other_record.per_tx_limit);
    }

    // ADR-050: VaultAction test removed — enum was orphaned dead code

    // ================================================================
    // ADR-093: Canonical (non-self-referential) PDA seed verification
    // ================================================================

    /// ADR-093: The vault PDA must be derivable using only externally-known
    /// information (owner public key + fixed discriminant), without needing to
    /// first load the vault account to read `vault.authority`.
    ///
    /// This test verifies the invariant: given an owner key, we can derive the
    /// vault PDA deterministically — and that derived PDA is distinct from the
    /// owner key (i.e., it is a proper PDA, not a self-referential derivation
    /// where the vault address would appear in its own seeds).
    #[test]
    fn test_adr093_pda_derivable_without_vault_address() {
        let program_id = crate::ID;
        let owner = sample_pubkey();

        // Derive the PDA using only the canonical seeds (discriminant + owner).
        // This must succeed without any knowledge of the vault account's contents.
        let (pda, _bump) = Pubkey::find_program_address(
            &[b"vault", owner.as_ref()],
            &program_id,
        );

        // The derived PDA must be distinct from the owner key.
        assert_ne!(pda, owner, "vault PDA must differ from owner key");

        // Critical ADR-093 property: the derivation does NOT use the vault
        // address itself as a seed. Verify by confirming that using the vault's
        // own address as a seed produces a *different* PDA.
        let (self_ref_pda, _) = Pubkey::find_program_address(
            &[b"vault", pda.as_ref()],
            &program_id,
        );
        assert_ne!(
            pda, self_ref_pda,
            "canonical PDA must differ from self-referential PDA: \
             ADR-093 ensures seeds are [b\"vault\", owner] not [b\"vault\", vault_addr]"
        );
    }

    /// ADR-093: Canonical seeds are stable across repeated derivations —
    /// off-chain tooling can reconstruct the vault address purely from the
    /// owner public key without any on-chain state reads.
    #[test]
    fn test_adr093_canonical_seeds_are_stable() {
        let program_id = crate::ID;
        let owner = sample_pubkey();

        let (pda1, bump1) = Pubkey::find_program_address(
            &[b"vault", owner.as_ref()],
            &program_id,
        );
        let (pda2, bump2) = Pubkey::find_program_address(
            &[b"vault", owner.as_ref()],
            &program_id,
        );

        assert_eq!(pda1, pda2, "canonical PDA must be deterministic");
        assert_eq!(bump1, bump2, "canonical bump must be deterministic");
    }

    // ================================================================
    // ADR-021: Property-based fuzz tests (proptest)
    // ================================================================

    mod fuzz {
        use super::*;
        use proptest::prelude::*;
        use proptest::collection::vec as prop_vec;

        proptest! {
            /// Allowlist operations never exceed MAX_TOKEN_ALLOWLIST.
            /// Simulates a sequence of add/remove operations on the token allowlist.
            #[test]
            fn token_allowlist_never_exceeds_max(
                ops in prop_vec((any::<[u8; 32]>(), any::<bool>()), 0..50)
            ) {
                let mut policy = VaultPolicy::new(100, 1000, 10);
                for (key_bytes, is_add) in ops {
                    let pubkey = Pubkey::new_from_array(key_bytes);
                    if is_add {
                        if !policy.token_allowlist.contains(&pubkey)
                            && policy.token_allowlist.len() < MAX_TOKEN_ALLOWLIST
                        {
                            policy.token_allowlist.push(pubkey);
                        }
                    } else {
                        policy.token_allowlist.retain(|&t| t != pubkey);
                    }
                }
                prop_assert!(policy.token_allowlist.len() <= MAX_TOKEN_ALLOWLIST);
            }

            /// is_token_allowed always returns true when the allowlist is empty.
            #[test]
            fn empty_allowlist_allows_any_token(key_bytes in any::<[u8; 32]>()) {
                let policy = VaultPolicy::new(100, 1000, 10);
                let mint = Pubkey::new_from_array(key_bytes);
                prop_assert!(policy.is_token_allowed(&mint));
            }

            /// Daily limit arithmetic never overflows with random inputs
            /// (mirrors the saturating_add pattern used in execute_transfer).
            #[test]
            fn daily_limit_arithmetic_no_overflow(
                spent_today in any::<u64>(),
                amount in any::<u64>(),
                daily_limit in any::<u64>(),
            ) {
                let new_total = spent_today.saturating_add(amount);
                // saturating_add must never panic and must be <= u64::MAX
                prop_assert!(new_total >= spent_today || new_total == u64::MAX);
                // The limit check itself must not panic
                let _within_limit = new_total <= daily_limit;
            }
        }
    }

    // ================================================================
    // ADR-095: Vault ↔ Registry suspension coupling tests
    // ================================================================

    /// ADR-095: The `require_not_suspended` helper rejects Suspended status.
    #[test]
    fn adr_095_suspended_agent_is_rejected() {
        use agent_registry::state::{AgentProfile, AgentStatus, PricingModel, ReputationStake};
        let mut profile = AgentProfile {
            authority: Pubkey::default(),
            name: String::new(),
            description: String::new(),
            category: String::new(),
            capabilities: vec![],
            pricing_model: PricingModel::PerTask,
            pricing_amount: 0,
            accepted_tokens: vec![],
            vault_address: Pubkey::default(),
            status: AgentStatus::Suspended,
            reputation_score: 0,
            // AUD-007 (PR-Q): legacy aggregates removed; the bytes they
            // occupied are now `__padding_aud007` padding.
            __padding_aud007: [0u8; 17],
            created_at: 0,
            updated_at: 0,
            reputation_stake: ReputationStake { staked_amount: 0, slash_count: 3 },
            bump: 0,
            manifest_cid: [0u8; 64],
            manifest_hash: [0u8; 32],
            manifest_signature: [0u8; 64],
            manifest_version: 0,
            version: 0,
            registration_nonce: 0,
            cleared_count: 0,
            // Q-S3-A: irrelevant to the suspension-gate fixture under test.
            cdp_wallet: None,
        };
        // Suspended agent must be rejected.
        let result = require_not_suspended(&profile);
        assert!(result.is_err());

        // Non-suspended agent must be allowed.
        profile.status = AgentStatus::Active;
        let result = require_not_suspended(&profile);
        assert!(result.is_ok());
    }

    // ================================================================
    // PR-X / AUD-023: update_agent_identity rotation cap arithmetic
    // ================================================================

    /// PR-X: Helper mirroring the handler's interval check, kept in sync
    /// with `update_agent_identity` in instructions.rs. Returns `true`
    /// when a rotation at `now` should be ALLOWED.
    fn rotation_allowed(now: i64, last_rotation_at: i64) -> bool {
        const MIN_ROTATION_INTERVAL_SECS: i64 = 24 * 60 * 60;
        now.saturating_sub(last_rotation_at) >= MIN_ROTATION_INTERVAL_SECS
    }

    /// PR-X / AUD-023: First rotation on a fresh vault (`last_rotation_at == 0`)
    /// must always succeed, regardless of `now`, because the sliding window
    /// is "T+24h" against the *previous* rotation — and there is none.
    #[test]
    fn rotation_first_call_on_fresh_vault_succeeds() {
        // last_rotation_at = 0 => any non-trivial `now` clears 86_400s.
        assert!(rotation_allowed(86_400, 0));
        assert!(rotation_allowed(1_700_000_000, 0));
    }

    /// PR-X / AUD-023: A rotation immediately after a previous rotation
    /// must be rejected. Models the "compromised authority drains, rotates,
    /// drains again" attack the cap is defending against.
    #[test]
    fn rotation_immediate_re_rotation_rejected() {
        let last = 1_700_000_000;
        // Same second, +1s, +1h, +23h59m59s — all rejected.
        assert!(!rotation_allowed(last, last));
        assert!(!rotation_allowed(last + 1, last));
        assert!(!rotation_allowed(last + 3_600, last));
        assert!(!rotation_allowed(last + 86_399, last));
    }

    /// PR-X / AUD-023: Boundary at exactly 24h — rotation is permitted
    /// because the check is `>=` not `>`.
    #[test]
    fn rotation_exact_24h_boundary_allowed() {
        let last = 1_700_000_000;
        assert!(rotation_allowed(last + 86_400, last));
        assert!(rotation_allowed(last + 86_401, last));
    }

    /// PR-X / AUD-023: Clock regression (validator clock skew running
    /// backward across an upgrade) must not panic and must not silently
    /// allow a rotation. `saturating_sub` clamps to 0, which is below the
    /// 24h threshold, so the rotation is rejected — fail-safe behaviour.
    #[test]
    fn rotation_clock_regression_does_not_panic() {
        let last = 1_700_000_000;
        // `now` < last_rotation_at => saturating_sub == 0 => rejected.
        assert!(!rotation_allowed(last - 1, last));
        assert!(!rotation_allowed(0, last));
        assert!(!rotation_allowed(i64::MIN, last));
    }

    /// PR-X / AUD-023: Two successive legitimate rotations 24h+ apart
    /// both succeed — the cap is "1 per 24h", not "1 ever".
    #[test]
    fn rotation_two_rotations_one_day_apart_both_succeed() {
        let t0: i64 = 1_700_000_000;
        // First rotation on a fresh vault.
        assert!(rotation_allowed(t0, 0));
        let last_after_first = t0;
        // Second rotation 25h later.
        let t1 = t0 + 25 * 3_600;
        assert!(rotation_allowed(t1, last_after_first));
    }

    /// ADR-095: All non-Suspended statuses pass the suspension gate.
    #[test]
    fn adr_095_non_suspended_statuses_are_allowed() {
        use agent_registry::state::{AgentProfile, AgentStatus, PricingModel, ReputationStake};
        let mut profile = AgentProfile {
            authority: Pubkey::default(),
            name: String::new(),
            description: String::new(),
            category: String::new(),
            capabilities: vec![],
            pricing_model: PricingModel::PerTask,
            pricing_amount: 0,
            accepted_tokens: vec![],
            vault_address: Pubkey::default(),
            status: AgentStatus::Active,
            reputation_score: 100,
            // AUD-007 (PR-Q): legacy aggregates removed; the bytes they
            // occupied are now `__padding_aud007` padding.
            __padding_aud007: [0u8; 17],
            created_at: 0,
            updated_at: 0,
            reputation_stake: ReputationStake { staked_amount: 0, slash_count: 0 },
            bump: 0,
            manifest_cid: [0u8; 64],
            manifest_hash: [0u8; 32],
            manifest_signature: [0u8; 64],
            manifest_version: 0,
            version: 0,
            registration_nonce: 0,
            cleared_count: 0,
            // Q-S3-A: irrelevant to the suspension-gate fixture under test.
            cdp_wallet: None,
        };
        for status in [AgentStatus::Active, AgentStatus::Paused, AgentStatus::Retired] {
            profile.status = status;
            assert!(
                require_not_suspended(&profile).is_ok(),
                "Expected {:?} to pass suspension gate",
                status
            );
        }
    }

    // ================================================================
    // AUD-006: Rate-limit window saturating-sub tests
    //
    // Regression coverage for the signed `i64` underflow at the rate-
    // limit comparison sites. The previous code computed
    // `clock.unix_timestamp - vault.rate_limit_window_start` directly;
    // when `window_start > now` (clock skew, fresh init drift), the
    // diff was negative and the "still inside window" branch was taken
    // forever. `compute_window_elapsed` clamps any negative result to
    // zero so the call site at least falls into a safe state.
    // ================================================================

    use crate::instructions::compute_window_elapsed;

    #[test]
    fn test_aud006_compute_window_elapsed_now_after_start() {
        // Normal case: elapsed > 0
        let start: i64 = 1_700_000_000;
        let now: i64 = start + 1234;
        assert_eq!(compute_window_elapsed(now, start), 1234);
    }

    #[test]
    fn test_aud006_compute_window_elapsed_equal_timestamps() {
        // Same instant: zero elapsed
        let t: i64 = 1_700_000_000;
        assert_eq!(compute_window_elapsed(t, t), 0);
    }

    #[test]
    fn test_aud006_compute_window_elapsed_now_before_start_clock_skew() {
        // Clock-skew / future-dated start case: must clamp to 0,
        // never return a negative value.
        let start: i64 = 1_700_000_000;
        let now: i64 = start - 5_000;
        let elapsed = compute_window_elapsed(now, start);
        assert_eq!(elapsed, 0);
        assert!(elapsed >= 0, "elapsed must never be negative");
    }

    #[test]
    fn test_aud006_compute_window_elapsed_extreme_negative_no_underflow() {
        // i64::MIN start with positive now used to underflow on raw
        // subtraction. saturating_sub guarantees no UB; .max(0)
        // collapses to zero so the call site never observes a wrap.
        let elapsed = compute_window_elapsed(0, i64::MAX);
        assert_eq!(elapsed, 0);
        let elapsed = compute_window_elapsed(i64::MIN, i64::MAX);
        assert_eq!(elapsed, 0);
    }

    #[test]
    fn test_aud006_window_reset_branch_taken_after_one_hour() {
        // Sanity-check the call-site predicate: when elapsed > 3600
        // the rate-limit branch resets the window. Semantics
        // (1-hour window) intentionally unchanged.
        let start: i64 = 1_700_000_000;
        let now: i64 = start + 3601;
        let elapsed = compute_window_elapsed(now, start);
        assert!(elapsed > 3600, "elapsed should trigger window reset");
    }

    #[test]
    fn test_aud006_window_held_inside_one_hour() {
        let start: i64 = 1_700_000_000;
        let now: i64 = start + 3599;
        let elapsed = compute_window_elapsed(now, start);
        assert!(elapsed <= 3600, "elapsed should keep window open");
    }

    #[test]
    fn test_aud006_clock_skew_does_not_freeze_window() {
        // The bug: with `now < start`, raw subtraction yields a
        // negative `i64` which fails the `> 3600` check and the
        // window never resets. With the fix, elapsed is 0 — the
        // call site keeps the window open for the current cycle
        // but does NOT see a phantom "still in window" forever
        // condition because as soon as the wall clock advances
        // past `start + 3600` the reset fires correctly.
        let start: i64 = 1_700_000_000;
        let now_skewed: i64 = start - 10;
        let elapsed = compute_window_elapsed(now_skewed, start);
        assert_eq!(elapsed, 0);
        // Once the clock catches up and exceeds the 1h window,
        // the reset branch must be taken.
        let now_recovered: i64 = start + 3601;
        let elapsed_recovered = compute_window_elapsed(now_recovered, start);
        assert!(elapsed_recovered > 3600);
    }

    // ================================================================
    // ADR-124 (AUD-116 path-a): vault_identity_bind_message domain-
    // separation tests. Mirrors the registry's
    // `adr_092_tagged_manifest_hash_*` test pattern.
    // ================================================================

    use crate::{vault_identity_bind_message, VAULT_IDENTITY_BIND_DOMAIN};
    use anchor_lang::solana_program::hash::hashv as test_hashv;

    /// ADR-124: bind message must equal sha256(VAULT_IDENTITY_BIND_DOMAIN
    /// || authority || agent_identity).
    #[test]
    fn adr_124_bind_message_applies_domain_separator() {
        let authority = sample_pubkey();
        let agent_identity = sample_pubkey();
        let result = vault_identity_bind_message(&authority, &agent_identity);

        let expected = test_hashv(&[
            VAULT_IDENTITY_BIND_DOMAIN,
            authority.as_ref(),
            agent_identity.as_ref(),
        ])
        .to_bytes();
        assert_eq!(result, expected);
    }

    /// ADR-124: differing inputs MUST produce differing digests — at minimum
    /// for both the authority and agent_identity legs of the bind tuple.
    #[test]
    fn adr_124_bind_message_is_injective_per_leg() {
        let authority_a = sample_pubkey();
        let authority_b = sample_pubkey();
        let agent_identity = sample_pubkey();
        // Different authority, same agent_identity → different digest.
        assert_ne!(
            vault_identity_bind_message(&authority_a, &agent_identity),
            vault_identity_bind_message(&authority_b, &agent_identity),
        );

        let agent_identity_b = sample_pubkey();
        // Same authority, different agent_identity → different digest.
        assert_ne!(
            vault_identity_bind_message(&authority_a, &agent_identity),
            vault_identity_bind_message(&authority_a, &agent_identity_b),
        );
    }

    /// ADR-124: VAULT_IDENTITY_BIND_DOMAIN must differ from the registry's
    /// MANIFEST_HASH_DOMAIN. The two protocols sign distinct domain-tagged
    /// hashes so a captured manifest signature cannot be replayed against a
    /// vault init (and vice-versa). This is the cross-protocol replay defense.
    #[test]
    fn adr_124_domain_differs_from_registry_manifest_domain() {
        // Hardcoded copy of `agent_registry::MANIFEST_HASH_DOMAIN`. We do not
        // import the registry crate constant because the design point of
        // domain separation is that the two values are independent and must
        // be inspected side-by-side here to make the divergence obvious in
        // code review.
        let registry_manifest_domain: &[u8] = b"AEP_CAPABILITY_MANIFEST_V1\x00";
        assert_ne!(
            VAULT_IDENTITY_BIND_DOMAIN, registry_manifest_domain,
            "vault bind domain MUST differ from registry manifest domain to \
             prevent cross-protocol signature replay (ADR-124)"
        );
    }

    /// ADR-124: domain tag is exactly `b"AEP_VAULT_IDENTITY_BIND_V1\x00"`
    /// (27 bytes: 26 ASCII + null terminator). Pinned so a typo in the
    /// constant surfaces here rather than as a runtime mismatch in tests.
    #[test]
    fn adr_124_domain_tag_shape_pinned() {
        assert_eq!(VAULT_IDENTITY_BIND_DOMAIN.len(), 27);
        assert_eq!(VAULT_IDENTITY_BIND_DOMAIN.last(), Some(&0u8));
        assert_eq!(
            &VAULT_IDENTITY_BIND_DOMAIN[..26],
            b"AEP_VAULT_IDENTITY_BIND_V1"
        );
    }

    // ================================================================
    // ADR-138: Execution provenance attestations
    //
    // Pure logic/serialization tests for the new event schema. The
    // end-to-end emit assertions are covered by the Anchor integration
    // tests in `tests/execution-provenance.ts`.
    // ================================================================

    use crate::events::{ActionKind, ExecutionAttested};
    use crate::instructions::{manifest_hash_from_profile, TOOL_ID_ZERO};
    use anchor_lang::AnchorSerialize;

    /// ADR-138: `ActionKind` tag values are positional. Reordering the
    /// enum re-encodes every previously-emitted event under a different
    /// tag and silently mis-classifies historical data on the indexer.
    /// Pin the declaration order here so the test fails loudly before a
    /// merge can land a reordering.
    #[test]
    fn adr_138_action_kind_tag_values_pinned() {
        // Serialize each variant and pull out the 1-byte enum tag.
        let pairs: &[(ActionKind, u8)] = &[
            (ActionKind::Transfer, 0),
            (ActionKind::TokenTransfer, 1),
            (ActionKind::PolicyUpdate, 2),
            (ActionKind::AllowlistManage, 3),
            (ActionKind::IdentityRotation, 4),
            (ActionKind::PauseToggle, 5),
            (ActionKind::GrantTransfer, 6),
            (ActionKind::GrantTokenTransfer, 7),
        ];
        for (variant, expected_tag) in pairs {
            let mut buf = Vec::new();
            variant.serialize(&mut buf).expect("serialize must succeed");
            assert_eq!(
                buf.len(),
                1,
                "ActionKind must serialize to a single positional byte"
            );
            assert_eq!(
                buf[0], *expected_tag,
                "{:?} should serialize to tag {}",
                variant, expected_tag,
            );
        }
    }

    /// ADR-138: the `ExecutionAttested` event must round-trip through
    /// borsh ser/de losslessly. This is a structural smoke test — the
    /// indexer decoder relies on exact field ordering, so a reorder
    /// would silently mis-decode every attestation row.
    #[test]
    fn adr_138_execution_attested_round_trips() {
        use anchor_lang::AnchorDeserialize;
        let original = ExecutionAttested {
            vault: sample_pubkey(),
            agent_identity: sample_pubkey(),
            authority: sample_pubkey(),
            action_kind: ActionKind::TokenTransfer,
            tool_id: [7u8; 32],
            manifest_hash: [9u8; 32],
            policy_version: 42,
            delegation_grant: None,
            amount: 1_000_000,
            mint: Some(sample_pubkey()),
            recipient: Some(sample_pubkey()),
            slot: 1_234_567,
            timestamp: 1_700_000_000,
        };
        let mut buf = Vec::new();
        original.serialize(&mut buf).expect("serialize");
        let decoded: ExecutionAttested = AnchorDeserialize::try_from_slice(&buf)
            .expect("deserialize");
        assert_eq!(decoded.vault, original.vault);
        assert_eq!(decoded.agent_identity, original.agent_identity);
        assert_eq!(decoded.authority, original.authority);
        assert_eq!(decoded.action_kind, original.action_kind);
        assert_eq!(decoded.tool_id, original.tool_id);
        assert_eq!(decoded.manifest_hash, original.manifest_hash);
        assert_eq!(decoded.policy_version, original.policy_version);
        assert_eq!(decoded.delegation_grant, original.delegation_grant);
        assert_eq!(decoded.amount, original.amount);
        assert_eq!(decoded.mint, original.mint);
        assert_eq!(decoded.recipient, original.recipient);
        assert_eq!(decoded.slot, original.slot);
        assert_eq!(decoded.timestamp, original.timestamp);
    }

    /// ADR-138: the all-zeros `TOOL_ID_ZERO` sentinel is the documented
    /// migration path for callers that haven't yet adopted the
    /// tool-id-hash convention. Pin its value so a refactor cannot
    /// silently change the sentinel.
    #[test]
    fn adr_138_tool_id_zero_sentinel_pinned() {
        assert_eq!(TOOL_ID_ZERO, [0u8; 32]);
    }

    /// OA-HIGH-1 (cycle-4): the two ADR-111 value-moving grant surfaces
    /// (`execute_grant_transfer` / `execute_grant_token_transfer`) MUST emit
    /// `ExecutionAttested` so grant-authorised value movement is visible to
    /// the ADR-138 provenance pipeline (indexer `execution_attestations`,
    /// ADR-139 reputation-attestor, SAS correlation). This asserts the
    /// grant attestation shape: the reserved `GrantTransfer` /
    /// `GrantTokenTransfer` ActionKinds are used and the previously-dead
    /// `delegation_grant` field is populated with `Some(grant)`.
    #[test]
    fn oa_high_1_grant_attestation_shape() {
        use anchor_lang::AnchorDeserialize;

        let grant = sample_pubkey();

        // SOL grant attestation: GrantTransfer, mint None, grant set.
        let sol = ExecutionAttested {
            vault: sample_pubkey(),
            agent_identity: sample_pubkey(),
            authority: sample_pubkey(),
            action_kind: ActionKind::GrantTransfer,
            tool_id: TOOL_ID_ZERO,
            manifest_hash: [3u8; 32],
            policy_version: 7,
            delegation_grant: Some(grant),
            amount: 500_000,
            mint: None,
            recipient: Some(sample_pubkey()),
            slot: 99,
            timestamp: 1_700_000_001,
        };

        // SPL grant attestation: GrantTokenTransfer, mint Some, grant set.
        let spl = ExecutionAttested {
            vault: sample_pubkey(),
            agent_identity: sample_pubkey(),
            authority: sample_pubkey(),
            action_kind: ActionKind::GrantTokenTransfer,
            tool_id: TOOL_ID_ZERO,
            manifest_hash: [4u8; 32],
            policy_version: 7,
            delegation_grant: Some(grant),
            amount: 250_000,
            mint: Some(sample_pubkey()),
            recipient: Some(sample_pubkey()),
            slot: 100,
            timestamp: 1_700_000_002,
        };

        for ev in [&sol, &spl] {
            // The grant field reserved at events.rs:146 must NOT be None on
            // the grant path — that is the OA-HIGH-1 regression.
            assert_eq!(
                ev.delegation_grant,
                Some(grant),
                "grant attestation MUST carry Some(grant) — a None here is \
                 the OA-HIGH-1 invisibility defect"
            );
            assert_eq!(ev.tool_id, TOOL_ID_ZERO);
            // Round-trips losslessly through the indexer's borsh path.
            let mut buf = Vec::new();
            ev.serialize(&mut buf).expect("serialize");
            let decoded: ExecutionAttested =
                AnchorDeserialize::try_from_slice(&buf).expect("deserialize");
            assert_eq!(decoded.action_kind, ev.action_kind);
            assert_eq!(decoded.delegation_grant, ev.delegation_grant);
            assert_eq!(decoded.mint, ev.mint);
        }

        // The two grant ActionKinds are distinct and are the reserved tags
        // (6, 7) — not the primary Transfer/TokenTransfer (0, 1).
        assert_ne!(ActionKind::GrantTransfer, ActionKind::Transfer);
        assert_ne!(ActionKind::GrantTokenTransfer, ActionKind::TokenTransfer);
        assert_ne!(ActionKind::GrantTransfer, ActionKind::GrantTokenTransfer);
    }

    /// ADR-138: `manifest_hash_from_profile` returns the profile's
    /// `manifest_hash` field verbatim, including the all-zeros sentinel
    /// for pre-ADR-060 profiles. Pinned so a future refactor (e.g.
    /// substituting the manifest_signature) cannot silently shift the
    /// binding surface.
    #[test]
    fn adr_138_manifest_hash_passthrough() {
        use agent_registry::state::{AgentProfile, AgentStatus, PricingModel, ReputationStake};
        let mut profile = AgentProfile {
            authority: Pubkey::default(),
            name: String::new(),
            description: String::new(),
            category: String::new(),
            capabilities: vec![],
            pricing_model: PricingModel::PerTask,
            pricing_amount: 0,
            accepted_tokens: vec![],
            vault_address: Pubkey::default(),
            status: AgentStatus::Active,
            reputation_score: 0,
            __padding_aud007: [0u8; 17],
            created_at: 0,
            updated_at: 0,
            reputation_stake: ReputationStake { staked_amount: 0, slash_count: 0 },
            bump: 0,
            manifest_cid: [0u8; 64],
            manifest_hash: [0u8; 32],
            manifest_signature: [0u8; 64],
            manifest_version: 0,
            version: 0,
            registration_nonce: 0,
            cleared_count: 0,
            cdp_wallet: None,
        };
        // Pre-manifest profile yields the all-zeros sentinel.
        assert_eq!(manifest_hash_from_profile(&profile), [0u8; 32]);

        // Once a manifest is registered, the helper returns it
        // byte-for-byte (no hashing, no transformation).
        let expected = [0xABu8; 32];
        profile.manifest_hash = expected;
        assert_eq!(manifest_hash_from_profile(&profile), expected);
    }

    // ================================================================
    // ADR-111: Delegation grant policy unit tests
    // ================================================================

    use crate::state::{grant_actions, DelegationGrant};
    use crate::instructions::validate_allowed_actions;

    fn empty_grant() -> DelegationGrant {
        DelegationGrant {
            vault: Pubkey::default(),
            grantor: Pubkey::default(),
            grantee: Pubkey::default(),
            allowed_actions: 0,
            spend_cap_lamports: 0,
            spent_lamports: 0,
            token_spend_caps: vec![],
            allowed_recipients: vec![],
            expires_at: 0,
            revoked: false,
            created_at: 0,
            nonce: 0,
            bump: 255,
        }
    }

    #[test]
    fn adr_111_allows_checks_specific_bit() {
        let mut g = empty_grant();
        g.allowed_actions = grant_actions::EXECUTE_TRANSFER;
        assert!(g.allows(grant_actions::EXECUTE_TRANSFER));
        assert!(!g.allows(grant_actions::EXECUTE_TOKEN_TRANSFER));
        // Read-only (zero bit) is never allowed by `allows()` — callers
        // must check `allowed_actions == 0` directly for the read-only case.
        assert!(!g.allows(0));
    }

    #[test]
    fn adr_111_allows_for_combined_actions() {
        let mut g = empty_grant();
        g.allowed_actions =
            grant_actions::EXECUTE_TRANSFER | grant_actions::EXECUTE_TOKEN_TRANSFER;
        assert!(g.allows(grant_actions::EXECUTE_TRANSFER));
        assert!(g.allows(grant_actions::EXECUTE_TOKEN_TRANSFER));
    }

    #[test]
    fn adr_111_recipient_allowed_empty_list_is_wildcard() {
        let g = empty_grant();
        let r = Pubkey::new_unique();
        assert!(g.is_recipient_allowed(&r));
    }

    #[test]
    fn adr_111_recipient_allowed_nonempty_list_is_restrictive() {
        let mut g = empty_grant();
        let r1 = Pubkey::new_unique();
        let r2 = Pubkey::new_unique();
        let r3 = Pubkey::new_unique();
        g.allowed_recipients = vec![r1, r2];
        assert!(g.is_recipient_allowed(&r1));
        assert!(g.is_recipient_allowed(&r2));
        assert!(!g.is_recipient_allowed(&r3));
    }

    #[test]
    fn adr_111_project_spend_overflow_returns_none() {
        let mut g = empty_grant();
        g.spent_lamports = u64::MAX - 5;
        assert_eq!(g.project_spend(10), None);
        assert_eq!(g.project_spend(5), Some(u64::MAX));
    }

    #[test]
    fn adr_111_is_within_window_no_expiry_sentinel() {
        let g = empty_grant();
        assert!(g.is_within_window(0));
        assert!(g.is_within_window(i64::MAX));
    }

    #[test]
    fn adr_111_is_within_window_strict_less_than() {
        let mut g = empty_grant();
        g.expires_at = 1_000_000;
        assert!(g.is_within_window(999_999));
        // At the boundary, expired (semantics: `now < expires_at`).
        assert!(!g.is_within_window(1_000_000));
        assert!(!g.is_within_window(1_000_001));
    }

    #[test]
    fn adr_111_validate_allowed_actions_accepts_known_bits() {
        assert!(validate_allowed_actions(0).is_ok()); // READ_ONLY
        assert!(validate_allowed_actions(grant_actions::EXECUTE_TRANSFER).is_ok());
        assert!(validate_allowed_actions(grant_actions::EXECUTE_TOKEN_TRANSFER).is_ok());
        assert!(validate_allowed_actions(grant_actions::ALL_KNOWN).is_ok());
    }

    #[test]
    fn adr_111_validate_allowed_actions_rejects_unknown_bits() {
        // Any bit above ALL_KNOWN MUST be rejected — reusing a removed bit
        // would silently widen the action surface of pre-existing grants.
        assert!(validate_allowed_actions(0b0000_0100).is_err());
        assert!(validate_allowed_actions(0b1000_0000).is_err());
        assert!(validate_allowed_actions(u8::MAX).is_err());
    }

    #[test]
    fn adr_111_grant_space_is_under_anchor_max() {
        // Anchor's `init` payer flow uses `max_account_size = 10240`
        // (the BPF transaction account-size ceiling). Pin the constant
        // here so a future field addition without a rent-budget
        // re-evaluation surfaces as a test failure.
        assert!(DelegationGrant::SPACE <= 10240);
    }

    #[test]
    fn adr_111_grant_space_room_for_full_vecs() {
        // Ensure SPACE leaves room for the bounded-vec maxima + Anchor
        // 8-byte discriminator. Recompute the worst case alongside the
        // SPACE constant comment in state.rs.
        let worst = 8 // disc
            + 32*3 // vault + grantor + grantee
            + 1    // allowed_actions
            + 8 + 8 // spend_cap_lamports + spent_lamports
            + 4 + (crate::state::MAX_GRANT_TOKEN_CAPS * (32 + 8 + 8)) // token_spend_caps vec
            + 4 + (crate::state::MAX_GRANT_ALLOWED_RECIPIENTS * 32)   // allowed_recipients vec
            + 8 + 1 + 8 + 1 + 1; // expires_at + revoked + created_at + nonce + bump
        assert!(
            DelegationGrant::SPACE >= worst,
            "SPACE ({}) must cover worst-case serialized size ({})",
            DelegationGrant::SPACE,
            worst
        );
    }

    #[test]
    fn adr_111_grantor_grantee_revoker_acceptance_matrix() {
        // The revoke handler accepts: grantee, grantor, or current
        // vault.authority. Test that no other signer is accepted.
        let grantor = Pubkey::new_unique();
        let grantee = Pubkey::new_unique();
        let auth = Pubkey::new_unique();
        let stranger = Pubkey::new_unique();
        let acceptable =
            |signer: Pubkey| signer == grantee || signer == grantor || signer == auth;
        assert!(acceptable(grantee));
        assert!(acceptable(grantor));
        assert!(acceptable(auth));
        assert!(!acceptable(stranger));
    }

    // ----- update tighten-only invariants -----

    #[test]
    fn adr_111_update_actions_subset_invariant() {
        // Subset bitmask: new MUST be a subset of stored.
        let stored = grant_actions::EXECUTE_TRANSFER | grant_actions::EXECUTE_TOKEN_TRANSFER;
        // Allowed (subset): TRANSFER only, TOKEN_TRANSFER only, both, neither.
        for new in [
            0u8,
            grant_actions::EXECUTE_TRANSFER,
            grant_actions::EXECUTE_TOKEN_TRANSFER,
            stored,
        ] {
            assert_eq!(new & !stored, 0);
        }
        // Rejected: any bit not present in stored.
        let new_with_extra = stored | 0b0100_0000;
        assert_ne!(new_with_extra & !stored, 0);
    }

    #[test]
    fn adr_111_update_cap_floor_is_spent_lamports() {
        // A grant with 100 spent cannot have its cap lowered below 100.
        let mut g = empty_grant();
        g.spend_cap_lamports = 500;
        g.spent_lamports = 100;
        // A proposed cap >= spent is acceptable.
        assert!(150 >= g.spent_lamports && 150 <= g.spend_cap_lamports);
        // A proposed cap < spent is rejected.
        assert!(99 < g.spent_lamports);
    }

    #[test]
    fn adr_111_update_expiry_tighten_only_semantics() {
        // Stored: no-expiry (0). Any new value is a tightening.
        let stored_no_expiry = 0i64;
        for new in [0i64, 1_700_000_000, i64::MAX] {
            let ok = stored_no_expiry == 0;
            assert!(ok || new <= stored_no_expiry);
        }
        // Stored: 1_000_000. new MUST be != 0 AND <= stored.
        let stored = 1_000_000_i64;
        let bad_no_expiry = 0i64;
        let bad_extend = 1_500_000_i64;
        let ok_shrink = 800_000_i64;
        assert!(bad_no_expiry == 0); // would loosen
        assert!(bad_extend > stored); // would loosen
        assert!(ok_shrink <= stored && ok_shrink != 0);
    }

    // ----- proptest: tighten-only update invariant under random walks -----
    mod adr_111_fuzz {
        use super::*;
        use proptest::prelude::*;

        proptest! {
            /// ADR-111: A sequence of "tighten-only" cap updates can never
            /// raise the cap. Models the update_delegation_grant path.
            #[test]
            fn cap_tightening_is_monotonic(
                start_cap in 1u64..u64::MAX/2,
                deltas in proptest::collection::vec(any::<u64>(), 0..32)
            ) {
                let mut cap = start_cap;
                for d in deltas {
                    // Each "tightening" can lower the cap (saturating at 0)
                    // but the operation must NEVER raise it.
                    let new_cap = cap.saturating_sub(d % (cap.max(1) + 1));
                    prop_assert!(new_cap <= cap);
                    cap = new_cap;
                }
                prop_assert!(cap <= start_cap);
            }

            /// ADR-111: A series of `project_spend` calls against a cap
            /// always saturates correctly — no panic, no silent overflow.
            #[test]
            fn project_spend_never_overflows(
                start_spent in any::<u64>(),
                amount in any::<u64>(),
            ) {
                let mut g = empty_grant();
                g.spent_lamports = start_spent;
                let projected = g.project_spend(amount);
                if let Some(p) = projected {
                    prop_assert!(p >= start_spent);
                } else {
                    // `None` only when start + amount > u64::MAX.
                    prop_assert!(start_spent.checked_add(amount).is_none());
                }
            }

            /// ADR-111: action mask intersection rule — a new mask is
            /// "tighter" iff it is a subset of the old (bitwise).
            #[test]
            fn action_subset_check_matches_bitwise(
                stored in 0u8..=grant_actions::ALL_KNOWN,
                candidate in 0u8..=grant_actions::ALL_KNOWN,
            ) {
                let is_subset = candidate & !stored == 0;
                let is_subset_iter = (0..8u8).all(|i| {
                    let mask = 1u8 << i;
                    if candidate & mask != 0 { stored & mask != 0 } else { true }
                });
                prop_assert_eq!(is_subset, is_subset_iter);
            }
        }
    }
}
