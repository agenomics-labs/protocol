# ADR-076: SAS resolver per-credential signer allowlist, schema↔credential binding, and deploy-time schema-owner assertion

## Status
Proposed

## Date
2026-04-22

## Context

DEEP-AUDIT-2026-04-22.md Audit 1 finding **SEC-3 (CRITICAL)** identified a structural scope gap in `@agenomics/sas-resolver` — the package that resolves SAS attestations into AEP reputation per ADR-061 and ADR-064.

Current resolver logic (`packages/sas-resolver/src/resolver.ts:326` + `allowlist.ts:57`) checks:

1. That `attestation.schema == config.schemaPda` (correct, `resolver.ts:317`).
2. That `attestation.credential ∈ allowlist` (correct, `resolver.ts:326`).

What it does **not** check:

3. That the signer of the attestation is authorized **for this specific credential**. SAS credentials can have multi-signer authorities (see ADR-063 §1 — `AEP_PROTOCOL` is 3-of-5, `AEP_VALIDATORS` is 5-of-9), and today the resolver will accept any `raw.signer` whose credential is on the allowlist — it does not cross-check the signer against the credential's signer set.
4. That this specific credential is authorized to attest under this specific schema. SAS semantically allows any credential authority to issue attestations against any schema PDA it references.

**Exploit**: an attacker who (a) controls one allowlisted credential authority — e.g., through the ADR-063 bootstrap-ceremony compromise scenario, or through key leakage at one of the 3-of-5 `AEP_PROTOCOL` signers below threshold — or (b) the resolver operator misconfigures the allowlist to include a credential the attacker controls, can mint an `AEP_AGENT_REPUTATION_v1` attestation claiming any subject has `score = 10000`. Downstream MCP consumers trust the score.

Additionally, finding **SEC-15 (LOW)** notes that if an operator misconfigures `config.schemaPda` to an attacker-controlled value, any attestation with that schema is trusted. The audit recommends a deploy-time assertion that `config.schemaPda`'s on-chain account owner is the SAS program.

ADR-063 §1.1/§1.2 already specifies the signer composition of each credential; ADR-061 §3 specifies which credentials attest under which schemas. This ADR wires those specifications into the resolver's enforcement layer.

## Decision

Extend `@agenomics/sas-resolver` with three new checks layered onto the existing allowlist model:

**Change 1 — Per-credential signer allowlist**: extend the `allowlist.ts` entry shape from `{ credential: Pubkey }` to `{ credential: Pubkey, signers: Pubkey[], schemas: Pubkey[] }`. Each entry now declares (a) the credential PDA, (b) the set of on-chain signer pubkeys authorized to issue attestations under that credential, and (c) the set of schema PDAs this credential is authorized to attest under. The resolver asserts `attestation.signer ∈ credentialEntry.signers` AND `attestation.schema ∈ credentialEntry.schemas` before trusting the attestation. This makes the check in `resolver.ts:326` a cross-product assertion, not an either-or.

**Change 2 — Schema↔credential binding**: explicit authorized-pairs enforcement. The resolver derives `authorized_pairs = Set<(credential, schema)>` at config load, and every attestation resolution asserts `(attestation.credential, attestation.schema) ∈ authorized_pairs`. This is strictly stronger than Change 1's per-entry `schemas: Pubkey[]` (which is the implementation mechanism for the pair set) — spec'd as a distinct concept so future allowlist variants (e.g., loaded from an on-chain registry) can implement it directly.

**Change 3 — Deploy-time schema-owner assertion (SEC-15 fold-in)**: at resolver initialization (`createResolver` constructor / first-resolution warm-up), the resolver issues a `getAccountInfo(config.schemaPda)` call and asserts `account.owner == SAS_PROGRAM_ID`. If not, the resolver throws at startup rather than silently trusting a misconfigured schema. Cached for the process lifetime; does not run per-resolution.

**Allowlist data source**: the v1 allowlist ships as a committed TypeScript constant in `packages/sas-resolver/src/allowlist.ts`, with entries for `AEP_PROTOCOL` and `AEP_VALIDATORS` populated from the ADR-063 bootstrap transcript (signer pubkeys, credential PDAs, schema PDAs). Future rotation is a TypeScript edit + package republish — acceptable for v1 per ADR-064 §7. Upgrade to an on-chain registry is tracked separately.

**Package changes**: `packages/sas-resolver` only. TypeScript-only fix. **Does NOT require multisig signing** — this is an npm publish, not a program upgrade.

**Tests to add** (under `packages/sas-resolver/test/`):

- Signer-authorized: attestation signed by a pubkey in `credentialEntry.signers` → resolves.
- Signer-unauthorized: attestation signed by a pubkey NOT in the credential's signer set (but valid SAS signature) → rejected with `UnauthorizedSigner`.
- Schema-mismatch: attestation under a schema not in `credentialEntry.schemas` → rejected with `SchemaCredentialBindingViolation`.
- Pair-not-authorized: `(credential, schema)` combination absent from authorized-pairs set → rejected.
- Deploy-time owner check: resolver initialized with `config.schemaPda` pointing at a non-SAS-owned account → `createResolver` throws `SchemaPdaOwnerMismatch`.
- Regression: existing happy-path tests (allowlisted credential + schema + signer in its set) remain green.
- Exploit regression: replay of the audit's exact exploit — allowlisted credential but attacker-controlled signer → rejected.

## Alternatives Considered

- **Keep credential-authority-only check and trust the authority to gate its own signers.** Rejected — the audit's SEC-3 is precisely about this assumption being violated when one authority key leaks below the credential's threshold, and there is no on-chain mechanism in the SAS v1 model that ensures attestation signatures correspond to quorum approval. Resolver-side enforcement is the only correct layer.
- **Fetch the credential's signer set dynamically from on-chain at every resolution.** Rejected for v1 — adds an RPC round-trip per resolution, hurts cache hit rates, and introduces a new failure mode (RPC outage → resolver blind). The committed allowlist is the simpler source of truth for v1; dynamic fetch is a future optimization tracked in ADR-065 §7.
- **Merge this into ADR-064 as an amendment.** Rejected — ADR-064 is Accepted and concerns the allowlist mechanism itself; adding schema binding + per-credential signer sets is a semantic extension significant enough to warrant its own ADR for auditability.
- **Defer SEC-15 (deploy-time schema-owner assertion) to a separate ADR.** Rejected — the check is tiny (one RPC call at startup), the threat model (operator misconfigures `schemaPda`) is genuinely orthogonal but the fix lives in the same resolver file. Bundling avoids a second ADR-and-PR round for a one-line assertion.

## Consequences

**Positive**: closes the critical SAS reputation-forgery vector; makes the resolver's trust surface auditable by reading one file (`allowlist.ts`); adds a startup assertion that catches schema misconfiguration at deploy rather than at first-resolution. Extends ADR-061/063/064's layered governance with the enforcement layer that actually binds specs to runtime behavior.

**Negative**: allowlist schema is now richer — every future allowlist entry must declare signers and schemas, not just the credential. Slightly more maintenance per rotation. The committed-allowlist model means every signer rotation under ADR-063 requires an `@agenomics/sas-resolver` minor version bump and MCP-server redeploy. Acceptable for v1 per ADR-064's published rationale, with on-chain registry migration tracked separately.

**Migration path**: TS-only — no on-chain deployment, no multisig. Package bump: `@agenomics/sas-resolver` minor (additive allowlist-entry fields; existing Result types unchanged). MCP-server and any other consumer picks up the new resolver via npm upgrade. Pre-upgrade, verify the committed allowlist in `packages/sas-resolver/src/allowlist.ts` exactly matches the ADR-063 bootstrap transcript's signer pubkeys and credential/schema PDAs — drift here is a silent-trust-downgrade hazard. A one-time CI assertion comparing `allowlist.ts` against a golden file derived from the bootstrap transcript is recommended as a companion change.

## References
- `docs/adr/DEEP-AUDIT-2026-04-22.md` — Audit 1, findings SEC-3 (CRITICAL) and SEC-15 (LOW)
- `docs/adr/ADR-061-sas-integration.md` — §3 credential authority model
- `docs/adr/ADR-063-sas-credential-authority-governance.md` — §1.1 `AEP_PROTOCOL` 3-of-5, §1.2 `AEP_VALIDATORS` 5-of-9, §4 allowlist model
- `docs/adr/ADR-064-resolver-allowlist.md` (referenced by ADR-063; if present)
- `packages/sas-resolver/src/resolver.ts:311-323, 326, 412-423`
- `packages/sas-resolver/src/allowlist.ts:57`
- `packages/sas-resolver/src/schema.ts:190-195`
