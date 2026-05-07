# @agenomics/client

Typed TypeScript client for the three AEP on-chain Anchor programs.

The main entry point for builders integrating with the Agenomics
Protocol from a Node or browser environment. Ships ergonomic Anchor
wrappers for `agent-registry`, `agent-vault`, and `settlement` —
`AgentRegistryClient`, `AgentVaultClient`, and `SettlementClient` — each
with deterministic PDA derivation and typed account fetches that match
the on-chain seeds byte-for-byte. A lightweight `AepClient` config
helper resolves cluster-keyed program IDs (re-exported from
`@agenomics/idl`) so you can bootstrap connections without hard-coding
addresses. Instruction builders are out of scope for `0.1.0`; this
release is read-side first. See ADR-098 for the design rationale.

## Install

```sh
npm install @agenomics/client
```

_Not yet on npm; pre-publish 0.1.0. See `docs/SDK_PUBLISH.md` for the publish path._

Peer dependencies: `@coral-xyz/anchor@^0.31`, `@solana/web3.js@^1.95`.

## Quick example

```ts
import { AgentRegistryClient, clampReputationScore } from "@agenomics/client";
import { AnchorProvider, Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { AgentRegistryIdl, getProgramIds } from "@agenomics/idl";

const provider = AnchorProvider.env();
const programId = new PublicKey(getProgramIds("devnet").agentRegistry);
const registry = new AgentRegistryClient(provider, AgentRegistryIdl as Idl, programId);

const authority = new PublicKey("psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv");
const profilePda = registry.profilePda(authority, 0n);
const profile = await registry.fetchProfile(authority, 0n);
const score = clampReputationScore(BigInt(profile.reputationScore.toString()));
console.log(profilePda.toBase58(), `${score}/100`);
```

For a one-line cluster bootstrap without owning a provider yet:

```ts
import { AepClient } from "@agenomics/client";

const client = new AepClient({ cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" });
const { agentRegistry, agentVault, settlement } = client.getProgramIds();
const profilePda = client.deriveAgentProfilePda(authority.toBase58(), 0n);
```

## Key exports

- `AepClient` — config helper: holds `rpcUrl`, exposes `getProgramIds()` and `deriveAgentProfilePda(ownerPubkey, nonce?)`.
- `AgentRegistryClient` — `profilePda`, `ownerNoncePda`, `fetchProfile`, `fetchOwnerNonce`. Constructor verifies the IDL `programId` matches the supplied one (early failure on mis-wired clusters).
- `AgentVaultClient` — `vaultPda`, `fetchVault`. Plus `vaultIdentityBindMessage(authority, agentIdentity)` and `buildVaultIdentityBindInstruction({...})` for the ADR-124 proof-of-control signature paired with `initialize_vault`. `VAULT_IDENTITY_BIND_DOMAIN` is exported as the canonical 27-byte domain tag.
- `SettlementClient` — `escrowPda`, `fetchEscrow`. Mirrors the on-chain settlement seeds.
- `MAX_REPUTATION_SCORE`, `clampReputationScore(raw)` — defensive presentation-layer clamp for AUD-112 legacy reads.
- Enums: `AgentStatus`, `PricingModel`, `EscrowStatus`, `MilestoneStatus`. Type alias `ReputationStake`.
- Re-exports from `@agenomics/idl`: `Cluster`, `ProgramIds`, `getProgramIds`, `PROGRAM_IDS`.

## Related packages

- `@agenomics/idl` — re-exported here; install it directly if you only need program IDs and IDL JSON, no Anchor wrappers.
- `@agenomics/action-runtime` — wrap your client calls inside `defineAction` to expose them as AEP capability handlers with a `Result`-typed contract.
- `@agenomics/capability-manifest-validator` — fetch an `AgentProfile` with this client, then validate its off-chain manifest body against `manifest_hash` / `manifest_signature` / `authority`.
- `@agenomics/sas-resolver` — resolve the optional SAS attestation pointer from a validated manifest into a typed reputation snapshot.

## Status

0.1.0 — pre-publish; private until license + READMEs land per `docs/SDK_PUBLISH.md`.
