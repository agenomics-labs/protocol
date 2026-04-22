# ADR-074: Settlement-authority `address =` assertion across all four Settlement CPI contexts

## Status
Proposed

## Date
2026-04-22

## Context

DEEP-AUDIT-2026-04-22.md Audit 1 finding **SEC-8 (HIGH)** identified a belt-and-braces gap in Settlement's CPI contexts.

`programs/settlement/src/contexts.rs` defines four contexts that CPI into Registry's `UpdateReputation`: `ApproveMilestone`, `ExpireEscrow`, `ResolveDispute`, `ResolveDisputeTimeout` — with `settlement_authority` accounts defined at lines 164-168, 263-265, 318-320, and 408-410 respectively.

Each `settlement_authority` is a PDA bound by `seeds = [b"settlement-authority"], bump`. The seeds derivation implicitly uses the calling program's ID (the Settlement program ID), which is correct today. Anchor's constraint framework does NOT additionally assert `settlement_authority.key() == <derived-pubkey>` via an explicit `address = ...` constraint — the seed derivation alone is the gate.

Meanwhile, the Registry's `UpdateReputation` context (`registry/contexts.rs:78-84`) validates the incoming signer via `seeds::program = SETTLEMENT_PROGRAM_ID`. If a future Settlement program upgrade silently changes the seed derivation (e.g., a developer renames the seed constant from `b"settlement-authority"` to `b"settlement-auth"` as a cosmetic refactor), the Settlement side will continue to derive and pass a PDA, but the Registry side will reject it — breaking the CPI. More perniciously, if the seed change is paired with a Registry-side update that also accepts the new seed, but without updating both programs atomically, there is a narrow window where cross-program trust silently desyncs and reputation CPIs fail.

Today this is latent — no such refactor has happened. The audit classifies it as HIGH because it is a future-upgrade trap, and because Anchor's `address = <derived>` annotation is the idiomatic defense against exactly this class of bug: it forces the derived address to match a compile-time expectation, so any seed change fails at compile-review rather than at runtime.

## Decision

Add `address = <derived>` constraints on `settlement_authority` in all four Settlement CPI contexts. The derived address is computed at compile-time from the seed + bump via Anchor's constant-folding or, if Anchor's macro does not support this directly, via a `pub const SETTLEMENT_AUTHORITY_ADDRESS: Pubkey = ...` constant committed to `state.rs` or `contexts.rs` and referenced from the annotation.

**Concrete per-context change** (applied identically at all four call sites):

```
settlement_authority: UncheckedAccount<'info>,
// Add:
#[account(
    seeds = [b"settlement-authority"],
    bump,
    address = SETTLEMENT_AUTHORITY_ADDRESS,
)]
```

(No code in this ADR per scope rules — this is indicative of the pattern, not final syntax.)

The `SETTLEMENT_AUTHORITY_ADDRESS` constant is computed once at program boot (or, preferably, at compile time via a `pub const` expression if Anchor's PDA derivation supports `const fn`). The value is published in the Settlement program's IDL and is the canonical Settlement-authority address that Registry's `UpdateReputation` expects.

**Pair with ADR-068**: ADR-068 hardens the Registry side of the same CPI path. ADR-074 hardens the Settlement side. Together they eliminate both the attacker-facing (ADR-068) and the maintainer-facing (this ADR) failure modes of the Settlement→Registry trust edge.

**Program changes**: `programs/settlement` only.

**Tests to add** (under `tests/settlement/`):

- Compile-time: attempt to change the `b"settlement-authority"` seed constant to something else in a test harness → compilation fails (or at runtime, the `address` assertion rejects) because the derived PDA no longer matches `SETTLEMENT_AUTHORITY_ADDRESS`.
- Integration: each of the four CPI call sites succeeds with the correct seed and fails with a mock mis-seeded PDA — confirms the assertion is wired at all four sites.
- Regression: existing Settlement-happy-path tests remain green; the assertion is purely additive.

**Deployment**: program upgrade required. **Multisig signing required** per ADR-031. Ideally bundled into the same upgrade as ADR-068 so the Registry/Settlement trust edge is hardened in one coordinated deploy.

## Alternatives Considered

- **Do nothing — the seed derivation is already correct.** Rejected — the whole point of `address = <derived>` is defense-in-depth against future refactors. The idiom exists because seed derivation is the most common silent-desync vector in Anchor multi-program systems.
- **Pull `SETTLEMENT_AUTHORITY_ADDRESS` as a runtime-computed value rather than a compile-time constant.** Rejected — runtime computation defeats the whole point. The assertion must fail at compile/IDL-publish time, not at tx-submit time, to catch the refactor before deploy.
- **Add the assertion only to the two most-used call sites (`approve_milestone`, `resolve_dispute`) and defer the other two.** Rejected — asymmetric protection is a classic future-maintainer trap. Any tech-debt pass that normalizes the four contexts would likely notice the asymmetry and remove it in one direction or the other; adding it consistently at all four sites now avoids the cleanup later.

## Consequences

**Positive**: catches any future Settlement-side seed refactor at compile / IDL-publish time, preventing silent CPI desync with Registry. Zero runtime cost — the `address` assertion compiles to a single Pubkey equality check that Anchor already performs in the constraint layer.

**Negative**: one additional `pub const` in `programs/settlement` that must be kept in sync with the seed. If a future developer intentionally changes the seed (valid case — e.g., a new `settlement-authority-v2` PDA during a migration), they must also update the constant. This is the desired friction: the change is visible and requires explicit intent.

**Migration path**: one program upgrade. Pure additive constraint — no existing caller pattern fails post-upgrade because the derived PDA today already equals the constant's value. Zero data migration. Devnet rehearsal required (GOV-6). If bundled with ADR-068, the upgrade window is a single Settlement+Registry two-program atomic deploy; if shipped separately, it can land before or after ADR-068 without ordering constraints — they are orthogonal.

## References
- `docs/adr/DEEP-AUDIT-2026-04-22.md` — Audit 1, finding SEC-8
- `docs/adr/ADR-068-registry-reputation-cpi-trust-boundary.md` — paired Registry-side hardening
- `docs/adr/ADR-007-settlement-cpi-pattern.md` — original Settlement CPI pattern
- `docs/adr/ADR-014-cpi-discriminator-verification.md` — related CPI trust hardening
- `programs/settlement/src/contexts.rs:164-168, 263-265, 318-320, 408-410`
- `programs/agent-registry/src/contexts.rs:78-84`
