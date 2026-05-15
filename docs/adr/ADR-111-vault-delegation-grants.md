# ADR-111: Vault delegation grants — bounded, auditable sub-authority

## Status

Accepted (2026-05-14)

## Date

2026-04-23 (proposed) / 2026-05-14 (accepted, v1 implemented)

**Related:** ADR-024 (scoped CPI restrictions), ADR-028 (anti- Sybil), ADR-038 (vault CPI pattern), ADR-050 (execute_program_call removal), ADR-069 (agent identity rotation), ADR-072 (recipient guards), ADR-081 (emergency suspend), ADR-095 (vault ↔ registry suspension coupling), ADR-124 (identity bind proof)

## Context

The agent-vault today has a binary authority model:

- `authority: Pubkey` — the human-custodied keypair. Can change
  policy, pause, rotate `agent_identity`, and initiate any CPI.
- `agent_identity: Pubkey` — the runtime hot key. Can sign
  `execute_transfer` and `execute_token_transfer`. Cannot change
  policy.

This is correct for the base case but **can't express narrower
delegations**:

- "This assistant agent can spend up to 100 USDC from this vault
  until Friday."
- "This orchestration system can trigger transfers to any of these
  three verified recipients, but no others."
- "This hired-for-the-week subagent can read but cannot spend."

Operators work around this by creating a second vault with a
second `agent_identity`, granting it a small balance, and topping
it up. That's wasteful (extra PDA rent) and loses the audit trail
(parent vault doesn't know the sub-vault exists in a
first-class way).

Saavedra — **"Interoperable Architecture for Digital Identity
Delegation for AI Agents with Blockchain Integration"**
(hf.co/papers/2601.14982, Jan 2026) — proposes formal **delegation
grants** as first-class on-chain objects:

- **Bounded**: every grant has an explicit scope (amount, time,
  recipient set, instruction set).
- **Auditable**: every grant emits a canonical issue/revoke event.
- **Least-privilege**: default-deny outside the grant's scope.
- **Revocable**: the grantor can revoke instantly; children revoke
  recursively.

This is the right shape to add as a vault extension.

## Decision

Add a `DelegationGrant` PDA child of `Vault`:

```rust
#[account]
pub struct DelegationGrant {
    pub vault: Pubkey,                  // parent Vault address
    pub grantee: Pubkey,                // sub-authority hot key
    pub created_at: i64,
    pub expires_at: i64,                // 0 = no expiry; u32::MAX = permanent
    pub spend_cap_lamports: u64,        // cumulative lifetime cap
    pub spent_lamports: u64,            // running tally (mutable)
    pub token_spend_caps: Vec<TokenSpendCap>, // per-mint caps
    pub allowed_recipients: Vec<Pubkey>, // empty = "any allowlisted recipient"
    pub allowed_actions: u8,            // bitfield; see below
    pub nonce: u8,                      // monotonic for PDA seed uniqueness
    pub revoked: bool,
    pub bump: u8,
}

bitflags! {
    pub struct GrantActions: u8 {
        const EXECUTE_TRANSFER       = 0b00000001;
        const EXECUTE_TOKEN_TRANSFER = 0b00000010;
        const READ_ONLY              = 0b00000000; // no action bits set
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TokenSpendCap {
    pub mint: Pubkey,
    pub cap: u64,
    pub spent: u64,
}
```

### Instructions

```rust
pub fn grant_delegation(
    ctx: Context<GrantDelegation>,
    grantee: Pubkey,
    expires_at: i64,
    spend_cap_lamports: u64,
    token_caps: Vec<TokenSpendCap>,
    allowed_recipients: Vec<Pubkey>,
    allowed_actions: u8,
) -> Result<()>;

pub fn revoke_delegation(ctx: Context<RevokeDelegation>) -> Result<()>;

pub fn execute_delegated_transfer(
    ctx: Context<ExecuteDelegatedTransfer>, // includes Vault + DelegationGrant
    amount_lamports: u64,
) -> Result<()>;

pub fn execute_delegated_token_transfer(
    ctx: Context<ExecuteDelegatedTokenTransfer>,
    amount: u64,
) -> Result<()>;
```

PDA seeds: `[b"delegation", vault.key(), grantee.key(), &nonce.to_le_bytes()]`.

### Enforcement

`execute_delegated_*`:
- MUST find `DelegationGrant` account matching vault + grantee.
- MUST check `revoked == false`, `expires_at == 0 || now < expires_at`.
- MUST increment `spent_lamports` / `token_spend_caps[mint].spent`
  atomically; revert on overflow past cap.
- MUST intersect `allowed_recipients` with the base vault
  `policy.program_allowlist` — the delegation never widens the
  vault's own allowlist (ADR-024 / ADR-072 guards still apply).
- MUST gate on ADR-095 suspension check of the parent vault's
  `agent_profile`.
- MUST emit `DelegatedTransferExecuted` event (authority, grantee,
  amount, recipient, cap_remaining).

`revoke_delegation`:
- Only vault `authority` can revoke.
- Sets `revoked = true`; does NOT close the account immediately
  (audit-trail preservation). A separate `close_delegation_grant`
  instruction archives expired+revoked grants ≥ 30 days old.

### Grantee signature model

The grantee signs like any runtime key — same pattern as
`agent_identity`. The DelegationGrant PDA is referenced in the
context, not an external signer.

## Alternatives considered

- **Keep workaround (sub-vaults)**. Keeps the protocol simple but
  doesn't scale and makes auditability painful.
- **Inline grants into Vault.policy**. Saves a PDA but makes policy
  an append-only log (can't expire cleanly, can't revoke a specific
  grant without touching others). Rejected.
- **Off-chain grants with on-chain signature verification** (similar
  to ERC-20 permit). Needs ed25519 sysvar precompile calls on every
  transfer — CU-expensive, and loses the canonical revoke event.
- **ERC-721-style NFT grants**. Over-engineered; transferability
  isn't a desired property (grants are personal to the grantee).

## Consequences

### Protocol

- New account kind; new instruction family; new events. Indexer
  (ADR-082) gains a `delegation_grants` table + event decoders.
- `mcp-server` MCP tool surface (`create_delegation_grant` /
  `revoke_delegation_grant` / `update_delegation_grant` /
  `execute_grant_transfer` / `execute_grant_token_transfer` /
  `get_delegation_grant` / `list_delegation_grants_for_vault`) is
  **deferred to a follow-up PR**. The first iteration of this ADR
  landed the on-chain primitive (program, IDL, SDK helpers, indexer
  projection) without the MCP wrappers — the wrappers need matching
  handlers + Action pipeline registrations that were out of scope for
  the first batch. Until the follow-up lands, callers integrate via
  the SDK (`sdk/client/src/vault.ts` — `GRANT_ACTIONS`,
  `GrantTokenCapInput`, `DELEGATION_SEED`) or by building the
  instructions directly against the IDL.
- dashboard renders "X delegations outstanding" per vault with
  expiry countdowns.

### Security

- Classic delegation-explosion concern: many grants → audit
  complexity. Mitigate via hard cap in `ProtocolConfig`:
  `max_active_grants_per_vault: u8` (default 32 ≈ 5 SOL of grant
  PDAs worst-case).
- Revocation-latency risk: a hostile grantee drains up to
  `spend_cap_lamports` before revoke is visible. Mitigate with the
  emergency suspend (ADR-081): authority can suspend the vault's
  `agent_profile`, which ADR-095 gates propagate to every delegated
  transfer in the same block.
- Nonce-reuse for closed grants: close-then-reopen with a fresh
  nonce prevents PDA resurrection of a revoked grant.

### Governance

- `max_active_grants_per_vault` is a `ProtocolConfig` field. Needs
  the same ADR-075 validation bounds as the other governance knobs.
- Upgrade path: v1 ships without recursive grants (grantees can't
  sub-delegate). Sub-delegation is a v2 ADR — proven useful first.

## Open items

1. **Rent**. Each DelegationGrant PDA is ~256 bytes allocated +
   Anchor discriminator + `Vec` buffers. Budget: ≤512 bytes per
   grant. Needs formal space calc before implementation, same
   pattern as ADR-040.
2. **CPI compute budget**. `execute_delegated_transfer` does the
   suspension gate (ADR-095) + delegation check + transfer. Early
   profiling needed to confirm it stays under CU ceilings.
3. **SAS credential integration**. The grantee pubkey could
   optionally carry a required SAS credential (ADR-061) —
   "grantee MUST hold `AEP_AGENT_REPUTATION_v1` subject attestation
   at grant time" — useful for HR-style grants to externally-vetted
   agents. Deferred to ADR-111b.
4. **UX of "grantee identity rotation"**. If a grantee rotates their
   hot key, their old grants don't automatically transfer. Document
   that each rotation requires a re-grant ceremony; encourage short
   expiries to bound the cost.

## References

- Saavedra, D. R. **"Interoperable Architecture for Digital Identity
  Delegation for AI Agents with Blockchain Integration."** 2026.
  <https://hf.co/papers/2601.14982>
- Internal: ADR-024, ADR-028, ADR-038, ADR-050, ADR-069, ADR-072, ADR-081,
  ADR-095, ADR-124.

## Implementation notes (2026-05-14, v1 acceptance)

The decision-shape above ships as-implemented with the following pinning.
Cross-reference the `AUD-DELEG-001` audit note in `docs/audits/` for the
invariant matrix the v1 enforces.

### Account layout (`DelegationGrant`)

Final field shape (mirrors `programs/agent-vault/src/state.rs`):

```rust
#[account]
pub struct DelegationGrant {
    pub vault: Pubkey,                 // parent Vault PDA
    pub grantor: Pubkey,               // vault.authority at create time
    pub grantee: Pubkey,               // signer for execute_grant_*
    pub allowed_actions: u8,           // bitflags (EXECUTE_TRANSFER=1, EXECUTE_TOKEN_TRANSFER=2)
    pub spend_cap_lamports: u64,       // lifetime SOL cap
    pub spent_lamports: u64,           // lifetime SOL spent (mutable)
    pub token_spend_caps: Vec<GrantTokenCap>, // per-mint caps, bounded at 10
    pub allowed_recipients: Vec<Pubkey>,      // bounded at 8 (empty = wildcard)
    pub expires_at: i64,               // 0 = no expiry sentinel
    pub revoked: bool,
    pub created_at: i64,
    pub nonce: u8,                     // third PDA seed
    pub bump: u8,
}
```

- `SPACE = 1024`. Worst-case serialized payload is ~884 bytes; 140 bytes
  of headroom for the v2 sub-delegation link and the optional SAS
  credential reference (open item #3).
- PDA seeds: `[b"delegation", vault, grantee, &[nonce]]`. Anchor's `init`
  rejects nonce reuse against an open PDA; v1 explicitly defers the
  close-then-reopen-with-same-nonce path to a future
  `close_delegation_grant` instruction (ADR-111b).
- `Vault.active_grant_count: u8` was added (1-byte tail field, absorbed
  by the existing 200-byte vault-space margin). Bumped on create,
  decremented on revoke. Hard cap `MAX_ACTIVE_GRANTS_PER_VAULT = 32`.

### Instruction signatures

Final shape:

```rust
create_delegation_grant(grantee, nonce, allowed_actions,
    spend_cap_lamports, token_caps, allowed_recipients, expires_at)
    -> only vault.authority

revoke_delegation_grant() -> grantee OR vault.authority OR grant.grantor

update_delegation_grant(new_allowed_actions, new_spend_cap_lamports,
    new_token_caps, new_allowed_recipients, new_expires_at)
    -> only vault.authority, tighten-only

execute_grant_transfer(amount_lamports) -> grantee
execute_grant_token_transfer(amount)    -> grantee
```

### Invariants enforced on every `execute_grant_*`

In handler-faithful order (a future refactor must preserve this — the
fuzz target `delegation_grant_policy` pins the priority):

1. `amount > 0` — fail with `InvalidAmount`.
2. ADR-095 suspension gate on parent vault's `agent_profile` —
   `AgentSuspended`.
3. `!vault.paused` — `VaultPaused`.
4. `!grant.revoked` — `GrantRevoked`.
5. `grant.is_within_window(now)` (i.e. `expires_at == 0 || now <
   expires_at`) — `GrantExpired`.
6. `grant.allows(action_bit)` — `ActionNotAllowed`.
7. `grant.is_recipient_allowed(recipient)` — `RecipientNotAllowed`.
8. Grant lifetime cap not exceeded (lamport OR per-mint) —
   `GrantSpendCapExceeded` / `GrantHasNoLamportCap` /
   `GrantTokenNotConfigured`.
9. Vault per-tx limit — `PerTxLimitExceeded` / `PerTxTokenLimitExceeded`.
10. Vault daily limit + day rollover — `DailyLimitExceeded` /
    `TokenDailyLimitExceeded`.
11. Vault rate-limit hourly window — `RateLimitExceeded`.
12. Rent-exempt minimum on the vault PDA post-transfer (SOL only) —
    `BelowRentExemption`.

Vault caps and grant caps are **additive**, never substitutive. ADR-111
§"Enforcement" rationale stands: a refactor that short-circuited vault
caps when the grant cap was finite would silently widen every grantee's
spend surface. The fuzz target pins this with property `P4 (vault cap
dominance)`.

### Tighten-only `update_delegation_grant` invariant

The handler rejects any update that would loosen scope:

- `new_allowed_actions ⊆ stored.allowed_actions` (no new bits).
- `new_spend_cap_lamports ≤ stored.spend_cap_lamports` AND
  `≥ stored.spent_lamports` (cap may shrink but not below
  already-spent).
- Per-mint caps may shrink but not raise; new mints cannot be
  introduced (re-issue a fresh grant for a broader scope).
- `new_allowed_recipients` MUST be a subset of stored; an empty stored
  list (wildcard) may tighten to non-empty, but a non-empty stored list
  cannot widen to empty.
- `new_expires_at`: if stored is 0 (no-expiry) any value tightens;
  otherwise `new_expires_at != 0 && new_expires_at <= stored`.

### Interaction with existing invariants

- **ADR-095 suspension coupling**: `create_delegation_grant` and both
  `execute_grant_*` handlers gate on
  `require_not_suspended(&agent_profile)`. A suspended agent cannot
  issue new grants OR transfer under existing ones — closing the seam
  where ADR-095 only covered direct transfers.
- **AUD-023 / ADR-069 daily-cap rotation lock**: Grant execution
  consumes the SAME `spent_today_lamports` and per-mint `spent_today`
  counters as direct `execute_transfer`. Rotating the
  `agent_identity` does NOT reset grant counters (grants are bound to
  `vault`, not `agent_identity`). A compromised authority rotating →
  draining → rotating is bounded by the 24h rotation cap on the
  authority side and by the per-mint and per-tx caps on the grant
  side.
- **ADR-097 Sybil nonce**: N/A — grants are issued by an
  already-registered authority. The vault's `profile_nonce` is used to
  re-derive the suspension-check profile PDA, identical to direct
  transfers.
- **ADR-124 identity bind**: N/A — grantee Ed25519 control is asserted
  by tx-signing semantics, not by a paired precompile. Future v2 may
  add an optional proof-of-control gate for high-risk grants (open
  item #3).
- **ADR-072 SEC-6 recipient guards**: The SPL transfer path retains
  the no-self-transfer / matching-mint constraints from
  `ExecuteTokenTransfer`. These run BEFORE the grant-scoped checks
  because they are Anchor account constraints, not handler-body
  `require!` calls.

### Threat model addendum

Net-new attack surfaces introduced by ADR-111:

1. **Grant-explosion DoS.** A compromised authority could issue up to
   32 grants × 1024-byte PDA = 32KB of rent per vault before
   `TooManyActiveGrants` fires. Mitigated by the active-grant cap and
   the fact that rent comes from the authority's own balance. A
   future ADR may move the cap to `ProtocolConfig`.
2. **Hostile grantee draining within the cap.** Default-allow recipient
   semantics (empty list) means a grantee can target ANY recipient
   subject to the vault's own gates. Mitigation: operators SHOULD
   issue grants with a non-empty `allowed_recipients` list. The
   `update_delegation_grant` tighten-only invariant means an emergency
   re-scoping by the authority is one tx away.
3. **Revocation latency.** Between the moment a grantee key leaks and
   the moment the revoke tx confirms (worst-case ~30s on devnet, ~1
   slot on mainnet), the grantee can drain up to `spend_cap_lamports`.
   ADR-111 §"Security" hardens this with: (a) the emergency suspend
   (ADR-081) propagates through the ADR-095 gate in the SAME slot, (b)
   the per-tx and daily caps still bind, (c) operators are encouraged
   to keep grant caps small relative to vault balances.
4. **Replay across surfaces.** Each execute_grant_* is a distinct
   on-chain instruction; the grant PDA carries `spent_lamports` /
   per-mint `spent` that are bumped under the same atomicity guarantee
   the runtime gives to other vault-state updates. No off-chain
   signatures are accepted; ed25519-permit-style flows were rejected
   in ADR-111 §"Alternatives considered".
5. **Indexer / dashboard staleness.** The four ADR-111 events feed the
   `delegation_grants` + `delegation_grant_events` projections under
   the indexer's at-least-once delivery model (ADR-082). A dashboard
   that aggregates "remaining cap" by subtracting events from the
   stored cap will, in the worst case, transiently understate
   remaining cap during a websocket-replay window — never overstate
   it. This is acceptable for monitoring; authoritative readings come
   from a direct account fetch.

### Surfaces touched

- `programs/agent-vault/src/{state,errors,events,contexts,instructions,lib}.rs`
- `programs/agent-vault/Cargo.toml` (new `no-entrypoint` / `cpi` feature gates)
- `tests/agent-vault.ts` (ADR-111 integration suite)
- `fuzz/fuzz_targets/delegation_grant_policy.rs` (B8 Phase 2 target)
- `fuzz/Cargo.toml` (new bin entry)
- `idl/agent_vault.json`, `sdk/idl/src/idl/agent_vault.json`
- `sdk/client/src/{vault,index}.ts`
- (MCP tool exposure `mcp-server/src/tools/{delegation,index}.ts`
  intentionally deferred — see Consequences §Protocol above)
- `src/indexer/index.ts` (disc-map, decoders, SQLite mirror, write paths)
- `src/indexer/migrations/004-adr-111-delegation-grants.sql`
- `src/indexer/migrations.embedded.ts`
- `dashboard/src/data/programs.js`, `README.md`, `SUMMARY.md`
- `docs/audits/AUD-DELEG-001-delegation-grants.md` (audit note)
