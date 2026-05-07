# Surface 3 — Open Questions

Items from the master spec's [§"Open questions"](../../../docs/aep-reflex-tech-spec.md) that touch this surface, plus issues noticed while drafting [`spec.md`](./spec.md).

---

## From master §"Open questions"

### Q3 — CCTP V2 Hook vs. relayer: which is the Day-7 default assumption? (DIRECTLY OWNED)

**Master answer:** *"Default to Hook; relayer is fallback."*

**Status here:** Confirmed as planning default. The binding decision is made at the **Day 7 status check** per [`spec.md` §"Decision rule"](./spec.md). Both paths are built in parallel during Days 3–7 (per master Day 3–7 stream) so the decision is purely which one the demo *flows through*, not which one *exists*.

**Owner needs to confirm before Day 3:**

- Who is the Surface 3 owner? (master Q1, unassigned)
- Does the owner have hands-on CCTP V2 Solana experience, or is this a frontier integration for them too? (Affects how aggressively to plan against R2.)

---

### Q5 — Where does the agent's CDP wallet seed live? (TOUCHES THIS SURFACE)

**Master answer:** *"AgentCore Identity vault. Confirmed?"* — the question mark is the master's; not yet confirmed.

**Why it matters for Surface 3:**

- The Hook's validation step requires an on-chain binding from a registered AEP agent (in Registry) to the CDP wallet that signed the Base-side x402 settle. If the CDP wallet seed location changes, the binding lookup needs to be wired against the right source of truth.
- The relayer fallback **also** holds a signing key in the AgentCore Identity vault per master §"Surface 3 — Fallback". If Q5 is unresolved, R9 (dev wallet keys committed to git) becomes more dangerous because there's no canonical "correct" place to put it.

**Action:** Surface 4 owner should confirm Q5 in writing before Day 3; Surface 3 owner needs the answer to wire the Registry binding lookup.

---

## Surface-3-specific items noticed during drafting

### Q-S3-A — Where does the on-chain Registry binding for CDP wallet → AEP agent get written?

The Hook reads it; some upstream surface must write it. Surface 4 (AgentCore) is the most likely writer (it provisions the CDP Server Wallet). **This is a Surface 3 ↔ Surface 4 interface that is NOT one of IC-1 through IC-4.** Either:

- (a) Add a tacit IC-5 / inline contract for this binding, OR
- (b) Reuse an existing AEP Registry instruction (e.g., `register_agent` extension fields) — confirm this exists before assuming.

**Action:** Surface 3 + Surface 4 owners agree on the binding mechanism by Day 2 stage gate (when ICs are frozen).

### Q-S3-B — What is the canonical CCTP V2 Solana receiver program ID, and is the Hook invoked via CPI from it or a separate dispatcher?

Master says *"Receives the CCTP mint with `ReflexHookPayload`"* but doesn't specify whether Circle's V2 Solana implementation supports arbitrary Hook callbacks at mint time, or whether we need a thin dispatcher between the CCTP receiver and our Hook. **Day 1 task: read the CCTP V2 Solana docs and answer this concretely.** If dispatcher is required, scope that in.

### Q-S3-C — How is `ReflexHookPayload` carried on the Base side?

IC-4 specifies the struct on the Solana side. The corresponding burn message on Base (constructed by Surface 2 / Surface 4 logic that initiates CCTP burn) must encode equivalent data into the CCTP message body. The encoding (Borsh? Anchor-style? raw bytes?) is not specified in the master. **Day 2: pin encoding before freezing IC-4.**

### Q-S3-D — Replay PDA TTL / rent reclamation policy?

[`spec.md`](./spec.md) mentions the replay-guard PDA "closes after a configurable TTL to reclaim rent." Default TTL? Owner of the close instruction? Suggested: 30 days, closable by anyone (rent goes to a treasury), but this needs an explicit decision.

### Q-S3-E — Demo-day rehearsal $5 USDC: Base mainnet or Sepolia?

Acceptance criterion #5 says "$5 of real USDC round-tripped." Master Q6 confirms Bazaar listing for Surface 4 is mainnet. For Surface 3, "real USDC" implies **mainnet** as well, but this should be an explicit budget line. Suggested: $5 USDC budget on Base mainnet for one rehearsal round-trip; document the burn/mint tx hashes in the submission package.

### Q-S3-F — Repo state inconsistency

The master spec references `services/reflex-relayer/` and `programs/reflex-cctp-hook/` (implicit in the design). Neither path exists in the repo yet:

- `programs/` currently contains: `agent-registry/`, `agent-vault/`, `settlement/` only.
- `services/` directory does not exist at all.

This is expected (Surface 3 hasn't started building) but the Surface 3 owner should be aware that the Day 1–2 scaffold work creates **both** the new program directory and the new top-level `services/` directory. Coordinate with whoever owns repo conventions (likely the Mainnet Checklist / RELEASE.md owner) on the `services/` layout before scaffolding.

---

## Out of master §"Open questions" but worth tracking

- **Q1 (owner assignment)** is upstream of this surface but blocking — without an owner, none of the Surface 3 questions get answered.
- **Q2 (Nova Act access)** is irrelevant to Surface 3.
- **Q4 (Nova Act hero web2 site)** is irrelevant to Surface 3.
- **Q6 (mainnet vs. Sepolia for self-monetized endpoint)** indirectly relevant — see Q-S3-E above.
