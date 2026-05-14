/**
 * SettlementClient — typed wrapper for the settlement Anchor program.
 *
 * Provides PDA derivation and typed account fetch methods. Instruction builders
 * (createEscrow, approveMilestone, etc.) are out of scope for v0.1.0.
 *
 * Usage:
 *   import settlementIdl from "path/to/idl/settlement.json" assert { type: "json" };
 *   import { Idl } from "@coral-xyz/anchor";
 *   import type { Address } from "@solana/kit";
 *
 *   const SETTLEMENT_PROGRAM_ID = "9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95" as Address;
 *   const client = new SettlementClient(provider, settlementIdl as Idl, SETTLEMENT_PROGRAM_ID);
 *
 *   const pda = await client.escrowPda(clientKey, providerKey, 1n);  // Address
 *   const escrow = await client.fetchEscrow(clientKey, providerKey, 1n);
 */

import { Program, AnchorProvider, web3 } from "@coral-xyz/anchor";
import {
  getProgramDerivedAddress,
  getAddressEncoder,
  type Address,
} from "@solana/kit";

import type { Settlement } from "./idl-types.js";

/**
 * ADR-087: PublicKey is reached via Anchor's `web3` re-export so the SDK
 * does not directly depend on `@solana/web3.js`.
 */
type PublicKey = web3.PublicKey;
const PublicKey = web3.PublicKey;

/** On-chain seed for task escrow PDAs. */
const ESCROW_SEED = "escrow";

/** On-chain seed for the protocol-config PDA. */
const PROTOCOL_CONFIG_SEED = "protocol_config";

/**
 * Client for the settlement program.
 *
 * Covers both the task-escrow lifecycle and the governance-owned
 * ProtocolConfig account (ADR-075).
 *
 * ADR-087: public API accepts/returns `Address` (kit). Anchor account
 * fetches retain Anchor's typed shape.
 */
export class SettlementClient {
  /** The underlying Anchor Program instance. ADR-088 typed via `Settlement`. */
  readonly program: Program<Settlement>;

  constructor(provider: AnchorProvider, idl: Settlement, programId: Address) {
    this.program = new Program<Settlement>(idl, provider);
    if (this.program.programId.toBase58() !== (programId as string)) {
      throw new Error(
        `SettlementClient: IDL programId ${this.program.programId.toBase58()} ` +
          `does not match supplied programId ${programId}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // PDA derivation
  // -------------------------------------------------------------------------

  /**
   * Derive the task-escrow PDA for a given client, provider, and task ID.
   *
   * Seeds: [ "escrow", client, provider, taskId as little-endian u64 ]
   *
   * Matches the on-chain `seeds = [b"escrow", client.key().as_ref(),
   * provider.key().as_ref(), &task_id.to_le_bytes()]` declaration in
   * `programs/settlement/src/contexts.rs` (and the matching CPI signer
   * seeds in `instructions/escrow.rs`). Pre-AUD-003 the SDK used the
   * literal `"task_escrow"`, which derives a different (and unowned)
   * PDA, so every escrow operation routed through `@agenomics/client`
   * failed on-chain.
   *
   * The task ID is a monotonically increasing counter chosen at escrow
   * creation time to prevent collisions (ADR-052).
   */
  async escrowPda(
    client: Address,
    provider: Address,
    taskId: bigint,
  ): Promise<Address> {
    const addressEncoder = getAddressEncoder();
    const taskIdBuf = new Uint8Array(8);
    new DataView(taskIdBuf.buffer).setBigUint64(0, taskId, true);
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.programIdAsAddress(),
      seeds: [
        ESCROW_SEED,
        addressEncoder.encode(client),
        addressEncoder.encode(provider),
        taskIdBuf,
      ],
    });
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
  async protocolConfigPda(): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.programIdAsAddress(),
      seeds: [PROTOCOL_CONFIG_SEED],
    });
    return pda;
  }

  // -------------------------------------------------------------------------
  // Account fetches
  // -------------------------------------------------------------------------

  /**
   * Fetch and decode a TaskEscrow account.
   *
   * Returns the raw Anchor-decoded account object. Notable fields (Anchor
   * coder still returns `PublicKey` for pubkey fields):
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
  async fetchEscrow(client: Address, provider: Address, taskId: bigint) {
    const pdaAddr = await this.escrowPda(client, provider, taskId);
    const pda = new PublicKey(pdaAddr as string);
    // ADR-088: typed via `Program<Settlement>.account.taskEscrow`.
    return this.program.account.taskEscrow.fetch(pda);
  }

  /**
   * Fetch and decode the ProtocolConfig account.
   *
   * Returns governance parameters including `minEscrowAmount`,
   * `disputeTimeoutSeconds`, and the three reputation deltas (all as BN).
   *
   * @throws if the account does not exist or cannot be decoded.
   */
  async fetchProtocolConfig() {
    const pdaAddr = await this.protocolConfigPda();
    const pda = new PublicKey(pdaAddr as string);
    // ADR-088: typed via `Program<Settlement>.account.protocolConfig`.
    return this.program.account.protocolConfig.fetch(pda);
  }

  // -------------------------------------------------------------------------
  // Internal Anchor adapters
  // -------------------------------------------------------------------------

  private programIdAsAddress(): Address {
    return this.program.programId.toBase58() as Address;
  }
}
