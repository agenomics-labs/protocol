# ADR-063: SAS credential authority governance — multisig composition, rotation, and bootstrap

## Status
Proposed

## Date
2026-04-21

> **Devnet bootstrap update (2026-04-22):** the `AEP_PROTOCOL` credential PDA and the `AEP_AGENT_REPUTATION_v1` schema PDA were created on devnet under the Squads v4 2-of-3 multisig per §5 (devnet dry run). Live PDAs are recorded in `scripts/.sas-devnet.json`. This ADR remains **Proposed** — not Accepted — because the items under "Pending items before Accept" below are still open. The devnet dry run does not satisfy §5 mainnet-ceremony pre-conditions.

## Pending items before Accept

Per Deep-Audit 2026-04-22 (Audit 3 gaps #2 and #9), ADR-063 cannot move to Accepted until all of the following are resolved. Each is a separate blocker; none is optional:

1. **Slots 4-5 of the `AEP_PROTOCOL` 3-of-5 multisig are populated.** §1.1 lists role descriptions (community-elected, security researcher) but names no humans. Populating these slots is a governance decision outside the mandate of this ADR's author — it runs through the §2 proposal process once the process itself is live.
2. **Auditor contact is registered** for the §6 emergency path. §3's "simple-majority + auditor co-sign" emergency threshold requires a designated, pre-registered external signer whose sole role is emergency co-signing. No such signer is currently identified; the emergency "fast path" therefore does not exist in practice.
3. **`docs/governance/signers.md` is published** (referenced in §7 but not present in-repo). Signer pubkeys for both credentials must be listed, with the community-elected slot and the auditor co-signer disclosing real-world identity per §7.
4. **Transparency-log publisher is shipped** (Audit 3 gap #9). §7 requires hourly JSON writes to `governance/attestation-log/YYYY-MM/`; no worker exists. A > 24h publication gap is a declared transparency incident — launching §5's mainnet ceremony before the publisher is live means declaring the incident on day 1.
5. **Emergency runbook is partially scripted** (Audit 3 gap #8). §6.1's T+2h suspend step is now operationalized in `scripts/emergency-suspend-credential.ts` per **ADR-081** (Accepted 2026-04-23). The T+24h rotate and T+7d audit steps ship as documented stub scripts (`scripts/rotate-credential-authority.ts`, `scripts/audit-suspended-credential-attestations.ts`) marked TODO before mainnet — see ADR-081 §4 + "TODO follow-ups" section. Auditor contact list and transparency-log publisher remain open under items 2 and 4 above; until they land, the suspend script can run only in `--dry-run` mode.
6. **End-to-end multisig flow exercised with an independent human signer** (Audit 3 gap #7). The current `bootstrap-sas-credential-devnet.ts` flow loads signer-1 and signer-2 from local disk — same operator controls both approvals. One ceremony must run where signer 2 is a different human on a different machine before Accept.

Items 1-3 are governance-process items (require human-recruitment + real-world coordination, not code). Items 4-6 are tooling/rehearsal items (shippable via follow-up PRs). All must land before this ADR is promoted to Accepted; promotion itself is a documentation-only follow-up PR at that time.

Related: ADR-077 (defers `AEP_VALIDATORS` bootstrap to T+90 post-mainnet) is explicitly dependent on items 1 and 4 being resolved before its own pre-conditions open. ADR-078 (program upgrade-authority transfer) and ADR-079 (operator key hygiene) cross-reference this ADR as a mainnet prerequisite.

## Maintainer Decision Required

**Decision-ready — awaiting maintainer input on:** the real-world principals for `AEP_PROTOCOL` slots 4–5 (community-elected signer, security researcher), the named external auditor co-signer for the §6 emergency path, and the `AEP_VALIDATORS` 5-of-9 initial slate.

The *mechanism* is fully specified and recommended: `AEP_PROTOCOL` = reuse the existing Registry program-upgrade multisig as a Squads V4 3-of-5 (supermajority 4-of-5 routine, simple-majority + auditor co-sign emergency); `AEP_VALIDATORS` = a separate Squads V4 5-of-9; off-chain proposal venue (`AEP-GOV-NNN` on pinned GitHub Discussions) with on-chain multisig execution. Squads V4 supplies the required primitives natively (per-member roles, time locks, separate vaults — no custom governance program needed). Every option (single-signer, permissionless, on-chain governance program, shared authority, token-weighted) is enumerated and rejected with rationale in *Alternatives Considered*.

The single irreducible human input is **trust-principal selection** (which humans/keys fill the role slots and the auditor co-signer) — explicitly out of this ADR's mandate per the "Pending items before Accept" §1–3; these run through the §2 proposal process once it is live. No protocol-economic parameter is open: thresholds and notice windows are decided in §3. Status stays **Proposed** until "Pending items before Accept" 1–6 are resolved (governance-recruitment + rehearsal items, not code).

**Dependency:** ADR-077 depends on items 1 and 4 here; ADR-078 and ADR-079 cross-reference this ADR as a mainnet prerequisite; ADR-113 stage-1 depends on this multisig being seated.

## Context

ADR-061 (Accepted) resolved *how* AEP integrates with `solana-attestation-service` (SAS) — option B, manifest-referenced attestations, with the Registry retaining authoritative reputation state. ADR-061 §3 named two SAS credentials at v1:

- **`AEP_PROTOCOL`** — baseline attestations derived from on-chain Registry state. Canonical; resolvers may treat as protocol-blessed.
- **`AEP_VALIDATORS`** — community-signed behavioral observations. Non-canonical; consumers may weight lower.

ADR-061 §3 explicitly deferred the governance details — *"detailed voting thresholds, proposal format, and multisig composition are out of scope for this ADR — tracked as **ADR-063**."* This ADR resolves that open item.

SAS credentials are multi-signer PDAs. Each credential carries an authority set that controls (a) which signers may issue attestations under the credential and (b) schema attachments. The authority set is mutable via SAS's admin instructions, so the question is not *can* we rotate — it's *who decides* and *under what process*.

Three related constraints shape the decision:

- AEP already operates a **program-upgrade multisig** for `programs/agent-registry` and the other on-chain artifacts. Introducing a parallel governance substrate for SAS credentials would fragment the trust model and create two separate compromise surfaces.
- ADR-060's **identity / reputation / capabilities separation** and ADR-061's **loose-coupling** decision argue for the lightest governance process that still meets the accountability bar. On-chain governance frameworks (Squads, Realms) exist and work, but they add infra that AEP does not otherwise need in v1.
- **Emergency rotation** (signer compromise) must be fast. A process that forces a 14-day delay on all rotations is wrong for v1; the protocol must distinguish routine rotation (slow, transparent) from emergency rotation (fast, auditor-backed).

This ADR is **DOCS-only** — no program changes, no SDK changes. Implementation of the bootstrap ceremony and the transparency log tooling is scoped to follow-ups (§9).

## Decision

### 1. Multisig composition

Each SAS credential authority is a Solana multisig account. The two v1 credentials use the following compositions:

#### 1.1 `AEP_PROTOCOL` authority — **3-of-5**

Reuses the **same multisig** that currently gates Registry program upgrades on mainnet (see ADR-031 for the deployment record). Rationale: a SAS attestation issued under `AEP_PROTOCOL` asserts something protocol-endorsed about an agent; the trust set for such assertions should not be larger or weaker than the trust set that can change the protocol itself.

Signer roles (not hardcoded to specific individuals — role slots):

| Slot | Role | Notes |
|---|---|---|
| 1 | Founder / protocol lead | Long-tenure, broad context |
| 2 | Key engineering contributor | Active committer in last 90 days |
| 3 | External security auditor | Independent firm, rotates per audit engagement |
| 4 | Community-elected signer | Elected via governance proposal (§2); 12-month term |
| 5 | Security researcher | Independent, reputation-based; can overlap with slot 3 if a single auditor fills both disclosures — but then threshold drops to 3-of-4 conceptually, which is rejected; the slots MUST be five distinct pubkeys |

Bootstrap (§5) initializes slots 1–3 from existing protocol stakeholders; slots 4–5 are filled within 60 days of bootstrap via the first governance cycle.

#### 1.2 `AEP_VALIDATORS` authority — **5-of-9**

A community validator collective. Membership is **not hardcoded** in code or ADR — it is stored on-chain as the multisig signer set and rotates per §4.

| Slot | Source | Initial term |
|---|---|---|
| 1–3 | Validators nominated by the protocol multisig at bootstrap | 6 months |
| 4–6 | Validators self-nominated, approved by community vote | 12 months |
| 7–9 | Validators nominated by existing validator collective | 12 months |

Rationale for 5-of-9 vs. 3-of-5: the validator collective attests to **third-party behavioral observations**, which by design have a larger and more diverse signer pool than protocol-endorsed attestations. Raising the threshold beyond simple majority prevents a 5-person clique from unilaterally shaping the community signal.

Explicitly rejected:

- **Single-signer per credential**: concentration risk; one key loss takes down the credential. Rejected for both authorities.
- **Unbounded signer set (permissionless)**: spam, trust dilution, impossible-to-audit attestation provenance. Rejected.
- **Identical composition for both credentials**: collapses the protocol/community distinction that §3 of ADR-061 exists to preserve. Rejected.

### 2. Proposal format

**Off-chain proposal venue; on-chain multisig execution.**

All changes to either credential authority (add / remove / rotate signer; emergency suspension) follow a two-stage process:

1. **Proposal** published at a stable URL — GitHub Discussions in the protocol repo, under a pinned `governance` category. Each proposal gets a monotonic ID (`AEP-GOV-NNN`) and is **never edited after voting opens**; corrections go in a successor proposal.
2. **Execution** via the relevant multisig after the proposal passes the §3 threshold and the required notice window (§4) elapses.

Required proposal fields:

| Field | Purpose |
|---|---|
| `id` | `AEP-GOV-NNN`, monotonic |
| `rationale` | Why the change is needed; what problem it solves |
| `affected_credential` | One of `AEP_PROTOCOL`, `AEP_VALIDATORS`, or both |
| `action` | `add_signer` \| `remove_signer` \| `rotate_signer` \| `suspend_credential` \| `resume_credential` |
| `target_pubkey` | The signer pubkey being added / removed / rotated (base58) |
| `replacement_pubkey` | Required for `rotate_signer`; empty for others |
| `effective_date` | Earliest date the multisig will execute (must respect §4 notice windows) |
| `fallback_plan` | What happens if the proposal fails — e.g., keep current signer, initiate emergency path, escalate to authority suspension |
| `possession_proof` | For `add_signer` / `rotate_signer`: Ed25519 signature by the new signer over the proposal ID, proving key possession |
| `auditor_cosign` | Required for emergency actions (§6); SHA-256 + pubkey of a designated auditor sign-off |

**Why off-chain + on-chain execution, not fully on-chain governance:**

- Rejected for v1: on-chain governance programs (Squads, Realms) add substantial infra surface — program accounts, voter registrars, token-weighted vote tallying — for a process that will see on the order of 10–30 proposals per year. The overhead is disproportionate.
- Off-chain proposals at a stable URL are **audit-able**: GitHub Discussions are append-only for practical purposes (edits are visible in history), provide free-form discussion, and have an existing authentication story.
- The actual authority change still lands on-chain (multisig execution against the SAS credential PDA), so the irrevocable step retains on-chain provenance.
- When volume grows or external stakeholders demand token-weighted voting, ADR-066 (§9) supersedes this section without disturbing the multisig substrate.

### 3. Voting thresholds

Thresholds apply to the **multisig signing** stage, not the off-chain discussion. The off-chain discussion is informative only — it establishes rationale, surfaces objections, and creates an auditable paper trail. Final authority is the on-chain multisig signature count.

| Action | `AEP_PROTOCOL` (3-of-5) | `AEP_VALIDATORS` (5-of-9) | Notice window |
|---|---|---|---|
| Add signer | **4-of-5** (supermajority) | **7-of-9** (supermajority) | 14 days |
| Remove signer (routine) | **4-of-5** | **7-of-9** | 14 days |
| Rotate signer (atomic add + remove) | **4-of-5** | **7-of-9** | 14 days |
| Emergency remove (signer compromised) | **3-of-5** + auditor co-sign | **5-of-9** + auditor co-sign | 0 days (immediate) |
| Emergency rotate (compromised signer replacement) | **3-of-5** + auditor co-sign | **5-of-9** + auditor co-sign | 0 days (immediate) |
| Authority suspension (pause issuance under credential) | **3-of-5** (simple majority) | **5-of-9** (simple majority) | 0 days |
| Authority resumption | **4-of-5** | **7-of-9** | 7 days |

Rationale:

- **Supermajority for routine changes** (all-but-one): signer set changes are rare enough, and durable enough, that forcing near-unanimous agreement is cheap. It also prevents a simple-majority clique from drifting the authority composition over time.
- **Simple majority + auditor co-sign for emergency**: a compromised key must be removed fast. Waiting for all-but-one approval gives the attacker a window. The auditor co-sign (a designated, pre-registered external signer — separate from the §1 slots — whose sole role is emergency co-signing) prevents the simple-majority threshold from being used to force a non-emergency removal.
- **Suspension is asymmetric**: entering suspension is fast (simple majority, no notice) because it's reversible and limits blast radius; exiting suspension is slow (supermajority, 7-day notice) because it re-enables issuance and should face the same scrutiny as a signer add.
- **No proposal can modify its own thresholds**: changing the threshold schedule itself requires a superseding ADR (see ADR-066 in §9).

### 4. Routine rotation procedure

A contributor steps down; a new contributor takes their slot. No compromise, no emergency.

1. **T–14 days: public notice.** Proposal `AEP-GOV-NNN` posted with `action: rotate_signer`, `target_pubkey`, `replacement_pubkey`, `rationale`, `effective_date ≥ T+14`.
2. **T–14 to T–7: discussion window.** Community / stakeholders review and object if applicable. Objections are recorded in the proposal thread but do not veto — only the multisig threshold does.
3. **T–7: new-signer possession proof.** Replacement signer publishes an Ed25519 signature over the string `"AEP-GOV-NNN:rotate:<replacement_pubkey>"` in the proposal thread. This proves the replacement controls the private key and prevents accidentally-committed pubkey typos.
4. **T–3: multisig pre-signing coordination.** Existing multisig members coordinate signing (off-chain, out-of-band); a serialized partial-signed transaction is circulated.
5. **T (effective_date): on-chain execution.** The multisig submits the SAS admin instruction that updates the credential's signer set — atomically add `replacement_pubkey` and remove `target_pubkey`. The transaction signature is recorded in the proposal thread and in the transparency log (§7).
6. **T+0 to T+7: post-rotation attestation audit.** A designated auditor (can be one of the §1 signers, rotates per rotation) enumerates all attestations issued under the credential by the departing signer in the preceding 180 days and confirms:
   - No attestation was issued after the possession-proof timestamp by the departing key.
   - No attestation's on-chain signature mismatches the attestation's declared signer.
   - The departing signer has no outstanding drafts or pending issuances.
   Audit results are appended to the proposal thread.

Total routine-rotation wall-clock: 14 days from notice to on-chain execution; 21 days to audit close.

### 5. Bootstrap ceremony (v1)

Performed when this ADR moves from Proposed to Accepted and the two credentials are first created.

**Devnet dry run (mandatory precursor)**

1. Protocol multisig generates `<aep_authority_devnet>` and `<validators_authority_devnet>` keypairs locally; pubkeys published in the ceremony transcript.
2. `AEP_PROTOCOL` credential PDA created on devnet via SAS admin instruction, signed by the existing program-upgrade multisig. Seeds: `["credential", <aep_authority_devnet>, "AEP_PROTOCOL"]`. Transaction signature logged.
3. `AEP_AGENT_REPUTATION_v1` schema PDA created on devnet under the `AEP_PROTOCOL` credential, per ADR-061 §2 layout.
4. `AEP_VALIDATORS` credential PDA created on devnet, signed by the same multisig. Initial validator set: three pubkeys nominated by the protocol multisig at ceremony time; four additional slots left empty pending the §1.2 first governance cycle.
5. End-to-end smoke test: issue a sample attestation under each credential, resolve it via the off-chain resolver path (ADR-064 dependency), confirm `@agenomics/sas-resolver` returns the expected structured output.
6. Devnet PDAs are **kept as historical reference**, not closed. They serve as a public rehearsal record.

**Mainnet ceremony**

Executed no earlier than 7 days after the devnet dry run, to allow independent review.

1. Witnesses: the five `AEP_PROTOCOL` prospective signers (§1.1), plus at least one external security researcher explicitly named in the ceremony announcement, plus a publicly-visible video or live-stream attestation of the ceremony (optional but recommended).
2. `AEP_PROTOCOL` PDA creation transaction signed by the Registry program-upgrade multisig (existing mainnet). Transaction signature published in the transparency log (§7).
3. `AEP_AGENT_REPUTATION_v1` schema PDA attached.
4. `AEP_VALIDATORS` PDA creation transaction signed by the same multisig. Initial 3 validator signers nominated by the protocol multisig; slots 4–9 filled per §1.2 within 60 days.
5. Post-ceremony checklist (must all be true before closing the ceremony record):
   - Devnet and mainnet PDAs both resolvable via `@agenomics/sas-resolver`.
   - All signer pubkeys verified on the multisig account state.
   - Transparency-log entries published (§7).
   - ADR-061 updated with the mainnet PDA addresses in a documentation-only follow-up PR.
6. The ceremony transcript (witness list, signer pubkeys, transaction signatures, timestamps) is committed to the protocol repo under `docs/governance/ceremony-2026-XX-XX.md`.

Everything in §5 is one-shot — this ADR does not prescribe bootstrap for hypothetical future credentials; those are handled by whichever ADR adds them (ADR-061 §3 governance path).

### 6. Emergency procedures

#### 6.1 Single-signer compromise

Triggered when a signer's private key is believed lost, leaked, or coerced.

1. **T–0: declare.** Any multisig member (or the compromised signer themselves) posts an emergency proposal with `action: rotate_signer`, `rationale: signer_compromise`, auditor co-sign pre-fetched.
2. **T+0 to T+2h: suspend issuance.** The credential is put into suspended state (§3 threshold: simple majority). Any attestations from the compromised signer's pubkey after T–0 are presumptively invalid.
3. **T+2h to T+24h: rotate.** Emergency rotate threshold (§3) applied; new signer replaces compromised signer on-chain.
4. **T+24h to T+7d: retroactive audit.** Audit all attestations signed by the compromised key in the suspected compromise window (conservatively: since last known-good event, typically 30–90 days). Attestations issued during that window are **flagged** in the transparency log (§7). Consumers choosing to honor them is their call; the protocol does not retroactively revoke — revocation is an authority action, and the authority may choose to close the affected attestations explicitly.
5. **T+7d: resume.** Credential resumption proposal posted (requires 7-day notice, supermajority — §3).

#### 6.2 Authority compromise (multiple signers lost simultaneously)

Below-threshold-loss (e.g., 1 signer of 3-of-5 lost): treat as §6.1.

At-or-above-threshold loss (e.g., 3 of 5 signers lost) — the multisig itself cannot sign:

1. Immediately publish an emergency governance proposal escalating to a **new multisig creation**. The protocol program-upgrade multisig (which is structurally a different key set in practice — not strictly guaranteed, but operationally maintained) signs the creation of a replacement SAS authority.
2. Historical attestations under the old authority **remain valid** unless the new authority explicitly closes them. Rationale: attestations issued before compromise were issued by (at the time) legitimate signers; invalidating them retroactively punishes the attested-about agents for governance failures they had no part in.
3. The old credential PDA is put into permanent suspension and documented as such.
4. Consumers and resolvers are notified via the transparency log (§7) that future attestations of this schema will be issued under the new credential PDA; the resolver allowlist (ADR-064) is updated.

#### 6.3 Schema vulnerability

If `AEP_AGENT_REPUTATION_v1` itself is found to have a flaw (integer overflow in score encoding, ambiguous field semantics, etc.), schema rotation is handled by a new ADR (tentatively ADR-065 in ADR-061 §9's numbering, or a superseding ADR). This ADR does not govern schema versioning — only credential authorities.

### 7. Transparency requirements

**Append-only issuance log.** Every attestation issuance under `AEP_PROTOCOL` or `AEP_VALIDATORS` is logged to a public append-only JSON feed. Log entries include: attestation PDA, credential, schema, signer pubkey, subject pubkey, expiry, transaction signature, and issuance timestamp. **No attestation data payload is mirrored in the log** — that would duplicate the on-chain state and create a second source of truth; the log is an index, not a cache.

Storage: IPFS or GitHub (repo: `agenomics-labs/protocol`, path: `governance/attestation-log/YYYY-MM/`). The log is published hourly by a designated off-chain worker; a failure to publish does not block issuance, but a persistent publication gap (> 24h) triggers a transparency incident proposal.

**Quarterly publication.** Every calendar quarter, governance publishes:

- Total attestations issued per credential.
- Signer-level issuance counts (aggregated per credential).
- Rotation events for the quarter.
- Revocations / closures, if any.
- Any transparency incidents (missed publications, log gaps, post-hoc corrections).

Published to the protocol repo and linked from the documentation site.

**Signer identities.** Each signer pubkey on either credential is published in the repo under `docs/governance/signers.md`. Per-signer real-world identity disclosure is **optional** — a signer may choose to remain pseudonymous behind the pubkey. The community-elected slot (`AEP_PROTOCOL` slot 4) and the auditor co-signer MUST publish real-world identity; all other slots MAY. The pubkey itself is always public — pseudonymity here is about the human, not the key.

## Alternatives Considered

### Alternative A: On-chain governance program (Squads, Realms)
**Rejected for v1.** On-chain governance frameworks are mature and battle-tested, and would ultimately provide stronger guarantees than off-chain proposals. They are rejected for v1 because: (a) AEP's governance volume is projected at 10–30 proposals per year — the overhead of running a governance program for that volume is disproportionate; (b) integrating a governance program creates a new on-chain surface with its own upgrade cadence, contradicting the loose-coupling principle ADR-061 established; (c) the actual authority change still lands on-chain via multisig regardless of where the proposal lives. ADR-066 (§9) tracks on-chain governance as a future upgrade path.

### Alternative B: Single-signer per credential
**Rejected.** Concentration risk is immediate and severe — one lost key takes down the credential. Conflicts with SAS's native multi-signer model. No compensating benefit.

### Alternative C: No governance (permissionless authority creation)
**Rejected.** SAS allows anyone to create a credential with any name, so "permissionless" is the default SAS behavior. The governed `AEP_PROTOCOL` and `AEP_VALIDATORS` authorities exist precisely so consumers have an authoritative set to trust. Abandoning governance would make the two named credentials indistinguishable from any impersonation attempt — a consumer would have no way to know which `AEP_PROTOCOL`-named credential is the real one.

### Alternative D: Time-locked rotation only (no emergency path)
**Rejected.** A 14-day delay on a compromised-key rotation gives an attacker a 14-day window of silently-forged attestations. Emergency rotation with auditor co-sign is the correct trade: fast enough to close the window, gated enough to prevent misuse.

### Alternative E: Shared authority (one multisig owns both credentials)
**Rejected.** Collapses the `AEP_PROTOCOL` / `AEP_VALIDATORS` distinction that ADR-061 §3 exists to preserve. A single compromise would take down both the canonical and the community signals simultaneously. Separate authorities preserve defense in depth.

### Alternative F: Token-weighted voting from day one
**Rejected for v1.** AEP does not currently have a governance token. Introducing one purely to gate SAS authority changes would conflate governance with tokenomics and create speculation pressure on a mechanism that should be process-driven, not market-driven. Tracked in ADR-066 as a possible future direction if/when a governance token emerges for other reasons.

## Consequences

### Positive
- **Clear accountability.** Every authority change has a named proposal, a signing multisig, and an on-chain transaction. Provenance is auditable end-to-end.
- **Reuses existing trust surface.** `AEP_PROTOCOL` binds to the same multisig that already controls Registry upgrades — no new key infrastructure, no new compromise surface.
- **Separation of concerns preserved.** Protocol-endorsed vs. community-observed attestations remain under distinct authorities with distinct trust models.
- **Emergency path is credible.** Simple-majority + auditor co-sign + 0-day notice is fast enough to respond to real key compromise, and gated enough to prevent misuse.
- **Transparency log makes misuse visible.** Even if an authority acts against community interests, the append-only issuance log makes the misuse publicly observable.
- **Off-chain proposal venue is lightweight.** GitHub Discussions require zero new infra; migration to a different venue (or to on-chain governance) is a process change, not a code change.

### Negative
- **New process surface.** Maintaining the proposal workflow, transparency log, and quarterly publications requires ongoing governance effort. Projected: 1–2 hours per proposal, quarterly-report authoring overhead.
- **14-day routine rotation wall-clock.** Routine signer changes are slow. Acceptable because rotations are rare, but creates friction when a contributor wants to step down gracefully.
- **Bootstrap is coordinated.** The §5 ceremony requires multisig-member availability, witness coordination, and a devnet-to-mainnet gap. Cannot be done async.
- **Off-chain proposal venue can be censored or lost.** GitHub Discussions are a centralized store. If the venue becomes unavailable, governance is disrupted. Partially mitigated by appending proposal state to the transparency log (§7); fully addressed only by ADR-066's eventual migration path.
- **Auditor-slot availability is a dependency.** Emergency rotations require the auditor co-signer to be reachable within hours. The auditor slot is a named role with a documented escalation contact (not specified in this ADR — captured in the ceremony transcript).

### Neutral
- **Off-chain proposal venue can evolve independently.** Moving from GitHub Discussions to another venue (forum, Snapshot, on-chain governance) does not require re-signing any existing credentials — the venue is metadata about *how* proposals are discussed, not about *what* gets executed on-chain.
- **No impact on Registry, Settlement, Vault, or MCP-server code.** Governance is entirely process + off-chain tooling + existing multisig usage. This ADR does not add any on-chain surface.
- **Quarterly publication cadence is a recommendation.** A missed quarter is a transparency incident but not a protocol-level failure. The cadence can be tightened or loosened per governance feedback.

## Open items / follow-up ADRs

- **ADR-066**: On-chain governance upgrade path. If the protocol outgrows multisig-executed off-chain proposals — for example, if volume grows past ~100 proposals per year, or if token-weighted voting becomes desirable — this ADR lays out the migration from the current model to a full on-chain governance framework (Squads, Realms, or a custom program). Supersedes §2 and §3 of this ADR.
- **ADR-067**: Cross-protocol credential trust. Whether SAS attestations issued under AEP authorities are accepted by external protocols, and conversely, whether external-protocol SAS attestations are surfaced by the AEP resolver. This is a policy question about the `@agenomics/sas-resolver` (ADR-064) allowlist and is independent of the authority governance in this ADR.

## References

- `docs/adr/ADR-061-sas-integration.md` — SAS integration model, §3 credential authorities (deferred governance details to this ADR)
- `docs/adr/ADR-060-capability-descriptor-format.md` — identity / reputation / capabilities separation doctrine
- `docs/adr/ADR-020-reputation-staking.md` — native Registry reputation state (`reputation_stake`, slashing, `Suspended` transition)
- `docs/adr/ADR-028-anti-sybil-defense.md` — economic defenses backing native reputation
- `docs/adr/ADR-031-mainnet-deployment.md` — existing mainnet program-upgrade multisig, reused for `AEP_PROTOCOL`
- `docs/adr/ADR-081-emergency-suspend-credential.md` — operationalizes §6.1 step 2 (T+2h suspend); ships `scripts/emergency-suspend-credential.ts` plus stub follow-ups for the T+24h rotate and T+7d audit steps
- `scripts/emergency-suspend-credential.ts` — the suspend script referenced by §6.1 step 2; idempotent / resumable; auditor cosign enforced
- `programs/agent-registry/**` — current on-chain surfaces (unchanged by this ADR)
- SAS documentation — credential PDA layout, multi-signer authority admin instructions, attestation closure semantics
- `docs/KEY_MANAGEMENT.md` — operational key inventory, tiering, and backup procedure for the keys this protocol actually uses today (devnet deployer, Squads devnet signers, CI secrets). Added 2026-07-01 after a same-host key-loss incident; complements this ADR's §6 emergency procedures for the (not-yet-bootstrapped) SAS credential multisig specifically.

## Concrete Proposal (decision-ready — maintainer fills bracketed blanks)

> **Status note:** This section is **non-normative until accepted**. It does
> not change the ADR Status (stays **Proposed**) and does not alter any
> canonical section above. It exists so the maintainer can *approve or
> adjust* a concrete custody design rather than design one from scratch.
> It mirrors the `## Maintainer Decision Required` precedent established in
> PR #186 and is appended after `## References` so the ADR-lint
> section-order check (Status → Date → Context → Decision → Consequences)
> is never disturbed. Cross-reads with **ADR-078 §Concrete Proposal**
> (the mainnet gate that consumes these seats), **ADR-079** (Accepted —
> every seat below is bound by its §4 hardware/KMS custody rules), and the
> cycle-4 **SDK-F1 / AUD-207** context (program IDs stay placeholders
> until ADR-078 transfers authority onto the multisig these seats define).

### CP-1. Recommended structures (maintainer confirms or adjusts the numbers)

| Authority | Recommended composition | Routine threshold | Emergency threshold | Why this shape |
|---|---|---|---|---|
| `AEP_PROTOCOL` | **Squads V4 3-of-5** | 4-of-5 (§3) | 3-of-5 + auditor co-sign (§3) | Protocol-endorsed attestations must not be weaker than the trust set that can change the protocol itself (§1.1). 5 seats give one-seat-loss tolerance at the emergency threshold without dropping below simple majority. |
| `AEP_VALIDATORS` | **Squads V4 5-of-9** | 7-of-9 (§3) | 5-of-9 + auditor co-sign (§3) | Community behavioral observations have a larger, more diverse signer pool; 5-of-9 stops a 5-person clique while tolerating loss of up to 4 seats before the multisig is inoperable (§1.2). |

Squads V4 supplies every primitive natively — per-member **Proposer / Voter
/ Executor** role separation, a configurable **threshold**, a per-multisig
**time-lock** field, and **spending-limit** scoping — so no custom
governance program is needed (confirms *Alternatives Considered* A). The
seat *taxonomy* below maps onto Squads V4 roles: operator seats are
Proposer+Voter+Executor; the independent auditor seat is Voter-only
(co-sign without initiating); the cold-backup seat is Voter-only and
normally offline.

### CP-2. Seat taxonomy and security rationale (`AEP_PROTOCOL` 3-of-5)

| Seat | Class | Squads V4 role | Custody (ADR-079 §4) | Security rationale |
|---|---|---|---|---|
| 1 | Operator — founder/protocol lead | Proposer+Voter+Executor | Hardware (Ledger/YubiKey) | Long-tenure broad context; initiates routine proposals. Operator class = day-to-day governance throughput. |
| 2 | Operator — key engineering contributor | Proposer+Voter+Executor | Hardware | Active committer; second independent operator so no single human can reach routine threshold alone. |
| 3 | **Independent auditor seat** | Voter-only | Hardware, distinct firm/custodian | External firm, NOT a protocol operator. Voter-only so it co-signs but cannot *initiate* a self-serving change — this is the seat that makes the emergency "+ auditor co-sign" threshold meaningful (§3). |
| 4 | Operator — community-elected signer | Proposer+Voter+Executor | Hardware or ≤1 KMS slot | 12-month term, real-world identity disclosed (§7). Adds a non-core-team check on operator class. |
| 5 | **Cold-backup seat** | Voter-only, normally offline | Hardware, air-gapped, separate custodian | Security researcher / independent. Held offline; brought online only to cross the 4-of-5 routine threshold or as the swing vote in emergency. Distinct hardware + distinct custodian from seats 1–4 so a single-site or single-custodian compromise cannot reach threshold. |

KMS is capped at ≤2 of 5 slots per ADR-079 §4 and recommended for at most
seat 4; seats 3 and 5 (auditor + cold-backup) MUST be hardware to preserve
the Byzantine-fault intent.

### CP-3. Correlated-failure analysis

The 3-of-5 only delivers its guarantee if no single failure domain spans
the threshold. Required separations (maintainer verifies when filling
blanks):

- **Distinct hardware vendors across seats 3 and 5** — do not put the
  auditor seat and the cold-backup seat on the same wallet make/model; a
  vendor-wide firmware CVE must not take both.
- **Distinct custodians / physical sites** — seats 1 & 2 may share an org
  but seats 3 (external auditor) and 5 (cold-backup) MUST be different
  humans at different physical locations from each other and from the
  operator class.
- **No human holds two seats** (ADR-079 §4 device-level rule) and **no
  human is also a program-upgrade signer** (Audit-3 gap #16 — the
  `AEP_PROTOCOL` signer set ≠ ADR-078 program-upgrade signer set).
- **Auditor seat is not a protocol operator** — if seat 3 were an operator,
  emergency "+ auditor co-sign" collapses to "operators agree with
  themselves."

### CP-4. The exact bracketed blanks the maintainer must fill

`AEP_PROTOCOL` (3-of-5):

- `[signer-1 principal]` — operator/founder pubkey + custody attestation
- `[signer-2 principal]` — operator/engineering pubkey + custody attestation
- `[independent auditor identity]` — seat 3: named external firm + pubkey + real-world identity disclosure (§7)
- `[signer-4 principal]` — community-elected pubkey + identity disclosure (§7); term start date
- `[signer-5 principal]` — cold-backup pubkey + custodian name + air-gap site
- `[threshold confirm/adjust]` — confirm 3-of-5 routine=4-of-5 / emergency=3-of-5+auditor, or adjust with rationale
- `[emergency auditor co-signer]` — the pre-registered §6 emergency co-signer (may be the seat-3 firm or a separate named auditor; if separate, its pubkey)

`AEP_VALIDATORS` (5-of-9):

- `[validators initial slate ×9]` — 9 pubkeys per §1.2 sourcing (3 protocol-nominated, 3 self-nominated+community-approved, 3 collective-nominated); seats 4–9 may land within 60 days of bootstrap
- `[threshold confirm/adjust]` — confirm 5-of-9 routine=7-of-9 / emergency=5-of-9+auditor

### CP-5. Decide-first ordering

**Decide the independent auditor seat (seat 3) first.** Rationale: it is
the single seat that (a) gates the §6 emergency fast-path (no auditor =
emergency threshold is unusable per "Pending items before Accept" #2), (b)
must be an *external* identity with the longest recruitment lead time, and
(c) is the explicit cross-dependency ADR-078 §5 checks
("cross-multisig non-overlap"). Operator seats 1–2 are effectively known
(current stakeholders, bootstrap §5 slots 1–2); seats 4–5 and the
`AEP_VALIDATORS` slate have a documented 60-day post-bootstrap fill window.
The auditor seat has neither a known incumbent nor a deferral window — it
is the critical path.

**Decision reduces to: 7 bracketed inputs for `AEP_PROTOCOL` (5 principals
+ threshold confirm + emergency auditor) and 2 for `AEP_VALIDATORS` (9-seat
slate + threshold confirm) — decide the independent auditor seat first.**
