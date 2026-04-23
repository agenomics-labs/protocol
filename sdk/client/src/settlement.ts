/**
 * SettlementClient — typed wrapper for the settlement Anchor program.
 *
 * Provides PDA derivation and typed account fetch methods. Instruction builders
 * (createEscrow, approveMilestone, etc.) are out of scope for v0.1.0.
 *
 * Usage:
 *   import settlementIdl from "path/to/idl/settlement.json" assert { type: "json" };
 *   import { Idl } from "@coral-xyz/anchor";
 *
 *   const SETTLEMENT_PROGRAM_ID = new PublicKey("GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3");
 *   const client = new SettlementClient(provider, settlementIdl as Idl, SETTLEMENT_PROGRAM_ID);
 *
 *   const pda = client.escrowPda(clientKey, providerKey, 1n);
 *   const escrow = await client.fetchEscrow(clientKey, providerKey, 1n);
 */

import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

/** On-chain seed for task escrow PDAs. */
const ESCROW_SEED = Buffer.from("task_escrow");

/** On-chain seed for the protocol-config PDA. */
const PROTOCOL_CONFIG_SEED = Buffer.from("protocol_config");

/**
 * Client for the settlement program.
 *
 * Covers both the task-escrow lifecycle and the governance-owned
 * ProtocolConfig account (ADR-075).
 */
export class SettlementClient {
  /** The underlying Anchor Program instance. */
  readonly program: Program;

  constructor(provider: AnchorProvider, idl: Idl, programId: PublicKey) {
    this.program = new Program(idl, provider);
    if (!this.program.programId.equals(programId)) {
      throw new Error(
        `SettlementClient: IDL programId ${this.program.programId.toBase58()} ` +
          `does not match supplied programId ${programId.toBase58()}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // PDA derivation
  // -------------------------------------------------------------------------

  /**
   * Derive the task-escrow PDA for a given client, provider, and task ID.
   *
   * Seeds: [ "task_escrow", client.toBytes(), provider.toBytes(), taskId as little-endian u64 ]
   *
   * The task ID is a monotonically increasing counter chosen at escrow
   * creation time to prevent collisions (ADR-052).
   */
  escrowPda(
    client: PublicKey,
    provider: PublicKey,
    taskId: bigint,
  ): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        ESCROW_SEED,
        client.toBytes(),
        provider.toBytes(),
        Buffer.from(new Uint8Array(new BigUint64Array([taskId]).buffer)),
      ],
      this.program.programId,
    );
    return pda;
  }

  /**
   * Derive the protocol-config PDA.
   *
   * Seeds: [ "protocol_config" ]
   *
   * The single ProtocolConfig account holds governance-adjustable parameters:
   * minimum escrow amount, dispute timeout, and reputation deltas (ADR-075).
   */
  protocolConfigPda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [PROTOCOL_CONFIG_SEED],
      this.program.programId,
    );
    return pda;
  }

  // -------------------------------------------------------------------------
  // Account fetches
  // -------------------------------------------------------------------------

  /**
   * Fetch and decode a TaskEscrow account.
   *
   * Returns the raw Anchor-decoded account object. Notable fields:
   *   - `client: PublicKey`
   *   - `provider: PublicKey`
   *   - `tokenMint: PublicKey`
   *   - `totalAmount: BN`
   *   - `status: { created: {} } | { active: {} } | ...`
   *   - `milestones: Array<{ amount: BN, status: ..., graceEndsAt: BN }>`
   *   - `disputedAt: BN | null`
   *
   * @throws if the account does not exist or cannot be decoded.
   */
  async fetchEscrow(
    client: PublicKey,
    provider: PublicKey,
    taskId: bigint,
  ): Promise<Record<string, unknown>> {
    const pda = this.escrowPda(client, provider, taskId);
    // TODO(typed): parameterise once @agenomics/idl provides the Settlement IDL type.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.program.account as any)["taskEscrow"].fetch(pda) as Promise<
      Record<string, unknown>
    >;
  }

  /**
   * Fetch and decode the ProtocolConfig account.
   *
   * Returns governance parameters including `minEscrowAmount`,
   * `disputeTimeoutSeconds`, and the three reputation deltas (all as BN).
   *
   * @throws if the account does not exist or cannot be decoded.
   */
  async fetchProtocolConfig(): Promise<Record<string, unknown>> {
    const pda = this.protocolConfigPda();
    // TODO(typed): parameterise once @agenomics/idl provides the Settlement IDL type.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.program.account as any)["protocolConfig"].fetch(
      pda,
    ) as Promise<Record<string, unknown>>;
  }
}
