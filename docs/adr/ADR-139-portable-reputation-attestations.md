# ADR-139 — Portable Reputation Attestations

## Status

Accepted

## Date

2026-05-14

**Related:** ADR-060 (capability manifest), ADR-061 (SAS integration),
ADR-064 (SAS resolver), ADR-094 (reputation delta CPI), ADR-097
(registration nonce), ADR-092 (manifest hash domain separation),
ADR-065 (resolver cache).

## Context

ADR-094 made reputation a Registry-owned, bounded-delta primitive
(`propose_reputation_delta(i16)`, ±10 per call). The score lives in
`AgentProfile.reputation_score` together with `reputation_stake`,
`slash_count`, `registration_nonce`, and `manifest_hash`. Today every
consumer of an agent's reputation is **inside Agenomics** — they read
the on-chain account, trust the indexer, or call the MCP server.

The strategic doc names "machine credit score" as a primitive AEP must
expose: third parties (other protocols, enterprise verifiers, x402
relays, capability-discovery indexes) must be able to verify an agent's
Agenomics reputation **without** running an Agenomics validator, RPC
fork, or trust relationship with a single hosted API. Concretely:

- Another protocol's on-chain gate wants to require "Agenomics
  reputation ≥ 70 with zero slashes" before granting privileges.
- An enterprise procurement workflow wants to attach an Agenomics
  reputation certificate to an agent contract.
- A cross-protocol marketplace wants to show "verified Agenomics
  reputation: 73" next to an agent listing.

The existing on-chain primitive answers none of these without forcing
the consumer into an Agenomics RPC relationship.

## Decision

Introduce a **portable, Ed25519-signed reputation attestation** that
encodes an `AgentProfile` snapshot at a specific Solana slot. Any party
can verify it in one signature check against the issuer key, with the
optional reinforcement of a current on-chain cross-check.

### Schema (`agenomics.reputation.v1`)

```json
{
  "schema": "agenomics.reputation.v1",
  "agent_id": "<AgentProfile PDA, base58>",
  "authority": "<authority pubkey, base58>",
  "manifest_hash": "<32-byte SHA-256, hex>",
  "reputation_score": 73,
  "slash_count": 0,
  "reputation_stake_lamports": "5000000000",
  "registration_nonce": "4",
  "snapshot_slot": "184729103",
  "snapshot_timestamp": 1731543123,
  "issuer": "<issuer pubkey, base58>",
  "issuer_url": "https://reputation.agenomics.io",
  "expiry_unix_ts": 0
}
```

`reputation_stake_lamports`, `registration_nonce`, and `snapshot_slot`
are decimal strings to preserve `u64` precision through JSON. Every
field is required — the canonical-JSON preimage is sensitive to
absent-vs-zero. `expiry_unix_ts === 0` means "perpetual but the
verifier MUST still enforce snapshot freshness".

### Signing

Same RFC-8785 + Ed25519 pattern as ADR-060 / ADR-092, with a domain
separator dedicated to this preimage:

```
domain  = b"AEP_REPUTATION_ATTESTATION_V1\0"  // 30 bytes
preimage = SHA-256(domain || canonicalJsonBytes(payload))
sig     = Ed25519.sign(issuerKey, preimage)
```

The domain prefix prevents an issuer signature over a manifest body, an
SAS attestation, or any other AEP signing context from ever replaying
as a reputation attestation. The shipped credential is

```json
{ "schema": "agenomics.reputation.v1", "payload": {...}, "signature": "<hex>" }
```

### Issuer trust model

v0.1.0 ships a **single-issuer** trust root. The issuer's Ed25519 key
is loaded from one of:

- `REPUTATION_ATTESTOR_KEYPAIR_PATH` — filesystem path to a 64-byte
  Solana-keygen JSON keypair.
- `REPUTATION_ATTESTOR_KEYPAIR_B64` — base64 of a 64-byte raw keypair.
- `REPUTATION_ATTESTOR_KMS_URI` — reserved for a future KMS adapter
  (AWS KMS / GCP KMS / HSM). Setting this var without bundling an
  adapter raises a clear error; the choice is deferred to a follow-up
  ADR.

Verifiers SHOULD pin an `allowedIssuers` allowlist; the verifier emits
`ISSUER_NOT_ALLOWED` for any credential outside the set. The default
allowlist is empty, which means "verify the signature but accept any
issuer key" — suitable for advisory surfaces, never for protocol
gates.

### Snapshot semantics

`snapshot_slot` and `snapshot_timestamp` pin the credential to a
specific Solana slot. Reputation is a moving target under ADR-094
(±10 deltas per call), so the credential ALWAYS reflects a point-in-time
view. Three derived rules:

1. **Verifiers MUST enforce snapshot freshness** via the
   `maxSnapshotAgeSeconds` option. Even a credential with
   `expiry_unix_ts == 0` becomes useless past the verifier's
   freshness tolerance — a 5-year-old "perfect score" snapshot must
   not become a permanent gate-bypass.
2. **Issuers SHOULD short-circuit non-active profiles**. The reference
   HTTP issuer returns 409 for `is_active == false` so verifiers
   never see a credential for a paused/suspended/retired agent.
3. **Score deltas between snapshot and on-chain are legitimate**.
   The `verifyAttestationWithChain` cross-check intentionally does
   NOT require `reputation_score` equality — only the monotonic
   invariants below.

### Optional on-chain cross-check

When a verifier has an RPC handle, `verifyAttestationWithChain` runs
two extra checks:

- `slash_count` MUST be non-decreasing between snapshot and current
  state (slashing is monotonic per ADR-094 / closed-state-machine
  invariant). A regression indicates a forged credential.
- `registration_nonce` MUST be non-decreasing (ADR-097). A regression
  indicates a close-and-reopen Sybil reuse — the credential refers to
  a previous incarnation of the PDA.
- `authority` MUST match exactly.

`reputation_score` is deliberately excluded — that's the field the
snapshot is *supposed* to differ on.

## Implementation

### Components

| Layer       | Path                                                            |
| ----------- | --------------------------------------------------------------- |
| Library     | `packages/reputation-attestor/`                                 |
| Resolver    | `packages/sas-resolver/src/agenomics-reputation.ts`             |
| Issuer HTTP | `src/indexer/reputation-attestor.ts` + `reputation-attestor-wire.ts` |
| MCP tools   | `mcp-server/src/tools/reputation-attestation.ts`                |
| SDK         | `sdk/client/src/reputation.ts`                                  |

The issuer mount is **opt-in**: the indexer mounts the routes only when
`REPUTATION_ATTESTOR_KEYPAIR_PATH` / `_B64` is set. Existing deployments
are byte-for-byte unaffected. The mount logs `mounted: false` at INFO
on startup when issuer key material is absent.

### MCP tools (3)

- `issue_reputation_attestation` — issuer-only, gated by the
  `rep:attestation:issue` claim (default-deny per ADR-058 §4).
- `verify_reputation_attestation` — public; structured `reasons[]`
  collected so callers see every failed check at once.
- `get_portable_reputation` — fetch-from-issuer + verify convenience.

### Routes (2)

- `GET /reputation/:agent_id` — fresh issuance, in-process LRU cache
  keyed by `(agent_id, time-bucket)`, plus per-IP token-bucket
  rate-limit (60 req/min default).
- `GET /reputation/:agent_id/at/:slot` — historical issuance. Returns
  `501` with a documented fallback when no archive fetcher is wired.

## Consequences

### Positive

- Agenomics reputation becomes interoperable with off-chain verifiers
  who have no Agenomics RPC relationship.
- The schema is one signature check long — minimal verifier cost.
- The bounded-delta on-chain primitive (ADR-094) is the trust root; the
  signed snapshot is just a serialised view of it.
- No on-chain program change is required.

### Negative

- Introduces a centralised issuer key. Compromise of that key allows
  an attacker to mint arbitrary "reputation X for agent Y" credentials.
  Mitigations: pinned issuer allowlist on the verifier side; planned
  KMS adapter; planned decentralised issuer set (see Open Questions).
- Snapshot-freshness enforcement is a verifier-side responsibility.
  An undisciplined verifier that ignores `maxSnapshotAgeSeconds` will
  accept stale credentials.

## Threat model

| Threat                                  | Mitigation                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issuer key compromise                   | Pinned issuer allowlist on verifier; rotate the key; KMS adapter; out-of-band key-rotation announcements via `issuer_url` discovery doc.                                                    |
| Stale snapshot replay                   | `maxSnapshotAgeSeconds` MUST be set by every protocol-gate verifier. Advisory surfaces MAY skip but should log.                                                                            |
| Score delta race                        | Snapshot pins `snapshot_slot`. Score is allowed to drift on-chain — the credential is a snapshot, not a live oracle.                                                                       |
| Sybil reuse (close-then-reopen)         | `registration_nonce` cross-check (ADR-097). A new incarnation has a higher nonce; a credential pinned to the old incarnation fails `ONCHAIN_DIVERGENCE`.                                  |
| Cross-protocol replay                   | Domain-separated preimage (`AEP_REPUTATION_ATTESTATION_V1\0`). A signature over an Agenomics manifest body cannot validate against the reputation preimage.                              |
| Schema-confusion attack                 | `schema` field is REQUIRED and pinned to `agenomics.reputation.v1`; verifier rejects others.                                                                                              |
| Forged credentials                      | Ed25519 signature over canonical preimage; verifier rejects malformed signatures and unknown issuers.                                                                                       |
| Issuer service compromise               | Issuer key is a single key; rate-limit + cache at the HTTP layer to slow bulk minting. Operators MUST front the issuer with a CDN and monitor for anomalous issuance volume.            |
| Suspended-profile credential issuance   | Reference issuer returns 409 for `is_active == false`. Verifiers cross-check status on-chain when stakes are high.                                                                          |

## Open questions

- **Decentralised issuer set.** A multi-issuer trust model (M-of-N
  attestations) would remove the single-key compromise risk. Likely
  implementation: per-issuer SAS allowlist; verifier requires the
  union of N signed credentials. Tracked as a follow-up.
- **ZK score range proofs.** "Score is in `[70, 100]`" is a stronger
  privacy primitive than "score is exactly 73". A Plonk / Groth16
  range proof over the canonical preimage could ship the score-band
  without leaking the exact value. Tracked as a follow-up.
- **Indexer-backed historical issuance.** Today
  `GET /reputation/:agent_id/at/:slot` returns 501 unless the indexer
  has an archive RPC. A purpose-built historical projection in the
  indexer's Postgres store could close this without an archive node.

## References

- `packages/reputation-attestor/README.md` — package-level usage docs.
- ADR-060 — manifest signing model (the inspiration for the
  canonical-JSON + Ed25519 + domain-separator pattern).
- ADR-094 — bounded-delta reputation primitive (the on-chain root).
- ADR-097 — registration nonce (Sybil reuse defence).
