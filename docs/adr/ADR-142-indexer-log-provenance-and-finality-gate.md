# ADR-142: Indexer log provenance + finality gate

## Status

Accepted

## Date

2026-05-17

## Context

Cycle-4 security re-audit (`docs/audits/ARCHITECTURE_REAUDIT_2026-05c-cycle4-security.md`,
findings CC-1 + CC-2) found that `src/indexer/index.ts` classifies events by
the 8-byte Anchor discriminator alone — the `programLabel` argument to
`parseLogsForEvents` (`index.ts:1377`) is discarded — and does not skip
transactions whose `meta.err` is set (`index.ts:2744`, backfill `:2524`).
`logsNotifications({mentions:[programId]})` returns logs from every program in
any transaction merely mentioning the subscribed program. A malicious program
can emit a `Program data:` line whose discriminator collides with
`EscrowSettled` / `ReputationDeltaProposed` / `ExecutionAttested`, inside a
deliberately-failed transaction, and the indexer persists the forged event into
the authoritative store — poisoning reputation, settlement projections, and
ADR-138 provenance. This is a cheap, deterministic state-forgery primitive.

## Decision

The indexer MUST bind every decoded event to its emitting program ID and reject
events from non-finalized or failed transactions. Concretely: (1) carry the
real emitting program through `parseLogsForEvents` and require it to equal the
expected program for that discriminator; (2) skip any transaction with
`meta.err != null` in both the live and backfill paths; (3) decode only against
`"finalized"` commitment. Discriminator-only classification is no longer a
trusted authority for persistence.

## Consequences

- **Positive**: closes the CC-1/CC-2 state-forgery primitive; reputation,
  settlement, and ADR-138 provenance projections become trustworthy.
- **Negative**: per-event program attribution adds a lookup; some historical
  fixtures/tests asserting label-less decode must be updated.
- **Follow-ups**: implement the provenance gate + failed-tx skip; add a
  regression test emitting a collision discriminator from a foreign/failed tx;
  cross-reference C4-OFF-01 (separate BorshReader hardening).

## Implementation

Implemented in `src/indexer/index.ts`:

- `EVENT_PROGRAM` binds every decoded event name to the program that
  legitimately emits it (sourced from each program's `src/events.rs`),
  plus `CCTP_HOOK_PROGRAM_ID` for the one CPI-emitted cross-program event
  (`MilestoneAutoApproved`).
- `attributeLogsToPrograms` walks the `Program <id> invoke/success/failed`
  scope brackets so each `Program data:` line is attributed to the
  innermost active program frame.
- `parseLogsForEvents` rejects any discriminator hit whose emitting
  program is not the expected owner, quarantining it to a forensics-only
  `event_rejected_provenance` classification that `updateAgentFromEvent`
  never matches (so it never reaches the authoritative projection). When
  the log stream carries no scope brackets (sparse RPC / unit fixtures)
  it falls back to the discriminator→owner binding gated by the
  subscribed program label.
- Failed transactions are skipped on the live path
  (`notification.value.err != null`) and the backfill path
  (`tx.meta.err != null`), with the backfill path still advancing the
  cursor so a failed signature is not re-fetched forever.
- Decode commitment was already pinned to `"finalized"`
  (`const COMMITMENT = "finalized"`), satisfying requirement (3).

Regression coverage: `src/indexer/decoder.test.ts` (ADR-142 / CC-1 +
CC-2 describe blocks — foreign-program collision, failed-frame collision,
cross-program leak, bracket-less fallback both directions).
