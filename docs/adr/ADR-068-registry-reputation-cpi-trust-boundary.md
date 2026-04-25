# ADR-068: Registry `UpdateReputation` CPI trust boundary — bind `agent_profile` to `escrow.provider`

## Status
Accepted

## Date
2026-04-22 (Proposed) — Promoted to Accepted on 2026-04-23 (shipping in PR #28-#33)

## Context

DEEP-AUDIT-2026-04-22.md Audit 1 finding **SEC-1 (CRITICAL)** identified cross-agent reputation forgery via the Settlement→Registry CPI path.

`programs/agent-registry/src/contexts.rs:70-85` defines `UpdateReputation` with a self-referential seed derivation: `seeds = [agent_profile.authority.as_ref(), b"agent-profile"]`. Because the seed is read *from the account being validated*, Anchor's PDA check is vacuously satisfied — it re-derives the key using a field inside the very account the attacker supplied, so any well-formed `AgentProfile` passes. The only real gate is the `settlement_authority` PDA signer.

On the caller side (`programs/settlement/src/contexts.rs:153-159, 255-261, 309-316, 400-406`), the provider profile is derived from `[escrow.provider.as_ref(), b"agent-profile"]` — correct — but **the Registry program never verifies that the profile it is writing to is the one the Settlement side asserted it to be.** Trust collapses to whatever the Settlement program signs for, which the attacker chose.

**Exploit**: a caller of `approve_milestone`, `expire_escrow`, `resolve_dispute`, or `resolve_dispute_timeout` passes an arbitrary other agent's `AgentProfile` account. Anchor's self-referential seed check passes, Settlement's signer-CPI writes reputation (positive or negative) to a victim's profile, and the attacker forges reputation deltas — either pumping their collaborator or slashing a competitor.

This is the **most severe** finding in Audit 1: it compromises the protocol's entire reputation trust model and is reachable via every Settlement-completion path.

## Decision

Harden the Registry↔Settlement CPI trust boundary on both sides:

**Registry side (`programs/agent-registry`)** — the `UpdateReputation` context gains an explicit binding between the passed `agent_profile` account and an `authority: AccountInfo` account also passed in the context, enforced via a `has_one = authority` style constraint on `AgentProfile` plus a seeds clause that reads `authority.key().as_ref()` (the passed account, not the account-internal field). The new context takes `authority` as a non-mutable, non-signer account whose key the Settlement caller is required to pass through — this turns the self-referential seed into an externally-anchored seed.

**Settlement side (`programs/settlement`)** — each of the four CPI call sites that invoke `UpdateReputation` (`approve_milestone`, `expire_escrow`, `resolve_dispute`, `resolve_dispute_timeout`) is amended to pass `escrow.provider` as the `authority` account in the Registry CPI. The existing Settlement-side constraint `seeds = [escrow.provider.as_ref(), b"agent-profile"]` remains and becomes the belt-and-braces check; the Registry side gains the primary binding.

**Program IDs**: on-chain upgrade required for both `agent-registry` and `settlement`. Deployment **requires multisig signing** per ADR-031.

**Cross-cutting finding — self-referential PDA seed pattern**

The audit flagged this same anti-pattern in SEC-1 (Registry `UpdateReputation`) and SEC-6 (Vault `ExecuteTokenTransfer` via `vault.authority`). Define as a protocol-wide code-review checklist item: *any `seeds = [account.field.as_ref(), ...]` where `account` is the same account being constrained is considered self-referential and MUST be paired with either (a) a `has_one` binding to a separately-passed account, or (b) an external seed rooted in a signer or a caller-supplied accountinfo.* This is not a new rule — it is the standard Anchor pattern; the checklist item is about noticing the violation in review. To be added to `.github/pull_request_template.md` under "security checklist" on a future PR.

**Tests to add** (under `tests/registry/` and `tests/settlement/`):

- Registry unit test: call `UpdateReputation` with a `agent_profile` whose `authority` field does not match the passed `authority` account → MUST fail with `ConstraintHasOne`.
- Settlement integration test: call `approve_milestone` where `provider_profile` account is a different agent's profile → MUST fail at Registry CPI, not silently write.
- Regression test for each of the four Settlement call sites with a malicious `provider_profile`.

## Alternatives Considered

- **Keep self-referential seed; add signer-side allowlist in Registry.** Rejected — the Settlement signer is a PDA, and Registry cannot distinguish "legitimate Settlement CPI with wrong profile" from "legitimate Settlement CPI with right profile" without the caller passing an anchor.
- **Move the binding only to the Settlement side.** Rejected — Audit 1 explicitly notes "the Registry side should also assert the profile key matches a provider passed as an account." Defense-in-depth requires both sides to enforce the invariant, so a future Settlement bug cannot silently forge reputation.
- **Lock CPI path behind a program-ID allowlist only.** Rejected — program-ID allowlists already exist; the flaw is *within* a legitimate call from the allowlisted Settlement program.

## Consequences

**Promoted to Accepted on 2026-04-23 (shipping in PR #28-#33).** The Registry-side `UpdateReputation` `provider_authority` anchor and the four Settlement-side CPI call sites were landed on `main` in PR #32 (`fix(registry+settlement): SEC-1/4/7/8/11 reputation trust-boundary hardening`, commit `5ce5e8a`). All four CPI call sites pass `escrow.provider` through the new `provider_authority: UncheckedAccount` constrained with `address = escrow.provider`. Code comment tags are updated from `(per ADR-068, in-flight)` to `(per ADR-068, Accepted 2026-04-23)` in this consolidation PR.

**Positive**: eliminates cross-agent reputation forgery; hardens the single most critical trust edge in the protocol. Aligns Registry with standard Anchor `has_one` idiom, removing a future-maintainer trap.

**Negative**: ABI change on both programs. Anyone who built SDKs against the Settlement↔Registry CPI (there are none published yet) would break; internal `@agenomics/mcp-server` dispatch paths for the four affected instructions must be regenerated from the new Anchor IDL.

**Migration path**: because both programs are on-chain with BPFLoaderUpgradeable and the upgrade authority is already the program-upgrade multisig (ADR-031), deployment is a coordinated two-program upgrade: (1) upgrade Registry first with the stricter `UpdateReputation` context — the new context is incompatible with old Settlement callers, so Registry `UpdateReputation` will reject all current calls until step 2; (2) same-slot (or next-slot) upgrade Settlement to pass the new account. The window between the two upgrades is a Settlement-reputation outage — acceptable because escrow operations still complete, they just fail to CPI reputation. Devnet rehearsal mandatory (ties to GOV-6 in the audit). No data migration needed — existing `AgentProfile` accounts are untouched.

## References
- `docs/adr/DEEP-AUDIT-2026-04-22.md` — Audit 1, finding SEC-1
- `docs/adr/ADR-001-cpi-caller-verification.md` — original CPI caller verification pattern
- `docs/adr/ADR-031-mainnet-deployment.md` — upgrade-authority multisig
- `programs/agent-registry/src/contexts.rs:70-85`, `src/lib.rs:127-130`
- `programs/settlement/src/contexts.rs:153-159, 255-261, 309-316, 400-406`

## Revisions

- 2026-04-25 — Partially superseded by ADR-094. The new bounded
  `propose_reputation_delta` instruction is the canonical path; legacy
  `update_reputation` is on the deprecation track (TODO at
  `programs/settlement/src/instructions/cpi.rs:43-48` and AUD-002).
  AUD-2026-04-25 drift matrix §4.
