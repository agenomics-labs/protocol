/**
 * AgentRegistryClient — typed wrapper for the agent-registry Anchor program.
 *
 * Provides PDA derivation and typed account fetch methods. Instruction builders
 * (registerAgent, updateAgent, etc.) are out of scope for v0.1.0.
 *
 * Usage:
 *   import agentRegistryIdl from "path/to/idl/agent_registry.json" assert { type: "json" };
 *   import { Idl } from "@coral-xyz/anchor";
 *
 *   const REGISTRY_PROGRAM_ID = new PublicKey("8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh");
 *   const client = new AgentRegistryClient(provider, agentRegistryIdl as Idl, REGISTRY_PROGRAM_ID);
 *
 *   const pda = client.profilePda(authority, 0n);
 *   const profile = await client.fetchProfile(authority, 0n);
 */

import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

/** On-chain seed for the owner-nonce PDA. */
const OWNER_NONCE_SEED = Buffer.from("owner-nonce");

/** On-chain seed for the agent-profile PDA. */
const AGENT_PROFILE_SEED = Buffer.from("agent-profile");

/**
 * Client for the agent-registry program.
 *
 * All PDAs are derived deterministically using the same seeds as the on-chain
 * Anchor context structs in programs/agent-registry/src/contexts.rs.
 */
export class AgentRegistryClient {
  /** The underlying Anchor Program instance. */
  readonly program: Program;

  constructor(provider: AnchorProvider, idl: Idl, programId: PublicKey) {
    this.program = new Program(idl, provider);
    if (!this.program.programId.equals(programId)) {
      throw new Error(
        `AgentRegistryClient: IDL programId ${this.program.programId.toBase58()} ` +
          `does not match supplied programId ${programId.toBase58()}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // PDA derivation
  // -------------------------------------------------------------------------

  /**
   * Derive the agent-profile PDA for a given authority and nonce.
   *
   * Seeds: [ authority.toBytes(), "agent-profile", nonce as little-endian u64 ]
   *
   * The nonce encodes the nth profile registered by this authority (ADR-097).
   * Pass the value returned by `fetchOwnerNonce().nonce` to derive the next
   * registration address, or 0n for the first profile.
   *
   * AUD-003: `OwnerNonce::nonce` is `u64` on-chain (see
   * `programs/agent-registry/src/state.rs`). Pre-fix the SDK encoded it
   * via `BigInt64Array` (signed i64), which is byte-identical for
   * non-negative values but documents the wrong sign convention; switching
   * to `BigUint64Array` matches the on-chain type exactly and prevents a
   * future signed-overflow regression if the encoder is ever asked to
   * round-trip via `Number`.
   */
  profilePda(authority: PublicKey, nonce: bigint): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        authority.toBytes(),
        AGENT_PROFILE_SEED,
        Buffer.from(new Uint8Array(new BigUint64Array([nonce]).buffer)),
      ],
      this.program.programId,
    );
    return pda;
  }

  /**
   * Derive the owner-nonce PDA for a given authority.
   *
   * Seeds: [ authority.toBytes(), "owner-nonce" ]
   *
   * The owner-nonce account tracks how many profiles an authority has
   * registered, providing a unique nonce seed for each registration.
   */
  ownerNoncePda(authority: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [authority.toBytes(), OWNER_NONCE_SEED],
      this.program.programId,
    );
    return pda;
  }

  // -------------------------------------------------------------------------
  // Account fetches
  // -------------------------------------------------------------------------

  /**
   * Fetch and decode an AgentProfile account.
   *
   * Returns the raw Anchor-decoded account object. Field names follow
   * Anchor's camelCase convention (e.g. `reputationScore`). u64 / i64 fields
   * are decoded as BN instances by Anchor. AUD-007 (PR-Q): the legacy
   * `totalTasksCompleted`, `totalEarnings`, and `avgRating` aggregates were
   * removed from the on-chain account; consumers must not assume they are
   * present.
   *
   * @throws if the account does not exist or cannot be decoded.
   */
  async fetchProfile(
    authority: PublicKey,
    nonce: bigint,
  ): Promise<Record<string, unknown>> {
    const pda = this.profilePda(authority, nonce);
    // TODO(typed): parameterise once @agenomics/idl provides the AgentRegistry IDL type.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.program.account as any)["agentProfile"].fetch(pda) as Promise<
      Record<string, unknown>
    >;
  }

  /**
   * Fetch and decode an OwnerNonce account.
   *
   * @throws if the account does not exist or cannot be decoded.
   */
  async fetchOwnerNonce(
    authority: PublicKey,
  ): Promise<Record<string, unknown>> {
    const pda = this.ownerNoncePda(authority);
    // TODO(typed): parameterise once @agenomics/idl provides the AgentRegistry IDL type.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.program.account as any)["ownerNonce"].fetch(pda) as Promise<
      Record<string, unknown>
    >;
  }
}
