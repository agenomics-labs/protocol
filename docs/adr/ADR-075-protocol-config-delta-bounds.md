# ADR-075: Protocol-config reputation-delta bounds and `checked_neg()` safety

## Status
Accepted

## Date
2026-04-22

## Context

DEEP-AUDIT-2026-04-22.md Audit 1 finding **SEC-11 (MEDIUM)** identified a panic/brick vector in `programs/agent-registry`.

`programs/agent-registry/src/lib.rs:127-130` casts a signed reputation delta via `(-reputation_delta) as u64`. If `reputation_delta == i64::MIN`, Rust's `-` operator overflows because `i64::MIN`'s absolute value exceeds `i64::MAX`. In release mode, integer-overflow wrapping masks the panic but produces garbage (`-i64::MIN == i64::MIN` in two's-complement wrapping), which then casts to a huge `u64` and corrupts the saturating-sub downstream. In debug mode, the unary negation panics outright.

The `update_protocol_config` instruction validates governance-set deltas only against `v <= 0` (per the audit's reading of the code). `i64::MIN` passes that check — it is indeed `<= 0`. A compromised `protocol_config` authority (itself a multisig in the ADR-031 governance model, but nothing algorithmic in the Registry program prevents the value) can set `reputation_delta_dispute_loss = i64::MIN`. Every subsequent dispute loss triggers the Registry panic, the CPI fails, Settlement's dispute path breaks.

**Blast radius**: a malicious `protocol_config` authority can brick all reputation slashing — dispute losers never lose reputation, anti-sybil defense (ADR-028) degrades to no-op. A compromised authority with narrower intent can tune the delta to a just-barely-safe-but-functionally-useless value (e.g., `-1_000_000_000_000_000` — causes every slash to saturate to zero, preserving on-chain-safe behavior but still defeating the economic model).

The audit mitigation has two parts: (1) bound protocol-config deltas to a sane range (`v >= -1_000_000`) in `update_protocol_config`, and (2) use `checked_neg()` at the cast site in `lib.rs:127-130` so an out-of-range value fails the instruction rather than silently wrapping.

## Decision

Two-part fix in `programs/agent-registry`:

**Part 1 — `update_protocol_config` validation**: amend the instruction to enforce explicit bounds on all reputation-delta fields:

- `reputation_delta_dispute_loss`: must satisfy `-1_000_000 <= v <= 0`.
- `reputation_delta_dispute_win`: must satisfy `0 <= v <= 1_000_000`.
- `reputation_delta_milestone_approval`: must satisfy `0 <= v <= 100_000`.
- Any other `i64` delta field gets a symmetric `±1_000_000` bound unless there is a documented reason to pick a different ceiling.

The `1_000_000` ceiling is chosen because the Registry's reputation score is capped at 10000 (per ADR-020), so any single delta that would move score by more than 100x the cap is definitionally a misconfiguration. The bound is generous enough to accommodate future governance adjustments without re-upgrading the program. Out-of-bounds values fail the instruction with a new error `ReputationDeltaOutOfRange`.

**Part 2 — `checked_neg()` at the cast site**: rewrite `lib.rs:127-130` so the sign flip uses `i64::checked_neg`, and the cast handles the `None` case by failing the instruction (not saturating, not wrapping). Specifically: the handler resolves `delta.checked_neg().ok_or(Error::DeltaOverflow)? as u64` instead of the current unchecked `(-reputation_delta) as u64`. The `DeltaOverflow` error is distinct from `ReputationDeltaOutOfRange` because it signifies a different failure class — an already-stored config value triggering the bug at apply time, not a new config being rejected at set time.

Both parts land together so that (a) new config values can never be bad, and (b) existing config values that are already bad (from pre-fix state) fail cleanly rather than panic.

**Program changes**: `programs/agent-registry` only.

**Tests to add** (under `tests/registry/`):

- `update_protocol_config` rejects `i64::MIN` → `ReputationDeltaOutOfRange`.
- `update_protocol_config` rejects `-1_000_001` (just below the bound).
- `update_protocol_config` accepts `-1_000_000` and `0` at the boundaries.
- Historical-state regression: manually inject `reputation_delta_dispute_loss = i64::MIN` via test helper (simulating pre-fix state), then call a dispute-loss path → MUST fail with `DeltaOverflow`, not panic.
- Golden-vector test: `reputation_delta_dispute_loss = -50` + `reputation_score = 100` → post-delta score = 50, confirming `checked_neg` + saturating-sub produce identical results to the previous happy-path code.

**Deployment**: program upgrade required. **Multisig signing required** per ADR-031.

## Alternatives Considered

- **Use `saturating_neg()` instead of `checked_neg()`.** Rejected — `i64::MIN.saturating_neg() == i64::MAX`, which would then cast to a huge positive `u64` and over-deduct the victim's score. Fails loudly is better than silently corrupts state.
- **Only bound the config, skip the `checked_neg` at the cast site.** Rejected — if a pre-fix config already contains `i64::MIN`, the bound on new writes doesn't help; the cast site must also be safe. Defense-in-depth.
- **Switch to `i128` internally to avoid the overflow entirely.** Rejected — over-engineered for a range check that solves the problem directly. Also complicates the on-chain account layout for a derivative benefit.
- **Pick a much tighter bound (e.g., `-1000`).** Rejected — too restrictive for future governance tuning; the audit explicitly suggests `-1_000_000` as a sane range.

## Consequences

**Positive**: eliminates the `i64::MIN` brick vector; bounds governance-set deltas to a range that cannot produce absurd on-chain behavior; makes `update_protocol_config` validation legible and auditable.

**Negative**: `update_protocol_config` gains validation that may reject values a future governance proposal intends (if someone legitimately wants a `-10_000_000` delta, they hit the bound). Mitigation: the bound itself is a `pub const` that can be raised in a subsequent program upgrade if governance surfaces a real need.

**Migration path**: one program upgrade. If any existing `protocol_config` account on devnet has an out-of-range value (unlikely — no operator has set one to `i64::MIN` intentionally), the `checked_neg` path will fail the instruction the next time it fires. Recovery: a new `update_protocol_config` call with an in-range value, signed by the governance authority. Devnet rehearsal required (GOV-6); as part of the rehearsal, confirm no existing devnet `protocol_config` has a value that would trigger `DeltaOverflow` post-upgrade. Zero data migration.

## References
- `docs/adr/DEEP-AUDIT-2026-04-22.md` — Audit 1, finding SEC-11
- `docs/adr/ADR-020-reputation-staking.md` — reputation score cap (10000) rationale
- `docs/adr/ADR-028-anti-sybil-defense.md` — economic model backing reputation deltas
- `programs/agent-registry/src/lib.rs:127-130` (cast site), `update_protocol_config` handler

## Revisions

- 2026-04-25 — Status flipped Proposed → Accepted. The audit caught the Status
  field lying: the enforcement actually shipped. The bounded delta validation
  is live at `programs/settlement/src/instructions/protocol_config.rs:84-99`,
  and the `checked_neg()` cast-site fix is live at
  `programs/agent-registry/src/lib.rs:170`. Audit reference: AUD-2026-04-25,
  drift matrix §3.
