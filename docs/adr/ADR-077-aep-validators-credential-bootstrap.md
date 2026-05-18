# ADR-077: `AEP_VALIDATORS` credential bootstrap — deferred with dated post-mainnet plan

## Status
Proposed

## Date
2026-04-22

## Maintainer Decision Required

**Decision-ready — awaiting maintainer input on:** confirmation of the T+90-days-post-mainnet target as the committed milestone (vs. an alternative dated milestone), and — at ceremony time, not now — the nine real `AEP_VALIDATORS` signer principals.

The recommended option is **(a) defer with a public, dated, post-mainnet plan** (launch mono-credential on `AEP_PROTOCOL`, ship `AEP_VALIDATORS` at T+90). Option (b) bootstrap-now-with-interim-slate and options C–E are enumerated and rejected in *Alternatives Considered*; the deferral is the lower-risk path because it lets `AEP_PROTOCOL` accrue ≥30 days of real rotation experience first. The composition (Squads V4 5-of-9, three tiers, thresholds) is *not* open here — it is decided in ADR-063 §1.2; this ADR only fixes the *date* and the *disclosure shape*.

The single irreducible human inputs are (1) a calendar/governance decision (accept T+90 as the committed deadline) and (2) trust-principal selection of the nine validator signers — deferred to the ADR-063 §2 proposal process at ceremony time and explicitly out of scope here. No protocol-economic parameter is open.

**Dependency:** strictly downstream of ADR-063 items 1 (slots 4–5 seated) and 4 (transparency-log publisher live); after ADR-078's mainnet ceremony defines T. Status stays **Proposed**.

## Context

ADR-061 §3 named two SAS credentials at v1:

- **`AEP_PROTOCOL`** — baseline attestations derived from Registry state; protocol-blessed.
- **`AEP_VALIDATORS`** — community-signed behavioral observations; non-canonical.

ADR-063 §1.2 specified the `AEP_VALIDATORS` multisig composition (5-of-9, three tiers of signers, rotation cadence) but called out that the actual **membership is not hardcoded** — it is stored on-chain as the multisig signer set and populated per the §1.2 tier schedule. Neither ADR drafted a bootstrap procedure, member list, election mechanism, or timeline.

Deep-Audit 2026-04-22 (Audit 3, gap #5 — GOV-5) flagged this as a mainnet-blocker class gap: the `AEP_PROTOCOL` / `AEP_VALIDATORS` split in ADR-061 §3 exists precisely to separate protocol-endorsed attestations from community-observed ones. Launching mainnet with only `AEP_PROTOCOL` means the community-signal half of the story is vaporware — consumers trusting ADR-061 §3 as written would find only one credential resolvable.

Two legitimate paths forward:

- **(a)** Defer `AEP_VALIDATORS` with a public, dated, post-mainnet plan — launch mono-credential, document the gap, commit to the composition on a known date.
- **(b)** Bootstrap now with an interim signer slate (e.g., 3-of-5 protocol-multisig-nominated validators as slots 1-3 from ADR-063 §1.2) and treat the 60-day first-governance-cycle clock as the path to the full 5-of-9.

Related constraints:

- **ADR-063 §1.1 slots 4-5 are still unnamed** (Audit 3 gap #2 — GOV-2). Bootstrapping `AEP_VALIDATORS` before the `AEP_PROTOCOL` multisig itself is fully seated compounds governance risk across two authorities simultaneously.
- **No end-to-end multisig-signed program-upgrade rehearsal** has run (Audit 3 gap #6 — GOV-6); the existing 2-of-3 devnet Squads has executed two SAS ceremonies but never a `set-upgrade-authority` or a second-human-signer ceremony (GOV-7).
- **Transparency-log publisher does not exist** (ADR-063 §7, Audit 3 gap #9). Bootstrapping a second credential adds a second stream to a feed that is not yet written.

This ADR is **DOCS-only** plus a **script skeleton** (`scripts/bootstrap-aep-validators-devnet.ts`). No program changes, no SDK changes.

## Decision

**Defer `AEP_VALIDATORS` credential bootstrap to a dated post-mainnet milestone; launch mainnet with `AEP_PROTOCOL` only and document the gap explicitly.**

### 1. Target date

**`AEP_VALIDATORS` bootstrap ceremony: T+90 days after mainnet launch**, where T is the day `mainnet-deploy.sh` completes and the `AEP_PROTOCOL` credential PDA is live on mainnet with 3-of-5 real-signer governance per ADR-063 §1.1. The 90-day window is calendared inside `docs/STATUS.md §7.D` at the mainnet-launch PR and surfaces as a governance-board item.

### 2. Mainnet-launch disclosure

At mainnet launch, the protocol repo README and `@agenomics/sas-resolver` README publish an explicit "credentials live at mainnet launch" block naming only `AEP_PROTOCOL`, with a one-line pointer to this ADR for `AEP_VALIDATORS` status. The resolver's default allowlist ships with **only** `AEP_PROTOCOL`'s mainnet authority; `AEP_VALIDATORS` is absent rather than stubbed. A stub allowlist entry pointing at a non-live credential would produce silent resolution failures; absence produces nothing.

### 3. Pre-conditions for the T+90 ceremony

All of the following must be resolved before the ceremony opens:

1. **ADR-063 slots 4-5 populated.** The `AEP_PROTOCOL` 3-of-5 must be fully seated and operating for at least 30 days, with at least one routine rotation exercise completed (simulated if necessary).
2. **ADR-063 §6.1 emergency runbook scripted** (Audit 3 gap #8). The `scripts/emergency-suspend-credential.ts` tool exists and has been rehearsed on devnet.
3. **Transparency-log publisher shipped** (ADR-063 §7, Audit 3 gap #9). An hourly worker writes to `governance/attestation-log/YYYY-MM/`.
4. **First three validators nominated** by the protocol multisig per ADR-063 §1.2 tier 1. Nominations published as `AEP-GOV-NNN` proposals under the pinned governance discussion category 30 days before the ceremony.
5. **First governance-cycle election** for tier 2 (slots 4-6) completed per ADR-063 §1.2; outcome published in `docs/governance/signers.md`.

### 4. Ceremony procedure

Mirrors ADR-063 §5's mainnet-ceremony shape, with these deltas:

- **Authority**: distinct multisig from `AEP_PROTOCOL`. Reuse the existing program-upgrade multisig as signer of the ceremony transaction (it creates the `AEP_VALIDATORS` PDA), but the resulting credential authority is a **new** 5-of-9 Squads vault whose signer set is the members seated per §3.4/§3.5.
- **Devnet dry run mandatory** no fewer than 7 days before mainnet ceremony, per ADR-063 §5 precedent.
- **Witnesses**: all five `AEP_PROTOCOL` signers (observer role), plus all nine `AEP_VALIDATORS` prospective signers (active role), plus at least one independent security researcher.
- **Post-ceremony**: update `@agenomics/sas-resolver` default allowlist to include the mainnet `AEP_VALIDATORS` authority; bump resolver package minor version; `@agenomics/capability-manifest-validator` unaffected.

### 5. Script skeleton — `scripts/bootstrap-aep-validators-devnet.ts`

A devnet-only skeleton ships with this ADR, mirroring `scripts/bootstrap-sas-credential-devnet.ts` (`feat/sas-credential-bootstrap` → merged). It:

- Reads the existing `scripts/.squads-devnet.json` for the current 2-of-3 multisig PDA as the interim devnet validator-authority (devnet does not need 5-of-9 separation; the 2-of-3 is sufficient for exercising the path).
- Creates an `AEP_VALIDATORS` credential PDA on devnet with a placeholder name `AEP_VALIDATORS_DEVNET` to avoid namespace collision if a future real ceremony reuses `AEP_VALIDATORS`.
- Does **not** create a schema — validators would attest under the same `AEP_AGENT_REPUTATION_v1` schema that ADR-061 §2 defines.
- Is idempotent against `scripts/.sas-devnet.json` (augments the file with a `validators_credential_pda` field on first run; exits quietly on subsequent runs if live on-chain).
- Runs in CI on the devnet smoke track but is **not** wired into the mainnet-deploy path — it is a rehearsal artifact.

## Alternatives Considered

### Alternative A: Bootstrap `AEP_VALIDATORS` now with interim signer slate
**Rejected.** The `AEP_PROTOCOL` 3-of-5 itself is not yet fully seated (ADR-063 slots 4-5 unnamed — Audit 3 gap #2). Bootstrapping a second, larger authority on top of a partially-seated first authority multiplies governance risk: a routine rotation failure on either would cascade into the other (shared signer pool, shared operator team, shared runbook). The multisig infrastructure has also not been exercised with an independent second human (Audit 3 gap #7 — GOV-7); a 5-of-9 ceremony would be the first ever such exercise. Bootstrapping at T+90 — after at least one `AEP_PROTOCOL` rotation has run — is the first moment operational confidence exists.

### Alternative B: Launch mainnet silently mono-credential
**Rejected.** Launching mainnet with only `AEP_PROTOCOL` while ADR-061 §3 documents two credentials produces a documentation/reality mismatch. Consumers building against ADR-061 would expect both credentials to resolve; the silent absence of `AEP_VALIDATORS` looks like a bug. Explicit disclosure (§2) makes the gap visible and committed to a close date.

### Alternative C: Drop `AEP_VALIDATORS` from ADR-061 §3 entirely (v1 is mono-credential)
**Rejected.** The protocol/community split is a first-principle governance design decision, not a v1-specific convenience. Dropping it would require rewriting ADR-061 §3 and reworking the resolver's allowlist doctrine (which already treats the two credentials asymmetrically in test fixtures). Deferring-with-plan preserves the architectural intent.

### Alternative D: Bootstrap only on devnet, never on mainnet
**Rejected.** A devnet-only second credential is indistinguishable from no second credential for mainnet consumers. The devnet skeleton (§5) exists as rehearsal, not as a substitute.

### Alternative E: Hardcode three protocol-nominated validators in ADR-077 as slots 1-3
**Rejected — out of scope.** Naming specific humans is a governance decision requiring community input (ADR-063 §2 proposal process) and is explicitly called out in the DEEP-AUDIT as gap #2's sister concern. This ADR records the decision to defer; the nomination process itself runs through `AEP-GOV-NNN` proposals once §3 pre-conditions are met.

## Consequences

### Positive
- **Mainnet launch unblocked.** GOV-5 shifts from "blocker" to "documented deferral with date." The mainnet-deploy path does not wait on validator recruitment.
- **Governance surface narrows for launch.** One credential to exercise, one authority to audit, one transparency-log stream — smaller blast radius if anything goes wrong in the first 90 days.
- **Real rehearsal data before second ceremony.** `AEP_PROTOCOL` runs for 90 days on mainnet before `AEP_VALIDATORS` bootstraps; any operational lessons feed into the second ceremony's runbook.
- **Explicit public commitment.** The T+90 deadline is calendared and surfaces on STATUS.md; missing it is a declared governance incident, not a silent slip.

### Negative
- **ADR-061 §3's protocol/community split is aspirational for 90+ days post-mainnet.** Consumers relying on the community signal get nothing at launch.
- **Risk of indefinite slip.** T+90 depends on §3 pre-conditions landing on schedule. If the `AEP_PROTOCOL` rotation rehearsal or transparency-log publisher slips, `AEP_VALIDATORS` slips with them.
- **Second full ceremony still required.** The devnet-skeleton rehearsal helps but does not substitute for the 9-signer mainnet coordination exercise.
- **Resolver allowlist must ship twice.** Once at mainnet launch (one entry), once at T+90 (two entries). Minor-version bump in `@agenomics/sas-resolver` each time; consumers pinning exact versions take one update they otherwise would not.

### Neutral
- **`AEP_AGENT_REPUTATION_v1` schema unchanged.** Both credentials attest under the same schema; bootstrapping the second one does not require a new schema PDA.
- **ADR-063 governance unchanged.** The 5-of-9 composition, thresholds, and rotation cadence from ADR-063 §1.2/§3/§4 apply to `AEP_VALIDATORS` whenever it bootstraps — this ADR only moves the date.

## References
- `docs/adr/ADR-061-sas-integration.md` §3 — protocol/community credential split
- `docs/adr/ADR-063-sas-credential-authority-governance.md` §1.2, §5 — 5-of-9 composition, mainnet ceremony shape
- `docs/adr/DEEP-AUDIT-2026-04-22.md` Audit 3 gaps #2, #5, #6, #7, #9 — governance preconditions
- `scripts/bootstrap-sas-credential-devnet.ts` — template for the `AEP_VALIDATORS` devnet skeleton
- `scripts/.sas-devnet.json` — devnet PDA registry (augmented by §5's script)
- `docs/STATUS.md` §7.D — mainnet path; the T+90 milestone lands here at mainnet launch
