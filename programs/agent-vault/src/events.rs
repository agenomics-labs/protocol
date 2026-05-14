use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub agent_identity: Pubkey,
    pub authority: Pubkey,
    pub daily_limit: u64,
    pub per_tx_limit: u64,
}

/// Emitted when the vault authority rotates `agent_identity` via
/// `update_agent_identity`. Indexers should treat this as the authoritative
/// signal that the old identity key is no longer authorized to sign
/// `execute_transfer` / `execute_token_transfer` on this vault.
///
/// See ADR-069 for the design rationale (SEC-2 from DEEP-AUDIT-2026-04-22).
#[event]
pub struct AgentIdentityUpdated {
    pub vault: Pubkey,
    pub old_identity: Pubkey,
    pub new_identity: Pubkey,
}

#[event]
pub struct PolicyUpdated {
    pub vault: Pubkey,
    pub daily_limit: u64,
    pub per_tx_limit: u64,
    pub max_txs_per_hour: u32,
}

#[event]
pub struct TransactionExecuted {
    pub vault: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
    pub success: bool,
}

#[event]
pub struct ProgramCallExecuted {
    pub vault: Pubkey,
    pub program_id: Pubkey,
    pub instruction_hash: [u8; 32],
    pub timestamp: i64,
    pub success: bool,
}

#[event]
pub struct TokenTransferExecuted {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct AllowlistUpdated {
    pub vault: Pubkey,
    pub item: Pubkey,
    pub action: String,
}

#[event]
pub struct VaultPaused {
    pub vault: Pubkey,
}

#[event]
pub struct VaultResumed {
    pub vault: Pubkey,
}

// ============================================================================
// ADR-138: Execution provenance attestations
// ============================================================================

/// Classifier for the on-chain action that produced an `ExecutionAttested`
/// event. Encoded as a 1-byte Borsh enum tag on the wire (positional, in
/// declaration order — DO NOT reorder, or every previously-indexed event
/// silently re-classifies).
///
/// Variants intentionally mirror the value-moving and authority-changing
/// surfaces in the vault program. `GrantTransfer` / `GrantTokenTransfer`
/// are reserved for the ADR-111 delegation-grants branch (which lands in
/// `claude/delegation-grants-adr-111`); they are declared here so the
/// future merge is additive and existing tag values do not shift.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionKind {
    Transfer,
    TokenTransfer,
    PolicyUpdate,
    AllowlistManage,
    IdentityRotation,
    PauseToggle,
    /// ADR-111 reserve. Emitted when `execute_transfer` runs under a
    /// `DelegationGrant` PDA (not yet implemented in this branch).
    GrantTransfer,
    /// ADR-111 reserve. Emitted when `execute_token_transfer` runs under a
    /// `DelegationGrant` PDA (not yet implemented in this branch).
    GrantTokenTransfer,
}

/// ADR-138: cryptographically-verifiable provenance record emitted at the
/// end of every value-moving or authority-changing vault instruction.
///
/// Binds:
///   - WHICH agent signed (`agent_identity`),
///   - WHICH human-custodied vault `authority` the agent is acting for,
///   - WHICH MCP tool triggered the action (`tool_id`, a SHA-256 over the
///     tool identifier — see `sdk/client` helper `toolIdHash`),
///   - WHICH capability manifest the agent was operating under
///     (`manifest_hash`, copied from `AgentProfile.manifest_hash` at
///     execution time; zero-hash means the profile had no manifest set),
///   - WHICH policy version was in force (`policy_version`,
///     monotonically-bumped on every `update_policy`),
///   - WHICH delegation grant authorised the action, when applicable
///     (`delegation_grant`; `None` when the action ran under the
///     vault's primary authority / agent_identity pair). Coexists with
///     the ADR-111 grant surface — see `ActionKind::GrantTransfer`.
///
/// Plus the value-bearing fields the action actually moved (`amount`,
/// `mint`, `recipient`) and the slot/timestamp pair so an indexer can
/// reconstruct the canonical timeline without an extra RPC round-trip.
#[event]
pub struct ExecutionAttested {
    pub vault: Pubkey,
    pub agent_identity: Pubkey,
    pub authority: Pubkey,
    pub action_kind: ActionKind,
    /// SHA-256 over the MCP tool identifier (`sha256("agenomics.tool." +
    /// name)`). The all-zeros sentinel is allowed (callers that haven't
    /// migrated yet) — indexers MAY emit a `tool_id_zero_count` metric.
    pub tool_id: [u8; 32],
    /// Copied from `AgentProfile.manifest_hash` at execution time. The
    /// all-zeros sentinel means the agent had no manifest registered
    /// (ADR-060 pre-manifest profile) — distinct from "no manifest used".
    pub manifest_hash: [u8; 32],
    pub policy_version: u32,
    /// Set when the action executes under an ADR-111 `DelegationGrant`
    /// PDA. Always `None` in this branch; left as `Option<Pubkey>` so the
    /// future merge with `claude/delegation-grants-adr-111` is additive.
    pub delegation_grant: Option<Pubkey>,
    /// `0` for non-value actions (PolicyUpdate, AllowlistManage,
    /// IdentityRotation, PauseToggle).
    pub amount: u64,
    /// `Some(mint)` for token transfers; `None` for SOL transfers and
    /// non-value actions.
    pub mint: Option<Pubkey>,
    /// `Some(recipient)` for transfer actions; `None` for non-value
    /// actions.
    pub recipient: Option<Pubkey>,
    pub slot: u64,
    pub timestamp: i64,
}
