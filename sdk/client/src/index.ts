import type { ProgramIds } from "@agenomics/idl";
import { getProgramIds } from "@agenomics/idl";

export type { Cluster, ProgramIds } from "@agenomics/idl";
export { getProgramIds, PROGRAM_IDS } from "@agenomics/idl";

export interface AepClientConfig {
  cluster: import("@agenomics/idl").Cluster;
  rpcUrl: string;
}

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
   * Derives the agent profile PDA for the given owner public key.
   *
   * This is a placeholder implementation. The real implementation requires
   * `@solana/web3.js` (`PublicKey.findProgramAddressSync`) which is an
   * optional peer dependency. Install `@solana/web3.js` and replace this
   * body with:
   *
   * ```ts
   * import { PublicKey } from "@solana/web3.js";
   * const [pda] = PublicKey.findProgramAddressSync(
   *   [Buffer.from("agent_profile"), new PublicKey(ownerPubkey).toBuffer()],
   *   new PublicKey(this.programIds.agentRegistry),
   * );
   * return pda.toBase58();
   * ```
   */
  deriveAgentProfilePda(ownerPubkey: string, nonce?: bigint): string {
    void ownerPubkey;
    void nonce;
    throw new Error(
      "deriveAgentProfilePda: install @solana/web3.js and implement " +
        "PublicKey.findProgramAddressSync for this SDK scaffold.",
    );
  }
}
