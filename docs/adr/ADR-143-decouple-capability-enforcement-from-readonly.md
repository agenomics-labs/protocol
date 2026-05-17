# ADR-143: Decouple capability enforcement from `readOnly`

## Status

Proposed

## Date

2026-05-17

## Context

Cycle-4 security re-audit (finding CC-3, refining seed finding #2 which was a
false positive) found that `mcp-server/src/adapters/capability-gated-tool.ts`
enforces capability claims only when `!action.readOnly` (gate at `:57`; the
registration guard at `:32-36` checks only `!readOnly && empty caps`). The
direction is correct default-deny — there is no runtime inversion — but
`readOnly: true` actions are exempt from claim enforcement entirely, even when
they expose sensitive data. Action authors already work around this at
`registry.ts:181-186` by declaring `find_similar_agents` as `readOnly: false`
purely to re-enable the gate, which is a footgun: a future read-only-but-
sensitive tool silently ships with no capability check. ADR-058 §4 ties
enforcement to `readOnly`, which conflates "mutating" with "capability-
relevant".

## Decision

Capability enforcement MUST be driven by an explicit per-action capability
declaration, not derived from `readOnly`. An action with a non-empty required-
capability set is gated regardless of `readOnly`; `readOnly` continues to govern
signer/idempotency semantics only. This amends ADR-058 §4. Read-only actions
that expose sensitive data declare their required `read:*` capabilities and are
enforced like any other.

## Consequences

- **Positive**: removes the `readOnly` footgun; sensitive read-only tools can
  no longer ship unguarded; intent is explicit at declaration.
- **Negative**: every existing action's capability set must be audited and made
  explicit; the `registry.ts` `readOnly:false` workaround is reverted.
- **Follow-ups**: amend ADR-058 §4; migrate action declarations; add a
  registration-time assertion that sensitive read actions carry caps; cross-ref
  CC-3 and the cycle-4 report.
