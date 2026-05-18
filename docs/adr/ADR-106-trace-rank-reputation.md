# ADR-106: TraceRank — payment-weighted reputation propagation

## Status

Proposed

## Date

2026-04-23

**Related:** ADR-020 (reputation staking), ADR-028 (anti-Sybil), ADR-094 (reputation trust inversion), ADR-017 (x402 HTTP payment relay)

## Maintainer Decision Required

**Decision-ready — awaiting maintainer input on:** the default values for the three `ProtocolConfig` knobs (`tracerank_half_life_seconds`, `tracerank_damping_alpha`, `tracerank_seed_weight`) and the volume threshold at which TraceRank flips on — both must be calibrated against ≥1000 real mainnet payments (open item 1), not invented.

**Options & recommendation:** the algorithm choice is decided — **TraceRank** (Shi et al., arXiv:2510.27554), an off-chain payment-value-weighted eigenvector score computed by the indexer over the existing event log. Plain PageRank (discards the amount+time signal we already emit), EigenTrust (older, weaker under collusion, no amount weighting), and an on-chain sparse-matrix solver (blows the Anchor CU budget) are enumerated and rejected in *Alternatives*. MeritRank is **complementary, not alternative** — its decay terms feed TraceRank's edge weight and are specified in the sibling ADR-107. The "second signal, off-chain, on-chain unchanged" architecture is the recommended and decided shape; only the numeric defaults remain.

The single irreducible human input is **protocol-economic parameter calibration** (the four numbers above) — deliberately left open per open item 1, to be locked after a backtest against the first ~90 days of real settlement data. Ship behind a feature flag, disabled, until then. Status stays **Proposed**.

**Dependency:** part of the coherent decentralized-reputation track (ADR-106→113, issue #71). ADR-107 extends this ADR's edge-weight; ADR-108/110/112/113 consume `tracerank_score`. Decide 106's algorithm-acceptance with 107 together (they share the `half_life` knob and the same backtest).

## Context

The protocol's reputation model (after ADR-094) is trust-inverted: the
settlement program proposes deltas; the registry applies bounded
mutations with a `±MAX_DELTA_PER_CALL = 10` cap per call. Scores are
raw counters seeded by `approve_milestone` / `resolve_dispute` CPIs.

This is robust against authority compromise (the point of ADR-094) but
offers weak Sybil resistance: any wallet that can complete a milestone
with another wallet it controls can inflate its own score. The
per-call delta cap and `MAX_REPUTATION_SCORE = 100` ceiling slow the
attack but don't defeat it — Sybil farms can still saturate score on
any number of puppet accounts.

Shi et al. — **"Sybil-Resistant Service Discovery for Agent Economies"**
(arxiv:2510.27554, Oct 2025) — proposes **TraceRank**, an eigenvector-
style reputation algorithm that propagates score along payment edges
weighted by transaction value and temporal recency. A self-endorsed
Sybil cluster can inflate *count* but cannot inflate *source-weighted
score* without a real high-reputation payer funding into the cluster.

The construction is already recognizable to us: we emit
`TaskCompleted`, `MilestoneApproved`, and `EscrowResolved` events with
`client`, `provider`, and `amount` fields (ADR-082 indexer event
coverage). A TraceRank pass can run off-chain over the indexer's event
log with no on-chain change.

## Decision

Add a TraceRank reputation score as a **second, off-chain-computed**
signal alongside the existing on-chain `reputation_score`. Expose both
through the mcp-server; leave existing on-chain logic untouched.

### Computation model

Let `G = (V, E)` be the payment graph where:
- `V` = set of authority pubkeys seen in `MilestoneApproved` / `EscrowResolved` events.
- `E` = directed edges `client → provider` with weight:

  ```
  w(e) = amount_tokens × exp(-λ · (now - slot_time) / half_life_seconds)
  ```

  with `λ = ln 2` so weight halves every `half_life_seconds`.

Seed each `v ∈ V` with its current on-chain `reputation_score` (0..100)
as a prior. Then iterate:

```
r_{t+1}(v) = (1 - α) · r_seed(v) + α · Σ_{u : (u,v) ∈ E} w(u,v) · r_t(u) / Σ_{v' : (u,v') ∈ E} w(u,v')
```

until `||r_{t+1} - r_t||_∞ < ε`. Typical convergence in ≤20 iterations
for graphs of our size (10³–10⁴ nodes).

Parameters stored in `ProtocolConfig`:
- `tracerank_half_life_seconds: u64` (default: 30 days)
- `tracerank_damping_alpha: u8` (0–100, default 85)
- `tracerank_seed_weight: u8` (0–100, default 15)

### Storage

No on-chain state change. The computed score lives in the indexer
SQLite (`agents.tracerank_score REAL`) and is surfaced via
`GET /agents/:authority` plus the existing `discover_agents` MCP tool.

### Why not make it on-chain

- Iteration count × graph size × 32-byte pubkey scan blows the Solana
  compute-unit budget.
- Off-chain computation is verifiable: the indexer's event log is
  merkle-consistent with finalized slot state. Anyone can re-run the
  calc and compare.
- Keeps governance knobs (`half_life`, `damping_alpha`) as
  `ProtocolConfig` fields so they're still on-chain votable.

### Sybil resistance claim

The attacker cost is no longer "register N Sybil agents." It becomes
"route real value through the Sybil cluster from a high-reputation
endpoint." Because payment volume is bounded by the attacker's
liquidity and the token daily-limit / per-tx-limit gates
(ADR-015, ADR-028), the economic cost of a TraceRank attack scales
with the score the attacker wants to steal. Empirically (per Shi's
simulations) a 10× Sybil multiplier yields only a ~1.3× score lift
at `α = 0.85, half_life = 30d`.

## Alternatives

- **PageRank instead of TraceRank**: simpler but treats all edges
  equal; wastes the amount + time signal we already have.
- **MeritRank (ADR-109 candidate)**: complementary — focuses on decay
  parameters on the same graph. Recommend adopting both; MeritRank's
  decay formula feeds directly into TraceRank's `w(e)`.
- **Eigentrust**: older, less attack-resistant under collusion; no
  amount weighting.
- **On-chain sparse matrix solver**: Anchor CU budget rules this out
  today. Revisit when Solana compute units rise (SIMD-0207+).

## Consequences

### Operational

- New indexer cron job: TraceRank pass every N slots (default every
  ~10 min at 600 slots). Runtime: ~500ms for 10⁴ nodes on a dev box.
- New table: `agents.tracerank_score` + `agents.tracerank_updated_at`.
- `GET /agents/:authority` response gains a `tracerank` field.
- `discover_agents` MCP tool gains optional sort-by `tracerank`.

### Governance

- `update_protocol_config` (settlement) gains three new u8/u64 fields.
  Breaking change to the instruction signature; needs an ADR-096-style
  migration pass for existing ProtocolConfig account.

### Security

- Sybil resistance improves by the factor derived above.
- Worst-case failure: the indexer is down → TraceRank score stales.
  The on-chain `reputation_score` still works unchanged; clients can
  fall back to the raw score (and should, via a feature flag).
- Parameter-governance risk: a hostile governance vote can tank the
  signal by setting `half_life = 1 second`. Mitigated by the existing
  ADR-081 emergency-suspend + Squads multisig (ADR-063).

## Open items

1. **Bootstrapping**: until a graph accumulates (first ~1000 payments),
   TraceRank ≈ seed. Ship disabled, flip on after a volume threshold.
2. **Delta exposure in MCP**: should `tracerank` be delta-relative to
   global mean, or absolute? Shi argues delta is more useful; easier
   to hide manipulation in absolute.
3. **Test vectors**: need a canonical graph fixture (checked into
   `tests/fixtures/tracerank/`) so the implementation can be verified
   against Shi's reference numbers.

## References

- Shi, D. et al. **"Sybil-Resistant Service Discovery for Agent
  Economies."** Operator Labs, Oct 2025. <https://arxiv.org/abs/2510.27554>
- Nasrulin, B. et al. **"MeritRank: Sybil Tolerant Reputation for
  Merit-based Tokenomics."** 2022. <https://hf.co/papers/2207.09950>
- Internal: ADR-020, ADR-028, ADR-082, ADR-094, ADR-017.
