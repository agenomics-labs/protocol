use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw");

pub mod state;
pub mod errors;
pub mod events;
pub mod contexts;
pub mod instructions;

use state::*;
use errors::*;
use events::*;
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
    pub fn execute_transfer(
        ctx: Context<ExecuteTransfer>,
        amount_lamports: u64,
    ) -> Result<()> {
        // ADR-095: gate on Registry suspension before any transfer logic.
        require_not_suspended(&ctx.accounts.agent_profile)?;
        instructions::execute_transfer(ctx, amount_lamports)
    }

    // ADR-050: execute_program_call removed — without vault PDA signing (ADR-038),
    // it was a rate-limited invoke wrapper with limited utility. Financial operations
    // use execute_transfer and execute_token_transfer. Non-financial CPI can be done
    // directly by the agent without going through the vault.

    /// Executes an SPL token transfer from the vault's token account to a recipient.
    /// Enforces token allowlist, rate limiting, the vault's pause state, and the
    /// Registry suspension gate (ADR-095).
    /// The vault PDA signs the transfer via CPI.
    pub fn execute_token_transfer(
        ctx: Context<ExecuteTokenTransfer>,
        amount: u64,
    ) -> Result<()> {
        // ADR-095: gate on Registry suspension before any transfer logic.
        require_not_suspended(&ctx.accounts.agent_profile)?;
        instructions::execute_token_transfer(ctx, amount)
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
}
