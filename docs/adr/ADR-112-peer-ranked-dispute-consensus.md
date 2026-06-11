# ADR-112: Peer-ranked dispute consensus (Bradley-Terry aggregation)

## Status

Proposed

## Date

2026-04-23

**Related:** ADR-025 (expire escrow approved milestones), ADR-026 (resolve-dispute bookkeeping), ADR-030 (dispute timeout), ADR-094 (reputation trust inversion), ADR-106 (TraceRank), ADR-107 (reputation decay), ADR-108 (stake-backed discovery)

## Maintainer Decision Required

**Decision-ready — awaiting maintainer input on:** (1) a legal/regulatory sign-off — whether peer-consensus dispute resolution constitutes arbitration in target jurisdictions (open item 4; devnet/testnet can ship regardless, mainnet enablement is gated on this) and (2) the `ProtocolConfig` defaults (`peer_consensus_window_seconds` 72h, `peer_consensus_min_voters` 5, `max_proposals` 5, per-vote reputation delta +1) to be tuned after mainnet data.

**Options & recommendation:** the recommended option is **an opt-in `PeerConsensus` dispute mode using Bradley-Terry MLE aggregation over pairwise peer rankings, computed off-chain in the indexer with O(V) on-chain verification, alongside (never replacing) the existing single-resolver path**. Rejected alternatives — pure majority vote (vulnerable to proposal-flooding split attacks), Schelling-point/Augur-style commit-reveal staking (over-heavy for this dispute volume), and single-resolver-only (the status quo gap this ADR closes) — are enumerated in *Alternatives considered*. Larin et al. "Fortytwo" (arXiv:2510.24801) plus Bradley & Terry (1952) are the cited basis; pairwise ranking is chosen over majority specifically for Sybil-resilience with capability-weighted voters. The instruction surface, off-chain-MLE/on-chain-proof split, and ADR-030 timeout fallback are all decided.

The single irreducible human inputs are a **legal classification decision** (arbitration exposure — a judgment call I must not invent) and **protocol-economic parameter tuning** (deferred to mainnet data). Status stays **Proposed**.

**Dependency:** consumes ADR-108 stake gate, ADR-106 TraceRank weights, ADR-107 decay; uses ADR-094 `propose_reputation_delta`. Decide after 106/107/108. Part of the ADR-106→113 track (issue #71); the legal gate is unique to this member.

## Context

Dispute resolution today has two paths (ADR-026 + ADR-030):

1. **Active resolve**: a single `dispute_resolver` (set at escrow
   creation) calls `resolve_dispute` with client/provider refund
   split. Judgment is binary from one oracle.
2. **Timeout auto-resolve**: if the resolver doesn't act by
   `dispute_timeout_seconds`, the escrow refunds the client and
   slashes the provider via `resolve_dispute_timeout`.

Both leave single-point-of-failure risk. A captured resolver or a
resolver outage flips the game; callers pick resolvers based on
trust signals outside the protocol.

Larin et al. — **"Fortytwo: Swarm Inference with Peer-Ranked
Consensus"** (hf.co/papers/2510.24801, Oct 2025) — show that a
**pairwise-ranking** consensus (Bradley-Terry aggregation over peer
votes) beats majority voting for quality and Sybil-resilience in a
swarm setting. Peers rank outputs pairwise; the global ordering is
the maximum-likelihood ranking under Bradley-Terry. Proof-of-capability
feeds the weights so loud-but-unreliable peers can't dominate.

This maps naturally to our dispute layer: the "output" is the
resolver's refund split proposal; peer validators (staked agents per
ADR-020) pairwise-rank competing proposals; the winning split
executes.

## Decision

Add an **opt-in** peer-consensus dispute resolution track alongside
the existing single-resolver path. New instruction:

```rust
pub fn propose_dispute_split(
    ctx: Context<ProposeDisputeSplit>,
    client_refund: u64,
    provider_payout: u64,
    reasoning_hash: [u8; 32], // sha256 of IPFS-pinned reasoning doc
) -> Result<()>;

pub fn rank_dispute_split_pair(
    ctx: Context<RankDisputeSplitPair>,
    winner: Pubkey,  // the proposal the voter prefers
    loser: Pubkey,   // the rejected proposal
) -> Result<()>;

pub fn finalize_peer_resolved_dispute(
    ctx: Context<FinalizePeerResolvedDispute>,
) -> Result<()>;
```

### Flow

1. Escrow's `dispute_mode: DisputeMode` field (new) is one of:
   `SingleResolver` (today's default) or `PeerConsensus`. Set at
   `create_escrow`.
2. On dispute, any staked agent (meeting ADR-108's stake gate) can
   call `propose_dispute_split` with a refund breakdown. Multiple
   proposals compete.
3. Voters (same stake gate) call `rank_dispute_split_pair` for each
   pair they judged. Weight = voter's `reputation_score` from
   ADR-094, decayed per ADR-107.
4. After `peer_consensus_window_seconds` elapses (new
   `ProtocolConfig` field, default 72 hours), anyone calls
   `finalize_peer_resolved_dispute`. Bradley-Terry MLE picks the
   winning proposal; its split executes; voters on the winning side
   earn a small reputation bump.

### Compute budget

Bradley-Terry MLE iteration is O(P²) in proposal count × V voters
per iteration, with ~10 iterations for convergence. On-chain this
would CU-out. Therefore: the **MLE runs off-chain** in the indexer
after the window closes; `finalize_peer_resolved_dispute` accepts a
proof-of-ranking (the rankings themselves + the winning proposal's
Merkle position). On-chain verification is O(V) — a single pass
over the ranking events.

Keep `ProtocolConfig.peer_consensus_min_voters: u8` (default 5) so
low-participation disputes can't be railroaded by one voter.

## Alternatives considered

- **Pure majority vote** (no pairwise). Vulnerable to splitting
  attacks (attacker floods 3+ proposals to dilute a winning one).
- **Schelling-point staking** (Augur-style). Heavier: requires
  commit-reveal phases + stake slashing on losing side. Over-kill
  for our dispute volume.
- **Stick with single-resolver indefinitely**. Works; ADR-112 is
  additive, not mandatory. No PR here proposes removing the single-
  resolver path.

## Consequences

### Protocol

- New account kinds (DisputeProposal, DisputeRanking).
- New events: `DisputeSplitProposed`, `DisputeSplitRanked`,
  `DisputeConsensusFinalized`.
- Indexer grows a consensus-computation job; dashboard gains a
  dispute-resolution visualization.

### Economic

- Voters earn small reputation bumps (via ADR-094's
  `propose_reputation_delta`), not payments. No token pot; the
  escrow's funds go to whichever proposal wins, not to voters.
- Spam-proposing cost: ADR-108 stake gate + small rent per
  `DisputeProposal` PDA (~200 bytes). Raises a floor but doesn't
  zero out attack surface.

### Security

- **Collusion**: N colluders with matched votes can win if they
  meet the min_voters threshold. Mitigation: TraceRank weights make
  fresh-colluder chains expensive; ADR-107 decay kills dormant
  puppets.
- **Timing attack**: final voter times their rank to swing a close
  vote. Mitigation: optional commit-reveal phase as a v2 ADR if we
  see this empirically.
- **Griefing by non-proposal**: if nobody proposes a split, dispute
  stalls. Mitigation: retain the ADR-030 timeout path — no peer
  consensus after `dispute_timeout_seconds` → auto-refund-to-client
  as today.

## Open items

1. **Proposal spam**: cap proposals per dispute at `max_proposals`
   (default 5) via ProtocolConfig.
2. **Reputation delta per vote**: keep small (default +1) so peer-
   voting is a side hustle, not a game. Tune after mainnet data.
3. **Dashboard**: render "peer-resolved" vs "single-resolver"
   histogram so operators can watch adoption.
4. **Legal**: peer-consensus dispute resolution in some jurisdictions
   may look like arbitration. Flag to legal before enabling on
   mainnet; devnet/testnet can ship immediately.

## References

- Larin, V. et al. **"Fortytwo: Swarm Inference with Peer-Ranked
  Consensus."** 2025. <https://hf.co/papers/2510.24801>
- Bradley, R. A. & Terry, M. E. (1952) — the original paper on
  paired-comparison ranking.
- Internal: ADR-025, ADR-026, ADR-030, ADR-094, ADR-106, ADR-107,
  ADR-108.

## Legal Landscape (research — NOT legal advice)

> Research synthesis (2026-05-19) to scope the *legal classification*
> open item in *Maintainer Decision Required*. **This is not legal
> advice and does not decide anything** — mainnet enablement still
> requires counsel sign-off. Status remains **Proposed**.

**Pivotal characterization — B2B vs. B2C.** Most "arbitration is
unenforceable" doctrine is *consumer*-specific. These disputes are
agent-to-agent escrow disputes between staked participants (B2B). B2B
arbitration is broadly enforceable worldwide; B2C is hostile-to-void in
EU/Canada and scrutinized in the US. The decisive counsel question is
therefore **"can any party be a consumer principal?"** — not "is this
arbitration?".

**Key design lever — arbitration vs. expert determination** (maps to
options C vs. D in *Alternatives considered*):
- *Expert determination* (advisory/contractual): enforced as breach of
  contract, **not** NY-Convention portable, minimal challenge surface,
  largely sidesteps arbitration-specific consumer prohibitions. Lower
  legal risk, lower decentralization value.
- *Arbitration* (binding): NY-Convention portable (~170 states) but
  carries the full arbitration regulatory surface incl. consumer
  carve-outs.

**Jurisdiction notes:**
- **USA** — FAA Ch. 2 / NY Convention; pro-arbitration. A *purely
  on-chain* award by pseudonymous deciders risks falling outside the
  Convention (no seat / no State nexus). B2B strong; consumer scrutinized.
- **Canada** — *Uber Techs. v. Heller* (SCC 2020): arbitration clauses
  void for unconscionability where bargaining-power inequality + access
  "realistically unattainable" (cost/foreign seat). Token-stake cost +
  pseudonymous deciders is the Uber fact pattern. Provincial consumer
  acts void mandatory pre-dispute consumer arbitration. B2B fine.
- **EU** — UCTD 93/13: pre-dispute *consumer* arbitration presumptively
  unfair/void, challengeable anytime; heavy member-state variance
  (FR/SE bans, DE separate-signature). Does not cover B2B. Parallel:
  ODR/ADR + DSA out-of-court bodies.
- **UK** — most favorable concrete wrapper: **UKJT Digital Dispute
  Resolution Rules (2021)** — purpose-built for on-chain/smart-contract
  disputes, incorporable by reference, on-chain implementation via
  private key, NY-Convention-enforceable, seat = England & Wales.
- **Singapore / Switzerland / UAE** — arbitration-friendly hubs
  (SG #2 global seat, SIAC 2025 crypto-aware; UAE DIFC/ADGM; CH crypto-
  and arbitration-friendly). Seat + governing-law selection is the
  standard de-risking move.

**Proven enforceability pattern (precedent):** Kleros recognized by a
Mexican court (2021) via a *hybrid model* — on-chain mechanism decides
the merits, a human arbitrator "translates" it into a conventional
NY-Convention award. Pure on-chain awards are legally fragile.

**De-risking recipe if option D (binding) is chosen:** B2B-only
characterization (the linchpin) + recognized seat/rules (UK UKJT or
Singapore) + hybrid human-arbitrator translation + genuine opt-in
consent + avoid the *Uber-v-Heller* access-cost trap.

**Counsel question set:** (1) can parties be contractually constrained
to B2B with credible consumer-use disclaimer? (2) UKJT Rules vs. SIAC
wrapper? (3) expert-determination (C) vs. hybrid-arbitration (D) given
enforcement needs? (4) which target jurisdictions actually matter for
our user base (drives member-state analysis)?

**Sources:** Stanford Law (Kleros study); Kleros-Mexico enforcement
case; UKJT Digital Dispute Resolution Rules (DLA Piper / UKJT PDF);
*Uber v. Heller* (Osler / Harvard L. Rev.); EU UCTD 93/13 (EUR-Lex;
Oxford JIDS); blockchain awards & NY Convention (T&F 2025; Kluwer);
arbitration vs. expert determination (Gatehouse Chambers); Singapore
SIAC 2025 / crypto arbitration (ALB; Pinsent Masons). Full URLs in the
PR description.
