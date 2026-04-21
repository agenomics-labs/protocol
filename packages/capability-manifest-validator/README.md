# @aep/capability-manifest-validator

Reference validator for the AEP capability manifest format defined in
[ADR-060](../../docs/adr/ADR-060-capability-descriptor-format.md).

Agents in the Agenomics Protocol publish a signed, off-chain
**capability manifest** that describes what they can do, in what I/O
shape, with what cost, and under what preflight gates. The Registry
program stores only a content hash + signature; the manifest itself
lives on IPFS or Arweave. This package validates a manifest body against
the on-chain commitment.

## What it checks

1. **Schema** — the JSON conforms to the ADR-060 §2 v1.0 `CapabilityManifest` interface (base58 pubkeys, kebab-case capability names, valid side-effects, recognized preflight gates, stability enum, required fields).
2. **Canonical JSON hash** — the bytes fed in, serialized with [RFC-8785 canonicalization](https://datatracker.ietf.org/doc/html/rfc8785) and SHA-256'd, match the on-chain `manifest_hash`. Eliminates whitespace / key-order drift.
3. **Ed25519 signature** — the on-chain `manifest_signature` is a valid Ed25519 signature over `manifest_hash` by the agent's authority pubkey.
4. **Authority binding** — the manifest's self-declared `agent.pubkey` matches the on-chain authority passed in (defense-in-depth against manifest-author confusion).

## Install

```sh
npm install @aep/capability-manifest-validator
```

Peer dependencies: `@noble/curves@^1.4.0`, `@noble/hashes@^1.4.0`, `canonicalize@^2.0.0`, `zod@^3.23`.

## Usage

```ts
import { validateManifest } from "@aep/capability-manifest-validator";

// Bytes fetched from IPFS/Arweave via the manifest_cid stored on-chain.
const manifestBytes: Uint8Array = await fetchManifestBody(cid);

// On-chain commitments from AgentProfile.
const onChainHash: Uint8Array      = profile.manifest_hash;
const onChainSignature: Uint8Array = profile.manifest_signature;
const authorityPubkey: Uint8Array  = profile.authority;

const result = validateManifest(
  manifestBytes,
  onChainHash,
  onChainSignature,
  authorityPubkey,
);

if (!result.ok) {
  // Typed error: { code: 'HASH_MISMATCH' | 'SIGNATURE_INVALID' | 'SCHEMA_INVALID' | ... , message, details? }
  throw new Error(`manifest invalid: ${result.error.message}`);
}

const manifest = result.value;
console.log(manifest.agent.name, manifest.capabilities.length);
```

## Non-goals

This package does **not** fetch the manifest from IPFS/Arweave, the Registry account from Solana, or SAS attestations. Those concerns live upstream (in a downstream integration) or in `@aep/sas-resolver`. This package is pure, synchronous-ish (Ed25519 is fast), and has no network dependency.

## Related

- [ADR-060](../../docs/adr/ADR-060-capability-descriptor-format.md) — manifest format + on-chain commitments
- [ADR-061](../../docs/adr/ADR-061-sas-integration.md) — the `owner_attestation` field reserved for SAS
- [`@aep/sas-resolver`](../sas-resolver/README.md) — resolves SAS attestations referenced by a validated manifest

## License

Part of the Agenomics Protocol. See repository root.
