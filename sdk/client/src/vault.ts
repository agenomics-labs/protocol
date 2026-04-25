/**
 * AgentVaultClient — typed wrapper for the agent-vault Anchor program.
 *
 * Provides PDA derivation and typed account fetch methods. Instruction builders
 * (initVault, executeTransfer, etc.) are out of scope for v0.1.0.
 *
 * Usage:
 *   import agentVaultIdl from "path/to/idl/agent_vault.json" assert { type: "json" };
 *   import { Idl } from "@coral-xyz/anchor";
 *
 *   const VAULT_PROGRAM_ID = new PublicKey("4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN");
 *   const client = new AgentVaultClient(provider, agentVaultIdl as Idl, VAULT_PROGRAM_ID);
 *
 *   const pda = client.vaultPda(authority);
 *   const vault = await client.fetchVault(authority);
 */

import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

/** On-chain seed for the vault PDA. */
const VAULT_SEED = Buffer.from("vault");

/**
 * Client for the agent-vault program.
 *
 * The vault PDA is the canonical account that holds spending policy and
 * per-token rate limiting for an agent. It is linked to an AgentProfile
 * via the `vault_address` field on registration (ADR-041).
 */
export class AgentVaultClient {
  /** The underlying Anchor Program instance. */
  readonly program: Program;

  constructor(provider: AnchorProvider, idl: Idl, programId: PublicKey) {
    this.program = new Program(idl, provider);
    if (!this.program.programId.equals(programId)) {
      throw new Error(
        `AgentVaultClient: IDL programId ${this.program.programId.toBase58()} ` +
          `does not match supplied programId ${programId.toBase58()}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // PDA derivation
  // -------------------------------------------------------------------------

  /**
   * Derive the vault PDA for a given authority.
   *
   * Seeds: [ authority.toBytes(), "vault" ]
   */
  vaultPda(authority: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [authority.toBytes(), VAULT_SEED],
      this.program.programId,
    );
    return pda;
  }

  // -------------------------------------------------------------------------
  // Account fetches
  // -------------------------------------------------------------------------

  /**
   * Fetch and decode a Vault account.
   *
   * Returns the raw Anchor-decoded account object. Notable fields:
   *   - `agentIdentity: PublicKey`
   *   - `authority: PublicKey`
   *   - `paused: boolean`
   *   - `policy.perTxLimitLamports: BN`
   *   - `policy.dailyLimitLamports: BN`
   *   - `tokenSpendRecords: Array<{ mint: PublicKey, perTxLimit: BN, dailyLimit: BN, ... }>`
   *
   * @throws if the account does not exist or cannot be decoded.
   */
  async fetchVault(authority: PublicKey): Promise<Record<string, unknown>> {
    const pda = this.vaultPda(authority);
    // TODO(typed): parameterise once @agenomics/idl provides the AgentVault IDL type.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.program.account as any)["vault"].fetch(pda) as Promise<
      Record<string, unknown>
    >;
  }
}
