# @agenomics/reputation-attestor

Portable reputation attestations for AEP agents (ADR-139).

A signed, schema-stable credential that lets a third party verify, in one
Ed25519 signature check, that an Agenomics agent has reputation X / slash
count Y at snapshot slot Z — **without** trusting a centralised API and
**without** re-reading Agenomics on-chain state.

## What this package is

- A pure, transport-agnostic credential primitive. No network calls. No
  filesystem mutation in the hot path.
- An RFC-8785 canonical-JSON payload (`agenomics.reputation.v1`), Ed25519-signed
  by an issuer key (loaded from env / KMS).
- A verifier that returns a structured `VerifyResult` listing every reason
  a credential failed — designed for operator triage, not silent failure.

## What this package is **not**

- It does not fetch the on-chain `AgentProfile`. Use `@agenomics/client` or
  the indexer for that, then hand the snapshot in.
- It does not host an HTTP service. See `src/indexer/reputation-attestor.ts`
  for the reference issuer endpoint.
- It is not a generic SAS resolver. ADR-061 / ADR-064 / `@agenomics/sas-resolver`
  cover that surface; this package is the cross-protocol export format.

## Quick start

### Issue

```ts
import {
  issueAttestation,
  issuerKeypairFromSecret,
  type AgentProfileSnapshot,
} from "@agenomics/reputation-attestor";

const issuer = issuerKeypairFromSecret(issuerSecretScalar32);

const snapshot: AgentProfileSnapshot = {
  agent_id: profilePda,
  authority: profile.authority.toBase58(),
  manifest_hash: hexEncode(profile.manifestHash),
  reputation_score: clampReputationScore(BigInt(profile.reputationScore.toString())),
  slash_count: profile.reputationStake.slashCount,
  reputation_stake_lamports: BigInt(profile.reputationStake.stakedAmount.toString()),
  registration_nonce: BigInt(profile.registrationNonce.toString()),
  snapshot_slot: currentSlot,
  snapshot_timestamp: Math.floor(Date.now() / 1000),
};

const credential = issueAttestation(snapshot, {
  issuer,
  issuerUrl: "https://reputation.agenomics.io",
  expiryUnixTs: 0, // perpetual; verifier must enforce freshness
});

// `credential` is JSON-safe — POST / GET / store anywhere.
```

### Verify

```ts
import { verifyAttestation } from "@agenomics/reputation-attestor";

const result = verifyAttestation(credential, {
  allowedIssuers: ["<issuer-pubkey-1>", "<issuer-pubkey-2>"],
  maxSnapshotAgeSeconds: 24 * 60 * 60, // 24h
});

if (result.ok) {
  console.log("verified", result.payload.reputation_score);
} else {
  for (const r of result.reasons) console.error(r.code, r.message);
}
```

### Optional on-chain cross-check

```ts
import { verifyAttestationWithChain } from "@agenomics/reputation-attestor";

const result = await verifyAttestationWithChain(credential, {
  allowedIssuers: ALLOWED,
  maxSnapshotAgeSeconds: 7 * 24 * 60 * 60,
  onChain: {
    async fetch(agentId) {
      const profile = await registry.fetchProfileByAddress(agentId);
      return {
        authority: profile.authority.toBase58(),
        reputation_score: profile.reputationScore.toNumber(),
        slash_count: profile.reputationStake.slashCount,
        registration_nonce: BigInt(profile.registrationNonce.toString()),
      };
    },
  },
});
```

The cross-check verifies the monotonic invariants between snapshot and
on-chain state:

- `slash_count`: on-chain must be `>=` snapshot.
- `registration_nonce`: on-chain must be `>=` snapshot. A regression
  signals a close-and-reopen Sybil re-use (ADR-097).
- `authority`: must match exactly.

`reputation_score` is intentionally **not** a cross-check field — it
fluctuates under ADR-094 ±10 deltas. Verifiers that need the current
value should request a fresh attestation, not reconcile against a stale
snapshot.

## Issuer key material

`loadIssuerKeypair()` checks these env vars in order:

| Env var                                | Meaning                                              |
| -------------------------------------- | ---------------------------------------------------- |
| `REPUTATION_ATTESTOR_KEYPAIR_PATH`     | Path to a 64-byte Solana-keypair JSON array          |
| `REPUTATION_ATTESTOR_KEYPAIR_B64`      | Base64-encoded raw 64-byte secret key                |
| `REPUTATION_ATTESTOR_KMS_URI`          | Reserved for a future KMS adapter (not yet bundled)  |

A production deployment should sit behind a KMS adapter; the choice is
deferred to a follow-up ADR (AWS KMS / GCP KMS / HSM). Until that lands,
the `_PATH` / `_B64` paths are the supported integration points.

## See also

- `docs/adr/ADR-139-portable-reputation-attestations.md` — full design.
- `docs/adr/ADR-094-reputation-trust-hierarchy-inversion.md` — the on-chain
  bounded-delta model this snapshot is read against.
- `docs/adr/ADR-060-capability-descriptor-format.md` — manifest signing
  precedent (same canonical-JSON + Ed25519 pattern).
- `packages/sas-resolver/` — adjacent attestation resolver; uses the
  shared resolver-init / Redis cache patterns.
