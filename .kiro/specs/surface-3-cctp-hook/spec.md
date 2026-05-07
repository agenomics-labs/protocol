# Surface 3 — CCTP V2 Hook (or relayer fallback)

*Build spec for the cross-chain round-trip surface. Self-contained: a Surface 3 owner can read just this file and know what to build. Cross-surface contracts are cited to the master spec; Surface-3-specific bits (IC-4, the session-level escrow pattern, the Hook program design, the relayer fallback) are inlined here.*

*Master spec: [`docs/aep-reflex-tech-spec.md`](../../../docs/aep-reflex-tech-spec.md) — read for system diagram, full risk register, and cross-surface flow.*

*Version: v1 · 2026-05-06*

---

## Owner

**TBD** — assign before Day 3 (Open Question §1 in master).

**Critical path: NO.** Per master line 309: *"cinematic close only; demo is complete without it."* If this surface slips, Surfaces 1, 2, and 4 still produce a complete, judge-defensible demo. The relayer fallback (below) is the safety net; the Hook is the architectural-purity prize.

---

## What it does

Lets the agent's session budget round-trip cleanly across chains:

1. USDC starts on Solana (in AEP Vault, Surface 1 territory)
2. Some flows to Base for x402 payments (via Surface 2's `pay_x402_service`)
3. Leftover bridges back to Solana via CCTP V2
4. The post-mint **Hook** calls AEP Settlement `approve_milestone` to close the session

Demo narrative at close: *"$0.50 went out as session budget, $0.42 was actually spent on three Bazaar services, $0.08 came back via CCTP and auto-closed the escrow."*

This is the surface that turns the cross-chain story from a hand-wave into an on-chain event sequence the judges can click through on Solscan + Basescan.

---

## The session-level escrow pattern

This is the architecture that makes the Hook meaningful — without this pattern, there's nothing for the Hook to call. **Read this carefully; the Hook design only makes sense in this context.**

The 4-step flow:

1. **User opens session** with $0.50 budget → Mobile (Surface 1) signs `update_vault_policy` via MWA → Seed Vault.
2. **Agent calls AEP `create_escrow`** (existing Settlement program, no changes):
   - Buyer: agent
   - Seller: a "session-pool" PDA that the agent itself controls
   - Amount: $0.50 USDC from Vault
   - Milestones: N (one per planned x402 call)
3. **For each x402 call:**
   - `pay_x402_service` (Surface 2) debits via Base (CCTP-bridged USDC)
   - On payment success, `submit_milestone(i)` is called on Settlement
   - CCTP V2 burn fires on Base side
   - On Solana mint, **the Hook program receives the payload and calls `approve_milestone(i)` via CPI** — funds released back to agent's Vault
4. **Session closes:** any unfilled milestones are `cancel_escrow`'d; remaining USDC stays in Vault.

The seller-is-a-self-PDA shape is intentional — it's not an AEP-to-AEP relationship (use Settlement directly) and not a one-shot Bazaar payment (use direct Vault debit per Surface 2 `pay_x402_service`). It's a session-bounded reconciliation account.

> **Cross-link:** Surface 2 (master §"Surface 2 — Why direct Vault debit, not Settlement escrow") explains why ordinary x402 calls do NOT use Settlement escrow. The session-level escrow here is the documented exception.

---

## Interface contract — IC-4 (verbatim from master)

The single frozen interface for this surface.

```rust
// Hook called after CCTP V2 mint on Solana
pub struct ReflexHookPayload {
    pub escrow_pda: Pubkey,           // AEP Settlement escrow
    pub milestone_index: u8,          // which milestone to approve
    pub base_tx_hash: [u8; 32],       // Base-side x402 settle tx
    pub amount_returned_micros: u64,  // USDC returned to Solana
}
```

**Contract guarantees:**

- The Hook program calls AEP Settlement `approve_milestone` via CPI.
- **Idempotent on `base_tx_hash`** to prevent replay.
- Once frozen (Day 1 stage gate per master §"Build sequence"), changes require a written ADR + sign-off from affected owners (notably Surface 4, which constructs the payload upstream when building the CCTP V2 burn message on Base).

---

## Hook program (Solana, new)

**Location:** `programs/reflex-cctp-hook/` (new Anchor program; does not exist yet in repo).

**Existing AEP programs (`programs/agent-vault/`, `programs/agent-registry/`, `programs/settlement/`) are NOT modified.** Surface 3 reaches into Settlement *only via CPI* to `approve_milestone`. No changes to Settlement source code, IDL, or deployed binary.

### Anchor program design

A small Anchor program (~5–10 KB compiled binary) with a single instruction.

**Responsibilities:**

1. Receive the CCTP mint with `ReflexHookPayload` (IC-4).
2. **Validate** the payload signer matches a registered agent's CDP wallet binding in AEP Registry.
3. **Call AEP Settlement `approve_milestone` via CPI**, addressing the escrow PDA from the payload.
4. **Emit `MilestoneAutoApproved { escrow, milestone_index, base_tx_hash }` event** for the dashboard / observability stack.

**Idempotency:**

- Keyed on the tuple `(escrow_pda, milestone_index, base_tx_hash)`.
- Implementation: a PDA seeded by `[b"hook-replay", escrow_pda, milestone_index, base_tx_hash]` with `init` constraint — second call fails atomically. Closes after a configurable TTL to reclaim rent.

**CCTP V2 integration surface:**

- Hooks on Solana receive a CPI-style invocation from Circle's CCTP V2 Solana receiver after `receive_message` mints USDC to the destination ATA.
- Read CCTP V2 Solana docs at the start of the build (master Day 1 task: *"CCTP V2 docs read, Anchor program scaffold, devnet test wallet funded"*).
- Devnet test wallet must be funded with devnet USDC + SOL for rent + signing.

**No new programs touch Vault or Registry** — Vault is only read from (via the Settlement `approve_milestone` flow that releases funds back to it). Registry is only read for the CDP wallet binding lookup.

---

## Fallback: off-chain relayer

If the CCTP V2 Hook integration on Solana side slips, ship the relayer instead. Less cinematic (off-chain trust), but functionally equivalent. Ships in a day per master §"Surface 3 — Fallback".

**Location:** `services/reflex-relayer/` (new; the `services/` directory does not currently exist in the repo and will be created).

### Lambda design

- **Trigger:** AWS Lambda (or equivalent) watching Base mainnet (or Sepolia for testing) for x402 settle events emitted by registered agents.
- **Detection:** filter on the agent's CDP wallet address (mapped from AEP Registry binding).
- **Action:** on detection, call AEP Settlement `approve_milestone` directly using the relayer's signing key.
- **Key custody:** relayer key lives in **AgentCore Identity vault** (per master §"Cross-cutting — Authentication boundaries"), rotated per session.
- **Idempotency:** same `(escrow, milestone_index, base_tx_hash)` keying, enforced at the relayer (e.g., DynamoDB conditional put) so a Lambda retry does not double-approve.

The relayer skips the on-chain Hook entirely. It is *trusted off-chain code* with a hot key — the architectural-purity loss is that approval is no longer enforced by the chain itself; it is enforced by the operator of the Lambda.

---

## Decision rule — Day 7 status check

Per master §"Surface 3 — Decision rule" and §"Build sequence — Stage gate end of Day 7":

> **If the CCTP V2 Solana Hook integration isn't end-to-end working in a test environment by end of Day 7, switch to relayer.** Don't sink the demo for an architectural purity point.

Status-check criteria (must ALL be green for Hook path):

- [ ] Hook program deployed to Solana devnet
- [ ] Integration test with simulated CCTP V2 attestation passes
- [ ] One real Base devnet → Solana devnet round-trip succeeds end-to-end
- [ ] Idempotency test passes
- [ ] Replay-protection test passes

If any fail → relayer is the demo path. Relayer Lambda is **also** built in Days 3–7 (per master Day 3–7 stream: *"Hook program deployed to devnet … relayer fallback Lambda also deployed"*) — so by Day 7 both options are operational, and the decision is purely which one the demo flows through.

---

## Cross-cutting (from master, applied to Surface 3)

### Authentication boundaries

Drawn directly from master §"Cross-cutting — Authentication boundaries":

| Boundary | Auth mechanism |
|---|---|
| AgentCore → x402 services | CDP Server Wallet **ECDSA signature** (EIP-3009 or Permit2) |
| AgentCore → CCTP | CDP Server Wallet **ECDSA on Base**; **CCTP attestation** consumed on Solana |

The Hook's validation step (item 2 of program design above) closes the loop: the payload signer's binding to a registered AEP agent is the on-chain anchor for the off-chain CDP signature that initiated the burn on Base. The CCTP attestation row (Circle-signed) is what Solana verifies before the mint completes — the Hook runs *after* that mint and inherits its trust.

### Observability

Per master §"Cross-cutting — Observability":

- **CCTP transfers visible on Solscan + Basescan; cross-link both directions.** Surface 3 must emit enough event data (notably `MilestoneAutoApproved`) for the dashboard at `app.agenomics.xyz` to wire up the cross-link via Helius webhook.
- **AgentCore Observability** captures every economic decision; the Hook's `approve_milestone` CPI is the on-chain confirmation that closes a payment decision recorded in AgentCore Memory.

### Performance targets

From master §"Cross-cutting — Performance targets":

| Metric | Target | Hard limit |
|---|---|---|
| **CCTP round-trip (Base → Solana with Hook)** | **≤ 30s** | **90s** |

If the hard limit is breached at demo time, this surface goes to fallback-mode only and gets cut from the live flow (master line 516).

The relayer-path equivalent target is **≤ 60s** per acceptance criteria below.

---

## Acceptance criteria

The 5 master criteria (verbatim from master §"Surface 3 — Acceptance criteria"):

- [ ] **Hook path:** full Base → CCTP burn → Solana mint → Hook → `approve_milestone` → AEP Settlement state change in **≤ 30s**.
- [ ] **OR Relayer path:** Base x402 settle → Lambda detection → `approve_milestone` in **≤ 60s**.
- [ ] **Idempotent on retry** (test by re-emitting same Base tx hash).
- [ ] **Replay-protected** (test with malicious double-call).
- [ ] **One demo-day rehearsal** with $5 of real USDC round-tripped successfully.

See [`acceptance-criteria.md`](./acceptance-criteria.md) for the full checklist including implicit criteria from the design (deployment, IDL publication, observability hooks).

---

## Risks that affect this surface

From master §"Risk register":

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| **R2** | **CCTP V2 Hook slips** | High | Low | Relayer fallback ready Day 7 |
| R6 | AgentCore Gateway + AEP MCP integration glitches | Medium | High | Day-1 hello-world is canary; eat the day if needed |
| R9 | Dev wallet keys committed to git | Low | Catastrophic | Pre-commit hooks; secrets in AWS SSM only |

**R2 is the dominant risk** for this surface and is the entire reason the relayer exists. Probability is HIGH precisely because CCTP V2 Hooks on Solana are a frontier integration; impact is LOW only because the relayer mitigation is real and ships on the same timeline.

**R6 applies indirectly** — the CDP wallet binding lookup in the Hook's validation step depends on a clean AgentCore↔AEP MCP path for Surface 4 to populate the Registry binding in the first place.

**R9 applies to the relayer path** specifically: the relayer's signing key must NOT land in git. Per master, it lives in AgentCore Identity vault with per-session rotation.

---

## Out of scope

Surface 3 explicitly does NOT include:

- **Any change to existing AEP Settlement program semantics.** `approve_milestone` is called via CPI as it exists today. No new instructions, no signer changes, no state changes to Settlement.
- **Any change to Vault or Registry programs.** Read-only consumers.
- **Mainnet deployment.** Devnet for build; mainnet roadmap is post-hackathon (master §"Out of scope — Mainnet deploy of AEP programs").
- **Multi-chain support beyond Base.** CCTP route is Base ↔ Solana only (master §"Out of scope — Multi-chain support beyond Base").
- **Generalized cross-chain hook framework.** The Hook is single-purpose: receive `ReflexHookPayload`, call `approve_milestone`. Don't generalize.
- **Reorg handling beyond CCTP's own attestation guarantees.** Inherit Circle's finality model; don't re-implement.

---

## Open questions

See [`open-questions.md`](./open-questions.md). Most pressing: **Open Question §3 (master)** — Hook vs. relayer Day-7 default. Master answer: *default to Hook; relayer is fallback*. Confirmed here, but the Day 7 status check is the binding decision.
