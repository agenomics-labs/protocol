# Cycle 4 — On-chain Rust Punchlist (2026-04-29)

Hostile re-audit of the post-cycle-3 on-chain corpus
(`programs/{agent-vault,agent-registry,settlement}/src/**`) against HEAD
`cd233dc`. Each cycle-3 closure was re-walked under adversarial assumptions:
the closure footnote was treated as a claim, then chased through to the
source-of-record at HEAD and re-evaluated for adjacent, symmetric, or
asymmetric gaps. The mindset is the same one that produced AUD-200 and
MCP-320 in cycle-3 — assume the attacker has full source access and is
hunting for the gap the closure forgot to close.

## Source

- Audit: cycle-4 hostile re-audit (security-auditor agent, 2026-04-29)
- Cycle-3 baseline: `docs/audits/CYCLE-3-ONCHAIN-PUNCHLIST.md`
- Closeouts re-verified: AUD-200 (rotation proof-of-control), AUD-201 (cancel-active), AUD-202 (`ProtocolConfig` field-order), AUD-203 (seeds parity), AUD-205 (sybil cost calibration ADR-131), AUD-206 (retired profile rejection)

## Severity tally

| Critical | High | Medium | Low |
|---|---|---|---|
| 0 | 0 | 0 | 0 |

## Findings

*No new findings; cycle-3 closures verified under adversarial review.*

### Verification trail (what was probed and held)

The following closures were chased to the source-of-record at HEAD `cd233dc`
and re-evaluated for adversarial bypasses. Each held.

- **AUD-200 (rotation proof-of-control)** —
  `programs/agent-vault/src/instructions.rs:262-278` and
  `programs/agent-vault/src/contexts.rs:120-150`. The rotation handler
  calls `crate::identity_bind::verify_ed25519_precompile` BEFORE the rate-
  limit check. Confirmed: a rejected proof leaves `last_rotation_at`
  untouched (CEI ordering), the same `vault_identity_bind_message` domain
  tag is shared with `initialize_vault`, and the precompile-introspection
  comparison binds `(authority, new_agent_identity)` symmetrically with
  init. Replay across surfaces is closed by the fact that both surfaces
  bind the same tuple; rotation cannot reuse an init-leg signature for a
  different `new_agent_identity` because the message hash diverges. No
  asymmetric gap.

- **AUD-201 (stuck-Active mutual rescission)** —
  `programs/settlement/src/instructions/escrow.rs:453-517` and
  `programs/settlement/src/contexts.rs:494-538`. Confirmed: dual signer
  binding via `has_one = client` AND `has_one = provider` (both must
  cosign), status precondition `Active` enforced at both Account-level
  and handler-level (defense-in-depth per AUD-019), refund equals
  `total_amount - released_amount` so already-released milestones stay
  with provider, no reputation CPI invoked (consensual unwind ≠ non-
  delivery). Looked for: a path where `Disputed` status with
  `disputed_at = Some(...)` could reach this handler — confirmed
  unreachable because `raise_dispute` flips status to `Disputed`, and
  `resolve_dispute*` paths transition to `Completed`/`Cancelled` (no
  `Disputed → Active` edge exists in the program). The lifecycle table
  in the doc-comment (lines 442-446) matches the actual handler
  transitions in `instructions/escrow.rs`. No grief vector, no
  unilateral drain.

- **AUD-202 (`ProtocolConfig` field-order pin)** —
  `programs/settlement/src/state.rs:175-231` (`#[repr(C)]` +
  `const _: () = assert!(offset_of!(ProtocolConfig, authority) == 0)`)
  and the runtime test at `lib.rs:2253-2370`. Confirmed: any field
  reorder/prepend at the `ProtocolConfig` struct fails the Settlement
  build itself (compile-time assert), well before the discriminator-
  unchanged-but-offset-shifted threat could ship. Cross-program
  consumer (`agent-registry/src/lib.rs:790-839`) reads bytes [8..40]
  defensively after gating on `PROTOCOL_CONFIG_DISCRIMINATOR`. The
  symmetric-coverage test (`programs/settlement/src/state.rs:312+`)
  exercises raw-bytes [8..40] equal `authority` after Borsh
  serialization. No drift seam.

- **AUD-203 (AUD-117 seeds-parity coverage)** —
  `programs/settlement/src/contexts.rs:709-870`. Confirmed: the
  mechanical-identity check uses `include_str!("contexts.rs")` so any
  edit to the file is observed by the test on the next `cargo test`
  run. The four `#[account(...)]` blocks on `provider_owner_nonce` and
  `provider_profile` across `ApproveMilestone`,
  `ResolveDispute`, `ResolveDisputeTimeout`, `ExpireEscrow` are all
  textually identical (verified by hand-reading the four blocks; the
  test asserts byte-level identity programmatically). The TS bankrun
  migration scheduled for 2026-05-10 will add the runtime-rejection
  side; until then the source-of-record drift is closed by the
  mechanical-identity test, which is the right strength of guard for
  the gap (per the AUD-203 footnote contract).

- **AUD-205 (ADR-131 sybil cost calibration)** —
  `docs/adr/ADR-131-sybil-cost-calibration.md`. ADR-131 is calibration
  documentation that accepts the current bounds at the protocol's
  current threat model and catalogs levers if the threat model
  expands. No code surface to probe. The economic argument
  (per-agent slash cost > expected sybil benefit at current escrow
  values) is internally consistent with ADR-028 + ADR-097.

- **AUD-206 (retired-profile rejection on `propose_reputation_delta`)** —
  `programs/agent-registry/src/lib.rs:296-350`. Confirmed: the
  `Retired` status check fires at handler entry (lines 347-350),
  before any state mutation (`slash_count`, `updated_at`,
  `reputation_score`). The `update_status` transition table at
  `lib.rs:226-229` already forbids `Retired → Active|Paused|Suspended`,
  and combined with the AUD-206 guard, `Retired` is now a true closed
  state for both status writes AND reputation/slash writes — no path
  exists to mutate a retired profile. The `ProfileRetired` error
  variant is checked-into `errors.rs`. Symmetric coverage:
  `update_reputation` (lib.rs:155-170) already had the same
  Retired-rejection from cycle-2; AUD-206 brought
  `propose_reputation_delta` to parity. No remaining un-gated reputation
  write surface exists.

## Adjacent surfaces probed (no findings)

- **`verify_protocol_invariants`** — `lib.rs:787-867`. Looked for: a
  forged `protocol_config` account that satisfies the seed-derivation
  but carries arbitrary bytes [8..40]. Closed by Solana's PDA ownership
  model: only the Settlement program can write to the PDA address
  derived under `seeds::program = SETTLEMENT_PROGRAM_ID`, and the
  `PROTOCOL_CONFIG_DISCRIMINATOR` discriminator gate at lib.rs:824 plus
  the AUD-202 field-order pin together close the layout-drift +
  name-drift dimensions. The 16-batch cap (AUD-106) bounds the CU
  worst case.

- **Owner-nonce monotonicity (AUD-118)** — `lib.rs:584-599`,
  `deregister_agent`. Confirmed: `saturating_add` is the deliberate
  choice over `checked_add` so the unreachable `2^64`-deregistrations
  boundary stays at `u64::MAX` (Anchor `init` rejects the collision
  rather than panicking on an unrelated future call). No griefing
  vector for legitimate users.

- **`update_manifest` ed25519 precompile path** — `lib.rs:626-680`.
  Same pattern as AUD-200 / AUD-124 rotation; introspects the paired
  ed25519-program ix in the Instructions sysvar. Domain separator
  (`MANIFEST_HASH_DOMAIN`) is distinct from
  `VAULT_IDENTITY_BIND_DOMAIN` so cross-surface signature replay is
  closed. Capabilities-subset invariant (`agent_profile.capabilities ⊆
  manifest_capability_names`) prevents on-chain capability
  advertisement drift from the off-chain manifest.

- **Mutual-rescission status precondition vs. clock-regression** —
  `cancel_active_escrow` does not consult `Clock::get()`; it only
  consults `escrow.status`. No clock-regression surface exists on this
  handler. (`expire_escrow` does, and uses `now > escrow.deadline`
  which is monotonic-respecting.)

## Recommendation

Cycle-3 on-chain closures hold under hostile re-audit. The corpus is
release-window-clean from the on-chain dimension. The remaining
release-window items per the cycle-3 audit state memory note (AUD-201,
AUD-202, OFF-201, ADR-125) are already closed in commits
`9daf07f`, `e59072a`, `3c63f8e`, `b2c4f86` respectively, and re-verified
above for AUD-201 + AUD-202.

No code changes required from cycle-4 on-chain.
