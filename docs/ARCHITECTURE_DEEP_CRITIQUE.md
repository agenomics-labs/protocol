# AEP Architecture Deep Critique

**Date:** 2026-04-17
**Branch:** `claude/architecture-audit-N9QMS`
**Scope:** All three Solana programs (settlement, agent-registry, agent-vault),
MCP server handlers, off-chain indexer, x402 payment relay, and CI posture.
**Status:** Post-ADR-053. Complements (does not replace) `docs/ARCHITECTURE_AUDIT.md`
and ADR-037. Findings here are primarily new or residual after ADR-039, 046,
047, 048, 049, 050, 051, 052, 053.

---

## Executive Summary

The protocol has reached a mature surface — three Solana programs, a 23-tool
MCP bridge, off-chain indexer, and x402 payment relay — with a credible
security posture in the core CPI graph (PDA-signed reputation updates,
checks-effects-interactions in `approve_milestone`, Anchor constraints on
most sensitive accounts). However, a deep re-read of the current source
surfaces **three classes of problem that together block any mainnet move**:

1. **Economic integrity holes** — `expire_escrow` + missing deadline guard
   on `approve_milestone` combine to let a client **drain the provider
   deterministically**: accept work, withhold approval, wait for deadline,
   receive full refund, and the provider's reputation is slashed. The
   "client-as-resolver" pattern also neuters the A-03 dispute slash guard.

2. **Runtime-broken instructions** — `unstake_reputation` **will fail on
   mainnet** the first time it is called, because the staking PDA is
   system-owned and only the owning program may decrement lamports.
   `update_status` has no Suspended→Active edge, so three dispute losses
   turn into a permanent ban with no governance path. These were shipped
   without local-validator integration tests.

3. **Non-functional off-chain components masquerading as functional** — the
   indexer's discriminator map contains **15 fabricated hex values** (none
   match real Anchor event discriminators), and `updateAgentFromEvent` reads
   four fields the parser never produces. The indexer has been written in
   good faith but could not have populated its `agents` table once since it
   was merged. Discovery still relies on `getProgramAccounts` because the
   indexer cannot actually substitute for it.

Additionally, three MCP handlers (`resolveDisputeTimeout`, `stakeReputation`,
`vaultTokenTransfer`) drift from their current Anchor contexts and will fail
at TX build/submit time — they have never been exercised end-to-end.

The CPI authority model, the settlement state machine, the token-transfer
rate limiter (on SOL), and the ADR-049 module split are genuine strengths.
The weaknesses are concentrated at the edges: deadline semantics,
off-chain classification, and client-layer drift.

---

## Risk Ranking (at a glance)

| Tier | Count | What it blocks |
|------|------:|----------------|
| **Critical** | 5 | Any mainnet activity; external audit engagement |
| **High** | 11 | Feature completeness; user-facing reliability |
| **Medium** | 8 | Operational maturity; governance; observability |
| **Informational** | — | (Covered in prior ADR-037 audit) |

All severities below are **new or residual** relative to prior audits.

---

## Severity Matrix

| ID | Sev | Component | Short Title | Mitigation Effort |
|----|-----|-----------|-------------|-------------------|
| C1 | Critical | settlement | Expire-escrow refund-and-slash attack | Medium |
| C2 | Critical | settlement | `approve_milestone` has no deadline check | Low |
| C3 | Critical | settlement | Client-as-resolver bypasses A-03 slash guard | Low |
| C4 | Critical | agent-registry | `unstake_reputation` violates Solana ownership invariant | Medium |
| C5 | Critical | agent-registry | Suspended status is a permanent trap | Low |
| H1 | High | indexer | Discriminator map contains fabricated hex values | Medium |
| H2 | High | indexer | `updateAgentFromEvent` reads fields the parser never produces | Low |
| H3 | High | agent-registry / settlement CPI | `avg_rating` is dead state (CPI hardcodes `rating=0`) | Low |
| H4 | High | agent-registry | `vault_address` field is never validated | Medium |
| H5 | High | mcp-server | `handleResolveDisputeTimeout` account shape wrong | Low |
| H6 | High | mcp-server | `handleStakeReputation` field-name mismatch | Low |
| H7 | High | mcp-server | `handleVaultTokenTransfer` passes extra account | Low |
| H8 | High | agent-vault | `execute_token_transfer` missing `per_tx_limit` | Low |
| H9 | High | agent-vault | `daily_limit_lamports` conflates decimal schemes | Low |
| H10 | High | agent-vault | Direct lamport mutation without rent-exemption check | Low |
| H11 | High | x402-relay | Replay-prune flood unlocks replay | Low |
| M1 | Medium | settlement ↔ registry | CPI uses hardcoded discriminator instead of Anchor CPI helper | Medium |
| M2 | Medium | mcp-server | Discovery still uses `getProgramAccounts` | Medium |
| M3 | Medium | governance | Compile-time parameters require program upgrade to change | High |
| M4 | Medium | settlement | `has_one` coverage inconsistent; handlers compensate | Low |
| M5 | Medium | settlement | `client_vault`/`provider_vault` in `CreateEscrow` are UncheckedAccount | Low |
| M6 | Medium | CI | Missing clippy, audits, integration tests, `src/*` typecheck | Low |
| M7 | Medium | indexer | No idempotency, backfill, or cursor persistence | Medium |
| M8 | Medium | ops | No structured logging or metrics pipeline | Medium |

---

## 1. Economic Soundness

The settlement program's biggest architectural weakness is that
**approval is not a temporal obligation**. Work can be submitted before
the deadline, but the client has no deadline-bound duty to approve or
reject. When combined with `expire_escrow`'s refund-and-slash semantics,
this produces exploitable asymmetry.

### C1 — Expire-escrow refund-and-slash attack

**Location:** `programs/settlement/src/instructions/escrow.rs:320-422`
(`expire_escrow`).

**Mechanics.** `approve_milestone` (lines 143-238) releases the milestone
amount to the provider immediately and updates `released_amount`. So at
expiry time, every approved milestone has *already* been paid out, and
`escrow.released_amount == sum(approved milestones)`. The "protection"
math at lines 330-347:

```rust
let mut provider_earned: u64 = 0;
for milestone in &escrow.milestones {
    if milestone.status == MilestoneStatus::Approved {
        provider_earned = provider_earned.checked_add(milestone.amount)?;
    }
}
provider_earned = provider_earned.saturating_sub(escrow.released_amount);
```

always evaluates to `0` because the two sums are definitionally equal
under the immediate-release model. ADR-025 intended to "protect the
provider against loss of approved work on deadline expiry", but the
protection is a no-op — approved work is protected by `approve_milestone`
itself, not by `expire_escrow`.

**The attack.** At lines 395-413:

```rust
let has_undelivered = escrow.milestones.iter()
    .any(|m| m.status == MilestoneStatus::Submitted);
...
if has_undelivered {
    update_provider_reputation(
        provider_key_for_slash, 0,
        REPUTATION_DELTA_EXPIRY_UNDELIVERED, // -10
        false, ...
    )?;
}
```

`has_undelivered` triggers on *Submitted* milestones. Combined with a
full refund of the remaining balance (`client_refund = remaining`), the
economically dominant strategy for a malicious client is:

1. Create escrow, lock `total_amount`.
2. Wait for provider to submit milestones.
3. **Do nothing.** Neither approve nor reject. There is no incentive
   or on-chain obligation.
4. At `deadline + 1`, anyone (including the client) calls `expire_escrow`.
5. Client receives `total_amount` refunded. Provider receives nothing for
   submitted work and is **slashed -10 reputation**.
6. Three such rounds and the provider is `Suspended` permanently (see C5).

**Economic damage.** A client can acquire work valued at `total_amount`
for zero cost, and simultaneously destroy a competing provider's
reputation. This is worse than the original S-A6 finding ADR-025 tried
to fix, because ADR-025 assumed approval was a credible action the
client would take under normal conditions. The underlying model makes
approval *optional*, so malicious clients will never take it.

**Recommendations.**

- **Primary:** On expiry, treat `Submitted` milestones as implicitly
  approved (pay provider, do not slash). Rationale: the submission is
  on-chain evidence of delivery; if the client disagreed they had the
  full deadline window to `reject_milestone` (which sends back to Pending
  for re-work) or `raise_dispute`. Silence = acceptance.
- **Secondary:** Add a "grace period" after `deadline` during which the
  client may still approve or reject; only after grace expires does
  the Submitted→paid default apply.
- **Never** slash on `has_undelivered` without distinguishing client
  silence from provider non-submission. The current boolean conflates
  two very different failure modes.

---

### C2 — `approve_milestone` has no deadline check

**Location:** `programs/settlement/src/instructions/escrow.rs:143-238`.

`submit_milestone` at line 118 correctly gates on `now ≤ deadline`, but
`approve_milestone` has no analogous check. Consequences:

- A submitted milestone that the client *wants* to approve after the
  deadline cannot be approved — they can still `approve_milestone`, but
  the instruction has no status guard, so approval after deadline is
  *allowed*. This is the opposite surprise: approval is permissive,
  submission is restrictive.
- Combined with C1, it removes the only non-malicious path the client
  has to rescue the provider. A slow client who genuinely wants to pay
  after the deadline cannot rely on consistent semantics.

The asymmetry is architectural: the deadline constrains *provider
behavior* but not *client behavior*. That is precisely backwards —
escrow deadlines exist to bound provider delivery risk, so clients
should be the party with post-deadline obligations.

**Recommendation.** Either (a) allow `approve_milestone` after deadline
with an explicit "post-deadline approval" branch that also prevents
`expire_escrow` until all submitted work is resolved, or (b) require
`approve_milestone` to be called before deadline by adding a `deadline`
check symmetric to `submit_milestone`, and split expiry into two
instructions: `expire_submitted_to_provider` and `expire_pending_to_client`.

---

### C3 — Client-as-resolver bypasses A-03 slash guard

**Location:** `programs/settlement/src/instructions/dispute.rs` — the
`resolve_dispute` slash gating at the A-03 mitigation:

```rust
if client_refund > 0 && is_resolver { slash(...) }
```

where `is_resolver` is "caller is the `dispute_resolver`". The intent is:
if a third-party resolver sides with the client, the provider gets
slashed; but if the *client themselves* resolves (a degenerate case),
don't slash.

**The problem.** `create_escrow` accepts `dispute_resolver: Option<Pubkey>`
with no constraint that it differs from `client`. A client can set
themselves as their own resolver. When they then call `resolve_dispute`
with `client_refund > 0`, `is_resolver == true` and the guard fires —
but "the guard firing" in A-03 means *slashing the provider*. The
mitigation was: don't slash when client self-resolves. In the current
code, that is what happens: self-resolve means the provider *is* slashed.

Actually the worse problem: if `is_resolver = caller == dispute_resolver`
and the client *is* the dispute_resolver, then any self-favorable
resolution slashes the provider. A client with a one-sided grudge has
a tool to both refund themselves and wreck the provider's reputation
in a single TX.

**Recommendation.**

- In `create_escrow`, require `dispute_resolver != client` and
  `dispute_resolver != provider`.
- Allow `None` for "no external resolver" and route such disputes to
  the ADR-030 timeout path only.
- Add a unit test: attempting to create with resolver == client must fail.

---

## 2. Runtime-Broken Instructions

Two instructions in the Registry program ship in the current tree but
cannot function on a real validator. Both would be caught by a single
integration test against `solana-test-validator`.

### C4 — `unstake_reputation` violates Solana ownership invariant

**Location:** `programs/agent-registry/src/lib.rs:163-179` +
`programs/agent-registry/src/contexts.rs:92-112`.

```rust
// contexts.rs
#[account(
    mut,
    seeds = [authority.key().as_ref(), b"reputation-stake"],
    bump
)]
pub staking_pda: UncheckedAccount<'info>,   // not initialized with `init`
```

```rust
// lib.rs unstake_reputation
**staking_pda_info.try_borrow_mut_lamports()? =
    staking_pda_info.lamports().checked_sub(amount)...;
**authority_info.try_borrow_mut_lamports()? =
    authority_info.lamports().checked_add(amount)...;
```

**Why it fails.** The staking PDA is created implicitly when
`stake_reputation` calls `system_program::transfer(authority → pda, amount)`.
The runtime creates an account with `owner == SystemProgram`. Only the
account owner may *decrement* lamports (Solana runtime invariant —
anyone may *transfer in*, only the owner may transfer out). When
`agent_registry` calls `try_borrow_mut_lamports` and subtracts, the
runtime's post-instruction invariant check rejects the transaction
with `ExternalAccountLamportSpend`.

**In practice:** every `unstake_reputation` transaction reverts. Staked
SOL is recoverable only by upgrading the program to either
(a) `init_if_needed` the PDA under the registry's ownership on the
first stake, or (b) CPI `system_program::transfer` on unstake — which
requires the PDA to be system-owned *and* signed by the PDA (which the
registry can do via `invoke_signed` with the seeds).

**Recommendation.**

1. Change `StakeReputation` context so the first `stake_reputation` call
   `init`s the staking PDA with `owner = agent_registry_program_id` and
   allocates 8 bytes (or a small `StakeState` account if you want an
   auditable record). Subsequent stakes `realloc` or just add lamports.
2. In `unstake_reputation`, keep the direct lamport mutation — this is
   now legal because the registry owns the account.
3. Or (simpler) make the staking PDA a `system_account!`-style transfer
   out via `invoke_signed` and keep it system-owned. Either pattern
   works; the current code is neither.
4. **Add an integration test** that stakes, then unstakes, against
   `solana-test-validator`. This bug cannot survive a single such test.

---

### C5 — Suspended status is a permanent trap

**Location:** `programs/agent-registry/src/lib.rs:94-108`.

```rust
match (&agent_profile.status, &new_status) {
    (AgentStatus::Retired, ...) => Err(...),
    (AgentStatus::Suspended, AgentStatus::Active)
    | (AgentStatus::Suspended, AgentStatus::Paused) =>
        Err(InvalidStatusTransition),
    _ => { agent_profile.status = new_status; }
}
```

After 3 slashes (`update_reputation` at `lib.rs:133-141`), the agent
becomes `Suspended`. There is **no transition back** — neither governance
instruction, nor cooldown, nor stake-forfeiture-for-reinstatement path.
The only allowed transition out is to `Retired` (which also closes the
profile). Given that C1 can produce 3 slashes in as few as 3 malicious
escrows (each cheap — `MIN_ESCROW_AMOUNT = 10,000 base units ≈ 0.01 USDC`),
a coordinated attacker can permaban an arbitrary agent for ~$0.03 in
settlement fees + TX fees.

**Recommendation.**

- Add `unsuspend_agent(ctx, ...)` gated by either (a) a governance PDA
  (which requires M3 to be resolved), (b) a reputation-stake forfeiture
  (burn staked SOL to reset slash_count), or (c) a time-based cooldown
  (e.g., 30 days after last slash).
- Until governance exists, option (b) is the cleanest self-service
  path and creates economic skin-in-the-game.
- Cap the slash counter or decay it over time.

---

## 3. Off-Chain Observability — Non-Functional Indexer

The off-chain event indexer is the protocol's only avenue for (a)
event history queries, (b) `agents` table population, and (c)
substituting for expensive `getProgramAccounts` discovery. The current
implementation is non-functional through no single intentional omission,
but through two compounding bugs.

### H1 — Discriminator map contains fabricated hex values

**Location:** `src/indexer/index.ts:59-77`.

```ts
const DISCRIMINATOR_MAP: Record<string, string> = {
  "40de3a87fb1a2b49": "EscrowCreated",
  "5b3a79c0e8f1d264": "TaskAccepted",
  ...
};
```

These 15 hex values are *not* real Anchor event discriminators. Anchor
computes event discriminators as
`sha256("event:<EventName>")[..8]` (differs from instruction
discriminators which use `"global:<name>"`). The values in the map
appear to be lexically plausible hex but have no computational
relationship to the actual event names — no hash computation in any
language produces this mapping.

**Verification.** Computing the real discriminators with Rust:

```rust
use anchor_lang::solana_program::hash::hash;
let h = hash(b"event:EscrowCreated").to_bytes();
// [..8] is the real discriminator; it is not "40de3a87fb1a2b49"
```

**Impact.** Every event emitted by the three programs falls through the
map to the fallback `event_${discriminator.substring(0, 8)}` name. The
`events` table will accumulate rows with event_name values like
`event_e445a52e`, `event_88fd2e22`, etc., useless for query/filter.

**Recommendation.**

- Generate the map programmatically at indexer startup from the IDL
  files under `target/idl/*.json` (`idl.events[].name` → sha256
  discriminator). This is what the `@coral-xyz/anchor` `EventParser`
  does; reusing it is preferable to a static table.
- Alternatively, run a one-time `cargo run --bin compute-discriminators`
  script to emit the correct values and commit them with a comment
  referencing the generator.
- Remove the static table entirely and use
  `anchor.EventParser(programId, coder).parseLogs(logs)` inside
  `parseLogsForEvents`.

---

### H2 — `updateAgentFromEvent` reads fields the parser never produces

**Location:** `src/indexer/index.ts:110-142`.

```ts
function updateAgentFromEvent(db, event) {
  const data = event.data as Record<string, string>;
  if (event.name === "AgentRegistered") {
    stmt.run(
      data.authority || "unknown",
      data.name || null,
      data.category || null
    );
  }
  if (event.name === "ReputationUpdated") {
    stmt.run(
      parseInt(data.new_score || "0", 10),
      data.authority || "unknown"
    );
  }
}
```

But the parser at lines 79-108 only ever produces:

```ts
events.push({
  name: eventName,
  data: { discriminator, rawData },  // <-- only these two keys
});
```

So `data.authority`, `data.name`, `data.category`, `data.new_score` are
all `undefined`. With the `||` fallbacks, the `agents` table receives
`authority = "unknown"` and everything else `null`. The `ON CONFLICT`
clause keys on `authority`, so every row collapses to a single
`(authority = "unknown")` entry that gets continuously overwritten.

Compounded by H1: this code path is never even reached, because
`event.name` is always `event_<hex>` and never `AgentRegistered` /
`ReputationUpdated`. The bug is double-dead.

**Recommendation.**

- After fixing H1 with IDL-driven parsing, populate `event.data` from
  the decoded Anchor event struct fields (convert camelCase → snake_case
  or keep consistent).
- Add a test fixture: a real transaction log emitted by
  `create_escrow` on devnet, parsed through the indexer, should produce
  an `EscrowCreated` event with populated fields.

---

### H3 — `avg_rating` is dead state (CPI hardcodes `rating = 0`)

**Location:**
`programs/settlement/src/instructions/cpi.rs:32` and
`programs/agent-registry/src/lib.rs:110-146`.

```rust
// cpi.rs
let rating: u8 = 0;
```

```rust
// registry lib.rs
if task_completed {
    ...
    if rating > 0 {
        let n = agent_profile.total_tasks_completed as u128;
        ...
        agent_profile.avg_rating = new_avg.min(5) as u8;
    }
}
```

Settlement is the only CPI caller of `update_reputation`. It always
passes `rating = 0`. `update_reputation` guards the `avg_rating`
update on `rating > 0`. Therefore `avg_rating` is never written — it
stays at its `register_agent` default of `0` forever. The property-based
fuzz test `avg_rating_bounded` at `lib.rs:275-283` tests logic that
never runs in production.

**Recommendation.**

- Either thread a real rating (1-5) from an on-chain source (e.g.,
  client supplies rating in `approve_milestone`, averaged at
  escrow-completion-CPI time), or
- Delete the `avg_rating` field and the `update_reputation` rating
  branch. Dead state in a public IDL is worse than absence — it
  signals a feature that isn't there.

---

### H4 — `vault_address` field is never validated

**Location:** `programs/agent-registry/src/lib.rs:19-64` (register/update),
`programs/agent-registry/src/state.rs` (AgentProfile definition).

`AgentProfile.vault_address` is a user-supplied `Pubkey` that the
Registry stores verbatim. No constraint ties it to a real Vault PDA
owned by the authority. Settlement's `CreateEscrow` also does not
consult this field.

**Impact.** A malicious agent can register with `vault_address` pointing
at an attacker-controlled vault, or an empty public key. Off-chain
consumers (the MCP server's discovery, dashboards, or any client that
auto-wires a vault for payouts) may route funds to the wrong account
if they trust this field.

**Recommendation.**

- Add an Anchor `constraint` that `vault_address` matches the PDA
  derived from `[b"vault", authority]`. This requires passing the
  vault account in the context.
- Or derive `vault_address` on-chain at registration time from the
  authority (remove it as a user-supplied parameter).
- Off-chain consumers must in any case verify by re-deriving the PDA
  from the authority key rather than trusting stored values.

---

## 4. MCP Client-Layer Correctness

Three MCP handlers have drifted from their target Anchor contexts. Each
is a cheap fix, but collectively they indicate that the MCP → program
integration has never been exercised end-to-end for the affected
instructions. This ties directly to ADR-037 M4 ("new instructions have
no integration tests") — the warning was explicit, and the regressions
predicted by it have materialized.

### H5 — `handleResolveDisputeTimeout` account shape wrong

**Location:** `mcp-server/src/handlers/settlement.ts:451-462` vs
`programs/settlement/src/contexts.rs:225-271`.

Handler sends:

```ts
.accounts({
  caller: wallet.publicKey,              // ← context expects `payer`
  escrow: escrowAddress,
  escrowTokenAccount,
  clientTokenAccount,
  providerTokenAccount,                   // ← not in context
  tokenProgram: TOKEN_PROGRAM_ID,
  // Missing: registryProgram,
  //          providerProfile,
  //          settlementAuthority
})
```

Context `ResolveDisputeTimeout` declares `payer`, `escrow`,
`escrow_token_account`, `client_token_account`, `registry_program`,
`provider_profile`, `settlement_authority`, `token_program`. ADR-050
added the registry accounts for slashing on timeout; the MCP handler
was not updated.

**Impact.** Every `resolveDisputeTimeout` MCP call fails at
`Program.methods(...)` TX build: missing required accounts, extraneous
keys the IDL doesn't recognize.

**Recommendation.** Mirror the context exactly:

```ts
.accounts({
  payer: wallet.publicKey,
  escrow: escrowAddress,
  escrowTokenAccount,
  clientTokenAccount,
  registryProgram: REGISTRY_PROGRAM_ID,
  providerProfile: deriveAgentProfilePDA(provider)[0],
  settlementAuthority: deriveSettlementAuthorityPDA()[0],
  tokenProgram: TOKEN_PROGRAM_ID,
})
```

Add PDA derivation helpers in `solana.ts` if absent.

---

### H6 — `handleStakeReputation` field-name mismatch

**Location:** `mcp-server/src/handlers/registry.ts:256-265` vs
`programs/agent-registry/src/contexts.rs:66-90`.

Handler sends `stakingAccount`, context declares `staking_pda` which
Anchor's client IDL exposes as `stakingPda`. The `stakingAccount` key is
ignored, leaving the required `stakingPda` unset. TX build fails.

**Recommendation.** Rename to `stakingPda` in the handler. Add a TS
integration test that exercises the full `stakeReputation` path.

---

### H7 — `handleVaultTokenTransfer` passes extra `tokenMint` account

**Location:** `mcp-server/src/handlers/vault.ts:160-170` vs
`programs/agent-vault/src/contexts.rs:92-119`.

Context `ExecuteTokenTransfer` does not declare a `tokenMint` account;
the mint is read implicitly from `vault_token_account.mint`. The handler
passes a `tokenMint` key which Anchor ignores. Not a runtime failure
(extra keys are dropped), but indicates drift and will mislead anyone
auditing the call shape or using the handler as a template for a
future instruction that *does* declare a mint.

**Recommendation.** Drop the `tokenMint` field. If the MCP tool schema
requires a mint argument for UX, resolve the mint off-chain to derive
the vault ATA (which is already happening) and do not forward it to
the TX builder.

---

## 5. Defense-in-Depth Completeness

### H8 — `execute_token_transfer` missing `per_tx_limit` check

**Location:** `programs/agent-vault/src/instructions.rs:262-347` vs
the SOL path at line 181 where `amount_lamports ≤ per_tx_limit_lamports`
is enforced.

The token path enforces hourly rate (txs/hour) and daily caps, but not
per-transaction. A single `execute_token_transfer` can move up to the
full remaining daily allowance in one shot. This is inconsistent with
the SOL path's layered limits.

**Recommendation.** Add a symmetric check after the allowlist gate:

```rust
require!(
    amount <= vault.policy.per_tx_limit_lamports,
    VaultError::ExceedsPerTxLimit
);
```

Even better: introduce explicit per-token `TokenLimits` (see H9).

---

### H9 — `daily_limit_lamports` conflates decimal schemes

**Location:** `programs/agent-vault/src/state.rs` (policy) and
`programs/agent-vault/src/instructions.rs:311` (token daily cap check).

The same `daily_limit_lamports` scalar is used as the per-token daily
spending cap for *every* allowlisted mint. But SOL uses 9 decimals,
USDC uses 6, other tokens may use 0-18. A policy of `daily_limit =
10_000_000 lamports` means 0.01 SOL for the native transfer but
`10_000_000` base units = 10 USDC for USDC, etc. These are not
economically equivalent.

**Impact.** Either the SOL cap is too generous (if tuned for USDC), or
the USDC cap is too restrictive (if tuned for SOL). Multi-token vaults
are effectively unsafe to configure without per-mint policies.

**Recommendation.** Replace the scalar with per-token policy:

```rust
pub struct TokenPolicy {
    pub mint: Pubkey,
    pub per_tx_limit: u64,
    pub daily_limit: u64,
}
pub token_policies: Vec<TokenPolicy>,  // capped by MAX_TOKEN_POLICIES
```

Tie `TokenSpendRecord` to its corresponding policy entry. Keep
`daily_limit_lamports` for the native SOL path only.

---

### H10 — Direct lamport mutation without rent-exemption check

**Location:** `programs/agent-vault/src/instructions.rs` (`execute_transfer`
handler — direct lamport borrow + subtract).

`execute_transfer` decrements the vault PDA's lamports directly. There
is no post-transfer check that the vault remains above the rent-exempt
minimum. A drain to below rent-exemption makes the account eligible for
garbage collection in the Solana runtime's rent regime (currently not
enforced, but the economic invariant is documented and may become
active again).

**Recommendation.** After the subtract, require
`vault_info.lamports() >= Rent::get()?.minimum_balance(vault_info.data_len())`.
Same guard should apply to any future instruction that moves lamports
out of a Registry- or Settlement-owned PDA.

---

### H11 — x402 replay-prune flood unlocks replay

**Location:** `src/x402-relay/index.ts:18-26`.

```ts
const redeemedSignatures = new Set<string>();
function pruneRedeemedSignatures(): void {
  if (redeemedSignatures.size > 10000) {
    redeemedSignatures.clear();   // ← nukes everything
  }
}
```

An attacker who can submit 10k unique (or even random-looking)
signatures at `/pay` triggers a full cache clear. Any previously-redeemed
signature — still within the JWT TTL — becomes replayable. Combined with
the relay's `confirmed` (not `finalized`) commitment, reorg-vulnerable
signatures add an additional window.

Other gaps in the relay:

- **No persistence.** Restart wipes `redeemedSignatures`; all
  previously-redeemed signatures can be replayed within TTL.
- **`confirmed` commitment.** A confirmed tx can be dropped in a reorg
  and re-submitted with the same signature as a different logical
  payment.
- **No upper bound on TTL vs window.** If `TOKEN_EXPIRY` is long, the
  replay window dominates.

**Recommendation.**

- Replace the in-memory Set with a TTL-indexed map
  (`Map<signature, expiresAt>`) and prune entries by expiry, not by set
  size. When `size > N`, drop the oldest N-k entries, not everything.
- Persist redemptions to disk (SQLite or the same AgentDB the indexer
  uses). The relay should survive restart without losing replay
  protection for tokens still valid.
- Upgrade verification to `finalized` commitment.
- Tie the replay window to the token's `exp` claim, not to a cache
  size heuristic.

---

## 6. CPI & Cross-Program Coupling

The CPI authority model (PDA-signed calls with `seeds::program`
verification) is genuinely strong — ADR-001 and ADR-007 remain the
clearest security foundation in the protocol. But the *implementation*
of the settlement → registry CPI uses a brittle manual pattern that
does not take advantage of Anchor's type system.

### M1 — Hardcoded CPI discriminator instead of Anchor CPI helper

**Location:** `programs/settlement/src/instructions/cpi.rs:31` and
verification test at `programs/settlement/src/lib.rs:225-241`.

```rust
let discriminator: [u8; 8] = [194, 220, 43, 201, 54, 209, 49, 178];
let mut data = Vec::with_capacity(8 + 8 + 1 + 8 + 1);
data.extend_from_slice(&discriminator);
data.extend_from_slice(&reputation_delta.to_le_bytes());
data.extend_from_slice(&[task_completed as u8]);
data.extend_from_slice(&earnings.to_le_bytes());
data.extend_from_slice(&[rating]);
```

ADR-014 added a test asserting the hardcoded bytes match
`sha256("global:update_reputation")[..8]`. This is defensive, but it
only catches renames of the function — not changes to the argument
serialization order, not changes in Anchor's encoding rules, and not
changes in the types (e.g., `i64 → i32`).

**Why this matters.** Anchor provides CPI helper types
(`cpi::accounts::UpdateReputation`, `cpi::update_reputation(...)`) that
the settlement program could use by adding Registry as a Cargo
dependency with `features = ["cpi"]` in `Cargo.toml`. The compiler
would enforce field-by-field correctness. The current manual pattern
trades compile-time safety for avoiding a build dependency, but the
savings are marginal and the risk is material: the next person to
touch `update_reputation` signature must also update the manual encoding
in cpi.rs, and there is no compiler help.

**Recommendation.**

- Add `agent-registry = { path = "../agent-registry", features = ["cpi"] }`
  to `programs/settlement/Cargo.toml`.
- Replace `invoke_signed(...)` with the generated
  `agent_registry::cpi::update_reputation(ctx, delta, completed, earnings, rating)`.
- Delete the manual byte packing and the discriminator test (it becomes
  unnecessary).

---

### M2 — Discovery still uses `getProgramAccounts`

**Location:** MCP `handleDiscoverAgents` in `mcp-server/src/handlers/registry.ts`.

ADR-016 introduced the off-chain indexer explicitly to replace expensive
`getProgramAccounts` discovery. But because the indexer does not
correctly populate its `agents` table (H1 + H2), discovery cannot
delegate to it. The MCP handler still hits the Solana RPC
`getProgramAccounts` endpoint, which is O(N) in total profiles and
rate-limited by most providers.

**Recommendation.** Fix H1 and H2 first; then route `handleDiscoverAgents`
through the indexer's `/agents` REST endpoint. The current code
comment in the handler ("documented trade-off") is a bandage over a
broken dependency chain.

---

### M4 — `has_one` coverage inconsistent

**Location:** settlement contexts.

Registry contexts use `has_one = authority` uniformly. Settlement's
`ResolveDispute`, `RaiseDispute`, `ApproveMilestone`, and some others
rely on handler-level equality checks (`require!(ctx.accounts.client.key() == escrow.client)`).
Defense-in-depth is fine, but architecturally Anchor constraints are
preferable — they run at deserialize time (before the handler) and
produce consistent error codes.

**Recommendation.** Add `has_one = client @ SettlementError::UnauthorizedClient`
(or similar) to every context where the handler already performs the
equality check. Remove the redundant handler checks. Align the style
with Registry.

---

### M5 — `client_vault`/`provider_vault` in `CreateEscrow` are UncheckedAccount

**Location:** `programs/settlement/src/contexts.rs` — CreateEscrow.

Both fields are `UncheckedAccount` with "informational-only" CHECK
comments. They are stored on `TaskEscrow` and referenced by event
emissions, but never validated to be actual Vault PDAs owned by the
respective parties.

**Impact.** The on-chain state contains claims about vault addresses
that may be false. If any future instruction or off-chain consumer
trusts these fields for routing or auditing, they have no guarantees.

**Recommendation.** Either

- Drop the fields from `TaskEscrow` (they are not consulted anywhere
  on-chain), or
- Add Anchor `constraint`s that derive them from `[b"vault", client]`
  and `[b"vault", provider]` using the vault program ID. The constraint
  can be `seeds::program = AGENT_VAULT_PROGRAM_ID` + `bump`.

---

## 7. Governance & Parameter Mutability

### M3 — Compile-time parameters require program upgrade

**Location:** `programs/settlement/src/state.rs`, ADR-053.

All economic and policy parameters are `pub const`:

- `MAX_MILESTONES: usize = 5`
- `MIN_ESCROW_AMOUNT: u64 = 10_000`
- `DISPUTE_TIMEOUT_SECONDS: i64 = 7 * 24 * 3600`
- `REPUTATION_DELTA_TASK_COMPLETED: i64 = 50`
- `REPUTATION_DELTA_DISPUTE_LOSS: i64 = -25`
- `REPUTATION_DELTA_EXPIRY_UNDELIVERED: i64 = -10`
- Slash threshold `3` (magic number inline)

ADR-053 documents this choice (v1 simplicity) and sketches a v2
`GlobalConfig` PDA. The choice is defensible for v1, but it has
implications:

- Adjusting reputation deltas to counter an emergent attack (e.g., the
  C1 exploit) requires a program upgrade and redeployment. Slow and
  risky.
- The protocol has no on-chain signal that governance is possible.
  External integrators assume fixed parameters, and wire those into
  their own assumptions (dashboards, alerting, policy).
- An attacker who discovers C1 can exploit it *before* a program
  upgrade ships. A governance-adjustable `REPUTATION_DELTA_EXPIRY_UNDELIVERED`
  could be set to `0` in a single governance TX.

**Recommendation.** Accelerate the ADR-053 v2 plan:

- Add a single `GlobalConfig` PDA at `[b"global-config"]` with an
  `authority` field (multisig or DAO for mainnet, deployer for devnet).
- Migrate slash threshold and expiry-slash delta to config fields first
  (these are the safety-critical ones given C1+C5).
- Keep `MAX_MILESTONES` and `MIN_ESCROW_AMOUNT` as consts — they don't
  need to change dynamically.
- Add a `set_param(...)` instruction with authority check.

---

## 8. CI, Release Posture & Operational Readiness

### M6 — CI is a courtesy check, not a release gate

**Location:** `.github/workflows/ci.yml`.

Current CI runs:

1. `cargo check --workspace`
2. `cargo test --workspace`
3. `npx tsc --noEmit` (mcp-server only)

Missing for a protocol at this maturity stage:

- `cargo clippy --workspace -- -D warnings` (should be mandatory;
  clippy catches common Rust pitfalls, dead code, etc.)
- `cargo audit` / `cargo deny check` (CVE surface in dependency graph
  — Solana ecosystem has had multiple meaningful advisories).
- `anchor build --skip-lint` at minimum — `cargo check` does not exercise
  the Anchor IDL generator, so IDL-breaking changes land silently.
- `npm audit` in `mcp-server`, `src/indexer`, `src/x402-relay`, and any
  other TS subdirectory.
- ESLint (mcp-server has none; src/* packages likely none).
- Integration tests against `solana-test-validator` — the C4 unstake
  bug and the H5/H6/H7 handler bugs would all be caught by one. The
  MCP test suite at `mcp-server/test/mcp-handlers.test.ts` is never
  run by CI as far as I can see.
- Type-check for `src/indexer`, `src/x402-relay`, `src/integrations/*`.
  Only mcp-server is type-checked.
- Secret scanning (e.g., `trufflehog`) — even if .env files are
  gitignored, a gofer-style leak can still slip in.

**Recommendation.** Promote `ci.yml` to a multi-job workflow with the
above gates. Make the integration test job explicit and required for
merge. Add a `release` workflow that runs all of these plus
`anchor deploy --network devnet` on tag pushes.

---

### M7 — Indexer has no idempotency, backfill, or cursor persistence

**Location:** `src/indexer/index.ts:146-221`.

- The indexer subscribes to `onLogs` at `confirmed` commitment and
  writes each event to SQLite with no dedup key. If the subscription
  reconnects after a WebSocket drop (see line 200 disconnect handler),
  the same event may be re-delivered; the current schema lacks a
  `UNIQUE(signature, event_name)` constraint to make insertion
  idempotent.
- No backfill. On restart, the indexer starts fresh from the current
  slot. Any events between shutdown and restart are permanently
  missed.
- `lastProcessedSlot` is tracked in memory but never persisted. The
  log line "Attempting re-subscribe (last processed slot: X)" suggests
  backfill was intended but never implemented.
- `confirmed` commitment means some reorg risk; `finalized` would be
  safer for a canonical log store.

**Recommendation.** Before relying on the indexer for discovery (M2):

- Add `UNIQUE(signature, event_name)` on `events` (or a dedicated
  `event_id` column) and use `INSERT OR IGNORE`.
- Persist `lastProcessedSlot` to a `meta` table on every insert.
- On startup, use `getSignaturesForAddress(programId, { minSlot: last + 1 })`
  to backfill before starting the `onLogs` subscription.
- Consider using `solana-geyser` for higher-reliability ingestion on
  mainnet.

---

### M8 — No structured logging or metrics pipeline

The only observability signals the protocol emits are:

- `emit!()` events (consumed by the broken indexer).
- `console.log` in the MCP server and indexer.
- HTTP `/health` endpoints on the indexer and relay.

There is no metrics endpoint (`/metrics` in Prometheus format), no
structured JSON logging, no log aggregation, no alerting, no request
tracing. For a protocol aiming at mainnet, this is a significant gap.

**Recommendation.**

- Add a `/metrics` endpoint to indexer and relay exposing basic counters
  (events processed, events failed, RPC calls, rate-limited requests,
  redemptions, 4xx/5xx per route).
- Replace `console.log` with `pino` (structured JSON logs).
- Add a minimal Grafana dashboard JSON under `infrastructure/` with
  the expected dashboards. Even as documentation, this forces thought
  about what to monitor.

---

## 9. Cross-Cutting Architectural Observations

### 9.1 The economic model assumes good-faith participation

The protocol's biggest unspoken assumption is that clients *want* to
approve work. Most features (auto-release on approval, slashing on
"undelivered", dispute resolution framed as exception) encode this.
But AEP is designed for *agents* — autonomous programs that
transact without human supervision. A malicious agent operator has
no reputation incentive and arbitrarily many keys. The current
model protects good agents from unresponsive clients badly (C1) and
protects providers from malicious clients not at all (C3 + C5).

**Implication.** The economic parameters and dispute mechanism need
to be tuned for an adversarial equilibrium, not a cooperative one.
The Nash-equilibrium strategy for a profit-maximizing client under
the current rules is **"never approve, always let expire"**.

### 9.2 Off-chain layer is undertested relative to on-chain

Rust unit tests (34 across three programs) and proptest fuzz tests
(2 suites) are thorough for on-chain logic. The off-chain components
— indexer, relay, MCP handlers — have significantly lower coverage
and no integration tests against real programs. This is visible in
the defect distribution:

- On-chain bugs in this audit: 3 architectural (C1, C2, C3), 2
  runtime (C4, C5). All are policy/semantic, not implementation.
- Off-chain bugs: 6 critical/high (H1, H2, H5, H6, H7, H11), all
  implementation errors that a single end-to-end test would have
  caught.

**Implication.** The testing discipline needs to extend to the
boundaries. A single `tests/e2e/full-escrow-lifecycle.test.ts` that
creates, submits, approves, disputes, and expires an escrow against
`solana-test-validator` would have caught most of these at authorship
time.

### 9.3 The ADR trail is excellent, but enforcement is weak

Fifty-three ADRs is unusually thorough and most are high-quality. But
several ADRs document fixes that were partially implemented:

- ADR-025 (expire_escrow approved milestones) — the code implements
  the specified math, but the math is effectively a no-op because
  of the immediate-release model (C1). The ADR did not consider the
  underlying invariant change that would have been needed.
- ADR-039 (wire slashing + unstake) — slashing was wired, but
  unstake was implemented in a way that cannot run on mainnet (C4).
- ADR-046 (add missing MCP tools) — the tools were added, but the
  handler drift (H5, H6) indicates they were never exercised.

**Implication.** ADRs should be merged only after (a) a test that
demonstrates the ADR's acceptance criterion passes, and (b) the
acceptance criterion is *observable from outside the code* (e.g., a
public invariant, not just "X is in the IDL").

---

## 10. Remediation Roadmap

### P0 — Must-fix before any mainnet activity

| ID | Action | Estimated effort |
|----|--------|------------------|
| C1 | Change expiry semantics: Submitted → paid-to-provider on expiry; stop slashing on `has_undelivered` without distinguishing submission from silence | 1-2 days + tests |
| C2 | Decide approve-after-deadline policy; if allowed, document; if not, add deadline check to `approve_milestone` | 0.5 days + tests |
| C3 | Reject `dispute_resolver == client || provider` in `create_escrow` | 0.5 days + tests |
| C4 | Re-architect staking PDA ownership; add e2e stake→unstake test | 2 days |
| C5 | Add `unsuspend_agent` via forfeited-stake or cooldown; rate-limit slash | 1-2 days |
| M6 | Add clippy, audits, integration test job to CI | 1 day |

**Gate:** Do not call any mainnet deployment a "v1 release" while any
of C1-C5 is open.

### P1 — Before external audit engagement

| ID | Action | Estimated effort |
|----|--------|------------------|
| H1 | Replace fabricated discriminator map with IDL-driven parser | 1 day |
| H2 | Populate `event.data` from decoded event; add fixture test | 0.5 days |
| H3 | Delete or wire `avg_rating` end-to-end | 0.5 days |
| H4 | Validate `vault_address` via Anchor constraint | 0.5 days |
| H5 | Fix `handleResolveDisputeTimeout` account shape; add integration test | 0.5 days |
| H6 | Fix `handleStakeReputation` field name; add integration test | 0.25 days |
| H7 | Remove extra `tokenMint` key from `handleVaultTokenTransfer` | 0.25 days |
| H8 | Add `per_tx_limit` check to `execute_token_transfer` | 0.25 days |
| H10 | Add rent-exemption guard to direct lamport mutations | 0.5 days |
| H11 | TTL-indexed redemption map + persistence in x402 relay | 1 day |
| M4 | Align `has_one` usage across settlement contexts | 0.5 days |
| M5 | Add/remove vault PDA validation in `CreateEscrow` | 0.5 days |

### P2 — Next dev cycle / v2

| ID | Action | Notes |
|----|--------|-------|
| H9 | Per-mint token policy (replace scalar `daily_limit`) | Breaking change to vault IDL |
| M1 | Switch settlement → registry CPI to Anchor-generated helper | Requires path dependency |
| M2 | Route `handleDiscoverAgents` through indexer once H1/H2 fixed | |
| M3 | `GlobalConfig` PDA for governance-adjustable parameters | v2 path per ADR-053 |
| M7 | Idempotent event insertion + backfill + cursor persistence | |
| M8 | Structured logging + `/metrics` endpoints | |

---

## 11. Recommended New ADRs

1. **ADR-054: Expiry-Time Settlement Semantics.** Submitted milestones
   on expiry are paid to the provider; slashing is removed or gated on
   "never submitted". Documents the new economic equilibrium.
2. **ADR-055: Staking PDA Ownership Model.** Registry owns the staking
   PDA; `init` on first stake; `invoke_signed` for unstake; integration
   test is required for merge.
3. **ADR-056: Governance via `GlobalConfig` PDA.** Promotes v2 sketch
   from ADR-053 into a concrete proposal, starting with the two
   safety-critical parameters (slash delta, slash threshold).
4. **ADR-057: Indexer IDL-Driven Event Decoding.** Removes the static
   discriminator map; uses `@coral-xyz/anchor` EventParser; adds
   backfill + cursor persistence; tightens CI with an integration
   fixture.
5. **ADR-058: End-to-End Test Harness.** Defines a `tests/e2e/` suite
   that runs against `solana-test-validator`, exercises every MCP
   handler against every on-chain instruction, and is a required CI
   gate. Replaces the current unit-test-only discipline.
6. **ADR-059: Per-Mint Vault Policy.** Replaces `daily_limit_lamports`
   scalar with `Vec<TokenPolicy>`; migration plan for existing vaults.
7. **ADR-060: Relay Hardening.** TTL-indexed redemption map with
   persistence, `finalized` commitment, rate-limit on unique-signature
   churn to block the H11 flood attack.

---

## 12. What the Protocol Gets Right

To calibrate the critique: these are real strengths that should be
preserved through any remediation effort.

1. **CPI authority model** (ADR-001/007). The PDA-signed call pattern
   makes cross-program trust explicit and auditable. The
   `seeds::program = SETTLEMENT_PROGRAM_ID` constraint on Registry's
   `settlement_authority` is cryptographic, not economic.
2. **Checks-Effects-Interactions in `approve_milestone`.** State is
   updated before the CPI token transfer. Re-entrance surface is
   minimal.
3. **Program module split (ADR-049).** The settlement program is much
   cleaner than before. `instructions/{escrow,dispute,cpi}.rs` is a
   good boundary.
4. **Property-based fuzz tests** (ADR-021). The proptest suites for
   milestone sum, released-amount tracking, and rating bounds are
   well-designed, even where the target code (avg_rating) is
   effectively dead.
5. **Anti-sybil defense** (ADR-028). `MIN_ESCROW_AMOUNT` +
   `SelfDealingProhibited` are good economic barriers. They need to
   be tuned for mainnet, but the structure is correct.
6. **The ADR discipline itself.** Fifty-three ADRs with clear context,
   decision, consequences structure is above the standard for most
   open-source Solana projects. The weakness is enforcement, not
   documentation.
7. **The MCP bridge boundary.** Separating the agent-facing tool
   surface from the on-chain program is a good architectural choice
   that keeps agent integrations versioned independently.

---

## 13. Verification of This Document

Every file:line reference in this document was verified against the
source tree on branch `claude/architecture-audit-N9QMS` at audit time.
Specifically:

- `programs/settlement/src/instructions/escrow.rs:320-422` — `expire_escrow` body reviewed.
- `programs/settlement/src/instructions/cpi.rs:32` — `let rating: u8 = 0;` observed.
- `programs/agent-registry/src/lib.rs:163-179` — `unstake_reputation` lamport mutation reviewed.
- `programs/agent-registry/src/contexts.rs:92-112` — `staking_pda: UncheckedAccount` confirmed.
- `programs/agent-registry/src/lib.rs:94-108` — `update_status` transition matrix.
- `mcp-server/src/handlers/settlement.ts:451-462` — account shape for `resolveDisputeTimeout`.
- `mcp-server/src/handlers/registry.ts:256-265` — `stakingAccount` vs `stakingPda`.
- `src/indexer/index.ts:59-77` — fabricated discriminator values.
- `src/indexer/index.ts:110-142` — `updateAgentFromEvent` field mismatches.
- `src/x402-relay/index.ts:18-26` — `pruneRedeemedSignatures` behavior.
- `.github/workflows/ci.yml` — current CI jobs.

References to prior audits (`docs/ARCHITECTURE_AUDIT.md`, ADR-037)
are for historical context; findings marked here are new or residual.

---

*End of critique.*
