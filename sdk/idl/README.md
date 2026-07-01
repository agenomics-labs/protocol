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

console.log(ids.agentRegistry); // 26KETQPxeMmbakxpVbUEpQBQmVgpabHAweTHBRgBHjW7
console.log(ids.agentVault);    // D2y1dEi4dj1pcxw6GvkFWX34RRbuFJCaGWdPNJAasQ5q
console.log(ids.settlement);    // AwjdsNvhR2uwPNbU6F2fsYB33VcNGL5XaANdgsyvZDia

// Pass the IDL to Anchor (cast at the call site).
const idl = AgentRegistryIdl as Idl;
```

## Key exports

- `getProgramIds(cluster)` — returns the `{ agentRegistry, agentVault, settlement }` triple for one cluster. **Throws** for any cluster whose IDs are not genuinely provisioned (currently `mainnet-beta`; see the AUD-207 caveat below).
- `PROGRAM_IDS` — the full record keyed by `Cluster`. Provisioned clusters map to a `ProgramIds` triple; un-provisioned clusters (`mainnet-beta`) map to `null`.
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

> **AUD-207 caveat — `mainnet-beta` is unprovisioned and fails closed.**
> Distinct, governance-controlled program IDs (one keypair per cluster,
> upgrade authority held by the Squads multisig) will land with
> Track A2 of `docs/PRE_MAINNET_ROADMAP.md` and ADR-083. Until that
> ceremony completes, `mainnet-beta` has **no** program IDs:
> `PROGRAM_IDS["mainnet-beta"]` is `null` and
> `getProgramIds("mainnet-beta")` (and therefore
> `new AepClient({ cluster: "mainnet-beta", ... })`) **throws** an
> actionable error rather than returning placeholder devnet addresses —
> returning them would build escrow/transfer transactions against
> programs whose upgrade authority is a test key (a fund-loss path).
> `devnet` and `localnet` resolve normally and intentionally share the
> same on-chain test binaries.
