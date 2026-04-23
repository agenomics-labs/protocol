# ADR-107: Reputation decay — MeritRank-style temporal + connectivity decay

- **Status**: Proposed
- **Date**: 2026-04-23
- **Related**: ADR-094 (reputation trust inversion), ADR-106
  (TraceRank), ADR-020 (reputation staking)

## Context

The current `AgentProfile.reputation_score` is a monotonically-non-
decreasing counter (mod `MAX_REPUTATION_SCORE = 100` saturation,
mod negative deltas from disputes). An agent that earns 100 once and
then goes dormant retains 100 indefinitely. This is a known failure
mode: discovery surfaces dormant high-rep agents; real attackers can
earn rep once then monetize the score for months.

Nasrulin et al. — **"MeritRank: Sybil Tolerant Reputation for
Merit-based Tokenomics"** (2022) — makes three decay parameters first-
class:

- **Connectivity decay** (`β_c`): score shrinks if the agent stops
  participating (no new inbound endorsements).
- **Transitivity decay** (`β_t`): trust propagated N hops from its
  origin decays as `β_t^N`; mitigates long-path Sybil chains.
- **Absolute time decay** (`β_a`): raw clock-based decay baseline.

Combined with TraceRank (ADR-106), the three together give
formal Sybil-tolerance guarantees (MeritRank Thm. 4.2).

## Decision

Apply all three decays to the **off-chain** TraceRank
computation from ADR-106. Do **not** modify the on-chain
`reputation_score` (that remains an append-only audit signal).

### Formulas

Augment the edge weight from ADR-106:

```
w(e) = amount_tokens                                   // raw volume
     × exp(-ln2 · Δt / half_life_seconds)              // β_a absolute-time decay
     × β_t^depth(e)                                    // transitivity decay
     × min(1, active_payments_last_30d(v_target)/k)    // β_c connectivity decay
```

where:
- `depth(e)` is the number of hops from the seed set (bootstrap
  high-reputation set) to the edge's destination. Computed per BFS
  during the TraceRank iteration.
- `k` is the "minimum activity" threshold; default 3 payments / 30d.
  Below `k`, the connectivity multiplier scales linearly to 0 at 0.
- `β_t` default 0.85; an 8-hop path contributes `0.85⁸ ≈ 0.27` of a
  direct endorsement.
- `half_life` shared with ADR-106; default 30 days.

Parameters added to `ProtocolConfig` (extend the ADR-106 set):
- `tracerank_transitivity_beta: u8` (0–100, default 85)
- `tracerank_connectivity_threshold: u8` (min payments in window,
  default 3)
- `tracerank_connectivity_window_seconds: u64` (default 30 days)

### Surface

Same API as ADR-106: `agents.tracerank_score` reflects the decayed
value. Add `agents.tracerank_decayed_at` (seconds since last
participation) so clients can render "stale" badges in UI without
rerunning the math.

## Alternatives

- **Only absolute-time decay** (simplest): misses the connectivity and
  transitivity signals; easy to game.
- **On-chain decay** (cron instruction that burns 1 point/week):
  increases Anchor CU consumption linearly in active-agent count;
  makes `update_profile` more expensive; loses the transitivity
  parameter entirely.
- **Skip decay, ship TraceRank only** (ADR-106 alone): leaves the
  dormant-high-rep gap open.

## Consequences

- Every TraceRank pass now does a BFS from seed set to compute
  `depth(e)`. +O(|V| + |E|) per pass, still sub-second for our scale.
- Test surface grows: need fixtures for each decay parameter
  (tests/fixtures/reputation/decay/).
- User-visible "reputation went down with no bad behavior" moments;
  need a doc blurb explaining decay in the discover-agents MCP tool
  output. File follow-up DX issue.

## Open items

1. **Governance stability**: three new knobs raise the
   ProtocolConfig's attack surface. Combine with ADR-063 multisig's
   2/3 threshold to bound change velocity; document allowed ranges in
   ADR-075 (ProtocolConfig validation).
2. **Backtest**: simulate decay parameters against the first 90 days
   of real settlement events once available. Lock defaults after the
   backtest; ship placeholders with a "DEFAULT — subject to review"
   comment.
3. **Alignment with ADR-020 staking**: staked agents shouldn't decay
   as aggressively (their stake is the activity signal). Consider a
   stake-weighted multiplier on `β_c`.

## References

- Nasrulin, B. et al. **"MeritRank: Sybil Tolerant Reputation for
  Merit-based Tokenomics."** 2022. <https://hf.co/papers/2207.09950>
- Internal: ADR-094, ADR-106, ADR-020, ADR-075, ADR-063.
