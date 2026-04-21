# @agenomics/sas-resolver

Reference resolver for the SAS (Solana Attestation Service) integration
described in [ADR-061](../../docs/adr/ADR-061-sas-integration.md) and
the caching strategy in
[ADR-065](../../docs/adr/ADR-065-caching-strategy.md).

Consumes a validated AEP capability manifest (see
[`@agenomics/capability-manifest-validator`](../capability-manifest-validator/README.md))
and resolves the optional `agent.owner_attestation` SAS pointer into a
typed reputation snapshot. Implements the 7-step flow in ADR-061 §4
faithfully — subject-mismatch is the one hard error; every other failure
mode (missing attestation, schema mismatch, expiry, credential not in
allowlist) degrades to `absent: true` so SAS stays strictly additive.

## Install

```sh
npm install @agenomics/sas-resolver
```

Peer deps: `@solana/kit@^6.8`, `@noble/curves@^1.4`. Optional runtime
dep: `ioredis@^5.4` (only needed if `AEP_REDIS_URL` is set — the
in-memory cache is the default).

## Usage

```ts
import { createSolanaRpc } from "@solana/kit";
import { SasResolver, createCache } from "@agenomics/sas-resolver";

const resolver = new SasResolver({
  rpc: createSolanaRpc("https://api.mainnet-beta.solana.com"),
  allowedCredentials: new Set([
    "<AEP_PROTOCOL credential PDA>",
    "<AEP_VALIDATORS credential PDA>",
  ]),
  schemaPda: "<AEP_AGENT_REPUTATION_v1 schema PDA>",
  cache: createCache(process.env),    // ADR-065: in-memory or Redis-backed
});

const result = await resolver.resolve(manifest, subjectAuthority);
//                                    ^ CapabilityManifest (already validated)
//                                              ^ base58 agent authority pubkey

if (!result.ok) throw new Error(result.error.message);
const reputation = result.value;

if (reputation.absent) {
  // No owner_attestation, or attestation missing/expired/unsupported — SAS has no signal.
} else {
  console.log("SAS score (bps):", reputation.attestation.score);
  console.log("completed_tasks:", reputation.attestation.completed_tasks);
  console.log("stale?", reputation.stale);
}
```

## Caching (ADR-065)

The resolver caches three SAS layers: **attestation** (5 min default),
**schema** (1 hour default), **credential** (1 hour default). TTLs are
configurable via `ResolverConfig.ttl`. Per-call overrides:

```ts
// Force-fresh read (e.g., a protocol-logic path that must see current state)
await resolver.resolve(manifest, subject, { maxAge: 0 });

// Accept up to 30s stale
await resolver.resolve(manifest, subject, { maxAge: 30_000 });
```

Multi-instance deployments can set `AEP_REDIS_URL` and the factory
returns a `LayeredCache` (in-memory L1 + Redis L2). Pattern mirrors
[`mcp-server/src/pipeline/idempotency.ts`](../../mcp-server/src/pipeline/idempotency.ts)
from ADR-059.

## Merge helpers

The resolver ships a few convenience helpers for the ADR-061 §4
"display side-by-side, don't blend" merge convention:

```ts
import { renderSideBySide, detectDisagreement, scoreFreshness } from "@agenomics/sas-resolver";

const lines = renderSideBySide(onChainReputation, reputation);  // { line1, line2 }
const disagrees = detectDisagreement(onChainReputation, reputation);   // > 2000 bps delta
const freshness = scoreFreshness(reputation.attestation.last_updated, Date.now());
//                 'fresh' | 'aging' | 'stale'
```

## Non-goals

- Does not fetch the Registry account or the manifest body — consume a pre-validated manifest.
- Does not validate the manifest — use `@agenomics/capability-manifest-validator` upstream.
- Does not mint, close, or rotate attestations — read-only client.
- Does not take on-chain governance actions — see [ADR-063](../../docs/adr/ADR-063-sas-credential-authority-governance.md) for the credential authority lifecycle.

## Related

- [ADR-061](../../docs/adr/ADR-061-sas-integration.md) — integration model + resolution flow + merge semantics
- [ADR-063](../../docs/adr/ADR-063-sas-credential-authority-governance.md) — credential authority governance (Proposed)
- [ADR-064](../../docs/adr/ADR-061-sas-integration.md#open-items--follow-up-adrs) — this package
- [ADR-065](../../docs/adr/ADR-065-caching-strategy.md) — caching strategy

## License

Part of the Agenomics Protocol. See repository root.
