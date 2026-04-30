# @agenomics/idl

Cluster-keyed program IDs and IDL JSON for the three AEP on-chain programs.

The lowest layer of the Agenomics SDK. This package ships the Anchor IDL
JSON for `agent-registry`, `agent-vault`, and `settlement`, plus a tiny
`getProgramIds(cluster)` helper that returns the deployed program
addresses for `devnet`, `mainnet-beta`, or `localnet`. It has zero
runtime dependencies — consume it directly when you only need program
IDs, or let `@agenomics/client` re-export it transparently when you want
typed program clients on top.

## Install

```sh
npm install @agenomics/idl
```

_Not yet on npm; pre-publish 0.1.0. See `docs/SDK_PUBLISH.md` for the publish path._

## Quick example

```ts
import { getProgramIds, AgentRegistryIdl } from "@agenomics/idl";
import type { Cluster, ProgramIds } from "@agenomics/idl";
import type { Idl } from "@coral-xyz/anchor";

const cluster: Cluster = "devnet";
const ids: ProgramIds = getProgramIds(cluster);

console.log(ids.agentRegistry); // 8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh
console.log(ids.agentVault);    // 4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN
console.log(ids.settlement);    // GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3

// Pass the IDL to Anchor (cast at the call site).
const idl = AgentRegistryIdl as Idl;
```

## Key exports

- `getProgramIds(cluster)` — returns the `{ agentRegistry, agentVault, settlement }` triple for one cluster.
- `PROGRAM_IDS` — the full record keyed by `Cluster`. Useful for sanity-checking all three clusters at boot time.
- `Cluster` — the union type `"devnet" | "mainnet-beta" | "localnet"`.
- `ProgramIds` — the shape of one cluster's program-ID triple.
- `AgentRegistryIdl`, `AgentVaultIdl`, `SettlementIdl` — the IDL JSON for each program. Cast to `Idl` from `@coral-xyz/anchor` at the call site.

## Related packages

- `@agenomics/client` — typed Anchor wrappers (`AgentRegistryClient`, `AgentVaultClient`, `SettlementClient`) that consume these IDs and IDLs.
- `@agenomics/action-runtime` — the `Result` type and `defineAction` builder for capability handlers; pairs naturally with `@agenomics/client` calls inside an action.
- `@agenomics/capability-manifest-validator` — validates an off-chain capability manifest against the on-chain `AgentProfile` commitments fetched via `@agenomics/client`.
- `@agenomics/sas-resolver` — resolves the optional SAS attestation referenced by a validated manifest.

## Status

0.1.0 — pre-publish; private until license + READMEs land per `docs/SDK_PUBLISH.md`.

> **AUD-207 caveat — placeholder program IDs.** The `devnet`,
> `mainnet-beta`, and `localnet` entries are byte-identical today.
> Distinct, governance-controlled program IDs (one keypair per cluster,
> upgrade authority held by the Squads multisig) will land with
> Track A2 of `docs/PRE_MAINNET_ROADMAP.md` and ADR-083. Until then,
> treat any cluster suffix as cosmetic — the bytes are the same.
> Builders should not assume `getProgramIds("mainnet-beta")` differs
> from `getProgramIds("devnet")` until that ceremony completes.
