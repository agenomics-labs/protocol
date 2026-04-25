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
 *   import { PublicKey } from "@solana/web3.js";
 *
 *   // Load your IDL JSON (from target/idl/ or @agenomics/idl once ADR-099 matures)
 *   import agentRegistryIdl from "./target/idl/agent_registry.json" assert { type: "json" };
 *
 *   const provider = AnchorProvider.env();
 *   const REGISTRY_PROGRAM_ID = new PublicKey("8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh");
 *   const registry = new AgentRegistryClient(
 *     provider, agentRegistryIdl as Idl, REGISTRY_PROGRAM_ID
 *   );
 *
 *   const pda = registry.profilePda(authority, 0n);
 *   const profile = await registry.fetchProfile(authority, 0n);
 *
 * Quick start — cluster config helper:
 *
 *   import { AepClient } from "@agenomics/client";
 *   const client = new AepClient({ cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" });
 *   const { agentRegistry, agentVault, settlement } = client.getProgramIds();
 *
 * See ADR-098 for design rationale.
 */

import { PublicKey } from "@solana/web3.js";
import type { ProgramIds } from "@agenomics/idl";
import { getProgramIds } from "@agenomics/idl";

// ---------------------------------------------------------------------------
// Re-export program clients
// ---------------------------------------------------------------------------

export { AgentRegistryClient } from "./registry.js";
export { AgentVaultClient } from "./vault.js";
export { SettlementClient } from "./settlement.js";

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
 * `PublicKey` arguments and use `PublicKey.findProgramAddressSync` under
 * the hood.
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
   * Seeds: [ ownerPubkey.toBytes(), "agent-profile", nonce as little-endian u64 ]
   *
   * AUD-003: `OwnerNonce::nonce` is `u64` on-chain (see
   * `programs/agent-registry/src/state.rs`). Pre-fix this helper encoded
   * the seed via `BigInt64Array` (signed i64); `BigUint64Array` matches
   * the on-chain type and keeps this helper byte-identical to
   * `AgentRegistryClient.profilePda`.
   *
   * Returns the PDA as a base58-encoded string.
   */
  deriveAgentProfilePda(ownerPubkey: string, nonce: bigint = 0n): string {
    const authority = new PublicKey(ownerPubkey);
    const registryProgramId = new PublicKey(this.programIds.agentRegistry);
    const [pda] = PublicKey.findProgramAddressSync(
      [
        authority.toBytes(),
        Buffer.from("agent-profile"),
        Buffer.from(new Uint8Array(new BigUint64Array([nonce]).buffer)),
      ],
      registryProgramId,
    );
    return pda.toBase58();
  }
}
