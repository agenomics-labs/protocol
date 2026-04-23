# ADR-082: Indexer event coverage CI gate

## Status

Accepted

## Date

2026-04-23

## Context

The off-chain indexer (`src/indexer/index.ts`) is the canonical projection of
on-chain state for every consumer that does not subscribe to logs directly:
the MCP server, the discovery / search APIs, dashboards, the SAS-resolver
cache, and any third-party subscriber that follows the `/events` REST
endpoint. The indexer derives an event name from the first 8 bytes of every
`Program data:` log via the Anchor convention
`sha256("event:<EventName>")[..8]`, then looks the bytes up in a static
`DISCRIMINATOR_MAP`.

The audit run on 2026-04-23 (`docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md`,
themes #2 and items 6/7) found that the indexer's discriminator table had
silently fallen out of sync with the program-side `#[event]` declarations.
Four shipped events were missing decoders entirely:

| Event | Program | Why it matters |
|-------|---------|----------------|
| `AgentIdentityUpdated` | agent-vault | This is the **on-chain signal that the SEC-2 fix added** (ADR-069). Any consumer that caches `vault.agent_identity → permitted-signer` mapping must invalidate when this fires. The indexer was not delivering it; the very fix designed to make SEC-2 detectable downstream was not detectable downstream. |
| `ManifestUpdated` | agent-registry | ADR-060 capability-manifest pointer rotations. Discovery / SAS-resolver caches go stale silently. |
| `ProtocolConfigInitialized` | settlement | One-shot creation of the singleton `ProtocolConfig`. Dashboards never see initial governance values. |
| `ProtocolConfigUpdated` | settlement | Every governance-driven change to escrow minimums / dispute timeouts / reputation deltas. Anyone projecting policy state silently drifted from chain. |

This is a **class of bug**, not a one-off. The seam between Rust `#[event]`
declarations in `programs/**/src/events.rs` and the indexer's TypeScript
discriminator map is hand-maintained, so every new event a future PR adds
to a program will silently not appear in the indexer until someone
remembers to wire it up. The pattern matches yesterday's audit finding
about the indexer's pre-fix fabricated discriminators (Finding #6 in the
prior cycle): an off-chain consumer can be wrong about on-chain state for
months without anyone noticing, because the failure mode is **missing
data**, not error logs.

## Decision

We adopt a defense-in-depth fix consisting of three coordinated changes:

1. **Backfill the four missing decoders.** `src/indexer/index.ts`
   `DISCRIMINATOR_MAP` gains entries for `AgentIdentityUpdated`,
   `ManifestUpdated`, `ProtocolConfigInitialized`, and
   `ProtocolConfigUpdated`. Each gets a Borsh decoder in `EVENT_DECODERS`
   that reads the exact field layout from the Rust struct. New side-effect
   tables (`vault_identity_history`, `manifest_history`,
   `protocol_config_history`) record the durable rows downstream
   subscribers need. The `events` table continues to receive every
   classified event in JSON form so the existing `/events` API stays
   backwards-compatible.

2. **Add a CI gate that derives the expected discriminator set from the
   Rust source and asserts the indexer covers it.**
   `scripts/check-event-coverage.ts` walks `programs/**/src/events.rs`,
   parses every `#[event] pub struct <Name>` declaration, computes the
   expected `sha256("event:<Name>")[..8]` for each, and asserts the
   indexer's `DISCRIMINATOR_MAP` contains a matching entry. Drift exits
   non-zero with a message naming the missing event and its expected
   discriminator hex.

3. **Wire the gate into a required GitHub Actions check.**
   `.github/workflows/event-coverage.yml` runs the script on every PR and
   on every push to `main`. The job is gated to fail closed: a future PR
   that adds a `#[event]` without updating the indexer cannot merge.

The discriminator computation strategy is the Anchor 0.30+ convention:
`sha256("event:<EventName>").subarray(0, 8)`, encoded lower-case hex. This
is the same formula already used by Anchor's IDL codegen and by the
indexer's existing 27 entries — we are not introducing a new format, only
moving from manual maintenance to mechanical verification.

## Alternatives

- **Generate the discriminator map from the IDL at build time.** The
  current scripts/check-idl.sh diff already verifies that Anchor's IDL
  codegen matches the committed baseline. We could go further and emit
  the discriminator table as generated TypeScript. Rejected for now
  because the IDL JSON does not expose the derived discriminator
  alongside each event in a stable, easy-to-consume shape across Anchor
  minor versions, and the codegen path adds a build-order dependency
  (anchor build must run before TypeScript type-checks the indexer).
  A check-only gate is strictly weaker than codegen but immediately
  prevents the class bug; codegen is captured as a follow-up.

- **Fail the build at the Rust side.** A `build.rs` proc-macro could
  enforce that every `#[event]` is named in a sibling whitelist file.
  Rejected because the on-chain code should not be aware of the
  off-chain consumer's catalog — this would invert the dependency the
  wrong way and tie program upgrade cadence to indexer churn.

- **Fall back to event-name regex parsing on logs.** Anchor itself emits
  `Program log: instruction: <name>` style lines that could be matched
  textually. Rejected because (a) `#[event]` payloads ride on
  `Program data:` lines that have no human-readable name, only the
  binary discriminator, and (b) regex on `Program log:` would be coupled
  to compiler output in a way Anchor explicitly does not promise to keep
  stable.

- **Ship the four decoders without a CI gate.** Rejected: this is the
  failure mode that motivated the audit. Without mechanical
  verification, the next event added in three months has the same
  silent-drift outcome.

## Consequences

**Positive.**

- Future drift is impossible-by-construction. Any PR that adds a new
  `#[event]` to any program will fail CI until the indexer's
  `DISCRIMINATOR_MAP` is updated. The error message names the missing
  event and provides the expected discriminator hex, so the fix is
  copy-paste.
- `AgentIdentityUpdated` (ADR-069 / SEC-2 from yesterday's audit) is
  finally detectable downstream. Caches keyed on
  `vault.agent_identity → permitted-signer` can subscribe and
  invalidate.
- ADR-060 manifest rotations and `ProtocolConfig` governance events are
  now first-class signals for dashboards and the SAS-resolver cache.
- The CI gate is < 100 lines of TypeScript (`scripts/check-event-coverage.ts`)
  and adds < 5 seconds to PR latency. Cost-benefit is decisively in favor.

**Negative.**

- Maintainers who rename a `#[event]` struct must update the indexer in
  the same PR. The CI gate is strict — there is no advisory mode. We
  consider this the desired friction; the alternative is silent breakage.
- The new SQLite tables (`vault_identity_history`, `manifest_history`,
  `protocol_config_history`) increase the on-disk footprint of long-lived
  indexer instances. Order of magnitude: 4 events × ~120 bytes/row ×
  expected emission rate (governance / manifest / identity rotations are
  all rare). Negligible vs. the existing `events` table.

**Migration path for older events that may have been silently broken.**

- The four missing events have been emitting on-chain since the programs
  shipped. Indexer instances in the wild have classified them as
  `event_<hex>` fallback rows, with the raw payload preserved. After the
  fix, those fallback rows remain queryable but new emissions are
  classified correctly and persist into the side-effect tables.
- Operators who need historical replay can run the indexer against an
  empty database and let the existing backfill worker re-process from a
  signature cursor — every prior `AgentIdentityUpdated` /
  `ManifestUpdated` / `ProtocolConfigInitialized` /
  `ProtocolConfigUpdated` will be classified correctly on this pass.
- Backwards compatibility for existing databases: the indexer's
  `initDb` adds the three new tables with `CREATE TABLE IF NOT EXISTS`
  and does not reshape any existing column. An indexer that upgrades
  in place keeps every prior row, gains the new tables empty, and
  begins populating them on the next live event. No destructive
  migration is needed.

**Operational considerations.**

- The new history tables are append-only and can be retention-pruned
  per the operator's policy without affecting indexer correctness.
- A future ADR (105 — see `ARCHITECTURE-AUDIT-2026-04-23.md`) covers
  durable backup / cron / S3 offload for the SQLite database and
  applies uniformly to the new tables.

## References

- `docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md` — items 6 and 7 (this ADR
  closes both).
- `docs/adr/ADR-069-vault-agent-identity-rotation.md` — the on-chain
  source of `AgentIdentityUpdated`. SEC-2 from
  `docs/adr/DEEP-AUDIT-2026-04-22.md`.
- `docs/adr/ADR-060-capability-descriptor-format.md` — defines the
  manifest payload that `ManifestUpdated` references.
- `docs/adr/ADR-075-protocol-config-delta-bounds.md` — governs the
  `ProtocolConfigUpdated` mutation pathway.
- `programs/agent-vault/src/events.rs`,
  `programs/agent-registry/src/events.rs`,
  `programs/settlement/src/events.rs` — the authoritative event
  declarations the gate parses.
- `src/indexer/index.ts` — the `DISCRIMINATOR_MAP` and decoder layer.
- `scripts/check-event-coverage.ts` — the CI gate implementation.
- `.github/workflows/event-coverage.yml` — the required check.
- Anchor 0.30+ event discriminator convention:
  `sha256("event:<EventName>")[..8]`.
