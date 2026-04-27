# ADR-125: `rotate_protocol_config_authority` Instruction (AUD-115 architectural complement)

## Status

Proposed

## Date

2026-04-26

## Context

Cycle-2 audit AUD-115
(`docs/audits/ARCHITECTURE-AUDIT-2026-04-26-onchain.md` row 53) observed
that **`ProtocolConfig.authority` is operationally equal to the
Settlement program's upgrade authority** for the entire post-init
lifetime of the deployment. The original AUD-005 design
(`docs/audits/DESIGN-DECISIONS-2026-04-25.md` §"AUD-005") chose
**Option C**: gate `initialize_protocol_config` to the upgrade authority
via the BPF Upgradeable Loader's `ProgramData`, then declare
`ProtocolConfig.authority` "fully independent of the upgrade authority"
post-init. The independence is asserted at the contexts layer
(`programs/settlement/src/contexts.rs:580-624`) — no other instruction
in the Settlement program references `ProgramData` — but no instruction
exists today to **change** `ProtocolConfig.authority` to a key different
from the one that signed `initialize_protocol_config`. The
`update_protocol_config` handler
(`programs/settlement/src/instructions/protocol_config.rs:57-122`)
mutates every tunable scalar except the `authority` field itself.

AUD-115 explicitly allowed two closure paths: (a) document the
entanglement in an operator-facing runbook, or (b) add a
`rotate_protocol_config_authority` instruction to the deploy
choreography "that immediately moves the authority away from the
upgrade key." The 2026-04-26 cycle-2 closure took path (a), landed in
two stages:

  1. Inline doc-comment at
     `programs/agent-registry/src/lib.rs:744-754` (commit `f77d244`),
     pinning the operational equality at the source-of-truth surface
     (the only handler that gates on `ProtocolConfig.authority`).
  2. Standalone operator runbook
     `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` (commit `7cb4415`),
     surfacing the entanglement and recovery paths to the multisig
     ceremony operator.

Path (b) — the rotation instruction itself — was deferred. This ADR is
where path (b) is decided **for or against** before the first
`v*-mainnet` tag.

### What changes if rotation ships pre-mainnet

The instruction unlocks three operations that today either are
impossible or require a redeploy at a new program ID: (1) migrating
governance to a *different* multisig PDA — Squads-internal membership
or threshold mutation already keeps the PDA constant per
`docs/PROTOCOL_AUTHORITY_OPERATIONS.md` §4 row 3; (2) closing a
post-launch divergence where `solana program set-upgrade-authority`
moves the bytecode-push role but leaves `ProtocolConfig.authority`
on the old key (runbook §2 row 4 + §6 bullet 1); (3) in-place recovery
from the first two `initialize_protocol_config` mis-bind rows in the
runbook §4 failure-modes table (deployer-keypair bind, typo'd PDA
bind), which are otherwise redeploy-only.

It does **not** affect: A2's Squads-internal threshold/member rotation
(those don't change the PDA); the C4 runbook §3 pre-bind checklist
(rotation is a recovery tool, not a pre-bind safeguard); or the BPF
Loader upgrade-authority surface (rotated via
`solana program set-upgrade-authority` per ADR-080, independent of
this ix).

## Decision

**Defer the rotation instruction to the first post-launch governance
cycle. Adopt Option δ for the mainnet launch window.** When rotation
ships, it MUST take the shape of Option β (2-step propose-then-accept).
Options α and γ are rejected for the reasons in §"Options Considered"
below.

The deferral rests on three load-bearing facts established in the C4
runbook + the A2 plan:

  1. **A2 already collapses the "rotate away from a weak key" use
     case.** AUD-115's recommendation text — "rotate the authority
     away from the upgrade key" — presupposes a single-key upgrade
     authority that is operationally inferior to the rotation
     target. Post-A2, the upgrade authority *is* the Squads multisig
     PDA. There is no stronger key to rotate to; rotating the
     `ProtocolConfig.authority` to "the same multisig but called
     by a different name" buys nothing.
  2. **Squads-internal mutation covers the normal-operation
     governance changes.** Membership rotation, threshold change,
     even total turnover of the signer set are all in-place
     operations on the multisig that leave the PDA constant
     (`docs/PROTOCOL_AUTHORITY_OPERATIONS.md` §4 rows 3-4). The
     remaining "I need a different PDA" use case is rare and
     non-launch-blocking; it can wait for a designed,
     audited rotation ix.
  3. **Adding a new on-chain governance surface during the launch
     window is high-risk per ADR-080's framing.** ADR-080 §1
     positions every gated mainnet surface as something that must
     have a tested rejection path
     (`docs/adr/ADR-080-mainnet-deploy-safety-mandates.md` §H Alt-D
     codifies the same principle for the hash gate). A new
     instruction would need: a context, a constraint, an event, two
     error variants, off-chain SDK + mcp-server wiring, and at
     minimum 4 on-chain integration tests + matching SDK/mcp-server
     test surfaces (cf. ADR-124's cycle-3 implementation cost: 37
     tests across 4 surfaces). That is roughly the same surface area
     as ADR-124, and ADR-124 was a directly compromise-defending
     change. Rotation, as established above, is not.

The deferral is **explicit**, not silent: this ADR is the auditable
record that the path-(b) option from AUD-115 was considered for the
launch window and rejected with reasons. The C4 runbook §6 ("What
does NOT exist today") will be updated to reference this ADR as the
authoritative deferral decision rather than carrying a generic
"no ADR number assigned yet" footnote.

## Options Considered

### Option α — 1-step rotation (REJECTED for post-launch)

`rotate_protocol_config_authority(ctx, new_authority: Pubkey)`. Current
authority signs; field updates atomically. Minimum surface (~30 LoC,
one ix, one event, one error). **Rejected** because a fat-fingered
`new_authority` (typo'd base58, wrong derivation) instantly transfers
governance to an unrecoverable address. The C4 runbook §4 row 2
already documents this exact failure mode for the *initial* bind; α
would extend it to every subsequent rotation, with no on-chain step
where the new authority proves key control.

### Option β — 2-step propose-then-accept (RECOMMENDED for post-launch)

Two instructions backed by an inline `pending_authority: Option<Pubkey>`
field on `ProtocolConfig` (or a dedicated PDA):
`propose_protocol_config_authority_rotation(new_authority)` signed by
the current authority writes the proposal;
`accept_protocol_config_authority_rotation()` signed by
`new_authority` promotes itself. Mirrors Solana's
program-upgrade-authority transfer pattern (the default `solana program
set-upgrade-authority` is two-step for exactly this reason — the
`--skip-new-upgrade-authority-signer-check` variant is the *unsafe*
one). The new authority must sign accept, which closes the typo'd-PDA
window completely. Cost vs α: one extra ix, ~50 extra LoC, marginally
more ceremony for the rare *intentional* rotations C4 §4 row 1
actually targets — trivial relative to the blast radius of an α typo.

### Option γ — Time-locked rotation (REJECTED)

Same as β plus a 24h delay enforced by
`Clock::get()?.unix_timestamp >= proposed_at + 86400`. **Rejected**
because the threat γ defends against — a compromised signer racing to
lock out legitimate maintainers — already requires the attacker to
control the multisig threshold of the current
`ProtocolConfig.authority`. Per A2, that authority is a 3-of-N Squads
multisig; an attacker with the threshold already has full governance
(can call `update_protocol_config` to break invariants, sign program
upgrades). A 24h time-lock on *one* of those operations does not
materially change blast radius. The multisig threshold *is* the
rate-limit on hostile rotations. γ would be the right design for a
single-key authority and is the wrong design for a multisig one.

### Option δ — Status quo (RECOMMENDED for the launch window)

No rotation instruction. `ProtocolConfig.authority` is permanently
bound to whichever key signs `initialize_protocol_config` for the
lifetime of the deployment; changing it requires redeploying at a new
program ID. **Recommended for launch** because: AUD-115 explicitly
allowed this closure path (a); the operational risk is quantified by
the C4 runbook §4 failure-modes table; and the alternative (shipping β
pre-mainnet) trades a low-probability future-recovery benefit for a
high-probability "new attack surface in the launch window" risk.
ADR-080 §H Alt-D's "every gated surface needs a tested rejection
path" principle is much cheaper to satisfy when the surface exists
than when we are racing to ship it. **Cost**: the §4 failure-modes
table's "not recoverable" rows stay not-recoverable until β ships;
if A2's multisig PDA needs replacement (rather than internal
mutation) before β ships, the recovery path is a redeploy at a new
program ID.

## Consequences

### Positive

  - **AUD-115's path-(b) deferral is now auditable.** Future cycles
    can diff against this ADR rather than re-deriving the rationale
    from the audit row + C4 runbook + A2 ceremony notes.
  - **Pre-mainnet on-chain surface is unchanged.** No new
    instruction, no new context, no new event, no new error
    variant. The `mainnet-readiness.yml` gate
    (`docs/adr/ADR-122-mainnet-readiness-ci-gate.md`) does not need
    a new test category for ADR-125 surface.
  - **Post-launch governance migration has a designed shape.**
    When the rotation instruction is needed, β is the chosen
    shape — implementation work does not need to re-litigate the
    α / β / γ tradeoff.

### Negative

  - **The `initialize_protocol_config` ceremony remains a one-way
    door for the launch window.** A mis-bound multisig PDA at init
    time is recoverable only via redeploy at a new program ID per
    `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` §4 row 2. The C4
    runbook §3 checklist is the only mitigation.
  - **The post-launch governance-migration path requires a future
    audited cycle.** β's implementation will need to repeat the
    ADR-124 cycle (proposal → audit context → implementation →
    test suite across all surfaces). Estimated work: ~100 LoC
    on-chain, ~50 LoC SDK + mcp-server wrapping, ~10-15 tests
    across 4 surfaces.

### Neutral

  - The C4 runbook will be amended in a separate (small) PR to
    point its §6 "What does NOT exist today" bullet at this ADR
    as the authoritative deferral record. No content rewrite — the
    runbook's operational guidance is unchanged by this ADR.

## On-chain surface (informational, for the future β implementation)

The recommendation above is δ-for-launch + β-when-shipped. The β shape
below is **non-binding** — sketched so the future cycle's implementer
inherits the decision rather than re-litigating it. Cite this section
in the eventual implementation PR; do not treat it as a spec.

  - **Two instructions on the settlement program**:
    `propose_protocol_config_authority_rotation(new_authority: Pubkey)`
    gated by `has_one = authority` (mirrors the existing
    `UpdateProtocolConfig` gate at
    `programs/settlement/src/contexts.rs:629-639`); and
    `accept_protocol_config_authority_rotation()` gated by
    `pending_authority == Some(new_authority.key())`. A third
    `cancel_*` ix reuses the `UpdateProtocolConfig` authority gate.
  - **State extension**: add `pending_authority: Option<Pubkey>` to
    `ProtocolConfig` (`programs/settlement/src/state.rs:154-165`);
    bump `ProtocolConfig::SPACE`; initialize to `None` in
    `initialize_protocol_config`. Existing on-chain accounts need
    a realloc + versioned-load helper — design out of scope here.
  - **Error variants** on `SettlementError`: `NoPendingRotation`
    (accept/cancel with no proposal), `NoPendingRotationForCaller`
    (proposal exists but for a different key),
    `RotationAlreadyPending` (propose called while one is in
    flight).
  - **Events**: `ProtocolConfigAuthorityRotationProposed`,
    `…Accepted`, `…Cancelled` — same shape as
    `ProtocolConfigUpdated` (`programs/settlement/src/events.rs`).
  - **Test surface (estimate, mirrors ADR-124's 4-package
    pattern)**: 4 Rust-unit predicate tests; 5+ on-chain TS
    integration tests at `tests/settlement.ts` (happy path +
    wrong-signer-at-propose + wrong-signer-at-accept +
    accept-without-propose + propose-while-pending); 2 SDK
    typed-wrapper tests; 2 mcp-server action/tool tests behind
    a new capability (e.g. `gov:authority:rotate`).

## References

  - `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-onchain.md` — AUD-115
    finding (row 53) + closure-status row (row 116). Path-(a)
    closed via inline doc + C4 runbook; this ADR is the explicit
    deferral of path-(b).
  - `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` (commit `7cb4415`) — C4
    operator runbook. §4 failure-modes table + §6 "What does NOT
    exist today" are the operational baseline the δ recommendation
    rests on.
  - `docs/audits/DESIGN-DECISIONS-2026-04-25.md` §"AUD-005" —
    Option-C decision: `ProtocolConfig.authority` is independent of
    the upgrade authority "after init"; no future ix references
    `ProgramData`. ADR-125 preserves both invariants.
  - `programs/agent-registry/src/lib.rs:744-754` (commit `f77d244`)
    — inline AUD-115 doc-comment at `verify_protocol_invariants`;
    names `rotate_protocol_config_authority` as the future
    architectural complement.
  - `programs/settlement/src/contexts.rs:580-624` and
    `programs/settlement/src/instructions/protocol_config.rs:16,57`
    — current `InitializeProtocolConfig` / `UpdateProtocolConfig`
    surfaces that β would extend.
  - `docs/adr/ADR-080-mainnet-deploy-safety-mandates.md` §1 + §H
    Alt-D — "every gated surface must have a tested rejection path."
  - `docs/adr/ADR-124-vault-agent-identity-proof-of-control.md` —
    cycle-3 on-chain surface cost reference (37 tests across 4
    packages); the order-of-magnitude basis for β's estimate.
  - `docs/PRE_MAINNET_ROADMAP.md` §A2 + §8 — Squads multisig
    provisioning; this ADR closes the §8 open question as "δ for
    launch, β post-launch."
