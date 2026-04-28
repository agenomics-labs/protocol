# ADR-131: Sybil-cost calibration — current bounds and threat-model boundary

## Status

Accepted

## Date

2026-04-28

## Context

The cycle-3 on-chain hostile re-audit (`docs/audits/CYCLE-3-ONCHAIN-PUNCHLIST.md`,
finding AUD-205, classified Architecture / calibration) surfaced a quantitative
question about the protocol's sybil resistance: with the current reputation
parameters, how many dispute losses can a freshly-registered agent absorb
before its `AgentStatus` flips to `Suspended`, and at what point does the
per-agent slash cost amortize below the per-task escrow value?

This ADR is **not a bug fix**. The audit did not surface a violated invariant
or a reachable exploit. It surfaced a calibration boundary — the parameters
work for the threat model the protocol is designed for today, and the
question of whether the boundary is far enough out is governance, not code.
The right outcome is an explicit ADR that:

1. Pins the current calibration values on the wire.
2. States the inequality at which sybil cost falls below sybil benefit.
3. Names exactly what the calibration defends against and what it does not.
4. Catalogs the levers available if the threat model expands, with the cost
   of pulling each.
5. Defines a triggering condition for re-opening the question.

This ADR exists so a future engineer (or auditor) inheriting the question
does not re-derive the parameter values from source, does not re-derive the
inequality, and does not re-litigate the decision to ship the launch with
these specific bounds — they pick up the trail with the analysis already
on the table.

### Current calibration (read at ADR date from source)

The reputation-policy constants live in `programs/agent-registry/src/lib.rs`:

- `MAX_REPUTATION_SCORE = 100` (lib.rs:17). Reputation scores are clamped
  to `[0, 100]`. This is also the seed value at registration: a fresh agent
  starts at `reputation_score = 0` per `register_agent` (lib.rs:107) — NOT
  at `100`.
- `MAX_DELTA_PER_CALL = 10` (lib.rs:21). `propose_reputation_delta` rejects
  any `|delta| > 10` via `require!(delta.unsigned_abs() <= 10, ...)`
  (lib.rs:304-307). A single dispute loss therefore moves the score by at
  most 10 points.
- `SUSPEND_AT_SLASH_COUNT = 3` (implicit in lib.rs:358-359 as the literal
  `>= 3` comparison and re-asserted in `assert_valid_profile` at
  `state.rs:198-200`). The third slash (and only the third) flips
  `AgentStatus::Active → Suspended`.
- Slash reasons are restricted to `{1 = dispute_loss, 2 = expiry_undelivered}`
  per AUD-108 (`require!(reason <= 2, ...)` at lib.rs:322-325; reason `0`
  is the non-slash positive-delta path).

The settlement-side floor that prices sybil registration is:

- `DEFAULT_MIN_ESCROW_AMOUNT = MIN_ESCROW_AMOUNT = 10_000` base units
  (`programs/settlement/src/state.rs:28,117`). At USDC 6-decimal precision
  this is 0.01 USDC per task. Below this floor, `create_escrow` rejects.
  Per-task escrow is governance-tunable via `ProtocolConfig` (ADR-075).

Per-agent registration cost:

- `AgentProfile` account is `8 + AgentProfile::SPACE + MIGRATION_HEADROOM
  = 8 + 1415 + 64 = 1487 bytes` (`programs/agent-registry/src/contexts.rs:64`),
  rent-exempt at roughly **0.0107 SOL** (≈1487 × 6960 lamports + 890_880
  base; computed against the live cluster rent rate).
- `OwnerNonce` account is 16 bytes total (`8 disc + 8 nonce`) per ADR-097,
  rent-exempt at ~0.00089 SOL.
- ADR-028 minimum-escrow + self-dealing prohibition apply at the Settlement
  boundary — independent of registry-side parameters. A sybil pair must
  fund both wallets and pay `MIN_ESCROW_AMOUNT` per fake task.
- Reputation staking (ADR-020) is **available but optional**: `stake_reputation`
  enforces only `amount > 0` (lib.rs:418), not a minimum bond. Sybil agents
  that skip staking pay only the rent-exempt minimum at registration. This
  is the lever the calibration analysis below leaves open.

Authority reuse defenses:

- ADR-097 `registration_nonce` makes the `agent_profile` PDA address
  uniquely derived from `[authority, "agent-profile", nonce]` and increments
  the nonce on `deregister_agent`. Re-registering at the SAME authority
  produces a DIFFERENT PDA address — off-chain reputation history cannot
  be laundered by close-then-reopen.
- ADR-097 raises the cost of authority reuse to "registering a NEW
  authority" (a fresh keypair with no on-chain history). It does **not**
  raise the cost of new-authority registration itself; that floor is set
  by the per-agent rent + per-task escrow floor only.

## Decision

The launch ships with `MAX_DELTA_PER_CALL = 10`, `SUSPEND_AT_SLASH_COUNT = 3`,
no minimum-stake-at-registration, and the ADR-028 + ADR-097 economic and
PDA-uniqueness defenses; this ADR is the auditable record that those
parameters were considered against AUD-205's calibration question and
explicitly held at their current values for the launch window. The
calibration defends against single-pair sybil attempts at protocol-floor
escrow values, raises the authority-reuse cost to "register a new keypair"
via ADR-097, and is sufficient as long as observed sybil-pattern incidents
stay below the trigger threshold defined in §"Re-calibration trigger" below.
The calibration does **not** defend against well-capitalized sybil attackers
with funded wallets transacting at high per-task escrow values; that
expansion of the threat model requires pulling one or more levers in
§"Levers available if the threat model expands" via a new ADR.

### Threat-model boundary (the AUD-205 inequality)

A sybil agent's per-agent slash cost is the cost of registering and
operating one sybil identity until it gets suspended. Suspension happens at
`slash_count = 3`, so the per-agent loss budget is **three dispute losses**.

Define:

- `R = registration cost = AgentProfile rent-exempt (~0.0107 SOL) +
       OwnerNonce rent-exempt (~0.00089 SOL) ≈ 0.011 SOL per fresh authority.`
- `L = per-loss opportunity cost = the value of the dispute the sybil
       lost = at minimum MIN_ESCROW_AMOUNT (0.01 USDC), but in practice
       whatever the disputed task's escrow was set to.`
- `E = per-task escrow value the sybil is targeting (the value the
       sybil's reputation farming is intended to unlock — i.e., the
       task value the sybil agent expects to win once its reputation
       is laundered up).`

The per-agent slash cost is bounded above by `3R + 3L` (three losses,
plus the registration cost amortized over those three losses, plus
gas/CU which is a rounding error at Solana fee levels). The sybil
attack is profitable when:

```
E > 3R + 3L
```

i.e., **when the target escrow value the sybil is hunting exceeds the
per-agent slash cost amortized over the three dispute losses required
to burn one sybil identity**. This is the AUD-205 inequality verbatim.

At launch parameters with a sybil running at the protocol floor
(`L ≈ MIN_ESCROW_AMOUNT = 0.01 USDC` per dispute), the right-hand side
is dominated by `3R ≈ 0.033 SOL ≈ ~$5-7 USD` (at SOL ≈ $150-200 USD).
A sybil hunting an escrow worth more than that is mathematically in
profit — the floor where the inequality flips depends on the fiat-SOL
exchange rate at the time of attack.

### What the calibration defends against (in scope)

- **Single-pair, low-value sybil attempts.** Agent A and agent B
  registering, A creating an escrow, B accepting, A disputing in B's
  favor (or vice versa) at protocol-floor `MIN_ESCROW_AMOUNT`: the
  per-fake-task value (≥0.01 USDC) is below the per-agent rent
  amortized over three losses, so even ignoring CU and dispute-fee
  overhead, a launch-floor sybil pair burns money faster than it
  earns reputation. Self-dealing within a single keypair is closed
  by ADR-028's `client != provider` check at `create_escrow`.
- **Reputation laundering via close-then-reopen on the SAME authority.**
  ADR-097's nonce-in-PDA-seed makes the post-close registration land
  at a different address; off-chain consumers see a fresh profile,
  not a re-occupation of the closed one. An attacker that wants to
  start over MUST register a new authority — paying `R` again.
- **Single-call reputation manipulation past the per-call cap.** The
  `MAX_DELTA_PER_CALL = 10` clamp forces large reputation shifts to
  span multiple transactions. Each transaction is independently
  visible to off-chain observers, and the `slash_count`-driven
  suspension is the per-call rate-limiter on the negative side.
- **Authority reuse via deregister-then-reregister.** ADR-070
  `StakePresentOnDeregister` requires draining the reputation stake
  before deregister; combined with ADR-097's nonce, the path that
  "wipes slash history by closing the account" is closed.
- **Suspended agents continuing to mutate state.** `update_status`
  (lib.rs:222-224) blocks `Suspended → Active|Paused` transitions;
  `propose_reputation_delta` post-AUD-206 (commit
  `2a2520f`) blocks the Retired closed-state mutation; the
  closed-state-machine invariant `Suspended ⇒ slash_count >= 3` is
  enforced post-mutation by `assert_valid_profile`.

### What the calibration does NOT defend against (out of scope)

- **Capitalized sybil attackers transacting at high per-task escrow
  values.** A sybil with the budget to register N identities and
  fund escrows above the inequality's right-hand side is in profit
  per ADR text above. Defense at this level requires either a
  minimum-stake-at-registration (turning the protocol-rent-only floor
  into a rent-plus-bond floor) or a higher `SUSPEND_AT_SLASH_COUNT`
  (forcing more losses per identity-burn) — both are governance
  decisions priced in §"Levers available" below.
- **Coordinated multi-account farming where the attacker controls both
  sides of every dispute.** Agent A creates an escrow, dispute-resolves
  in B's favor; B accepts losses on B's reputation, A keeps the
  payment. ADR-028's self-dealing check blocks A=B; it does NOT block
  A and B being two keypairs the SAME real-world entity controls.
  Defense requires off-chain proof-of-uniqueness (rejected by ADR-028
  for autonomous-agent-incompatibility reasons), or staking with
  slashing tied to dispute outcomes that hits a *common* economic
  surface — neither is in the launch.
- **Reputation farming without a counterparty dispute.** The slash
  branch is reachable only via Settlement's `resolve_dispute` and
  `expire_escrow` paths (the only callers that emit `reason = 1` or
  `reason = 2`). An attacker farming reputation purely through
  "task_completed" deltas (`reason = 0`) cannot trigger slashing —
  but also cannot do so without a counterparty whose payment they
  must produce. The economic floor on this attack is the
  cost-of-a-counterparty, which is upstream of the calibration here.
- **Escrow values the protocol cannot observe.** `MIN_ESCROW_AMOUNT`
  pins a floor; the *ceiling* (the `E` in the inequality) is set by
  the customer, not the protocol. A protocol that wants to defend at
  high `E` must either bond stake to escrow size (linking sybil cost
  to sybil benefit on a per-task basis) or rate-limit reputation
  gains regardless of escrow value — both governance decisions.
- **Slow-rate sybil farming.** A sybil that makes one dispute every
  N days and never trips `slash_count >= 3` (because they let the
  account go inactive after two losses, then register a new authority)
  is bounded only by `R`-per-identity. ADR-097's nonce raises the
  per-authority cost, but new-authority cost is still rent-only.

## Levers available if the threat model expands

If observed sybil-pattern incidents trigger the §"Re-calibration trigger"
condition below, a future ADR (numbered ≥132 at write-time) can pull
one or more of:

- **Lower `MAX_DELTA_PER_CALL`.** Cost: every dispute resolution moves
  reputation by less, so off-chain consumers must aggregate over more
  observations to make a decision; legitimate large-scale slashing
  (e.g. emergency-suspend semantics from ADR-081) becomes multi-tx.
  Benefit: higher per-loss observability (more events per economically
  significant move) and a finer-grained suspension trigger if paired
  with `SUSPEND_AT_SLASH_COUNT` retuning. Implementation: single-line
  change at `lib.rs:21` plus `MIN_REPUTATION_DELTA / MAX_REPUTATION_DELTA`
  in `programs/settlement/src/state.rs:101,109` (per ADR-102), plus a
  test pin to lock the new value in.
- **Raise `SUSPEND_AT_SLASH_COUNT`.** Cost: a sybil identity absorbs
  more losses before suspension — pushing the right-hand side of the
  AUD-205 inequality UP, but ALSO making legitimate-bug-on-good-actor
  paths take longer to surface as suspension. The AUD-001/002 closed-
  state invariant `Suspended ⇒ slash_count >= 3` (state.rs:197-201)
  hard-codes the threshold; raising it requires bumping both the
  comparison in lib.rs:358 AND the constant in `assert_valid_profile`,
  AND a migration for any pre-bump Suspended profiles whose
  `slash_count` would now be deficient. Implementation cost: roughly
  the AUD-004 PR-I shape — multiple-file change with a paired
  migration test and `assert_valid_profile` invariant update.
- **Add a minimum-stake-at-registration bond.** Cost: turns
  `register_agent` into a token-transfer instruction with a new
  failure mode (`InsufficientFunds`) that shadow-blocks legitimate
  fresh-authority registrations from low-balance operators. Adds a
  governance-tunable parameter to `ProtocolConfig`. Benefit: directly
  raises `R` in the AUD-205 inequality from rent-only to rent + bond,
  and gives the slashing path a real economic surface to hit. The
  bond is forfeit on suspension (ties sybil cost to sybil benefit on
  the *per-loss* axis, not just the per-identity axis). Implementation
  cost: new account (`RegistrationBond` PDA) + Settlement-side slash
  CPI to drain it on `slash_count >= 3` flip, plus IDL surface +
  SDK + test coverage. ~ADR-124-cost order of magnitude.
- **Tie escrow size to required reputation OR required stake.** Cost:
  changes `create_escrow`'s acceptance shape — a high-`E` escrow
  rejects providers below a (governance-tunable) reputation or stake
  floor. Off-chain matchmaking changes shape. Benefit: directly
  defends the high-`E` boundary §"What the calibration does NOT
  defend against" calls out, by making `E > 3R + 3L` un-reachable
  for fresh-authority sybils (because they cannot accept the high-`E`
  escrow at all). Cost is ADR-bounded at the `create_escrow` site.
- **Make `MAX_DELTA_PER_CALL` and `SUSPEND_AT_SLASH_COUNT`
  governance-tunable via `ProtocolConfig`.** Cost: removes the
  compile-time pin; raises the bar on operator-error blast radius
  (a misconfigured ProtocolConfig update could disable suspension
  entirely if `SUSPEND_AT_SLASH_COUNT = 255`). Benefit: parameter
  changes ship without a program redeploy. Implementation cost:
  field additions to `ProtocolConfig` + `update_protocol_config`
  validation + AUD-202-style field-order pin. The lever is
  attractive operationally but pays a one-time on-chain governance-
  surface expansion that this launch deliberately does not take.

The launch decision is to take **none** of these levers today. Each
introduces a new on-chain surface (`assert_valid_profile` invariant
edits, new accounts, governance-tunable parameter additions); per
ADR-080 §H Alt-D's tested-rejection-path principle, each new surface
costs ~ADR-124-magnitude tests to ship safely. The expansion is
not justified by the current threat model.

### Re-calibration trigger

Re-open this ADR (or write a successor numbered ≥132) when ANY of:

- **Observed sybil-pattern incidents on mainnet exceed 5 per quarter
  in the first post-launch year, or 10 per quarter thereafter.**
  "Sybil-pattern incident" is defined as: an off-chain indexer
  detects ≥3 newly-registered authorities (no on-chain reputation
  history pre-registration) all participating in disputes within
  a 7-day window where the dispute outcome favored a counterparty
  also showing the same fresh-authority pattern. The threshold
  values are intentionally conservative — first-year mainnet has
  little operating history, so a low trigger preserves option-value
  on calibration tightening; year-two doubles the threshold to
  account for organic-fresh-authority churn that is not adversarial.
- **Median escrow value on mainnet exceeds 1 SOL (≈$150-200 USD)
  per task as a sustained 30-day rolling average.** The AUD-205
  inequality `E > 3R + 3L` is dominated by `R ≈ 0.011 SOL` at
  current rent rates; once median `E` is two orders of magnitude
  above `R`, sybil profitability ceases to depend on whether the
  attacker found a niche high-value task and starts depending on
  the median market. At that point the `R`-only floor is too weak
  and the minimum-stake lever (above) becomes the natural answer.
- **A funded sybil incident is forensically reconstructed where
  `E > 3R + 3L` was demonstrably reachable for the attacker.**
  This is the post-incident trigger; the calibration as shipped
  was bet against a particular threat model and the bet was
  empirically wrong. Re-opening the ADR is the post-mortem record.
- **A new dispute-resolution surface lands that emits `reason = 1`
  or `reason = 2` from a code path other than `resolve_dispute` /
  `expire_escrow` / governance suspension.** New slash-emitting
  paths change the operating point on this calibration without
  changing any of the constants — the analysis above must be
  re-run under the new emission shape. AUD-108's reason-code
  accept-list (`require!(reason <= 2, ...)`) is the gate that
  keeps the surface fixed; an ADR that bumps that gate triggers
  this re-open clause as a side effect.

## Consequences

- **Positive**: The calibration is now an auditable, named decision
  rather than an emergent property of three independently-chosen
  constants. A future engineer can trace the AUD-205 question
  forward to this ADR, see the inequality, see the levers, and pick
  up the trail without re-deriving any of the analysis. The
  re-calibration trigger gives ops a *concrete* condition to watch
  rather than the vague "if sybil becomes a problem" — the trigger
  values are conservative on purpose, biased toward early
  re-evaluation rather than late.
- **Negative**: This ADR is doc-only — it ships with zero defensive
  surface. If the threat model expands faster than the trigger
  conditions catch (e.g., a single high-`E` incident lands inside
  the 5-per-quarter window before the cumulative threshold trips),
  the calibration is exposed and the levers in §"Levers available"
  must be pulled under time pressure. Mitigated by the third
  trigger clause (post-incident forensic reconstruction is also
  a re-open trigger) but the mitigation is reactive, not preventive.
  The decision to bias toward "ship the launch with the current
  calibration; pull levers post-launch when triggered" is the
  ADR-080 §H Alt-D bet that on-chain-surface expansion under time
  pressure is more dangerous than calibration drift in the
  measurable threshold zone.
- **Follow-ups**: None today. The next action is operational:
  off-chain indexer plumbing must surface the §"Re-calibration
  trigger" metrics (sybil-pattern count, median escrow value) on
  the mainnet dashboard. That work is downstream of this ADR's
  acceptance and lives in the indexer / dashboard backlog, not in
  the on-chain protocol; it does not block the launch.

## Alternatives considered

- **Tune the constants now without an ADR (e.g., bump
  `SUSPEND_AT_SLASH_COUNT` to 5 "to be safe").** Rejected — the
  AUD-205 punchlist row classifies this as Architecture / calibration
  precisely to flag that constant-tuning without analysis is the
  wrong move. The launch parameters are a calibrated bet against
  a specific threat model; changing them without changing the
  threat model is just guessing in a different direction.
  Constant-tuning ALSO carries the AUD-001/002 invariant-update
  cost (assert_valid_profile pin) and the post-bump-migration cost
  for any pre-bump Suspended profiles, so even a "small" tune is
  not free at the test-coverage level.
- **Add the minimum-stake-at-registration lever now as belt-and-
  suspenders.** Rejected for the launch window — the lever is
  enumerated in §"Levers available" with its full cost, and the
  cost (~ADR-124 magnitude in tests + new account + Settlement-
  side slash CPI) is not justified by the current threat model.
  The trigger conditions in this ADR are the falsifiable claim
  that the lever is not needed today; if a trigger fires, that
  lever is the natural successor.
- **Write this as a `Reserved` ADR (per ADR-130's pattern) and
  defer ratification.** Rejected — `Reserved` is for decisions the
  protocol genuinely cannot make today (because the trigger has
  not landed and the answer would be premature). AUD-205 is
  different: the audit asked a calibration question and the
  decision *is* that the current bounds hold for the launch
  threat model. That's an actual decision (`Accepted`), not a
  hold (`Reserved`). Conflating the two would weaken the ADR
  corpus's status taxonomy.
- **Document the analysis inline in `lib.rs` doc-comments only.**
  Rejected — the analysis is governance-shaped (threat-model
  boundary, lever cost catalog, re-calibration trigger), not
  implementation-shaped (what the code does and why this line
  is here). Inline doc-comments are the right home for the
  `MAX_DELTA_PER_CALL = 10` mechanical justification; the
  decision to set it to 10 specifically (versus 5 or 20) at
  this point in the protocol's lifecycle is ADR-shaped. Both
  homes are warranted; this ADR captures the second.

## References

- `docs/audits/CYCLE-3-ONCHAIN-PUNCHLIST.md` — AUD-205 punchlist
  row (Architecture / calibration); the inequality `escrow > 3×
  rent + 3× per-loss opportunity-cost` is captured verbatim above.
- `docs/adr/ADR-028-anti-sybil-defense.md` — original anti-sybil
  decision (`MIN_ESCROW_AMOUNT`, self-dealing prohibition, opt-in
  reputation staking). This ADR is a calibration update, not a
  supersede; ADR-028 still owns the policy shape, this ADR owns
  the parameter analysis.
- `docs/adr/ADR-097-registration-nonce-sybil-resistance.md` —
  PDA-uniqueness defense against close-then-reopen authority
  reuse. Raises the cost of authority reuse to "register a new
  keypair", which is the floor `R` in the AUD-205 inequality.
- `docs/adr/ADR-094-reputation-trust-hierarchy-inversion.md` —
  the policy-owner ADR for Registry-side reputation. Defines
  why the `[0, 100]` clamp and `MAX_DELTA_PER_CALL` live in
  Registry rather than Settlement.
- `docs/adr/ADR-075-protocol-config-delta-bounds.md` — Settlement-
  side delta-bounds enforcement (`MIN_REPUTATION_DELTA`,
  `MAX_REPUTATION_DELTA`); the upstream pin that ADR-094's
  Registry-side accept-list mirrors.
- `docs/adr/ADR-001-cpi-caller-verification.md`, ADR-068 (registry-
  reputation CPI trust boundary) — the CPI-trust shape that
  makes Registry's `propose_reputation_delta` the *only* path
  that increments `slash_count`, and therefore the only path
  this calibration analysis applies to.
- `programs/agent-registry/src/lib.rs:17,21,322-325,358-359` —
  the source-of-truth constants and slash-suspension predicate.
- `programs/agent-registry/src/state.rs:83-85,197-201` — the
  `__padding_aud007` block (where the audit pointed for the
  slash-state context) and the `assert_valid_profile`
  Suspended-invariant pin.
- `programs/settlement/src/state.rs:28,117` — `MIN_ESCROW_AMOUNT`,
  the protocol-side escrow floor that prices `L` in the AUD-205
  inequality.
