# ADR-094 — Reputation Trust Hierarchy Inversion

## Status

Accepted

## Date

2026-04-23

**Supersedes:** —
**Related:** ADR-039, ADR-068, ADR-075

## Context

Settlement currently calls Registry via CPI as a privileged setter to update
reputation scores directly via `update_reputation(delta: i64, ...)`. This
inverts the natural ownership: Registry owns the `AgentProfile` state and
therefore should own and enforce reputation policy. Under the current model:

- Settlement decides what the valid delta range is.
- Settlement decides what the valid score range is (it doesn't — there is no
  range check; scores grow unbounded beyond 100).
- Registry is a passive data store that accepts whatever Settlement sends.

The correct architecture: Registry owns and enforces reputation policy
(valid score range `[0, 100]`, maximum absolute delta per call). Settlement
proposes deltas; Registry validates and applies them.

The existing `update_reputation` instruction (the direct-setter path used by
Settlement) has no score upper bound. `AgentProfile.reputation_score` is
`u64`, so a positive delta stream can inflate it arbitrarily. Any future
reputation consumer (governance, slashing circuits, capability gating) must
either trust the unbounded value or independently re-clamp it.

## Decision

1. **Registry exposes `propose_reputation_delta(delta: i16, reason: u8)`**.
   Only the Settlement program ID is authorized to call it via CPI (enforced
   via a signed `settlement_authority` PDA, matching the existing SEC-1
   pattern from ADR-068).

2. **Registry validates**:
   - `delta.abs() <= MAX_DELTA_PER_CALL` (= 10 per call).
   - `new_score` is clamped to `[0, MAX_REPUTATION_SCORE]` (= 100) — never
     panics, never overflows, never produces a value outside the band.

3. **Settlement removes direct reputation field mutation.** The `cpi.rs`
   module is updated with a TODO referencing this ADR. Full CPI re-wiring
   (new account struct, new instruction call) is deferred to a follow-up
   because it touches the Settlement contexts and requires adding the new
   account to every caller site — more than 50 lines across files. The
   direct `update_reputation` path remains callable in the interim to avoid
   a breaking gap.

4. **The existing `update_reputation` instruction in Registry is deprecated**
   (retained for migration continuity; a follow-up ADR will gate it to
   upgrade authority only once Settlement has been migrated to the new
   `propose_reputation_delta` path).

## Constants

```rust
pub const MAX_REPUTATION_SCORE: u8 = 100;
pub const MAX_DELTA_PER_CALL: i16 = 10;
```

## New Instruction: `propose_reputation_delta`

```
Accounts:
  authority          UncheckedAccount  — external PDA seed anchor (agent owner)
  agent_profile      Account<AgentProfile>  — mut, seeded by authority
  settlement_authority  UncheckedAccount  — must sign, seeded by Settlement program

Parameters:
  delta: i16    — signed reputation change; |delta| <= MAX_DELTA_PER_CALL
  reason: u8    — caller-supplied reason code (0 = task_completed,
                   1 = dispute_loss, 2 = expiry_undelivered)
```

Validation order:
1. `delta.abs() as i16 <= MAX_DELTA_PER_CALL` — reject oversized deltas.
2. Saturating-clamp: `new_score = (current_score as i16 + delta).clamp(0, MAX_REPUTATION_SCORE as i16) as u8`.

Emits `ReputationDeltaProposed` event.

## Reason Codes

| Value | Meaning |
|-------|---------|
| 0 | Task completed — positive delta |
| 1 | Dispute loss — negative delta |
| 2 | Expiry undelivered — negative delta |
| 3-255 | Reserved for future governance/slashing sources |

## Alternatives

- **Keep Settlement as unconstrained setter**: simpler short-term but Registry
  can never enforce invariants; reputation scores grow unbounded.
- **Use an on-chain oracle or governance vote per update**: over-engineered
  for v1 where the only reputation source is Settlement.
- **Clamp in Settlement before calling Registry**: still leaves Registry with
  no self-enforced invariants; any future caller bypasses the policy.

## Consequences

### Positive

- Registry becomes the single source of reputation truth and can enforce
  `[0, 100]` invariant at the program boundary.
- Settlement no longer needs to know the valid score range or delta cap.
- Any future reputation source (governance slashing, cross-program hooks)
  goes through the same Registry gate and inherits the same invariants
  without code changes.
- `MAX_DELTA_PER_CALL = 10` makes large reputation manipulation require many
  transactions, improving observability and reducing flash-manipulation risk.
- Score type can eventually be narrowed to `u8` in a future migration
  (currently `u64` for backward compatibility).

### Negative / Trade-offs

- Full Settlement CPI migration requires a follow-up pass (account struct
  changes, new instruction wiring).
- The deprecated `update_reputation` path remains active until the migration
  is complete, so the trust-inversion is not fully enforced on-chain yet.
- `MAX_DELTA_PER_CALL = 10` means Settlement must call multiple times if
  governance ever allows larger single-event deltas (mitigation: raise the
  cap via a future ADR).

## Migration Path

1. (This ADR) Introduce `propose_reputation_delta` with full validation.
2. (Follow-up) Update Settlement's `cpi.rs` and all caller contexts to call
   `propose_reputation_delta` instead of `update_reputation`.
3. (Follow-up) Gate `update_reputation` to upgrade-authority-only.
4. (Future) Remove `update_reputation` entirely after mainnet migration
   is confirmed clean.

## References

- Architecture Audit 2026-04-23, Item 19, Arch §1.1
- ADR-039: Wire slashing / unstake (introduced `reputation_delta` parameter)
- ADR-068: Registry reputation CPI trust boundary (SEC-1 settlement_authority PDA)
- ADR-075: Protocol config delta bounds (SEC-11 i64::MIN negation overflow)
