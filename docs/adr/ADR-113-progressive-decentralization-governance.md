# ADR-113: Progressive decentralization governance

## Status

Proposed

## Date

2026-04-23

**Related:** ADR-019 (security audit prep), ADR-063 (Squads multisig), ADR-075 (ProtocolConfig validation bounds), ADR-077 (governance ADR backfill), ADR-078 (governance roles), ADR-079 (governance policy), ADR-081 (emergency suspend), ADR-094 (reputation trust inversion)

## Context

Governance today is centralized by design:

- `ProtocolConfig` is mutable only by a Squads 2-of-3 multisig
  (ADR-063).
- Emergency suspend (ADR-081) lives in that same multisig.
- Program upgrade authority is one human-custodied key, deferred
  transfer to Squads per ADR-063 §4.
- The three throwaway devnet signers are placeholders; mainnet
  requires "real signers per ADR-063 §1.1 (3-of-5 with role slots)."

This is the right **stage 1** for an early-ops protocol: centralized
enough to fix bugs, bounded enough (multisig + ADR-075 validation
ranges) to constrain unilateral action. It's also **not the end
state**. Long-term trust requires the governance power to migrate to
the ecosystem that uses the protocol — not stay with the team that
launched it.

The referenced paper — **"Governing the Agent-to-Agent Economy of
Trust via Progressive Decentralization"**
(arxiv:2501.16606, Jan 2025) — proposes a formal staged path:

| Stage | Who decides | What decides what |
|---|---|---|
| 0 | Core team, 2/3 multisig | Everything (today) |
| 1 | Core team + validator DAO, 2/3 + 2/4 | Parameter changes, program upgrades need both |
| 2 | Validator DAO majority, core team veto (time-limited) | Most changes; core team can only block for 14 days max |
| 3 | Validator DAO alone | Everything |

Validator DAOs are composed of staked agents (ADR-020 + ADR-108
stake gate) and **high-utility AI agents** (per the paper) —
participants who have demonstrably routed value through the
protocol.

## Decision

Adopt the paper's four-stage model as the protocol's governance
roadmap, encoded as a stage-gated on-chain state:

```rust
#[account]
pub struct GovernanceStage {
    pub current_stage: u8, // 0..=3
    pub entered_stage_at: i64,
    pub core_team_veto_remaining_days: i16, // stage 2 only; -1 = unlimited (stages 0/1)
    pub validator_dao_pda: Pubkey, // seeded [b"validator_dao"]; filled at stage 1+
    pub bump: u8,
}
```

### New instruction: `advance_governance_stage`

- Callable by the existing Squads multisig (stages 0 → 1).
- Callable by a joint core-team + validator-DAO quorum (stages 1 →
  2).
- Callable by validator DAO alone (stages 2 → 3).
- NEVER callable backwards (one-way ratchet).

### What changes at each stage

Every existing governance instruction (e.g. `update_protocol_config`,
`clear_suspension` under ADR-081) gains a stage-gated require:

```rust
match governance.current_stage {
    0 => ensure_signer_is_multisig(ctx, SQUADS_MULTISIG)?,
    1 => ensure_signer_is_multisig_or_validator_dao(ctx)?,
    2 => ensure_validator_dao_majority_unless_vetoed(ctx)?,
    3 => ensure_validator_dao_majority(ctx)?,
}
```

Program-upgrade authority transfers at stage 1 from the current key
to a BPF-Upgrade-authority-owned-by-Squads PDA (this is the ADR-063
§4 deferred work; ADR-113 finally forces it).

### Validator DAO composition

- Membership: staked agents passing ADR-108's discovery gate, weighted
  by `stake × tracerank` (ADR-106) × decay (ADR-107).
- Quorum: 51% weighted vote.
- Slashing a validator: inherited from ADR-020; slashed stake zeroes
  DAO weight until re-staked.

### Core team veto (stage 2 only)

- Core team can veto a DAO-initiated governance change within 14 days.
- Each stage-2 veto spends a reputation delta proportional to the
  reversal; core team reputation is public. Enough vetoes trigger
  stage-3 ratchet (DAO majority overrides without veto).
- Intent: a safety valve for protocol-breaking votes without being
  a permanent sovereignty claim.

## Alternatives considered

- **Skip to stage 3 immediately** (maximalist decentralization).
  Reckless for a protocol this young: first-year bugs land in
  governance hands without expert triage. Paper explicitly warns
  against this.
- **Frozen stage 0** (no transition plan). Technical debt; makes the
  "who governs this" question increasingly political as adoption
  grows.
- **Token-vote DAO**. Cheap-to-buy voting power; Sybil-amplifies
  capital, not competence. Paper argues for stake-weighted AND
  reputation-weighted voting (this ADR follows).

## Consequences

### Operational

- Every governance instruction must gain a `GovernanceStage` check
  at the signer-validation layer. Adds ~5 lines per instruction; CU
  cost is single account read.
- New dashboard panel: "governance stage, validator DAO members,
  vetoes outstanding, days to next auto-ratchet."
- Every ADR that introduces a new governance knob must state **which
  stage(s) each parameter is mutable in** (add section to ADR
  template).

### Economic

- Validator DAO participation is unpaid at stage 1 but gains
  reputation-weighted voting power (ADR-094). Stage 2+ may introduce
  fee-sharing (separate ADR) — explicitly out of scope here.

### Security

- Stage transitions are irreversible: a buggy stage-2 could lock
  parameters until stage 3 unlocks. Mitigation: require a 7-day
  simulation window on devnet for each stage transition, gated by
  ADR-036 audit sign-off for mainnet.
- DAO-capture risk at stage 3: a whale accumulating enough stake
  could govern unilaterally. Mitigation: stake-weight uses
  `log10(stake)` not linear — diminishing returns (same pattern as
  ADR-108's ranking).

### Legal / regulatory

- Progressive decentralization is a path recognized by several
  jurisdictions as "sufficiently decentralized" for reduced
  regulatory classification. Flag to legal: each stage transition
  is a defensible milestone in that narrative.

## Open items

1. **Validator DAO bootstrap**: who's in the first DAO? Proposal:
   seed with agents that have > 90 days mainnet history, stake >
   some threshold, and no active slashes. Tune after mainnet
   baseline.
2. **Core team veto accounting**: where do "reputation deltas for
   vetoes" live? Could piggyback on ADR-094's
   `propose_reputation_delta`.
3. **Automated stage advancement**: stages 1→2→3 can auto-advance
   after time-based criteria (e.g. stage 2 auto-advances to stage 3
   after 12 months, unless explicitly halted by DAO vote). Worth
   adding to avoid indefinite stasis.
4. **Fork risk**: if governance makes a change a meaningful portion
   of the network dislikes, they fork. Protocol should document the
   canonical-branch criterion (longest-chain / highest-stake /
   signed-by-X).

## References

- **"Governing the Agent-to-Agent Economy of Trust via Progressive
  Decentralization."** 2025. <https://arxiv.org/html/2501.16606v1>
- Internal: ADR-019, ADR-020, ADR-063, ADR-075, ADR-077, ADR-078,
  ADR-079, ADR-081, ADR-094, ADR-106, ADR-107, ADR-108.
