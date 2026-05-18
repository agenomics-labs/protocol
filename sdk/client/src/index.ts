/**
 * @agenomics/client — TypeScript SDK for AEP on-chain programs.
 *
 * Provides ergonomic, typed wrappers around the three AEP Anchor programs:
 *   - AgentRegistryClient  (agent-registry program)
 *   - AgentVaultClient     (agent-vault program)
 *   - SettlementClient     (settlement program)
 *
 * Also re-exports cluster-keyed program IDs from @agenomics/idl via AepClient,
 * which is a lightweight config helper for bootstrapping connections.
 *
 * Quick start — program clients:
 *
 *   import { AgentRegistryClient, AgentStatus } from "@agenomics/client";
 *   import { AnchorProvider, Idl } from "@coral-xyz/anchor";
 *   import type { Address } from "@solana/kit";
 *
 *   // Load your IDL JSON (from target/idl/ or @agenomics/idl once ADR-099 matures)
 *   import agentRegistryIdl from "./target/idl/agent_registry.json" assert { type: "json" };
 *
 *   const provider = AnchorProvider.env();
 *   const REGISTRY_PROGRAM_ID = "psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv" as Address;
 *   const registry = new AgentRegistryClient(
 *     provider, agentRegistryIdl as Idl, REGISTRY_PROGRAM_ID
 *   );
 *
 *   const pda = await registry.profilePda(authority, 0n);   // returns Address
 *   const profile = await registry.fetchProfile(authority, 0n);
 *
 * Quick start — cluster config helper:
 *
 *   import { AepClient } from "@agenomics/client";
 *   const client = new AepClient({ cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" });
 *   const { agentRegistry, agentVault, settlement } = client.getProgramIds();
 *
 * See ADR-098 (SDK rationale) and ADR-087 (web3.js v1→@solana/kit v2 migration).
 */

import {
  getProgramDerivedAddress,
  getAddressEncoder,
  type Address,
} from "@solana/kit";
import type { ProgramIds } from "@agenomics/idl";
import { getProgramIds } from "@agenomics/idl";

// ---------------------------------------------------------------------------
// Re-export program clients
// ---------------------------------------------------------------------------

export {
  AgentRegistryClient,
  MAX_REPUTATION_SCORE,
  clampReputationScore,
} from "./registry.js";
export {
  AgentVaultClient,
  VAULT_IDENTITY_BIND_DOMAIN,
  ED25519_PROGRAM_ADDRESS,
  vaultIdentityBindMessage,
  buildVaultIdentityBindInstruction,
  GRANT_ACTIONS,
  type Ed25519VerifyInstruction,
  type GrantTokenCapInput,
} from "./vault.js";
export { SettlementClient } from "./settlement.js";
export {
  REFLEX_HOOK_PAYLOAD_LEN,
  HOOK_REPLAY_SEED,
  HOOK_SIGNER_SEED,
  encodeReflexHookPayload,
  decodeReflexHookPayload,
  hookSignerPda,
  hookReplayPda,
  type ReflexHookPayload,
} from "./cctp-hook.js";

// ADR-139 — portable reputation attestation namespace. Re-exports the
// helpers and types from `@agenomics/reputation-attestor` plus SDK-side
// `fromAgentProfile` / `issueForProfile` conveniences keyed off Anchor's
// decoded profile shape.
export {
  Reputation,
  type AnchorAgentProfileLike,
  type FromAgentProfileOptions,
  type ReputationCredential,
  type ReputationAttestationPayload,
  type AgentProfileSnapshot,
  type IssueOptions,
  type IssuerKeypair,
  type VerifyOptions,
  type VerifyResult,
  type OnChainProfileFetcher,
} from "./reputation.js";

// ---------------------------------------------------------------------------
// Re-export shared types
// ---------------------------------------------------------------------------

export {
  AgentStatus,
  PricingModel,
  EscrowStatus,
  MilestoneStatus,
  type ReputationStake,
} from "./types.js";

// ---------------------------------------------------------------------------
// ADR-141 — Codama-generated typed clients (additive, tree-shakable).
//
// `@agenomics/client@0.1.0` deferred instruction builders (ADR-098 "Out
// of scope"). ADR-141 closes that gap via codegen: the three program
// clients are rendered from the committed Anchor IDL by `npm run codegen`
// (see `codama.config.mjs`) and committed under `src/generated/`. Each is
// re-exported under a per-program namespace because the generated trees
// have intentional cross-program name collisions (e.g. `AgentStatus`
// exists in both the registry and vault IDLs); namespacing keeps every
// generated symbol reachable without a flat-export clash and preserves
// tree-shaking (consumers import only `registry.getRegisterAgentInstruction`
// etc. and pay only for that surface).
//
// The hand-written `AgentRegistryClient` / `AgentVaultClient` /
// `SettlementClient` façades above are UNCHANGED in public shape and now
// derive PDAs through these generated helpers (SDK-F2 trust root closed).
// New surface (instruction builders, account decoders, error maps) is
// purely additive — `0.1.0` consumers upgrade with no source changes.
// ---------------------------------------------------------------------------

export * as registry from "./generated/registry/index.js";
export * as vault from "./generated/vault/index.js";
export * as settlement from "./generated/settlement/index.js";

// ---------------------------------------------------------------------------
// Re-exports from @agenomics/idl
// ---------------------------------------------------------------------------

export type { Cluster, ProgramIds } from "@agenomics/idl";
export { getProgramIds, PROGRAM_IDS } from "@agenomics/idl";

// ---------------------------------------------------------------------------
// AepClient — lightweight config helper
// ---------------------------------------------------------------------------

export interface AepClientConfig {
  cluster: import("@agenomics/idl").Cluster;
  rpcUrl: string;
}

/**
 * Lightweight cluster-config helper.
 *
 * Use this to resolve program IDs for a given cluster and bootstrap
 * `AgentRegistryClient`, `AgentVaultClient`, and `SettlementClient`.
 *
 * For PDA derivation, use the typed client classes directly — they accept
 * `Address` (string-branded base58) arguments and use kit's
 * `getProgramDerivedAddress` under the hood.
 */
export class AepClient {
  private readonly programIds: ProgramIds;
  readonly rpcUrl: string;

  constructor(config: AepClientConfig) {
    this.programIds = getProgramIds(config.cluster);
    this.rpcUrl = config.rpcUrl;
  }

  getProgramIds(): ProgramIds {
    return this.programIds;
  }

  /**
   * Derive the agent-profile PDA for a given owner public key (base58) and nonce.
   *
   * Seeds: [ ownerPubkey, "agent-profile", nonce as little-endian u64 ]
   *
   * AUD-003: `OwnerNonce::nonce` is `u64` on-chain (see
   * `programs/agent-registry/src/state.rs`). Pre-fix this helper encoded
   * the seed via `BigInt64Array` (signed i64); we use a DataView with
   * `setBigUint64(..., true)` to match the on-chain `u64::to_le_bytes()`
   * encoding exactly.
   *
   * ADR-087: post v2 migration, this helper is async because kit's
   * `getProgramDerivedAddress` is async (Web Crypto-compatible).
   *
   * @returns the PDA as a base58-encoded `Address` (branded string).
   */
  async deriveAgentProfilePda(ownerPubkey: string, nonce: bigint = 0n): Promise<Address> {
    const addressEncoder = getAddressEncoder();
    const nonceBuf = new Uint8Array(8);
    new DataView(nonceBuf.buffer).setBigUint64(0, nonce, true);
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.programIds.agentRegistry as Address,
      seeds: [
        addressEncoder.encode(ownerPubkey as Address),
        "agent-profile",
        nonceBuf,
      ],
    });
    return pda;
  }
}
