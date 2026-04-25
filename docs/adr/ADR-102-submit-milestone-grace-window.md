# ADR-102 — submit_milestone Grace Window

## Status

Accepted

## Date

2026-04-23

## Context
An attacker observing the mempool can front-run a valid `submit_milestone` call
with a slash instruction, causing the agent to be penalized even though the
milestone was submitted on time. A grace window prevents slashing during the
submission window.

## Decision
Add `grace_period_slots: u64` to `submit_milestone`. The MilestoneAccount stores
`grace_ends_at: u64 = submission_slot + grace_period_slots`. Any slash instruction
that executes while `Clock::get()?.slot < grace_ends_at` returns
`ErrorCode::MilestoneInGracePeriod` rather than applying the penalty.
Default grace period: 0 (caller must opt in; protocol may mandate minimum later).

## Alternatives
- Commit-reveal scheme: stronger but much more complex.
- Off-chain dispute period: requires trusted arbiter.

## Consequences
- Submission transactions that include a grace_period_slots > 0 are protected.
- Slash instructions must now check the grace window.

## References
- Architecture Audit 2026-04-23, Item 25, Sec 2.2
