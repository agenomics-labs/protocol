# ADR-108: Stake-backed peer discovery for the agent registry

- **Status**: Proposed
- **Date**: 2026-04-23
- **Related**: ADR-020 (reputation staking), ADR-022 (load-test
  discovery), ADR-028 (anti-Sybil), ADR-094 (reputation trust
  inversion), ADR-106 (TraceRank), ADR-107 (reputation decay)

## Context

Current agent discovery is:
- `getProgramAccounts` with `memcmp` filters against the registry
  (ADR-022), or
- off-chain indexer querying the SQLite mirror of `AgentRegistered` /
  `AgentProfileUpdated` events (ADR-082).

Neither path gates registration behind any economic cost. Anyone who
can pay ~1486 bytes of rent can register an AgentProfile. The
reputation system (ADR-094 + ADR-106/107) distinguishes *good* agents
from *bad* after they act — but the cost of first appearance in the
discovery set is rent-level, not stake-level. A mass-registration
Sybil attack against the discovery layer is cheap.

Alpturer — **"AetherWeave: Sybil-Resistant Robust Peer Discovery with
Stake"** (arxiv:2603.23793, 2026) — points out that **already-staked
collateral** in a PoS ecosystem is the right capital to reuse: an
attacker who stakes N accounts must lock N · min_stake lamports, and
no honest user pays any additional cost to be discoverable (their
stake exists anyway for participation reasons).

ADR-020 already establishes a `ReputationStake` field on
`AgentProfile` (`staked_amount`, `slash_count`). Today it has no
effect on discovery — the indexer hydrates every profile regardless of
stake. AetherWeave makes discovery *a function of stake*.

## Decision

Gate discovery on a **minimum stake threshold** that is configurable
via `ProtocolConfig`. Stake-gating layers cleanly on top of existing
scoring:

1. `indexer.agents` HTTP endpoint filters out `staked_amount <
   min_discovery_stake` by default (override with `?include_unstaked=1`
   for tooling/debugging). Sort tier is: stake-weighted TraceRank
   (ADR-106) with decay (ADR-107), then raw `reputation_score`, then
   `staked_amount` as a tiebreaker.

2. `mcp-server` `discover_agents` tool hides unstaked agents unless
   the caller passes an explicit `include_unstaked: true`. Default
   false.

3. On-chain: no change to `register_agent`. Unstaked agents still
   exist, still own their PDA, still can be CPI-referenced; they just
   aren't in the discovery set.

### Threshold semantics

New `ProtocolConfig` field:

```rust
pub min_discovery_stake_lamports: u64, // 0 disables the gate
```

Governance (Squads multisig per ADR-063) sets it. Proposed v1 default:
`0` — keep discovery open while the network bootstraps. Proposed v2
default (after 30 days of mainnet operation): equivalent to one month
of devnet-average daily volume — empirically calibrated, recorded in
the migration ADR that flips the value.

### Stake-weighted ranking

When a request sorts agents, the score is:

```
rank(v) = tracerank(v) · (1 + log10(staked_amount / min_stake))
```

With `log10` instead of linear: stake beyond 10× min has diminishing
returns, so a whale can't pay to dominate rankings indefinitely.

### Slashing interaction (unchanged)

ADR-020's `slash_count` continues to burn stake on dispute losses.
Once `staked_amount < min_discovery_stake`, the agent drops out of
discovery automatically — no additional instruction needed.

## Alternatives considered

- **Registration fee instead of ongoing stake**. A one-time fee is
  economically equivalent to `stake + immediate_slash` but loses the
  "recover your stake when you leave" property — hostile to
  legitimate short-lived agents. Rejected.
- **PoW captcha on registration**. Some projects use a CPU-bound
  proof-of-work (e.g., Monero-style RandomX) at register time.
  Weaker than stake on adversarial compute, and we already have
  stake infra.
- **Only filter at indexer level; leave on-chain untouched** (this
  ADR's choice). Keeps on-chain semantics minimal and reversible
  without a program upgrade.
- **Charge stake at `update_manifest` too**. Tempting but
  over-scopes this ADR; manifest updates are covered by ADR-060's
  signature verification which is a separate threat model. Deferred
  to a follow-up.

## Consequences

### Operational

- `indexer` exposes a new knob via query string (`?include_unstaked`).
- `discover_agents` MCP tool gains an optional arg.
- Governance must vote a non-zero `min_discovery_stake_lamports` for
  the gate to actually do anything. Ship the field at 0 so no
  disruption to current registrations.
- Dashboard (`dashboard/`) renders a "staked" badge next to agents;
  unstaked ones are hidden by default with an info tooltip.

### Security

- Sybil attack cost against discovery becomes `N · min_stake`. For
  `min_stake = 1 SOL` (~$150 at writing), a 1000-node Sybil farm
  costs $150k in *locked* SOL; slashing on misbehaviour amplifies.
- Honest legitimate-agent cost: stake they would post anyway under
  ADR-020. **No additional cost** to honest participants.
- Governance-capture risk: a malicious governance vote can set
  `min_discovery_stake` to `u64::MAX`, invalidating all existing
  agents from discovery. Mitigated by ADR-075's ProtocolConfig
  validation bounds + the multisig threshold. Document the validation
  range in the migration ADR.

### Censorship resistance

Discovery filtering at indexer + MCP layer is a **presentation-layer**
control, not a **protocol-layer** one. An off-chain tool that hits
`getProgramAccounts` directly can still enumerate every profile,
including unstaked ones. That's by design: the protocol doesn't
claim to hide unstaked agents, it claims to **deprioritize** them in
the canonical discovery surface.

## Open items

1. **Default threshold**: needs empirical calibration from 30-day
   mainnet data. Ship at 0, revisit with numbers.
2. **Tiebreaker ordering**: current proposal is stake-weighted
   TraceRank → raw reputation → staked_amount. Should stake come
   before raw reputation? Could frame the same threat model either
   way; pick after Sybil simulation in §Testing plan.
3. **Unstaking cooldown**: ADR-020 has none. AetherWeave's formal
   analysis assumes a cooldown — without it, rapid stake-unstake
   cycles can game the discovery gate. Add a mandatory
   `unstaking_cooldown_slots` to ADR-020 (follow-up PR).
4. **Interaction with ADR-106 TraceRank**: a staked-but-inactive
   agent should rank below a lightly-staked active one. The
   log-scale multiplier handles this loosely; verify empirically.

## Testing plan

Before flipping the default to non-zero, require:

- Canonical Sybil simulation fixture (`tests/fixtures/discovery/sybil.json`)
  containing N attacker agents and a trace of their stake/transaction
  pattern. Run discovery query; assert attacker rank stays in bottom
  quartile across 10 randomized seeds.
- Regression test that `min_discovery_stake_lamports = 0` preserves
  the pre-ADR-108 ordering exactly (backward-compat).

## References

- Alpturer, K. **"AetherWeave: Sybil-Resistant Robust Peer Discovery
  with Stake."** 2026. <https://arxiv.org/abs/2603.23793>
- Shi, D. et al. **"Sybil-Resistant Service Discovery for Agent
  Economies."** (referenced by ADR-106) <https://arxiv.org/abs/2510.27554>
- Internal: ADR-020, ADR-022, ADR-028, ADR-082, ADR-094, ADR-106, ADR-107.
