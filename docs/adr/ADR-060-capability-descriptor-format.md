# ADR-060: AEAP capability descriptor format — off-chain manifest, on-chain pointer

## Status
Proposed

## Date
2026-04-21

## Context

AEAP agents need to publish **what they can do** in a machine-readable, typed, signed, versioned format so that other agents and the Settlement program can verify capabilities before engaging.

Ecosystem alternatives surveyed:

- **`sendaifun/skills`**: Markdown + YAML frontmatter. LLM prompt shrapnel — not an authorization contract. No typed I/O, no signing, no cost declarations. Suitable for agent/user *documentation*, not for a programmatic capability contract.
- **`solana-dev-skill`** (solana-foundation): Same Markdown + YAML format as sendaifun skills, now formalized as "March 2026 best practices." Great for progressive-disclosure user-facing docs. **Still insufficient as a typed capability schema.**
- **`txtx`** (solana-foundation): HCL2 deployment manifests (Terraform-for-web3). Describes deployment runbooks (`solana_program_deployment`, `solana_transfer`). Different abstraction layer — runbook, not capability contract.
- **`solana-attestation-service` (SAS)**: Schema + attestation + signer model. Powerful for *reputation* (third parties attesting about an agent). Not designed for an agent self-declaring its capabilities + typed I/O + cost estimates.

None of these is a capability descriptor. AEAP must define its own.

Companion analysis: `docs/SOLANA_ECOSYSTEM_ANALYSIS.md`, `docs/SENDAIFUN_ECOSYSTEM_ANALYSIS.md`.

## Decision

### 1. Off-chain JSON manifest with on-chain pointer + hash + signature

Capability descriptors are **off-chain JSON** (size + cost prohibitive on-chain), with an on-chain pointer + integrity commitment stored in the Agent Registry's profile account.

Registry adds three fields to the agent profile:

```rust
pub struct AgentProfile {
    // ...existing fields...
    pub manifest_cid: [u8; 46],           // IPFS CIDv1 or Arweave tx ID, padded
    pub manifest_hash: [u8; 32],          // SHA-256 of canonical-JSON manifest bytes
    pub manifest_signature: [u8; 64],     // Ed25519 signature over manifest_hash by agent authority
    pub manifest_version: u16,            // semver major.minor packed
    // ...
}
```

Rationale:
- **CID/tx ID** resolves the manifest content off-chain (IPFS or Arweave).
- **Hash** ensures manifest immutability after publication; any mutation invalidates verification.
- **Signature** ensures the manifest was published by the agent's authority, not an impostor.
- **Version** enables schema evolution with compatibility windows.

### 2. Manifest schema (v1.0)

```ts
interface CapabilityManifest {
    $schema: 'https://aeap.dev/schemas/capability-manifest/v1.0.json';
    version: '1.0';                          // schema version, not agent version
    agent: {
        pubkey: string;                       // base58 Solana address
        name: string;
        owner_attestation?: string;           // optional SAS attestation pubkey for reputation link (ADR-061)
        website?: string;
    };
    agent_version: string;                    // semver of the agent's own implementation
    capabilities: Capability[];
    published_at: string;                     // ISO 8601
    expires_at?: string;                      // ISO 8601; missing = no expiry
}

interface Capability {
    name: string;                             // verb-noun, kebab-case: "transfer-funds", "approve-milestone"
    description: string;
    input_schema: JsonSchema;                 // strict; $ref allowed
    output_schema: JsonSchema;
    cost_estimate?: CostEstimate;
    required_capabilities: RequiredCapability[];    // AEAP Capability taxonomy from ADR-058
    preflight?: PreflightGate[];              // ADR-059 preflight gates
    side_effects: SideEffect[];               // 'read-onchain' | 'write-onchain' | 'signs-tx' | 'external-http'
    stability: 'experimental' | 'beta' | 'stable';
}

interface CostEstimate {
    unit: 'micro_usd' | 'lamports';
    amount: string;                           // string-encoded bigint (JSON-safe)
    confidence: 'exact' | 'estimate' | 'worst-case';
}

interface RequiredCapability {
    capability: string;                       // ADR-058 Capability literal: "sign:settlement", "read:vault", ...
    rationale?: string;
}

type PreflightGate = 'cluster_health' | 'account_rent_exempt' | 'daily_cap_not_exhausted' | 'dispute_window_open';
type SideEffect = 'read-onchain' | 'write-onchain' | 'signs-tx' | 'external-http' | 'emits-event';
```

### 3. Canonical JSON encoding

Manifest must be serialized with **RFC 8785 canonical JSON** (same as `mpp-sdk`'s `serde_json_canonicalizer`) before hashing. This eliminates whitespace / key-order variance that would otherwise cause `manifest_hash` to drift across re-serialization.

### 4. Storage

Two supported backends (consumer chooses; Registry stores CID in either case):
- **IPFS** (CIDv1, `dag-json` codec): pinning responsibility is the agent's. Recommended pin service: Pinata or agent-run Kubo.
- **Arweave**: immutable by design, pay-once storage. CID field holds the Arweave tx ID.

Rejected: S3, HTTPS URLs (mutable).

### 5. Schema evolution

- **Minor version bumps**: additive-only (new optional fields). Consumers MUST accept unknown optional fields.
- **Major version bumps**: publish a new `$schema` URL; old consumers reject. Registry keeps both `manifest_version` fields during deprecation windows.
- Validation: AEAP publishes a reference validator crate (`@aeap/capability-manifest-validator`) with JSON Schema bundled.

### 6. Explicit rejections (see also the Alternatives section)

- **sendaifun/skills format**: rejected as capability schema (LLM prompt shrapnel, no typed I/O, no signing).
- **solana-dev-skill format**: rejected as capability schema (same reason — it's a docs format, not a contract format).
- **txtx HCL manifests**: rejected as capability schema (deployment runbook, wrong abstraction layer).
- **SAS attestation as capability descriptor**: rejected (SAS is reputation substrate; capability ≠ reputation. Compose via `owner_attestation` field, don't conflate).
- **On-chain capability storage**: rejected (storage cost + schema evolution cost prohibitive).

### 7. Scope boundary with `programs/**`

This ADR adds **three fields** (`manifest_cid`, `manifest_hash`, `manifest_signature`, `manifest_version` — effectively 144 bytes plus the u16) to the Registry's agent profile account. Those additions **are** in scope for this ADR and require a Registry-program migration PR paired with the manifest-validator library.

Anything beyond those three fields — policy programs, cross-program manifest indexing, on-chain manifest validation CPI — is **out of scope** for ADR-060 and will land in follow-up ADRs if needed.

## Alternatives Considered

### Alternative A: On-chain capability descriptors
Rejected. A full capability manifest with typed I/O can run to several KB; storing that in an agent-profile account is prohibitively expensive. Off-chain storage with on-chain hash is the standard pattern (mirrors how Metaplex metadata works).

### Alternative B: Adopt the sendaifun/solana-dev skills format
Rejected. Markdown + YAML is optimized for LLM consumption, not for programmatic authorization. No typed I/O, no signing, no cost declarations. AEAP will publish **both** — a Markdown skill (for agent discovery / user docs) AND a JSON capability manifest (for programmatic verification) — but they are not the same artifact.

### Alternative C: Adopt `txtx` HCL manifests
Rejected. `txtx` describes *how to deploy* something. A capability manifest describes *what an agent can do*. Different abstractions at different lifecycle stages.

### Alternative D: Use SAS attestations as the descriptor
Rejected. SAS answers "did X say Y about agent Z?" — it's a reputation / claims substrate. A capability manifest answers "what can agent Z do, and with what cost/signature/I-O shape?" — it's a contract. An agent can have both: a self-published manifest (this ADR) AND a set of SAS attestations linked via `owner_attestation`.

### Alternative E: JSON-LD with schema.org vocabulary
Rejected. JSON-LD's open-world semantics don't match AEAP's closed-world validation needs. JSON Schema with a strict `$schema` reference is simpler and verifiable.

### Alternative F: Protobuf or Borsh binary manifests
Rejected for v1. JSON is debuggable, inspectable in browsers, and trivial to validate cross-language. Binary formats can be added as a v2 schema if bandwidth becomes a constraint.

## Consequences

### Positive
- Typed, signed, versioned capability contracts — a substrate higher-level coordination protocols can build on.
- Composable: one agent's manifest can declare `required_capabilities` that another agent must provide.
- Clean separation: **identity** (Registry core fields) + **reputation** (SAS, via `owner_attestation`) + **capabilities** (this manifest).
- Off-chain storage keeps on-chain costs bounded (144 bytes + u16 per agent).
- `$schema` URL with semver enables coordinated evolution across the ecosystem.
- Compatible with future indexers: a service crawling IPFS/Arweave can build a searchable agent-capability index without on-chain reads.

### Negative
- Off-chain storage dependency (IPFS or Arweave) — agents must maintain pin / pay Arweave fees.
- Off-chain content is only as live as its pinning — invisible bitrot risk. Mitigated by Arweave option + on-chain hash integrity.
- Adds fields to the Registry agent profile account — Anchor constraint / migration work.
- Publishing a canonical validator and schema adds maintenance surface.
- Schema evolution ceremony (major-version deprecation windows) requires process discipline.

## Open items

- Manifest validator crate (`@aeap/capability-manifest-validator`) — separate work item.
- ADR-061 (planned): how agents reference SAS attestations via `owner_attestation`.
- Indexer crate to build a searchable capability index from Registry + IPFS/Arweave — separate work item.

## References

- `docs/SOLANA_ECOSYSTEM_ANALYSIS.md` — SAS, solana-dev-skill, txtx analyses
- `docs/SENDAIFUN_ECOSYSTEM_ANALYSIS.md` — skills-format rejection rationale
- ADR-058 — Capability taxonomy (used by `required_capabilities`)
- ADR-059 — `PreflightGate` enum (used by `preflight`)
- RFC 8785 — Canonical JSON
