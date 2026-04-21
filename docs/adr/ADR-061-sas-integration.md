# ADR-061: SAS integration model — manifest-referenced attestations, Registry keeps authoritative state

## Status
Accepted

## Date
2026-04-21

## Context

`solana-attestation-service` (SAS) is a Solana Foundation primitive for issuing, storing, and verifying third-party claims ("attestations") about on-chain subjects. SAS answers "did signer X, acting under credential C, say Y about subject Z, per schema S?" — it is **reputation / credential substrate**, not identity and not capability.

AEP already owns three separate concerns:

- **Identity** — `AgentProfile` in `programs/agent-registry/src/state.rs` (authority, name, category, status, vault_address).
- **Reputation** — `reputation_score`, `reputation_stake { staked_amount, slash_count }`, `total_tasks_completed`, `avg_rating`, slashing → `Suspended` state (ADR-020, ADR-028).
- **Capabilities** — off-chain `CapabilityManifest` referenced via `manifest_cid` + `manifest_hash` + `manifest_signature` + `manifest_version` on the Registry profile (ADR-060).

ADR-060 §2 reserved one forward-compatible hook for SAS: the manifest's `agent.owner_attestation?: string` field, explicitly typed as "optional SAS attestation pubkey for reputation link (ADR-061)." ADR-060 §6 also explicitly rejected SAS as the capability schema itself: *"SAS answers 'did X say Y about agent Z?' — it's a reputation / claims substrate. A capability manifest answers 'what can agent Z do, and with what cost/signature/I-O shape?' — it's a contract."*

The open question — tracked as decision #8 in `docs/SOLANA_ECOSYSTEM_ANALYSIS.md` — is **how deep** the Registry couples to SAS:

> SAS integration depth — wrap SAS attestations from the Registry (lightest touch) vs. make Registry a SAS client (Registry stores SAS attestation pointers) vs. bypass SAS entirely (heaviest disagreement).

SAS substrate findings (from `docs/SOLANA_ECOSYSTEM_ANALYSIS.md` §3.1):

- **Stack**: Rust (pinocchio-based, `no_std`) + TS SDK. Custom serialization (not Borsh).
- **Schema Registry**: schemas define typed data layouts (U8–U128, Bool, Char, String, Vec). PDA seeds: `["schema", credential, name, version]`.
- **Credentials**: multi-signer authority. PDA seeds: `["credential", authority, name]`.
- **Attestations**: bind schema + credential + signer + data + expiry. PDA seeds: `["attestation", credential, schema, nonce]`.
- **Tokenization**: optional NFT wrapper per attestation (soulbound credentials).

This ADR resolves decision #8 and specifies the resolution flow, schema layout, credential authority governance, and merge semantics with the Registry's native reputation fields. It is **DOCS-only** — no program or SDK changes land with this ADR. Implementation work is scoped to follow-up ADRs (see §9).

## Decision

### 1. Integration depth — option B (manifest-referenced, loose coupling)

Three options were evaluated against decision #8:

| Option | Coupling | Who resolves SAS | On-chain cost | Upgrade cadence |
|---|---|---|---|---|
| **A** Registry-as-SAS-client | Tightest — Registry reads/verifies SAS CPI-style or via indexer | On-chain or Registry worker | Registry account +32 bytes per attestation pointer, possibly a Vec; new CPI surface | Registry program upgrade every SAS schema change |
| **B** Manifest-references-SAS *(accepted)* | Loose — manifest carries the attestation pubkey, consumers resolve off-chain | Off-chain consumer | Zero on-chain cost beyond ADR-060's 162 bytes | Independent — SAS schema evolves on its own cadence |
| **C** Bypass SAS | None — Registry owns all reputation state | N/A | Zero | Registry only |

**Decision: option B.** The manifest's existing `agent.owner_attestation?: string` field (ADR-060 §2) carries a base58 SAS attestation pubkey. Consumers dereference it via the SAS SDK off-chain; AEP programs never read SAS accounts.

Rationale:

- Preserves the **identity / reputation / capabilities** separation ADR-060 §6 explicitly called out. Collapsing any two of the three ties their upgrade cycles together, which is exactly the pathology the separation exists to prevent.
- Registry program upgrades are the slowest, most cautious artifact in the stack (on-chain, IDL-versioned, Anchor-constrained, affects every deployed agent). Making it a SAS client couples it to SAS's release cadence for zero protocol-logic benefit — Settlement CPIs do not need SAS data to decide payouts.
- Zero new on-chain surface. Zero new custody surface. Zero new CPI edges. Option A would add at minimum an attestation-pubkey field, arguably a Vec of pointers, and either a CPI to SAS or a trust-the-indexer compromise.
- Off-chain resolution cost is already paid: consumers fetch the manifest from IPFS / Arweave (ADR-060 §4), so adding a SAS lookup is an incremental — not net new — fetch.
- Additive: option B does not preclude option A as a v2 enhancement. If a concrete Settlement use-case emerges that needs SAS data on-chain, a later ADR can lift option B's off-chain resolution into program state without rewriting manifests in the field.

### 2. Schema — `AEP_AGENT_REPUTATION_v1`

AEP publishes **one canonical SAS schema** for baseline agent reputation. The schema is deliberately minimal; richer signals (graph-of-graphs reputation, cross-protocol endorsements) compose out-of-band off-chain.

```
Schema name:    AEP_AGENT_REPUTATION
Schema version: 1
Schema PDA:     ["schema", credential, "AEP_AGENT_REPUTATION", 1]
```

Field layout (SAS typed encoding, not Borsh):

| Offset | Field | Type | Description |
|---|---|---|---|
| 0 | `score` | `U16` | Normalized reputation score, 0–10_000 (basis points of a 0.0–1.0 score). |
| 2 | `completed_tasks` | `U32` | Count of successfully completed tasks observed by the signer. |
| 6 | `dispute_ratio_bps` | `U16` | Disputes / total tasks in basis points (0–10_000). |
| 8 | `last_updated` | `I64` | Unix timestamp (seconds) of observation window end. |

Total: 16 bytes. This is not the NFT-wrapped soulbound variant; see §4.

Design notes:

- **Normalized score** rather than raw sum — prevents stale-range drift as the protocol scales.
- **No identity fields** — subject is determined by the attestation's `subject` pubkey (the agent authority), which is intrinsic to SAS, not schema data.
- **No signer identity** — attestation's `signer` pubkey is intrinsic to SAS.
- **No free-form strings** — prevents the "LLM-prompt-shrapnel" regression ADR-060 called out for skills formats.
- **Explicit scope**: this schema is the **baseline** only. Additional schemas (`AEP_AGENT_KYC_v1`, `AEP_AGENT_EXPERTISE_v1`, cross-protocol endorsement schemas) may be published later under their own ADRs; consumers MUST treat missing auxiliary schemas as "no signal," not as failure.

### 3. Credential authorities

SAS credentials are multi-signer. AEP defines **two credential authorities** at v1, with a governance path to add more:

| Credential | PDA | Signer set | Purpose |
|---|---|---|---|
| **AEP Protocol Authority** | `["credential", <aep_authority>, "AEP_PROTOCOL"]` | Protocol governance multisig (same multisig that gates Registry program upgrades) | Baseline attestations derived from on-chain Registry state (reputation_score, dispute outcomes). Canonical — resolvers may treat as protocol-blessed. |
| **AEP Validators Collective** | `["credential", <validators_authority>, "AEP_VALIDATORS"]` | N-of-M community validators; membership governed by the protocol multisig | Community-signed behavioral observations (e.g., third parties attesting a agent completed a task outside the Settlement path). Non-canonical — consumers may weight lower. |

**Governance for adding / removing credential authorities:**

- Adding a new credential authority requires a proposal referencing this ADR (or a superseding one) and approval by the protocol governance multisig.
- Removing / rotating a credential authority follows the same path; existing attestations remain valid until expiry (§6) or superseding credentials are issued.
- Detailed voting thresholds, proposal format, and multisig composition are out of scope for this ADR — tracked as **ADR-063** (§9).

Explicitly **not** blessed in v1: arbitrary third-party credentials. A consumer is free to resolve any SAS attestation, but the AEP-published resolver (`@agenomics/sas-resolver`, tracked as ADR-064) ships with an allowlist containing only the two authorities above. Extending the allowlist is a consumer-side decision.

### 4. Resolution flow

When a consumer (another agent, an indexer, a UI) looks up an agent:

```
1. Fetch AgentProfile
   └─ from Registry account by (authority, "agent-profile") PDA

2. Extract manifest pointer
   └─ manifest_cid + manifest_hash + manifest_signature + manifest_version

3. Fetch off-chain manifest
   └─ IPFS / Arweave by manifest_cid
   └─ verify SHA-256(canonical_json(bytes)) == manifest_hash
   └─ verify Ed25519(manifest_hash, authority) == manifest_signature

4. If manifest.agent.owner_attestation is set:
   a. Parse the base58 pubkey → SAS attestation PDA
   b. Fetch the attestation account via SAS SDK
   c. Verify attestation.schema == AEP_AGENT_REPUTATION_v1 schema PDA
   d. Verify attestation.credential is in the allowed-authorities set
   e. Verify attestation.expiry is not elapsed (see §6)
   f. Verify attestation.subject == AgentProfile.authority
      (defense-in-depth — manifest author could reference an attestation
       about a different subject, accidentally or adversarially)
   g. Parse attestation.data per the AEP_AGENT_REPUTATION_v1 layout

5. Merge with Registry native state (see below)
```

**Failure modes in the resolution flow.** Each step of §4 can fail independently. The reference resolver (ADR-064) treats them asymmetrically:

| Step | Failure | Resolver behavior |
|---|---|---|
| 1 | AgentProfile missing / unreadable | Hard error — the agent does not exist. |
| 2–3 | Manifest CID fetch fails / hash mismatch / signature mismatch | Hard error — manifest integrity is a protocol invariant (ADR-060 §1). |
| 4a | `owner_attestation` unset or empty | Skip — not an error. Agent simply hasn't published a SAS link. |
| 4b | SAS attestation account missing / closed | Treat as "no attestation" (see §6). Surface `absent: true` to caller. |
| 4c–d | Schema or credential-authority mismatch | Skip this attestation, log a warning. Do not escalate — an agent may reference an unsupported schema and the resolver should not consider that a manifest failure. |
| 4e | Expired | Skip + `stale: true` flag (see §6). |
| 4f | Subject pubkey mismatch | **Hard error.** A subject mismatch is either an agent mistake (accidentally referencing someone else's attestation) or adversarial (trying to borrow a stronger agent's reputation). Never silently paper over. |
| 4g | Data parse failure (malformed per `AEP_AGENT_REPUTATION_v1`) | Skip + warn. Schema-mismatch guard (4c) should catch this upstream; the explicit data-parse check is defense-in-depth. |

This asymmetry is deliberate: manifest integrity failures (steps 2–3) invalidate the agent's capability claims and must be hard errors; SAS lookup failures (most of step 4) degrade to "no reputation signal" because SAS is additive. Subject mismatch is the one exception inside step 4 — it's a provenance violation, not a signal absence.

**Merge semantics (Registry native + SAS):**

- Registry's `reputation_score`, `reputation_stake.staked_amount`, `slash_count`, `total_tasks_completed`, `avg_rating`, and `status` remain the **authoritative** protocol-enforced signals. These are the only values Settlement, Vault, and dispute programs read when making CPI decisions.
- SAS attestation data is **advisory / additive** only. Consumers MAY surface it alongside Registry values, MAY weight it for UX ranking, but MUST NOT substitute it for Registry state in protocol-level authorization decisions.
- When displaying a merged score, recommended UI convention is "`reputation_score` (Registry) + `score` (SAS, last_updated ≤ N days)" — surfaced side-by-side, not summed. Mixing them into a single numeric hides the provenance, which is the opposite of what this ADR is trying to preserve.
- A divergence between Registry `reputation_score` and SAS `score` by > 2000 bps (20 percentage points) SHOULD be flagged to the consumer as a staleness / disagreement signal. This threshold is a recommendation for `@agenomics/sas-resolver` (ADR-064), not a protocol rule.
- Consumers integrating the resolver into an automated decision path (e.g., a client-side auto-bidder choosing between agents) MUST document which side (Registry vs. SAS) drives the decision. Opaque blended weights are the failure mode this rule exists to prevent.

### 5. What stays in Registry vs. what lives in SAS

| Concern | Location | Rationale |
|---|---|---|
| `reputation_score` | **Registry** | Settlement reads this via CPI for tier-gated tasks. On-chain logic must be self-contained. |
| `reputation_stake.staked_amount` | **Registry** | Real economic stake — must be in custody of the Registry's staking PDA. |
| `reputation_stake.slash_count` | **Registry** | Drives automatic `Suspended` state transition (ADR-020 §5). Protocol enforcement. |
| `total_tasks_completed` | **Registry** | Incremented by Settlement CPI on milestone approval (ADR-020). |
| `avg_rating` | **Registry** | Same as above — protocol-authored, written by CPI. |
| `status` (Active/Paused/Retired/Suspended) | **Registry** | State machine enforced on-chain. |
| `capabilities: Vec<String>` | **Registry** (denormalized index) | ADR-060 §1 — search index for on-chain discovery. |
| Capability manifest (typed I/O, cost, preflight) | **Off-chain** (IPFS / Arweave) | ADR-060 §1 — manifest body. |
| Baseline reputation observation (SAS `AEP_AGENT_REPUTATION_v1`) | **SAS** (optional, additive) | Third-party readable, composable with wider SAS ecosystem. |
| KYC attestation | **SAS (pointer) + off-chain (data)** | PII MUST NOT be in the attestation data itself — see §7. |
| Expertise / certification claims | **SAS** | Additive; consumers choose which credentials to trust. |
| Cross-party endorsements | **SAS** | Graph-of-graphs reputation composes from signer set. |

**Rule of thumb**: on-chain protocol logic (Settlement CPI, dispute timing, slashing) must be self-contained in Registry. SAS adds decorative, contextual, or cross-ecosystem layers that off-chain consumers can compose.

### 6. Attestation lifecycle — expiry, revocation, versioning

**Expiry.** SAS attestations carry an expiry field. The resolver (ADR-064) treats an expired attestation as **absent** — it is silently skipped, not propagated as an error. Rationale: an agent publishing a manifest that references an expired attestation is equivalent to publishing a manifest with no `owner_attestation` — the agent is simply not making a third-party-backed reputation claim. Failing closed would penalize agents whose signer authorities are slow to re-attest. The resolver SHOULD surface expiry via a `stale: true` flag for UX, separately from the skip.

**Revocation.** SAS supports attestation closure by the issuing authority. When an attestation is closed, the PDA is gone and the resolver surfaces "absent" — indistinguishable from "never issued." Consumers requiring stricter provenance MAY cache historical attestation hashes off-chain; AEP does not maintain such a cache.

**Versioning.** Schema version is part of the SAS schema PDA seed. A future `AEP_AGENT_REPUTATION_v2` would have a distinct PDA; resolvers MUST treat v1 and v2 as independent signals during a deprecation window. The `@agenomics/sas-resolver` package tracks the supported schema set in its own semver — new schema versions ship via resolver upgrades, not Registry upgrades.

**Stale-data policy.** Attestations with `last_updated` older than 90 days SHOULD be weighted lower by consumers but not discarded. The 90-day threshold is a resolver-side convention, documented in ADR-064, not a protocol rule.

### 7. Privacy

SAS attestations are **public on-chain records**. Consequences:

- **No raw PII in attestation data.** KYC-style attestations MUST reference a secondary off-chain resolver (e.g., an IPFS CID pointing to encrypted KYC artifacts, or a URL to a KYC provider's verification API) rather than embedding PII bytes in `attestation.data`.
- The v1 `AEP_AGENT_REPUTATION_v1` schema (§2) is PII-free by design: only scores, counts, and a timestamp.
- Future schemas for expertise / certification claims MUST be reviewed against this rule before the corresponding credential authority is added (§3).
- Agents operating under pseudonymous authorities retain pseudonymity — SAS attestations about a pseudonymous pubkey do not de-anonymize it.

This follows the same pattern as ADR-060's manifest storage: the on-chain artifact is the **commitment**, the off-chain artifact is the **content**. PII-bearing content lives behind access control; only non-PII commitments touch the chain.

### 8. Scope boundary with `programs/**` and the SDKs

This ADR **changes no code**. Specifically:

- `programs/agent-registry/**` — unchanged. `AgentProfile` fields from ADR-060 are reused verbatim; no new fields, no new instructions, no new CPI edges.
- `@agenomics/capability-manifest-validator` (PR9, in flight) — unchanged. The validator already recognizes `agent.owner_attestation?: string` as an optional base58 pubkey; no SAS-specific validation is added here.
- `mcp-server/**` — unchanged. SAS resolution is not an MCP action in v1.

The SAS resolver is a **new, separate, off-chain TS package** — `@agenomics/sas-resolver` — tracked as ADR-064 (§9). It depends on SAS's TS SDK and implements the §4 flow. Keeping the resolver out of the Registry program is the concrete embodiment of decision-#8 option B.

## Alternatives Considered

### Alternative A: Registry-as-SAS-client (tight coupling)
**Rejected.** Would require adding an attestation-pointer field (or Vec) to `AgentProfile`, plus either a CPI to SAS on reads or trust in an off-chain indexer. Registry upgrade cadence (multisig-gated, on-chain) would dominate SAS schema evolution. Zero protocol-logic benefit: Settlement does not need SAS data for CPI decisions — `reputation_score` already covers that. The coupling pays ongoing cost for no protocol capability. ADR-060 §6 explicitly warned against conflating reputation and identity; this option re-couples them.

### Alternative B: Manifest-references-SAS (loose coupling)
**Accepted by this ADR.** Uses the ADR-060 §2 `owner_attestation?: string` field as the only integration point. Off-chain resolvers dereference. Zero new on-chain surface. Independent upgrade cadence. Additive — does not preclude a future v2 that lifts resolution on-chain if a concrete use case emerges.

### Alternative C: Bypass SAS entirely (AEP owns all reputation state)
**Rejected.** Gives up SAS-ecosystem network effects (cross-protocol signer authorities, reusable schemas, tooling, indexers) for a gain that is already achieved by option B (AEP Registry remains authoritative for protocol-logic reputation — see §5). Option C is a strictly smaller surface than B with no corresponding benefit.

### Alternative D: Federated reputation via signed JSON outside SAS
**Rejected.** AEP could publish its own "signed reputation claims" format outside SAS — essentially a parallel attestation substrate. Rejected because:
- Misses the on-chain signer-authority enforcement SAS provides (credential PDA with multisig).
- Misses the optional soulbound-NFT wrapper SAS offers.
- Forks from a production Foundation primitive for no architectural gain.
- Creates a new standard when one already exists — exactly the pattern ADR-058 §9 / ADR-059 §9 warned against (reinventing ecosystem primitives).

### Alternative E: Hybrid — B today, A later
**Explicitly allowed, not rejected.** Option B does not preclude option A. If, after deploying option B, a concrete Settlement use case emerges that genuinely requires SAS data on-chain (e.g., a dispute resolution program reading cross-protocol endorsement attestations), a later ADR can supersede this one and add Registry-side resolution. Option B is the right v1; option A is a possible v2 trigger, not a contradiction.

## Consequences

### Positive
- **Separation of concerns preserved.** Identity (Registry core), reputation (Registry native + SAS additive), capabilities (manifest) remain three independent artifacts with independent upgrade cadences — the explicit design goal of ADR-060 §6.
- **SAS-ecosystem network effects accessible.** Any third-party wallet, indexer, or aggregator that already resolves SAS attestations can surface AEP agent reputation without any AEP-specific integration.
- **No new custody surface.** No SOL or tokens flow through SAS on the AEP path; SAS holds no AEP-economic state.
- **No new CPI edges.** Registry program remains isolated from SAS; no upgrade coupling.
- **Additive, reversible v1.** Consumers that don't care about SAS never fetch it; agents that don't publish attestations have an empty `owner_attestation` field. Zero opt-in cost for either side.
- **DOCS-only ADR.** Resolves decision #8 without blocking on implementation — the PR9 validator ships as-is, and the resolver package follows asynchronously.

### Negative
- **Consumers need SAS SDK or an equivalent resolver.** Off-chain resolution adds a dependency for any caller that wants SAS signals (not just Registry reads). Mitigated by shipping `@agenomics/sas-resolver` (ADR-064) as the reference implementation with a batched-fetch API.
- **Multiple fetches per agent lookup.** Full resolution is Registry → IPFS/Arweave → SAS — three network hops worst case. Mitigated by caching at every layer (see ADR-065 for the explicit caching strategy).
- **Merge semantics are a convention, not a protocol rule.** Different consumers may weight Registry vs. SAS signals differently; cross-consumer consistency depends on adoption of the recommended convention (§4). This is an acceptable cost for a reputation *layer* — it would not be acceptable for a *protocol-logic* signal, but §5 keeps protocol logic in Registry.
- **Credential authority governance is a new process surface.** Adding / removing authorities requires multisig action and a governance proposal (ADR-063). Bootstrap requires an initial credential creation ceremony.

### Neutral
- **Validator crate `@agenomics/capability-manifest-validator` (PR9) stays as-is.** It already validates `owner_attestation` as an optional base58 pubkey per ADR-060 §2. No SAS-specific validation in the manifest validator.
- **`@agenomics/sas-resolver` TS package is the only new code artifact** implied by this ADR, and it is explicitly out-of-scope here (tracked as ADR-064).
- **No impact on existing Registry, Vault, Settlement, or MCP-server behavior.** SAS resolution is strictly additive and strictly off-chain in v1.
- **Option A remains available as a future superseding ADR** if a concrete need emerges.

## Open items / follow-up ADRs

- **ADR-063**: AEP SAS credential authority governance — multisig composition, proposal format, voting thresholds, rotation procedure, and bootstrap ceremony for the two v1 credentials (`AEP_PROTOCOL`, `AEP_VALIDATORS`).
- **ADR-064**: `@agenomics/sas-resolver` TS package — implementation PR for the §4 resolution flow, including batched-fetch API, allowlist handling, expiry / staleness flags, and merge-convention helpers.
- **ADR-065**: Caching strategy for multi-fetch resolution — TTL policy per layer (Registry account, IPFS/Arweave manifest body, SAS attestation), invalidation hooks on Registry updates, and cross-process cache sharing (Redis vs. in-process) paralleling ADR-059's mutex decision.

## References

- `docs/adr/ADR-060-capability-descriptor-format.md` — manifest schema + `owner_attestation` hook (§2), explicit SAS-as-capability rejection (§6), three-way separation doctrine
- `docs/adr/ADR-020-reputation-staking.md` — `ReputationStake`, slashing, `Suspended` state transition
- `docs/adr/ADR-028-anti-sybil-defense.md` — economic defenses the Registry-native reputation signals back
- `docs/adr/ADR-058-action-and-signer-abstraction.md` — open-item entry that prefigured this ADR
- `docs/SOLANA_ECOSYSTEM_ANALYSIS.md` §3.1 — SAS substrate findings, decision #8
- `programs/agent-registry/src/state.rs` — current `AgentProfile` fields (including ADR-060 manifest fields landed in PR #3)
- SAS documentation — schema / credential / attestation PDAs, multi-signer authority model, optional NFT wrapper
