# ADR-147: Intent-Based Multilateral Clearing

## Status

Proposed

## Date

2026-05-15

## Context

Today AEP settles value through one shape only: a **bilateral, pre-addressed
escrow**. `settlement::create_escrow` (see
`programs/settlement/src/instructions/escrow.rs:10`) requires the client to
already know the provider's pubkey and vault, and it only clears when each
party's want is the counterparty's offer. Two agents whose wants do not
line up directly cannot trade, even when a satisfying trade exists across a
*chain* of agents.

The protocol thesis is that **coordination, not compute, is the
bottleneck**. The missing primitive is the ability to clear trades that no
single agent could find: a *coincidence of wants* (CoW) discovered across a
cycle. Canonical example (the demo target):

```
Agent A: offers compute-credit, wants storage-credit
Agent B: offers storage-credit, wants data-credit
Agent C: offers data-credit,    wants compute-credit
```

No bilateral match exists, yet the 3-cycle A→B→C→A clears: A gives compute
to C, B gives storage to A, C gives data to B, and every agent ends holding
what it wanted. This ADR decides how to add that layer.

Constraints fixed before this ADR (load-bearing; not re-derived here):

- **Frozen core.** The three deployed programs (agent-vault, agent-registry,
  settlement) and the MCP server are devnet-live and treated as
  FROZEN/STABLE. Their *logic* must not change. A new, separately auditable
  Anchor program `programs/clearing` carries all new on-chain logic.
- **Off-chain solver.** Cycle discovery is an off-chain TypeScript service
  matching repo conventions (`Result<T, AepError>` per ADR-103,
  `@agenomics` scope). It ingests open intents, builds a wants-graph, finds
  bilateral CoWs first then 3-cycles, and *proposes* a clearing. The chain,
  not the solver, is the arbiter of correctness.
- **Reuse, don't re-implement.** A cleared cycle is a multi-leg settlement,
  not a second settlement engine. The clearing program reuses the
  Settlement *model* — PDA-as-token-authority, event-driven indexing, the
  `propose_reputation_delta` reputation pattern, the `ProtocolConfig`
  governance pattern — rather than re-deriving them.
- **Substrate to sit on.** Discovery/reputation already exists in part:
  capability manifests (ADR-060, Accepted) and the on-chain `AgentProfile`
  (`reputation_score ∈ [0,100]`, `reputation_stake.staked_amount`) are
  implemented. TraceRank (ADR-106), reputation decay (ADR-107),
  stake-backed discovery (ADR-108), and capability vectors (ADR-110) are
  **Proposed, not yet built** — the solver must consume them *where
  available* and degrade to the implemented on-chain signals otherwise.
- **Scope.** Devnet prototype that proves the thesis and demos cleanly.
  Out of scope: mainnet keypairs, formal verification, unbounded intent
  expressiveness, cycles longer than 3.

Two findings from reading the frozen core materially shape the options
below and are called out now because they constrain what "reuse Settlement
via CPI" can mean:

1. **Settlement escrow is not a synchronous swap.** `create_escrow` locks
   funds one-directionally (client→escrow, with `client` as a transaction
   `Signer`, `escrow.rs:101`); release is a *separate, later*
   provider-signed lifecycle (`accept_task` → `submit_milestone` →
   `approve_milestone`). There is no single Settlement instruction that
   atomically moves value from one party to another. N legs therefore
   cannot be delivered all-or-nothing in one transaction *through unmodified
   Settlement instructions alone*.
2. **Reputation writes are settlement-authority-gated.** Registry's
   `propose_reputation_delta` only accepts the PDA
   `[b"settlement_authority"]` derived under `SETTLEMENT_PROGRAM_ID` (see
   `programs/settlement/src/instructions/cpi.rs:68` and the Registry
   `seeds::program` check). A new clearing program cannot write on-chain
   reputation without either routing value through Settlement or modifying
   the frozen Registry.

## Decision

**Introduce `programs/clearing`: an on-chain intent book with funds locked
at intent time, cleared by a single atomic multi-leg swap instruction that
an untrusted off-chain solver merely proposes; reputation effects for clears
are observed off-chain by the existing event/TraceRank substrate.** The
decision breaks into four sub-decisions, each with the option enumerated and
the recommendation.

### D1 — Intent representation: on-chain account with locked funds

Options weighed (the brief asks explicitly: on-chain intent account vs
off-chain order + on-chain settlement):

- **D1-A — Fully off-chain signed orders.** Agents sign intents off-chain
  (0x/CoWSwap style); only the final clearing touches chain. Cheapest, most
  flexible. But there is **no proof-of-funds at intent time** — the solver
  can build a cycle on an agent who cannot pay its leg, and atomic funding
  at settlement re-introduces the very coordination problem (every agent
  must co-sign the settlement tx) the cycle was meant to dissolve.
- **D1-B — On-chain intent account, funds locked at submit (recommended).**
  `submit_intent` creates an `Intent` PDA and moves the offered asset into a
  clearing-owned vault. The locked balance *is* the proof-of-funds. The
  solver reads open intents from chain, finds a cycle, and calls
  `execute_clearing`, which moves each pre-locked leg to its cycle successor
  atomically. Costs per-intent rent + capital lock-up until clear/expiry.
- **D1-C — On-chain intent account, no lock, vault delegation grant.**
  Intent records constraints on-chain; funds stay in the vault and are
  pulled at clear time via a pre-authorized delegation (ADR-111). Avoids
  capital lock but weakens proof-of-funds (balance can drift between intent
  and clear) and depends on ADR-111, which is Proposed.

**Recommendation: D1-B.** It is the only option that delivers the brief's
explicit "proof-of-funds at intent time" guarantee, keeps the solver
untrusted, and reduces atomic all-or-nothing settlement to a single
instruction over funds the clearing program already controls. The capital
lock is acceptable for a devnet prototype and mirrors the escrow model the
protocol already relies on.

### D2 — Commit mechanism: clearing program performs the atomic swap; Settlement model is reused, not CPI-driven per leg

Given finding (1) above, two readings of "reuse Settlement as the atomic
commit layer via CPI":

- **D2-A — Clearing owns the atomic transfer; reuse Settlement's *model*
  (recommended).** `execute_clearing` is one instruction that, over funds
  pre-locked in clearing PDAs, transfers every leg to its successor and
  marks all intents `Cleared` — atomic by construction (any failing leg
  reverts the whole transaction). It reuses Settlement's *conventions*
  (PDA-as-token-authority signing via `invoke_signed`, `#[event]`-driven
  indexing, `ProtocolConfig`-style governance) but does **not** CPI into
  Settlement for value movement, because no unmodified Settlement
  instruction can express a synchronous leg.
- **D2-B — CPI into `settlement::create_escrow` per leg.** Literal reuse of
  the Settlement *program*. Rejected for the prototype: (i) `create_escrow`
  only locks funds into an escrow — release needs a *separate*
  provider-signed `accept`+`approve`, so N legs cannot be *delivered* in one
  transaction; (ii) the escrow's `client`/`provider` keys would be the
  clearing PDA, corrupting reputation attribution; (iii) making it atomic
  would require a new `commit`-style instruction *inside* Settlement, which
  violates the frozen-core constraint.

**Recommendation: D2-A**, with an explicit open item (O1) asking the
reviewer to confirm this interpretation, since "reuse Settlement via CPI"
was flagged load-bearing and D2-A honors its *spirit* (no parallel
settlement engine, frozen core untouched) while departing from a literal
per-leg CPI for the reasons above.

### D3 — Matching order: bilateral CoW first, then 3-cycles, capped at length 3

The solver enumerates direct 2-cycles (bilateral coincidence of wants)
first, then 3-cycles; longer cycles are out of scope for the prototype
(combinatorial blow-up and compute-budget pressure on-chain). `k = 3` is the
hard cap. On-chain validation in `execute_clearing` is independent of how
the solver found the cycle.

### D4 — Solver trust model: untrusted; chain validates every clear

The solver is a **liveness/quality** component, never a **safety**
component. `execute_clearing` independently re-verifies, on-chain: every
referenced intent is `Open`, unexpired, and funded ≥ its leg; the cycle is
balanced (each agent gives its `offer` and receives an asset satisfying its
`want` within its limit/min-receive constraint); and intents are consumed
exactly once (no double-spend across concurrent batches). Anyone may run a
solver; multiple solvers compete. The solver uses TraceRank + stake
weighting (ADR-106/108) only to *prioritize* which intents to include —
falling back to on-chain `reputation_score` and `reputation_stake.staked_amount`
while those ADRs remain Proposed — and this ordering never affects safety.

Reputation effects of a successful clear are **observed off-chain**: the
indexer/TraceRank substrate ingests the `BatchCleared` / per-leg events
exactly as it ingests Settlement events. On-chain reputation *writes* for
clears are deferred (see finding (2): they would require modifying the
frozen Registry's authorized-signer set) and tracked as open item O2.

## Consequences

- **Positive.** Adds the protocol's first multilateral clearing primitive
  with no change to the frozen core. Proof-of-funds is structural (locked at
  intent). The solver is untrusted and replaceable; correctness lives
  on-chain. Atomicity is trivial — one instruction, one transaction, all leg
  transfers revert together. The demo (3 agents, no bilateral match, 3-cycle
  clears atomically with observable events) maps directly onto D1-B + D2-A.
- **Negative / new failure modes.** Capital is locked from intent to
  clear/expiry, so an unmatched intent ties up funds until its owner
  cancels or it expires (needs a `cancel_intent` + expiry-refund path).
  Compute budget bounds cycle length; `k=3` is a real product limit.
  On-chain reputation deltas for clears are *not* written in the prototype
  (off-chain observation only) — a visible gap versus Settlement, justified
  by the frozen-core constraint. Departing from literal per-leg Settlement
  CPI (D2-A over D2-B) needs reviewer sign-off.
- **Follow-ups / open items.**
  - **O1 (blocking review):** Confirm the D2-A interpretation of "reuse
    Settlement via CPI." If literal per-leg CPI is required, the brief's
    "do not modify settlement logic" constraint must be relaxed to add a
    `commit_leg` instruction, or atomicity must be dropped.
  - **O2:** On-chain reputation for clears. Options for a later ADR: route
    clears through Settlement; add a clearing authority to Registry's
    accepted signers (touches frozen core); or keep off-chain-only.
  - **O3:** Intent expiry/refund + `cancel_intent` mechanics and rent
    reclamation.
  - **O4:** Concurrency — preventing two solvers from clearing overlapping
    intent sets (intent status flips to `Cleared` under the same tx that
    consumes it; needs a documented race analysis).
  - **O5:** When ADR-106/107/108/110 land, replace the solver's reputation
    fallback with the TraceRank-decayed, stake-weighted ranking.

## Alternatives considered

- **Order-book / RFQ instead of cycle clearing.** Solves price discovery,
  not coincidence-of-wants across a chain — does not address the thesis.
- **AMM/liquidity-pool routing.** Requires pooled liquidity and a numéraire;
  the prototype's value is bilateral-want barter that clears without a
  market maker.
- **D1-A (off-chain orders) and D2-B (per-leg Settlement CPI):** enumerated
  and rejected above (D1, D2).
- **Cycles of arbitrary length.** Deferred; combinatorial cost off-chain and
  compute-budget cost on-chain. `k=3` proves the thesis.

## References

- ADR-060 — Capability descriptor format (Accepted): how the solver reads
  offered/wanted capabilities.
- ADR-103 — Standardized Result shape (Accepted): `Result<T, AepError>` for
  the solver + MCP handlers.
- ADR-106 / ADR-107 / ADR-108 — TraceRank / decay / stake-backed discovery
  (Proposed): the ranking the solver consumes *where available*.
- ADR-110 — Versioned capability vectors (Proposed): semantic matching of
  offers/wants, future enhancement.
- ADR-111 — Vault delegation grants (Proposed): basis for the rejected
  D1-C.
- ADR-135 — Zod ↔ MCP tool schema mirroring (Proposed): pattern for the new
  `submit_intent` / `clear_batch` / `get_clearing` tools.
- `programs/settlement/src/instructions/escrow.rs`,
  `.../instructions/cpi.rs`, `.../contexts.rs`, `.../state.rs` — the frozen
  Settlement surface this ADR builds beside.

## Migration

New program; no wire-format or storage migration of existing accounts. The
clearing program ships with its own `declare_id!` (assigned at first build
via `anchor keys list`), its own `idl/clearing.json` baseline, and three new
MCP tools that raise the tool count from 28 to 31 (update the
`action-shape.test.ts` drift guard accordingly). All additions are additive;
the frozen core is untouched.
