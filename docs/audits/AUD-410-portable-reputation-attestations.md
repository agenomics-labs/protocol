# AUD-410 — Portable Reputation Attestations (ADR-139)

**Date:** 2026-05-14
**ADR:** ADR-139
**Scope:** `packages/reputation-attestor/`,
`packages/sas-resolver/src/agenomics-reputation.ts`,
`src/indexer/reputation-attestor.ts` + `reputation-attestor-wire.ts`,
`mcp-server/src/tools/reputation-attestation.ts`,
`sdk/client/src/reputation.ts`.

## Invariants enforced

1. **Schema discriminator pinned.** Every credential MUST carry
   `schema: "agenomics.reputation.v1"` at both the top level and on
   `payload`. The verifier rejects anything else as `SCHEMA_MISMATCH`.
2. **Domain-separated preimage.** `SHA-256(b"AEP_REPUTATION_ATTESTATION_V1\0" || canonicalJsonBytes)`
   prevents cross-protocol signature replay against ADR-060 manifest
   signatures or any other AEP signing context.
3. **Field set is closed under v1.** New optional fields cannot be
   added under `agenomics.reputation.v1` without breaking the
   canonical-JSON preimage. A `v2` schema is the path forward.
4. **Score range pinned to `[0, 100]`.** Issuer rejects out-of-range
   inputs (e.g. a legacy `u64` profile carrying a pre-AUD-112 value
   above 100). Verifier rejects payloads outside the range as
   `SHAPE_INVALID`. This is the on-chain ADR-094 policy made explicit
   at the credential boundary.
5. **`u64` precision via decimal strings.** Lamports / nonce / slot
   are encoded as decimal strings in JSON. JS `number` cannot round-trip
   `u64`; the canonical preimage MUST survive a serialise/parse cycle.
6. **Issuer scope opt-in.** Verifiers MAY pass `allowedIssuers`. When
   set, the credential's issuer MUST be in the list — `ISSUER_NOT_ALLOWED`
   surfaces otherwise. Empty allowlist = "verify the signature but
   accept any issuer" (advisory only).
7. **Monotonic on-chain cross-check.** When the optional
   `verifyAttestationWithChain` path runs, `slash_count` and
   `registration_nonce` MUST be non-decreasing between snapshot and
   on-chain. A regression triggers `ONCHAIN_DIVERGENCE` —
   `reputation_score` is excluded (legitimately fluctuates).
8. **Snapshot freshness is a verifier responsibility.** A perpetual
   credential (`expiry_unix_ts == 0`) is the default; verifiers MUST
   set `maxSnapshotAgeSeconds` to bound replay.
9. **Issuance is opt-in at the indexer.** No issuer key configured ⇒
   no routes mounted. Existing indexer behaviour is byte-for-byte
   preserved when the env vars are absent.
10. **Non-active profiles cannot be issued credentials.** The reference
    issuer returns `409 Conflict` when `is_active == false`; the route
    handler short-circuits before signing.

## Threat-coverage matrix

| Threat                                  | Status   | Notes                                                                                                                         |
| --------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Issuer key compromise                   | Mitigated | Verifier-pinned issuer allowlist; documented KMS migration path; rotation via `issuer_url` discovery.                       |
| Cross-protocol signature replay         | Mitigated | Domain-separated preimage (`AEP_REPUTATION_ATTESTATION_V1\0`). Distinct from ADR-060 manifest hash domain.                  |
| Stale-snapshot replay                   | Mitigated | `maxSnapshotAgeSeconds` enforced by `verifyAttestation`. Defaults to 24h in the resolver helper.                            |
| Sybil reuse (close-then-reopen)         | Mitigated | `registration_nonce` cross-check (ADR-097).                                                                                  |
| Score-delta race                        | Tolerated | Snapshot semantics — score is a moving target under ADR-094. Cross-check intentionally excludes `reputation_score`.        |
| Schema-confusion                        | Mitigated | Zod schema rejects unknown discriminators; signature verify rejects mutated payloads.                                       |
| Suspended-profile credential issuance   | Mitigated | Reference issuer 409s on `is_active == false`. Verifiers cross-check status on-chain for high-stakes gates.                 |
| Bulk-mint via issuer flooding           | Mitigated | Per-IP token-bucket rate limit + cache bucket; CDN-friendly `Cache-Control` headers.                                       |
| Out-of-band issuer-service compromise   | Residual  | Single-issuer trust root; decentralised issuer set is a deferred follow-up.                                                  |

## Test coverage

| Test file                                                                            | Tests | Subject                                                                |
| ------------------------------------------------------------------------------------ | ----- | ---------------------------------------------------------------------- |
| `packages/reputation-attestor/test/canonical.test.ts`                                | 5     | RFC-8785 key-order invariance; preimage stability; mutation distinguishability; domain-prefix layout. |
| `packages/reputation-attestor/test/sign-verify.test.ts`                              | 8     | Round-trip; signature tampering; payload tampering; schema discriminator; issuer scope; expiry; pubkey derivation. |
| `packages/reputation-attestor/test/freshness.test.ts`                                | 9     | Snapshot freshness; on-chain cross-check monotonicity; authority match; lookup failure; score-drift tolerance. |
| `packages/reputation-attestor/test/issuer.test.ts`                                   | 7     | Keypair loading (PATH/B64/KMS); invalid inputs; KMS not-bundled error path. |
| `packages/sas-resolver/test/agenomics-reputation.test.ts`                            | 5     | Resolver verify pass-through; issuer allowlist; cache hit/miss; forceFresh; TTL. |
| `src/indexer/test/adr-139-reputation-issuer.test.ts`                                 | 10    | HTTP `/reputation/:agent_id` 200/400/404/409/502; cache buckets; rate limiting; `/at/:slot` 200/400/501. |
| `mcp-server/test/reputation-attestation-tools.test.ts`                               | 5     | MCP tool registration + descriptor shape.                              |
| `sdk/client/test/reputation.test.ts`                                                 | 6     | Anchor profile → snapshot projection; manifest_hash hex; score clamp; BN → bigint; round-trip via SDK namespace. |
| **Total**                                                                            | **55**| Across canonicalisation, sign/verify, snapshot freshness, on-chain cross-check, HTTP, MCP, and SDK layers. |

## Open follow-ups

- KMS adapter (AWS KMS / GCP KMS / HSM): the `REPUTATION_ATTESTOR_KMS_URI`
  env var is reserved and the loader emits a clear "not implemented"
  error. The choice of provider is gated on a separate ADR.
- Decentralised issuer set (M-of-N): single-issuer trust root is the
  v0.1.0 posture. Tracked in ADR-139 Open Questions.
- ZK score range proofs: "score ≥ 70" without disclosing the exact
  value. Tracked in ADR-139 Open Questions.
- Indexer-backed historical issuance: `GET /reputation/:agent_id/at/:slot`
  currently 501s; a projection on the indexer's Postgres store would
  close this without an archive RPC.
