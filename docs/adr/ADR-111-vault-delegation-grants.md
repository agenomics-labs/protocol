# ADR-111: Vault delegation grants — bounded, auditable sub-authority

## Status

Proposed

## Date

2026-04-23

**Related:** ADR-024 (scoped CPI restrictions), ADR-028 (anti- Sybil), ADR-038 (vault CPI pattern), ADR-050 (execute_program_call removal), ADR-069 (agent identity rotation), ADR-072 (recipient guards), ADR-081 (emergency suspend)

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
- `mcp-server` gains `grant_delegation` / `revoke_delegation` /
  `list_active_grants` tools.
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
- Internal: ADR-024, ADR-028, ADR-038, ADR-050, ADR-069, ADR-072, ADR-081.
