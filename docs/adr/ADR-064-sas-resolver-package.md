# ADR-064: `@agenomics/sas-resolver` — off-chain resolver package for ADR-061 §4 manifest-referenced attestations

## Status
Accepted

## Date
2026-04-22 (backfill — implementation merged in PR #12, resolver v0.1.0 unpublished; extended by PRs #14, #15)

## Context

ADR-061 (SAS integration, option B, Accepted) defined a **three-hop resolution flow** for a complete view of an AEP agent: (1) Registry account via Solana RPC `getAccountInfo`, (2) off-chain manifest body via IPFS / Arweave, (3) SAS attestation account via Solana RPC. ADR-061 §8 explicitly scoped the resolver as out-of-scope for ADR-061 and tracked it as a follow-up ADR-064. ADR-061 §9 promised ADR-064 as the implementation PR covering "the §4 resolution flow, including batched-fetch API, allowlist handling, expiry / staleness flags, and merge-convention helpers."

The resolver package landed on `main` in PR #12 (`feat(sas-resolver): ADR-064 — @aeap/sas-resolver@0.1.0 reference implementation`, commit `986bfbc`) and has been extended by PR #14 (`feat(mcp-server): add get_agent_reputation action (ADR-061 end-to-end)`) and PR #15 (`feat(sas-resolver): ADR-065 caching — per-layer TTLs, in-memory + Redis backends`). The resolver v0.1.0 is prepared but not yet published to npm (hold per STATUS.md §5). The `ADR-064` comment tags are sprinkled across `packages/sas-resolver/src/*.ts` — but the ADR text itself was never authored. Deep-Audit 2026-04-22 (Audit 3 gap #12) flagged this as a pre-mainnet backfill obligation.

This ADR documents the design decisions made during the resolver's implementation. It is a **backfill** — the decisions are live in production code and in the adjacent ADRs (ADR-061, ADR-065, ADR-076); this ADR stitches them together.

## Decision

### 1. Package identity

- **Name**: `@agenomics/sas-resolver` (per `@agenomics/*` scope, see STATUS.md §2 and PR #19 which renamed from `@aep/*` due to ecosystem contention).
- **Scope**: off-chain TypeScript SDK for resolving ADR-061 SAS attestations referenced from AEP capability manifests. Does **not** duplicate Registry or manifest-validation code (which live in `@agenomics/capability-manifest-validator`); does **not** write on-chain (read-only).
- **Runtime**: Node.js 18+, browser via bundler (ESM-only). No top-level network or `process.env` access at import time.
- **Primary RPC**: `@solana/kit` `Rpc<SolanaRpcApi>` with the narrow `Pick<SolanaRpcApi, "getAccountInfo">` acceptance (the resolver only ever calls `getAccountInfo`, documented in `types.ts`).

Rejected: writing the resolver in Rust as a client-side crate. Rust-side clients would force consumers to bring a Rust toolchain into a TypeScript-dominant ecosystem (dashboards, MCP tooling, indexer). TS-first was chosen for reach; a hypothetical Rust resolver is a future ADR, not this one.

Rejected: depending on `sas-lib` for account decoding. `sas-lib@1.0.10` pins `@solana/kit@^5` which conflicts with the repo-wide `@solana/kit@^6` tree (documented in STATUS.md §7.A.3 and in `src/schema.ts:6-11`). The resolver hand-implements SAS account decoding against the byte layouts Codama generates in sas-lib — traceable but decoupled from sas-lib's version pins.

### 2. ADR-061 §4 failure-mode table — row-for-row implementation

Every row of ADR-061's §4 failure-mode table maps to a concrete code path in `resolver.ts:#resolveSingle`. Most rows degrade to `absent: true` (SAS is **additive** — an absent attestation is "no signal," not an error):

| §4 row | Failure mode | Resolver behavior |
|---|---|---|
| 4a | No `owner_attestation` in manifest | `absent: true, reason: "NO_ATTESTATION"` |
| 4b | Attestation account closed / absent on-chain | `absent: true, reason: "ACCOUNT_NOT_FOUND"` |
| 4c | Schema PDA mismatch | `absent: true, reason: "SCHEMA_MISMATCH"` |
| 4d | Credential PDA not in allowlist | `absent: true, reason: "CREDENTIAL_NOT_ALLOWED"` |
| 4e | Attestation expired (SAS `expiry < now`) | `absent: true, reason: "EXPIRED"` (flagged `stale: true` separately for UX) |
| 4f | **Subject mismatch** — attestation's subject ≠ manifest's agent pubkey | **Hard error**: `Result<_, { code: "SUBJECT_MISMATCH" }>` |

Row 4f is the **only** SAS-layer failure treated as a hard error. Rationale: a subject-mismatched attestation is either an agent mistake (misconfigured manifest) or an adversarial attempt to borrow another agent's reputation. Silently papering over it would let an attacker point their manifest at any allowlisted-credential attestation about anyone else and have the resolver happily surface the other agent's score as their own.

Hard-error codes beyond row 4f: `INVALID_INPUT` (malformed manifest), `INVALID_CONFIG` (malformed `ResolverConfig`), `RPC_ERROR` (transport failure), `RESOLVER_INIT` (strict-init schema-PDA owner check failure — ADR-076 §2).

### 3. Allowlist-based credential trust

Per ADR-061 §3 and its strengthened successor ADR-076, the resolver enforces a **per-credential allowlist** at two layers:

- **Credential authority pubkey**: `AllowedCredential.authorityPubkey` must match the attestation's credential reference.
- **Per-credential signer scope** (ADR-076 §1): each allowlist entry names the specific pubkeys authorized to sign under that credential. The handler at `resolver.ts` asserts `raw.signer ∈ entry.signerPubkeys` — a leaked credential-authority key cannot mint attestations signed by an unintended signer.
- **Per-credential schema scope** (ADR-076 §1): each allowlist entry names which schema PDAs the credential is authorized to attest under. The handler asserts `raw.schemaPda ∈ entry.schemaPdas` — an allowlisted credential whose signing key later leaks cannot forge attestations under a schema it was never authorized for.

The v1 AEP-published defaults (`AEP_PROTOCOL` and, eventually per ADR-077, `AEP_VALIDATORS`) are **not hardcoded** in the package. Consumers build their own allowlist via `buildAllowlist()` (exported from `allowlist.ts`) and pass it in `ResolverConfig.allowedCredentials`. The resolver ships with zero trusted credentials by default; a consumer that does not populate the allowlist gets `absent: true, reason: "CREDENTIAL_NOT_ALLOWED"` for every attestation.

Rejected: centrally-managed allowlist shipped as a live JSON file fetched at runtime. Introduces a network dependency and a censorship surface. Consumer-side allowlist means the trust decision is explicit and auditable at the consumer.

### 4. Strict resolver-init mode (ADR-076 §2)

On resolver construction, `strict: true` (default) asserts that `ResolverConfig.schemaPda` is owned by the configured SAS program (`DEFAULT_SAS_PROGRAM_ID = "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG"`, the canonical devnet deployment). A misconfigured schema pointing at an attacker-controlled account is a protocol-level trust failure; refusing to resolve is safer than silently trusting attacker-owned accounts. Failure surfaces as `ResolverInitError` (distinct from `RPC_ERROR` and `INVALID_CONFIG`).

### 5. Caching integration — ADR-065

Cache lives in a pluggable `CacheBackend` (`cache.ts`) with an `InMemoryCache` default and an optional `RedisCache` (`cache-redis.ts`, loaded lazily only if `AEP_REDIS_URL` is set). Per-layer TTLs (registry 30s, manifest 24h, attestation 5m, schema 1h, credential 1h) and the `maxAge: 0` opt-in strict-staleness knob are specified by ADR-065 and implemented here. The resolver's `#now` clock runs in **seconds** (matches SAS on-chain expiry fields); the cache clock runs in **milliseconds** (matches `Date.now` + `setTimeout`) — the two clocks are kept separate by `ResolverConfig.now` and `ResolverConfig.cacheNow` test hooks per `types.ts` commentary.

### 6. Merge helpers for registry + SAS UX

`merge.ts` exports:

- `detectDisagreement(registryView, sasView)` — surfaces the "> 2000 bps divergence" flag per ADR-061 §5.
- `renderSideBySide(registryView, sasView)` — producer of UX-ready side-by-side strings.
- `scoreFreshness(attestation, now)` — buckets freshness into `fresh | stale-warning | expired` per ADR-061 §6 (stale = `last_updated > 90 days ago`).

These are UX helpers, not protocol rules. `@agenomics/capability-manifest-validator` is authoritative for manifest integrity; the resolver is authoritative for attestation surfacing. The merge helpers bridge the two for consumers that want a single "here is the agent" view.

### 7. Module / export boundaries

Package public entry is `.` (`src/index.ts`). Audit 2 (DEEP-AUDIT-2026-04-22) flagged the v0.1.0-pre-publish surface as too wide; the tightening PR is tracked as a follow-up pre-tag-push concern (see DEEP-AUDIT Synthesis §"Block the next v0.1.0 publish tag-push"). Specifically:

- Encoder helpers (`encodeBase58`, `base58Decode`, `base64Decode`, `base64Encode`) and test-fixture encoders (`encodeReputationData`, `encodeAttestationAccount`) are currently exported but slated for removal from `index.ts` before v0.1.0.
- `@solana/kit` is currently a hard dependency; slated to move to `peerDependencies` to avoid type-identity drift across consumer dep trees.
- Subpath exports in `package.json` will collapse to `.` only (plus optional `./cache-redis` peer).
- `AttestationReputation` will gain a `readonly version?: 1` discriminator for v2 extensibility.

This ADR does not re-decide those (the v0.1.0 tightening PR does); it documents the current shape and points at the follow-up.

## Alternatives Considered

### Alternative A: On-chain resolver (Rust crate callable from programs)
**Rejected for v1.** ADR-061 option B picked off-chain resolution as the whole point of manifest-referenced SAS; an on-chain resolver inverts that choice. A Rust client-side crate is a separate possibility for Rust-side consumers, tracked as a future ADR.

### Alternative B: Depend on `sas-lib` directly
**Rejected.** `sas-lib@1.0.10`'s `@solana/kit@^5` pin is incompatible with the repo's `@solana/kit@^6`. The resolver uses Codama-generated byte layouts directly, documented in `src/schema.ts` comments. If sas-lib bumps to Kit v6+ in the future, ADR-064 can be revisited without consumer impact (the byte layout is the stable surface, not the SDK method names).

### Alternative C: Single centrally-managed allowlist fetched at runtime
**Rejected.** Introduces a network dependency at resolve time and a censorship surface. Consumer-side allowlist is explicit and auditable per-consumer.

### Alternative D: Scan every SAS attestation for a subject (no manifest reference required)
**Rejected.** ADR-061 option B explicitly chose manifest-references-SAS rather than SAS-discovery. The resolver accepts a manifest-derived attestation PDA; it does not do a `getProgramAccounts`-style scan. Rationale and trade-offs are in ADR-061 §§3-4.

### Alternative E: Hard-fail all §4 rows
**Rejected.** Most §4 failure modes (no attestation, expired attestation, revoked attestation) are **additive**: an agent with no AEP attestation still has Registry-authoritative reputation. Hard-failing would force every consumer to handle `try/catch` for the normal case of "this agent has not published a SAS attestation." Soft-degradation to `absent: true` matches the economic reality — no signal is not an error.

### Alternative F: Subscribe to Solana WebSocket accounts to push invalidation
**Rejected for v1** (ADR-065 alt D). Adds a persistent WebSocket dep, multiplies RPC surface area, and creates dropped-event handling complexity that has no equivalent on the TTL-bounded path. The `maxAge: 0` escape hatch already serves "I need fresh data right now."

## Consequences

### Positive
- **ADR-061 §4 flow has a concrete, testable reference implementation.** 56 resolver tests exercise every §4 row plus the trust-boundary additions from ADR-076.
- **Allowlist model keeps trust decisions explicit.** Consumers pick which credentials they trust; the resolver does not ship opinionated defaults that could silently outgrow the protocol.
- **Soft-degrades on absent / expired / mismatched attestations.** `absent: true` matches the economic reality of additive attestations.
- **Hard-fails on subject mismatch.** The one case where silence would let an attacker borrow reputation is a loud error.
- **Strict-init prevents attacker-owned-schema trust compromise.** Closes ADR-076 §2 / Audit 1 finding #15.
- **Caching, merge helpers, and the `@solana/kit` v6 contract all ride in the same package** — consumers get a complete off-chain view from one dependency.

### Negative
- **Hand-built account decoders couple the resolver to SAS's byte layout.** If SAS changes the layout (e.g., adds fields, changes discriminator, bumps an enum variant), the resolver silently fails with `discriminator mismatch` until rebuilt. Audit 1 finding #14 flagged the hardcoded `tag = 2` as a centralized kill switch on SAS's side. Tolerable given SAS is pre-v1; a future ADR will revisit when SAS stabilizes.
- **v0.1.0 export surface is too wide.** Audit 2 identified 5 blockers for v0.1.0 tag push (encoder helpers, test-fixture encoders, `@solana/kit` dep vs peer, subpath exports, closed unions). Tightening PR is a pre-publish blocker per DEEP-AUDIT synthesis.
- **Consumer-owned allowlist is work for consumers.** Every caller must construct and maintain the allowlist — friction that an opinionated default would avoid, at the cost of centralized trust.
- **Two separate clocks (seconds for SAS, milliseconds for cache).** Documented but mildly error-prone for test authors.

### Neutral
- **Read-only.** Does not sign, does not submit, does not mutate.
- **No module-level side effects.** Safe to import at library load time.
- **Orthogonal to `@agenomics/capability-manifest-validator`.** Neither depends on the other; both are composable from a consumer's perspective.

## Open items / follow-up ADRs

- **v0.1.0 publish-hold tightening PR** (DEEP-AUDIT synthesis). Tracked pre-tag-push.
- **ADR-067** — cross-protocol credential trust, if external protocols want their credentials honored by the AEP resolver's default allowlist or vice versa.
- **ADR-077** — `AEP_VALIDATORS` credential bootstrap, whose landing updates the resolver's default allowlist to include a second authority (deferred to T+90 post-mainnet).

## References
- `docs/adr/ADR-061-sas-integration.md` §§3, 4, 5, 6, 8, 9 — the resolver's design source
- `docs/adr/ADR-065-caching-strategy.md` — caching policy implemented in `cache.ts` / `cache-redis.ts` (Accepted)
- `docs/adr/ADR-076-sas-resolver-schema-credential-binding.md` — schema↔credential and per-credential signer binding (on the parallel `docs/adrs-sec-068-076` track)
- `docs/adr/ADR-063-sas-credential-authority-governance.md` — governance of the allowlistable credentials
- `docs/adr/ADR-077-aep-validators-credential-bootstrap.md` — deferral of the second credential
- `docs/adr/DEEP-AUDIT-2026-04-22.md` Audit 2 (API/ABI stability), Audit 3 gap #12 (this backfill)
- `packages/sas-resolver/src/resolver.ts` — main resolver class, §4 failure-mode row comments
- `packages/sas-resolver/src/schema.ts` — hand-built SAS account decoders
- `packages/sas-resolver/src/allowlist.ts` — per-credential scoping
- `packages/sas-resolver/src/cache.ts`, `cache-redis.ts` — ADR-065 implementation
- `packages/sas-resolver/src/merge.ts` — registry + SAS UX helpers
- `packages/sas-resolver/src/types.ts` — public type surface
- `packages/sas-resolver/README.md` — consumer-facing doc; points at this ADR and ADR-061
