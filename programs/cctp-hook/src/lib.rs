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
// C4-OB-01(b): the typed SPL `TokenAccount` is only referenced by the
// hardened `escrow_token_account` / `provider_token_account` fields, which
// exist only on a `cctp_attestation_verified` build (see the
// guard/deserialization-ordering rationale in `AutoApproveMilestone`).
#[cfg(feature = "cctp_attestation_verified")]
use anchor_spl::token::TokenAccount;

// Q-S3-A: pull the Registry's `AgentProfile` account type (with
// `no-entrypoint` so Registry's `entrypoint!` is not redeclared in this
// program's binary). The Registry crate is unchanged on disk; we only
// inherit its struct layout for the typed read.
use agent_registry::state::AgentProfile;

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

/// C4-OB-01(d): canonical CCTP receiver authority permitted to drive
/// `auto_approve_milestone`.
///
/// Before this constant existed, the dispatcher `payer` was an
/// unconstrained `Signer` — *any* signer could invoke the fund-releasing
/// instruction (the audit's "any signer can drive approval"). Restricting
/// to a single canonical authority is defense-in-depth on top of the
/// ADR-145 deploy guard.
///
/// **Q-S3-B / ADR-145 (Proposed):** the *real* on-chain trust anchor must
/// be the Circle CCTP V2 MessageTransmitter receiver (CPI-caller check or
/// attestation-account binding). That receiver program ID / authority is
/// not yet pinned (open question Q-S3-B). Until ADR-145 lands, this is the
/// system program ID — a deliberately unusable sentinel: combined with the
/// hard deploy guard (feature `cctp_attestation_verified`, default OFF),
/// the instruction is unreachable on any fund-bearing cluster, and even a
/// guard-enabled localnet build must explicitly opt in to whichever
/// authority operators wire as `payer`. This constant MUST be replaced
/// with the canonical receiver binding when ADR-145 is implemented.
pub const CCTP_RECEIVER_AUTHORITY: Pubkey =
    anchor_lang::solana_program::system_program::ID;

/// ADR-145: canonical Circle CCTP V2 `MessageTransmitterV2` program ID.
///
/// Same address on Solana mainnet-beta and devnet (verified against
/// `circlefin/solana-cctp-contracts` `programs/v2/message-transmitter-v2/
/// src/lib.rs::declare_id!` and Circle's published CCTP Solana programs
/// doc). This is the program that:
///   1. runs `verify_attestation_signatures(message.hash(), attestation)`
///      against Circle's on-chain attester set, and
///   2. `init`s the `used_nonce` PDA (so the PDA's mere existence is
///      attestation-gated proof a Circle-signed message was consumed).
pub const CCTP_MESSAGE_TRANSMITTER_V2_ID: Pubkey =
    anchor_lang::solana_program::pubkey!(
        "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC"
    );

/// ADR-145: CCTP V2 domain of Solana (the destination of the return
/// leg). Circle's canonical domain table assigns Solana = 5.
pub const CCTP_SOLANA_DOMAIN: u32 = 5;

/// ADR-145: CCTP V2 domain of Base (the source of the return leg —
/// where the USDC was burned to come back to Solana). Circle's
/// canonical domain table assigns Base = 6.
pub const CCTP_BASE_DOMAIN: u32 = 6;

/// ADR-145: `used_nonce` PDA seed prefix used by MessageTransmitterV2.
/// PDA = find_program_address([b"used_nonce", message[12..44]],
/// CCTP_MESSAGE_TRANSMITTER_V2_ID). Pinned against
/// `message-transmitter-v2/src/instructions/receive_message.rs`.
pub const CCTP_USED_NONCE_SEED: &[u8] = b"used_nonce";

/// ADR-145 — CCTP V2 message-header byte offsets.
///
/// Pinned against `message-transmitter-v2/src/message.rs`:
///   VERSION 0 · SOURCE_DOMAIN 4 · DESTINATION_DOMAIN 8 · NONCE 12
///   · SENDER 44 · RECIPIENT 76 · DESTINATION_CALLER 108
///   · MIN_FINALITY_THRESHOLD 140 · FINALITY_THRESHOLD_EXECUTED 144
///   · MESSAGE_BODY 148. The V2 nonce is the 32 bytes `[12..44]` and is
/// the exact `used_nonce` PDA seed.
pub const CCTP_MSG_SOURCE_DOMAIN_INDEX: usize = 4;
pub const CCTP_MSG_DESTINATION_DOMAIN_INDEX: usize = 8;
pub const CCTP_MSG_NONCE_INDEX: usize = 12;
pub const CCTP_MSG_SENDER_INDEX: usize = 44;
pub const CCTP_MSG_BODY_INDEX: usize = 148;

/// ADR-145 — CCTP V2 BurnMessage body byte offsets.
///
/// Pinned against `token-messenger-minter-v2/src/token_messenger_v2/
/// burn_message.rs`. EVM-width fields are 32 bytes; Solana reads the low
/// 8 bytes after a 24-byte zero `OFFSET`, big-endian.
///   VERSION 0 · BURN_TOKEN 4 · MINT_RECIPIENT 36 · AMOUNT 68
///   · MSG_SENDER 100 · MAX_FEE 132 · FEE_EXECUTED 164
///   · EXPIRATION_BLOCK 196 · HOOK_DATA 228. `amount` (u64 BE) lives at
/// AMOUNT_INDEX + OFFSET = 92.
pub const CCTP_BURN_AMOUNT_INDEX: usize = 68;
pub const CCTP_BURN_EVM_OFFSET: usize = 24;
pub const CCTP_BURN_MIN_LEN: usize = 228;

/// C4-OB-01 / ADR-145 HARD DEPLOY GUARD — compile-time flag.
///
/// `true` only when the crate is built with the (default-OFF)
/// `cctp_attestation_verified` Cargo feature. This constant is referenced
/// by an **account-level** constraint on the *first* field of
/// `AutoApproveMilestone` (see `payer` below) so the guard is the
/// deterministic FIRST failure during Anchor's account-validation phase —
/// *before* any account is deserialized (escrow, the typed SPL token
/// accounts, the Registry PDAs). A handler-body `require!` cannot achieve
/// this: Anchor runs the entire `#[derive(Accounts)]` struct before the
/// handler body, so an in-handler guard would fire only AFTER token-account
/// deserialization — defeating the "unreachable before any work" intent and
/// surfacing a confusing `AccountNotInitialized` instead of the guard
/// error. The handler-body `require!` is retained as belt-and-braces.
pub const CCTP_ATTESTATION_VERIFIED: bool =
    cfg!(feature = "cctp_attestation_verified");

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

/// C4-OB-05: Anchor account discriminator for settlement's `TaskEscrow`.
///
/// Computed as `sha256("account:TaskEscrow")[..8]`. The Hook reads the
/// escrow as a raw `UncheckedAccount` (to avoid a settlement-crate dep);
/// `owner == SETTLEMENT_PROGRAM_ID` is necessary but NOT sufficient — the
/// Settlement program owns many account types (ProtocolConfig, etc.). This
/// constant pins the byte slice `escrow_data[0..8]` to the `TaskEscrow`
/// type so a non-escrow Settlement-owned account cannot be substituted.
///
/// Verified against the Anchor convention by
/// `task_escrow_discriminator_matches_anchor_convention` below; if
/// Settlement renames `TaskEscrow` this constant MUST be regenerated.
pub const TASK_ESCROW_DISCRIMINATOR: [u8; 8] =
    [209, 72, 197, 54, 17, 55, 3, 187];

/// C4-OB-01: raw-bytes layout of `settlement::state::TaskEscrow` needed to
/// reconcile `payload.amount_returned_micros` against the milestone amount
/// the escrow actually authorizes. Layout after the 8-byte discriminator
/// (Borsh, declaration order — see `programs/settlement/src/state.rs`):
///
/// ```text
///   8   client:        Pubkey   (32)
///   40  provider:      Pubkey   (32)
///   72  client_vault:  Pubkey   (32)
///   104 provider_vault:Pubkey   (32)
///   136 token_mint:    Pubkey   (32)
///   168 total_amount:  u64      (8)
///   176 released_amount:u64     (8)
///   184 milestones:    Vec<Milestone>  -> 4-byte LE len, then entries
/// ```
///
/// Each `Milestone` is `description_hash:[u8;32] + amount:u64 +
/// status:MilestoneStatus(1-byte Borsh enum discriminant) +
/// grace_ends_at:u64` = 49 bytes; `amount` sits 32 bytes into the entry.
const TASK_ESCROW_MILESTONES_LEN_OFFSET: usize = 184;
const MILESTONE_ENTRY_SIZE: usize = 32 + 8 + 1 + 8; // 49
const MILESTONE_AMOUNT_INNER_OFFSET: usize = 32;

/// ADR-145 — genuine on-chain CCTP V2 attestation verification.
///
/// CCTP V2 on Solana has **no generic post-mint hook dispatch**:
/// `MessageTransmitterV2::receive_message` only CPIs into the program
/// named by `message.recipient()`, which for a USDC burn is
/// `TokenMessengerMinterV2` itself; its `handle_receive_finalized_message`
/// mints to the recipient ATA and returns without ever reading or
/// forwarding `hook_data`. Therefore this Hook can never be CPI-invoked
/// *by* CCTP. The sound on-chain anchor is instead the **`used_nonce`
/// PDA** that `receive_message` `init`s *after*
/// `verify_attestation_signatures` passes. Its existence + ownership +
/// `is_used` is unforgeable proof that a Circle-attester-signed message
/// with that exact nonce was consumed on this cluster.
pub mod cctp {
    use super::*;

    /// `UsedNonce` account body as defined by MessageTransmitterV2
    /// (`message-transmitter-v2/src/state.rs`): a single `bool`,
    /// preceded by Anchor's 8-byte account discriminator.
    const USED_NONCE_IS_USED_OFFSET: usize = 8;
    const USED_NONCE_MIN_LEN: usize = 8 + 1;

    /// Read a big-endian `u32` from `buf[idx..idx+4]`.
    fn be_u32(buf: &[u8], idx: usize) -> Result<u32> {
        let s = buf
            .get(idx..idx + 4)
            .ok_or(error!(HookError::CctpMessageMalformed))?;
        Ok(u32::from_be_bytes(s.try_into().unwrap()))
    }

    /// Verify that `cctp_message` was genuinely received & attested by
    /// Circle CCTP V2 on this cluster, and return the BurnMessage
    /// `amount` (u64) the attested mint released.
    ///
    /// Soundness chain:
    ///   1. `message_transmitter.key() == CCTP_MESSAGE_TRANSMITTER_V2_ID`
    ///      pins the program whose attester set gates the nonce PDA.
    ///   2. The `used_nonce` account is owned by that program — only
    ///      MessageTransmitterV2 can create/own a `used_nonce` PDA.
    ///   3. `used_nonce.key()` equals the canonical
    ///      `find_program_address([b"used_nonce", message[12..44]],
    ///      MessageTransmitterV2)` derived from THESE message bytes —
    ///      binds the witness account to this exact message's nonce.
    ///   4. `UsedNonce.is_used == true` — `receive_message` only sets
    ///      this after `verify_attestation_signatures` succeeds, so a
    ///      true value is attestation-gated proof of a real Circle mint.
    ///   5. source/destination domain sanity (Base→Solana).
    ///   6. parse the BurnMessage body `amount` for the caller to
    ///      reconcile against the escrow milestone.
    pub fn verify_message_and_amount(
        message_transmitter: &UncheckedAccount,
        used_nonce: &UncheckedAccount,
        cctp_message: &[u8],
    ) -> Result<u64> {
        // (1) canonical MessageTransmitterV2 program.
        require_keys_eq!(
            message_transmitter.key(),
            CCTP_MESSAGE_TRANSMITTER_V2_ID,
            HookError::InvalidCctpMessageTransmitter
        );

        // header must reach at least MESSAGE_BODY_INDEX.
        require!(
            cctp_message.len() >= CCTP_MSG_BODY_INDEX,
            HookError::CctpMessageMalformed
        );

        // (5) domain sanity: Base (6) -> Solana (5).
        require!(
            be_u32(cctp_message, CCTP_MSG_DESTINATION_DOMAIN_INDEX)?
                == CCTP_SOLANA_DOMAIN,
            HookError::CctpWrongDestinationDomain
        );
        require!(
            be_u32(cctp_message, CCTP_MSG_SOURCE_DOMAIN_INDEX)?
                == CCTP_BASE_DOMAIN,
            HookError::CctpWrongSourceDomain
        );

        // (3) re-derive the canonical used_nonce PDA from the 32-byte
        // V2 nonce slice message[12..44] and require equality with the
        // supplied witness account.
        let nonce_seed = cctp_message
            .get(CCTP_MSG_NONCE_INDEX..CCTP_MSG_SENDER_INDEX)
            .ok_or(error!(HookError::CctpMessageMalformed))?;
        let (expected_used_nonce, _bump) = Pubkey::find_program_address(
            &[CCTP_USED_NONCE_SEED, nonce_seed],
            &CCTP_MESSAGE_TRANSMITTER_V2_ID,
        );
        require_keys_eq!(
            used_nonce.key(),
            expected_used_nonce,
            HookError::UsedNonceAddressMismatch
        );

        // (2) ownership: only MessageTransmitterV2 can own a real
        // used_nonce PDA. A look-alike account owned by anything else
        // (incl. this program or the system program) is rejected.
        require_keys_eq!(
            *used_nonce.owner,
            CCTP_MESSAGE_TRANSMITTER_V2_ID,
            HookError::UsedNonceOwnerMismatch
        );

        // (4) UsedNonce.is_used == true.
        let nonce_data = used_nonce.try_borrow_data()?;
        require!(
            nonce_data.len() >= USED_NONCE_MIN_LEN,
            HookError::CctpNonceNotConsumed
        );
        require!(
            nonce_data[USED_NONCE_IS_USED_OFFSET] == 1,
            HookError::CctpNonceNotConsumed
        );
        drop(nonce_data);

        // (6) parse the BurnMessage body `amount` (EVM 32-byte field;
        // Solana reads the low 8 bytes big-endian after a 24-byte zero
        // OFFSET, and requires the skipped 24 bytes are zero).
        let body = &cctp_message[CCTP_MSG_BODY_INDEX..];
        require!(
            body.len() >= CCTP_BURN_MIN_LEN,
            HookError::CctpBurnBodyMalformed
        );
        let amt_hi = CCTP_BURN_AMOUNT_INDEX;
        let amt_lo = amt_hi + CCTP_BURN_EVM_OFFSET;
        require!(
            body[amt_hi..amt_lo].iter().all(|&b| b == 0),
            HookError::CctpBurnBodyMalformed
        );
        let amount = u64::from_be_bytes(
            body[amt_lo..amt_lo + 8]
                .try_into()
                .map_err(|_| error!(HookError::CctpBurnBodyMalformed))?,
        );

        Ok(amount)
    }

    /// ADR-145 — bind `payload.base_tx_hash` to the verified message.
    ///
    /// The Base L1 transaction hash is **not carried in the CCTP wire
    /// message** (CCTP identifies a transfer by `(source_domain,
    /// nonce)`, never the source-chain tx hash). To still give the
    /// replay-PDA seed and audit trail an on-chain-verifiable meaning,
    /// the Hook redefines `base_tx_hash` as the keccak256 digest of
    /// `source_domain (BE u32) || nonce (32 bytes)` taken from the
    /// **verified** message. The Base-side burn constructor (Surface 4)
    /// computes the identical digest, so a payload whose `base_tx_hash`
    /// does not equal this digest is not bound to the attested message.
    /// This is the documented ADR-145 trust redefinition (see ADR).
    pub fn expected_base_tx_binding(cctp_message: &[u8]) -> Result<[u8; 32]> {
        use anchor_lang::solana_program::keccak;
        let src = cctp_message
            .get(CCTP_MSG_SOURCE_DOMAIN_INDEX..CCTP_MSG_SOURCE_DOMAIN_INDEX + 4)
            .ok_or(error!(HookError::CctpMessageMalformed))?;
        let nonce = cctp_message
            .get(CCTP_MSG_NONCE_INDEX..CCTP_MSG_SENDER_INDEX)
            .ok_or(error!(HookError::CctpMessageMalformed))?;
        let mut preimage = Vec::with_capacity(4 + 32);
        preimage.extend_from_slice(src);
        preimage.extend_from_slice(nonce);
        Ok(keccak::hash(&preimage).to_bytes())
    }
}

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
        // ---- 0. C4-OB-01 / ADR-145 HARD DEPLOY GUARD (belt-and-braces) ----
        //
        // The PRIMARY guard is the account-level `constraint =
        // CCTP_ATTESTATION_VERIFIED` on the first field of
        // `AutoApproveMilestone` (`payer`), which Anchor evaluates during
        // the account-validation phase BEFORE the handler body and before
        // any account is deserialized. This in-handler `require!` is a
        // second, independent check on the same compile-time flag: if a
        // future refactor reorders or drops the account-level constraint,
        // this still hard-disables the fund-release path on any default /
        // fund-bearing build before ANY state write or CPI.
        require!(
            CCTP_ATTESTATION_VERIFIED,
            HookError::CctpAttestationNotVerified
        );

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

        // C4-OB-05: pin the account *type*, not just its owner program.
        // `owner == SETTLEMENT_PROGRAM_ID` (enforced by the accounts
        // struct) is necessary but not sufficient — Settlement owns
        // several account types. Require the first 8 bytes equal the
        // canonical `TaskEscrow` Anchor discriminator so a non-escrow
        // Settlement-owned account (e.g. ProtocolConfig) cannot be
        // substituted to bypass the client / amount checks below.
        require!(
            escrow_data[0..8] == TASK_ESCROW_DISCRIMINATOR,
            HookError::EscrowDiscriminatorMismatch
        );

        let mut client_bytes = [0u8; 32];
        client_bytes.copy_from_slice(
            &escrow_data[TASK_ESCROW_CLIENT_OFFSET..TASK_ESCROW_CLIENT_OFFSET + 32],
        );
        let escrow_client = Pubkey::new_from_array(client_bytes);

        // ---- C4-OB-01(c): reconcile the returned amount against the
        // milestone amount the escrow actually authorizes, from raw
        // escrow bytes, BEFORE writing the ReplayRecord or emitting the
        // event. `payload.amount_returned_micros` is attacker-influenced
        // wire data; the escrow's `milestones[idx].amount` is the
        // on-chain source of truth. A mismatch means the CCTP round-trip
        // claims a different number than the escrow will release — reject
        // hard rather than persist a false `amount_returned_micros` in
        // the ReplayRecord / MilestoneAutoApproved audit trail.
        let idx = payload.milestone_index as usize;
        require!(
            escrow_data.len() >= TASK_ESCROW_MILESTONES_LEN_OFFSET + 4,
            HookError::EscrowMilestoneParseFailed
        );
        let mut len_bytes = [0u8; 4];
        len_bytes.copy_from_slice(
            &escrow_data[TASK_ESCROW_MILESTONES_LEN_OFFSET
                ..TASK_ESCROW_MILESTONES_LEN_OFFSET + 4],
        );
        let milestones_len = u32::from_le_bytes(len_bytes) as usize;
        require!(idx < milestones_len, HookError::MilestoneIndexOutOfRange);

        let entries_start = TASK_ESCROW_MILESTONES_LEN_OFFSET + 4;
        let amount_off = entries_start
            + idx
                .checked_mul(MILESTONE_ENTRY_SIZE)
                .ok_or(error!(HookError::EscrowMilestoneParseFailed))?
            + MILESTONE_AMOUNT_INNER_OFFSET;
        require!(
            escrow_data.len() >= amount_off + 8,
            HookError::EscrowMilestoneParseFailed
        );
        let mut amt_bytes = [0u8; 8];
        amt_bytes.copy_from_slice(&escrow_data[amount_off..amount_off + 8]);
        let milestone_amount = u64::from_le_bytes(amt_bytes);
        require!(
            payload.amount_returned_micros == milestone_amount,
            HookError::AmountReconciliationMismatch
        );

        drop(escrow_data); // release borrow before CPI

        // ---- 2b. ADR-145: GENUINE on-chain CCTP V2 attestation
        // verification. This is the actual fix for C4-OB-01 — it
        // replaces the shape-only `base_tx_hash != 0` sentinel with a
        // binding to a Circle-attester-gated `used_nonce` PDA.
        //
        // Compiled only on a `cctp_attestation_verified` build: that is
        // exactly the build where the instruction is reachable (the HARD
        // DEPLOY GUARD blocks the default / fund-bearing build before
        // this point, so the CCTP witness accounts are not even present
        // in the default account context — see `AutoApproveMilestone`).
        #[cfg(feature = "cctp_attestation_verified")]
        {
            require!(
                !payload.cctp_message.is_empty(),
                HookError::CctpMessageMalformed
            );

            // (a) prove the message was Circle-attested & consumed;
            // get the BurnMessage `amount` the attested mint released.
            let attested_amount = cctp::verify_message_and_amount(
                &ctx.accounts.cctp_message_transmitter,
                &ctx.accounts.cctp_used_nonce,
                &payload.cctp_message,
            )?;

            // (b) bind the returned amount: the attested CCTP mint
            // amount MUST equal the payload's claimed return amount
            // (which step 2 already reconciled == the escrow milestone
            // amount). Net: escrow milestone == payload == attested
            // CCTP mint — a fabricated payload cannot pass.
            require!(
                attested_amount == payload.amount_returned_micros,
                HookError::CctpAmountBindingMismatch
            );

            // (c) bind base_tx_hash to the verified message identity
            // (source_domain || nonce) — see ADR-145 trust redefinition.
            let expected_base_tx =
                cctp::expected_base_tx_binding(&payload.cctp_message)?;
            require!(
                payload.base_tx_hash == expected_base_tx,
                HookError::CctpBaseTxBindingMismatch
            );
        }

        // ---- 3. Agent CDP-wallet binding validation (Q-S3-A) ----
        //
        // The IC-4 contract requires that the auto-approval only fires for an
        // agent whose CDP Server Wallet on Base is registered on-chain. The
        // Registry's `AgentProfile.cdp_wallet` field is the source of truth
        // (set by Surface 4 via `update_cdp_wallet`); the Hook reads it here
        // and (a) requires it is `Some(_)` — i.e. a binding exists, and (b)
        // matches the payload's `cdp_recipient` — i.e. the address that the
        // Base-side x402 settle was delivered to.
        //
        // Defense-in-depth: the existing escrow-client check below still
        // gates that the upstream `create_escrow` listed `hook_signer
        // (agent_authority)` as the escrow's `client`, so the
        // `agent_authority` argument is bound to the escrow being approved
        // — an attacker cannot pass an arbitrary agent_authority whose
        // profile happens to carry a Some(cdp_wallet) and "approve" some
        // other agent's escrow.
        require!(
            escrow_client == ctx.accounts.hook_signer.key(),
            HookError::EscrowClientMismatch
        );

        // Typed read via Registry's `AgentProfile`.
        //
        // Address validation: `agent_owner_nonce` is pinned by the accounts
        // struct's `seeds = [agent_authority, b"owner-nonce"]` constraint
        // under `AGENT_REGISTRY_PROGRAM_ID`, so it must be the canonical
        // OwnerNonce PDA for `agent_authority`. We read the `nonce: u64`
        // (first field after the 8-byte Anchor discriminator), derive the
        // expected 3-seed `agent_profile` PDA address, and require equality
        // with the supplied account. The `owner` constraint already pinned
        // ownership to Registry, so satisfying both means the bytes we
        // deserialize below are the canonical profile.
        let nonce_data = ctx.accounts.agent_owner_nonce.try_borrow_data()?;
        require!(
            nonce_data.len() >= 8 + 8,
            HookError::AgentProfileDeserializeFailed
        );
        let mut nonce_bytes = [0u8; 8];
        nonce_bytes.copy_from_slice(&nonce_data[8..16]);
        drop(nonce_data);

        let (expected_profile, _bump) = Pubkey::find_program_address(
            &[
                ctx.accounts.agent_authority.key().as_ref(),
                b"agent-profile",
                &nonce_bytes,
            ],
            &AGENT_REGISTRY_PROGRAM_ID,
        );
        require!(
            ctx.accounts.agent_profile.key() == expected_profile,
            HookError::AgentProfileDeserializeFailed
        );

        let profile_data = ctx.accounts.agent_profile.try_borrow_data()?;
        let profile = AgentProfile::try_deserialize(&mut profile_data.as_ref())
            .map_err(|_| error!(HookError::AgentProfileDeserializeFailed))?;
        let bound_wallet = profile
            .cdp_wallet
            .ok_or_else(|| error!(HookError::CdpWalletNotBound))?;
        require!(
            bound_wallet == payload.cdp_recipient,
            HookError::CdpWalletMismatch
        );
        drop(profile_data); // release borrow before CPI

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
    /// The transaction signer — the canonical CCTP V2 receiver authority.
    ///
    /// C4-OB-01(e) HARD DEPLOY GUARD (account-level, FIRST field): the
    /// `constraint = CCTP_ATTESTATION_VERIFIED` is evaluated by Anchor
    /// during the account-validation phase, on the first struct field,
    /// *before* any other account (escrow, the typed SPL token accounts,
    /// the Registry PDAs) is deserialized. On a default / fund-bearing
    /// build the feature is OFF, `CCTP_ATTESTATION_VERIFIED == false`, and
    /// every call deterministically reverts here with
    /// `CctpAttestationNotVerified` — no state write, no CPI, no
    /// account-deserialization side effects, and a clear error rather than
    /// a misleading `AccountNotInitialized`. The handler body re-checks the
    /// same flag (belt-and-braces). The flag may be enabled ONLY on a
    /// no-value localnet/devnet integration build (see Cargo.toml).
    ///
    /// C4-OB-01(d): also pinned via `address = CCTP_RECEIVER_AUTHORITY`
    /// (previously any signer could drive the fund-releasing approval). The
    /// constant is currently a guard-only sentinel (system program ID)
    /// pending ADR-145, which will replace it with the real Circle CCTP V2
    /// MessageTransmitter CPI-caller / attestation-account binding (Q-S3-B).
    #[account(
        mut,
        constraint = CCTP_ATTESTATION_VERIFIED @ HookError::CctpAttestationNotVerified,
        address = CCTP_RECEIVER_AUTHORITY @ HookError::UnauthorizedCctpReceiver,
    )]
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

    /// Q-S3-A: the agent's `OwnerNonce` PDA in the Registry program. Used
    /// to derive `agent_profile`'s 3-seed PDA per ADR-097
    /// (`[authority, b"agent-profile", nonce-le]`). Read-only — we never
    /// mutate Registry state from the Hook.
    /// CHECK: address pinned by `seeds = [agent_authority, b"owner-nonce"]`
    /// under the Registry program ID, plus `owner = ...` to ensure the
    /// account is initialized and owned by Registry (not just an empty
    /// PDA address that happens to satisfy seeds).
    #[account(
        owner = AGENT_REGISTRY_PROGRAM_ID @ HookError::AgentProfileDeserializeFailed,
        seeds = [agent_authority.key().as_ref(), b"owner-nonce"],
        bump,
        seeds::program = AGENT_REGISTRY_PROGRAM_ID,
    )]
    pub agent_owner_nonce: UncheckedAccount<'info>,

    /// Q-S3-A: the agent's `AgentProfile` PDA in the Registry program. We
    /// borrow its data, deserialize via `agent_registry::state::AgentProfile`,
    /// and gate the auto-approval on `cdp_wallet == payload.cdp_recipient`.
    /// Read-only.
    ///
    /// Address validation is done in the handler: it reads the nonce from
    /// `agent_owner_nonce`, re-derives the 3-seed PDA, and asserts equality
    /// with `agent_profile.key()`. The `owner` constraint here pins the
    /// account ownership to Registry. Doing the seed-derivation check in
    /// the handler (vs. the macro) lets us reuse the deserialized nonce
    /// for the derivation without a second account-data borrow.
    /// CHECK: address validated in-handler against the OwnerNonce-derived
    /// canonical 3-seed PDA; ownership pinned via `owner = ...`.
    #[account(
        owner = AGENT_REGISTRY_PROGRAM_ID @ HookError::AgentProfileDeserializeFailed,
    )]
    pub agent_profile: UncheckedAccount<'info>,

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
    ///
    /// C4-OB-01(b): defense-in-depth — typed `Account<TokenAccount>` with
    /// `token::authority = escrow`, mirroring settlement's
    /// `ApproveMilestone` (`escrow_token_account.owner == escrow.key()`)
    /// so the Hook does not rely solely on the Settlement callee.
    ///
    /// C4-OB-01(e) — guard/deserialization ordering. Anchor deserializes
    /// every typed `Account<T>` field during `try_accounts`; an
    /// uninitialized SPL account fails with `AccountNotInitialized (3012)`
    /// at THIS field *before* a field-level `constraint`/`address` check on
    /// an earlier `Signer` field is reported. On a default / fund-bearing
    /// build the HARD DEPLOY GUARD (feature OFF) means this instruction is
    /// unreachable regardless, so the strict SPL deserialization here would
    /// only mask the guard error with a confusing 3012. The field is
    /// therefore `UncheckedAccount` on the default build (the guard is the
    /// clean first failure) and the hardened typed+constrained
    /// `Account<TokenAccount>` ONLY on a `cctp_attestation_verified` build —
    /// i.e. exactly the build where the instruction is reachable and the
    /// C4-OB-01(b) constraint must actively run. The handler additionally
    /// guards the typed access behind the same `cfg` (see below).
    #[cfg(feature = "cctp_attestation_verified")]
    #[account(
        mut,
        token::authority = escrow,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// See the documented C4-OB-01(b)/(e) rationale on the
    /// `cctp_attestation_verified` variant above. On the default /
    /// fund-bearing build this is an unchecked plumb-through; the HARD
    /// DEPLOY GUARD blocks the instruction before any CPI, so no
    /// fund-release path is exposed by the looser type here.
    /// CHECK: deserialized + constrained only on a guard-enabled build;
    /// the deploy guard makes this account unreachable otherwise.
    #[cfg(not(feature = "cctp_attestation_verified"))]
    #[account(mut)]
    pub escrow_token_account: UncheckedAccount<'info>,

    /// Provider's USDC token account (the session-pool PDA's ATA).
    ///
    /// C4-OB-01(b): defense-in-depth — typed `Account<TokenAccount>`
    /// constrained to the *same mint* as the escrow's token account, so a
    /// wrong-mint provider account is rejected at the Hook boundary. Same
    /// C4-OB-01(e) guard/deserialization-ordering rationale as
    /// `escrow_token_account` above: hardened typed form ONLY on a
    /// `cctp_attestation_verified` build, unchecked plumb-through on the
    /// default / fund-bearing build where the deploy guard blocks the
    /// instruction outright.
    #[cfg(feature = "cctp_attestation_verified")]
    #[account(
        mut,
        token::mint = escrow_token_account.mint,
    )]
    pub provider_token_account: Account<'info, TokenAccount>,

    /// See the documented C4-OB-01(b)/(e) rationale on the
    /// `cctp_attestation_verified` variant above.
    /// CHECK: deserialized + constrained only on a guard-enabled build;
    /// the deploy guard makes this account unreachable otherwise.
    #[cfg(not(feature = "cctp_attestation_verified"))]
    #[account(mut)]
    pub provider_token_account: UncheckedAccount<'info>,

    /// ADR-145: Circle CCTP V2 `MessageTransmitterV2` program account.
    /// Address-pinned to `CCTP_MESSAGE_TRANSMITTER_V2_ID`. Used only to
    /// anchor the `cctp_used_nonce` PDA derivation/ownership to the
    /// canonical attester-gated program. Present ONLY on a
    /// `cctp_attestation_verified` build — on the default /
    /// fund-bearing build the HARD DEPLOY GUARD makes the instruction
    /// unreachable, so the witness accounts are intentionally absent
    /// (keeps the default IDL/account context unchanged, mirroring the
    /// C4-OB-01(e) token-account cfg split).
    /// CHECK: address-pinned; never deserialized as a typed account.
    #[cfg(feature = "cctp_attestation_verified")]
    #[account(
        executable,
        address = CCTP_MESSAGE_TRANSMITTER_V2_ID
            @ HookError::InvalidCctpMessageTransmitter,
    )]
    pub cctp_message_transmitter: UncheckedAccount<'info>,

    /// ADR-145: the Circle CCTP V2 `used_nonce` PDA for THIS message.
    /// `receive_message` `init`s it only after
    /// `verify_attestation_signatures` passes; the handler asserts the
    /// address derives from `message[12..44]`, that it is owned by
    /// MessageTransmitterV2, and that `UsedNonce.is_used == true`. This
    /// is the genuine on-chain attestation anchor (C4-OB-01 fix).
    /// CHECK: address + owner + is_used validated in-handler against the
    /// CCTP message bytes; see `cctp::verify_message_and_amount`.
    #[cfg(feature = "cctp_attestation_verified")]
    pub cctp_used_nonce: UncheckedAccount<'info>,

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

    /// C4-OB-05: regression pin on the `TaskEscrow` account discriminator.
    /// Anchor derives an account discriminator as
    /// `sha256("account:<StructName>")[..8]`. If Settlement renames
    /// `TaskEscrow`, this breaks before ship instead of letting the Hook's
    /// `escrow_data[0..8]` type check silently reject every legit escrow.
    #[test]
    fn task_escrow_discriminator_matches_anchor_convention() {
        let preimage = b"account:TaskEscrow";
        let h = hash(preimage).to_bytes();
        let mut expected = [0u8; 8];
        expected.copy_from_slice(&h[..8]);
        assert_eq!(TASK_ESCROW_DISCRIMINATOR, expected);
    }

    /// C4-OB-01: the milestones-vec offset constant must equal the sum of
    /// the five `Pubkey` fields + `total_amount` + `released_amount` that
    /// precede `milestones` in `settlement::state::TaskEscrow`, plus the
    /// 8-byte Anchor discriminator. Pins the raw-bytes reconciliation read
    /// against a layout drift in Settlement.
    #[test]
    fn task_escrow_milestones_offset_matches_layout() {
        // 8 disc + 5*32 pubkeys + 8 total_amount + 8 released_amount
        let expected = 8 + (5 * 32) + 8 + 8;
        assert_eq!(TASK_ESCROW_MILESTONES_LEN_OFFSET, expected);
        // description_hash(32) + amount(8) + status(1) + grace_ends_at(8)
        assert_eq!(MILESTONE_ENTRY_SIZE, 49);
        assert_eq!(MILESTONE_AMOUNT_INNER_OFFSET, 32);
    }

    /// ADR-145: pin the CCTP V2 message-header offsets against
    /// `circlefin/solana-cctp-contracts`
    /// `message-transmitter-v2/src/message.rs`. If Circle changes the V2
    /// header layout this breaks before the Hook ships a wrong nonce
    /// derivation.
    #[test]
    fn cctp_v2_message_header_offsets_match_circle() {
        assert_eq!(CCTP_MSG_SOURCE_DOMAIN_INDEX, 4);
        assert_eq!(CCTP_MSG_DESTINATION_DOMAIN_INDEX, 8);
        assert_eq!(CCTP_MSG_NONCE_INDEX, 12);
        assert_eq!(CCTP_MSG_SENDER_INDEX, 44);
        // V2 nonce is the 32 bytes [12..44] — exactly the used_nonce seed.
        assert_eq!(CCTP_MSG_SENDER_INDEX - CCTP_MSG_NONCE_INDEX, 32);
        assert_eq!(CCTP_MSG_BODY_INDEX, 148);
    }

    /// ADR-145: pin the BurnMessage body offsets against
    /// `token-messenger-minter-v2/src/token_messenger_v2/burn_message.rs`.
    #[test]
    fn cctp_v2_burn_body_offsets_match_circle() {
        assert_eq!(CCTP_BURN_AMOUNT_INDEX, 68);
        assert_eq!(CCTP_BURN_EVM_OFFSET, 24);
        assert_eq!(CCTP_BURN_MIN_LEN, 228);
        // Solana reads u64 amount at AMOUNT_INDEX + OFFSET = 92.
        assert_eq!(CCTP_BURN_AMOUNT_INDEX + CCTP_BURN_EVM_OFFSET, 92);
    }

    /// ADR-145: the pinned MessageTransmitterV2 program ID must equal
    /// Circle's published canonical address.
    #[test]
    fn cctp_v2_message_transmitter_id_is_canonical() {
        assert_eq!(
            CCTP_MESSAGE_TRANSMITTER_V2_ID.to_string(),
            "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC"
        );
        assert_eq!(CCTP_SOLANA_DOMAIN, 5);
        assert_eq!(CCTP_BASE_DOMAIN, 6);
    }

    /// ADR-145: `expected_base_tx_binding` is a pure keccak over
    /// (source_domain BE || nonce) of the verified message — assert it
    /// is deterministic, sensitive to both inputs, and matches a
    /// hand-computed reference.
    #[test]
    fn cctp_base_tx_binding_is_deterministic_and_sensitive() {
        use anchor_lang::solana_program::keccak;

        let mut msg = vec![0u8; CCTP_MSG_BODY_INDEX + CCTP_BURN_MIN_LEN];
        // source_domain = 6 (Base), BE u32 at offset 4.
        msg[CCTP_MSG_SOURCE_DOMAIN_INDEX..CCTP_MSG_SOURCE_DOMAIN_INDEX + 4]
            .copy_from_slice(&CCTP_BASE_DOMAIN.to_be_bytes());
        // nonce bytes [12..44].
        for (i, b) in msg
            [CCTP_MSG_NONCE_INDEX..CCTP_MSG_SENDER_INDEX]
            .iter_mut()
            .enumerate()
        {
            *b = (i as u8).wrapping_add(1);
        }

        let got = cctp::expected_base_tx_binding(&msg).unwrap();

        // hand-computed reference.
        let mut pre = Vec::new();
        pre.extend_from_slice(&CCTP_BASE_DOMAIN.to_be_bytes());
        pre.extend_from_slice(&msg[CCTP_MSG_NONCE_INDEX..CCTP_MSG_SENDER_INDEX]);
        assert_eq!(got, keccak::hash(&pre).to_bytes());

        // deterministic.
        assert_eq!(got, cctp::expected_base_tx_binding(&msg).unwrap());

        // sensitive to a nonce-byte flip.
        let mut msg2 = msg.clone();
        msg2[CCTP_MSG_NONCE_INDEX] ^= 0xFF;
        assert_ne!(got, cctp::expected_base_tx_binding(&msg2).unwrap());

        // malformed (too short) → error, never panic.
        assert!(cctp::expected_base_tx_binding(&msg[..10]).is_err());
    }
}
