/**
 * AgentRegistryClient — typed wrapper for the agent-registry Anchor program.
 *
 * Provides PDA derivation and typed account fetch methods. Instruction builders
 * (registerAgent, updateAgent, etc.) are out of scope for v0.1.0.
 *
 * Usage:
 *   import agentRegistryIdl from "path/to/idl/agent_registry.json" assert { type: "json" };
 *   import { Idl } from "@coral-xyz/anchor";
 *   import type { Address } from "@solana/kit";
 *
 *   const REGISTRY_PROGRAM_ID = "psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv" as Address;
 *   const client = new AgentRegistryClient(provider, agentRegistryIdl as Idl, REGISTRY_PROGRAM_ID);
 *
 *   const pda = await client.profilePda(authority, 0n);  // Address (base58 string)
 *   const profile = await client.fetchProfile(authority, 0n);
 */

import { Program, AnchorProvider, web3 } from "@coral-xyz/anchor";
import {
  getProgramDerivedAddress,
  getAddressEncoder,
  type Address,
} from "@solana/kit";

/**
 * ADR-087: PublicKey is re-exported from Anchor's `web3` namespace so the
 * SDK never directly imports `@solana/web3.js`. Anchor's internal account
 * decoder still returns `PublicKey` values, and `Program.methods.…accounts`
 * expects `PublicKey` instances — we accept `Address` at the public API and
 * convert at the Anchor boundary only.
 */
type PublicKey = web3.PublicKey;
const PublicKey = web3.PublicKey;

import type { AgentRegistry } from "./idl-types.js";

/** On-chain seed for the agent-profile PDA. */
const AGENT_PROFILE_SEED = "agent-profile";

/** On-chain seed for the owner-nonce PDA. */
const OWNER_NONCE_SEED = "owner-nonce";

/**
 * Maximum valid reputation score, mirrored from the on-chain constant
 * `MAX_REPUTATION_SCORE` in `programs/agent-registry/src/lib.rs:17`
 * (ADR-094: `pub const MAX_REPUTATION_SCORE: u8 = 100;`). Pinned here
 * so the SDK does not need to dlopen the IDL just to render a score.
 *
 * If the on-chain constant ever changes, update this value in lockstep.
 */
export const MAX_REPUTATION_SCORE = 100;

/**
 * Clamp a raw on-chain reputation score into the policy presentation
 * range `[0, MAX_REPUTATION_SCORE]` (= `[0, 100]`).
 *
 * AUD-112 (cycle-2 reciprocal SDK helper). The on-chain
 * `propose_reputation_delta` handler self-heals any pre-migration
 * profile whose `reputation_score` (a `u64` field) carries a legacy
 * value above `MAX_REPUTATION_SCORE`: the handler clamps `old_score`
 * into the policy window for arithmetic and writes the in-range
 * result back. See the doc-comment at
 * `programs/agent-registry/src/lib.rs:283-298` (committed in
 * `d5df7ad`) for the full transitional-window note.
 *
 * The race window is narrow — any post-migration call self-heals —
 * but SDK consumers that read a profile *before* any post-migration
 * call would observe the legacy out-of-range score. This helper is
 * the recommended presentation-layer clamp for those reads:
 *
 *   `Math.min(reputation_score, MAX_REPUTATION_SCORE)` in the doc-
 *   comment, generalised here to also defend against negative input
 *   so the helper is total over `bigint`.
 *
 * Defensive contract:
 *   - Never throws. Out-of-range inputs clamp to the nearest bound.
 *   - Returns a `number` in `[0, MAX_REPUTATION_SCORE]`, safe for UI.
 *   - Inputs above `Number.MAX_SAFE_INTEGER` clamp safely (we compare
 *     in `bigint`-space before the `Number` coercion, so the lossy
 *     `Number(raw)` conversion only ever runs on already-in-range
 *     values that round-trip exactly).
 *
 * @param raw - The raw on-chain reputation score, decoded as a `bigint`
 *              (Anchor decodes `u64` fields as `BN`, callers should
 *              pass `BigInt(profile.reputationScore.toString())` or
 *              equivalent).
 * @returns The clamped score as a `number` in `[0, MAX_REPUTATION_SCORE]`.
 *
 * @example
 *   // Safe rendering during the migration window:
 *   const score = clampReputationScore(BigInt(profile.reputationScore.toString()));
 *   render(`Reputation: ${score}/100`);
 */
export function clampReputationScore(raw: bigint): number {
  const max = BigInt(MAX_REPUTATION_SCORE);
  if (raw <= 0n) return 0;
  if (raw >= max) return MAX_REPUTATION_SCORE;
  return Number(raw);
}

/**
 * Client for the agent-registry program.
 *
 * All PDAs are derived deterministically using the same seeds as the on-chain
 * Anchor context structs in programs/agent-registry/src/contexts.rs.
 *
 * ADR-087: post v2 migration the public API surface accepts/returns
 * `Address` (kit's base58-string brand) rather than `PublicKey` (web3.js v1
 * class). Anchor itself still operates on `PublicKey` internally — this
 * client converts `Address → PublicKey` at the Anchor boundary so callers
 * never see the v1 type.
 */
export class AgentRegistryClient {
  /** The underlying Anchor Program instance. ADR-088 typed via `AgentRegistry`. */
  readonly program: Program<AgentRegistry>;

  constructor(provider: AnchorProvider, idl: AgentRegistry, programId: Address) {
    this.program = new Program<AgentRegistry>(idl, provider);
    if (this.program.programId.toBase58() !== (programId as string)) {
      throw new Error(
        `AgentRegistryClient: IDL programId ${this.program.programId.toBase58()} ` +
          `does not match supplied programId ${programId}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // PDA derivation
  // -------------------------------------------------------------------------

  /**
   * Derive the agent-profile PDA for a given authority and nonce.
   *
   * Seeds: [ authority, "agent-profile", nonce as little-endian u64 ]
   *
   * The nonce encodes the nth profile registered by this authority (ADR-097).
   * Pass the value returned by `fetchOwnerNonce().nonce` to derive the next
   * registration address, or 0n for the first profile.
   *
   * AUD-003: `OwnerNonce::nonce` is `u64` on-chain (see
   * `programs/agent-registry/src/state.rs`). Pre-fix the SDK encoded it
   * via `BigInt64Array` (signed i64), which is byte-identical for
   * non-negative values but documents the wrong sign convention; we use
   * `DataView.setBigUint64(..., true)` which matches the on-chain
   * `u64::to_le_bytes()` exactly and prevents a future signed-overflow
   * regression if the encoder is ever asked to round-trip via `Number`.
   */
  async profilePda(authority: Address, nonce: bigint): Promise<Address> {
    const addressEncoder = getAddressEncoder();
    const nonceBuf = new Uint8Array(8);
    new DataView(nonceBuf.buffer).setBigUint64(0, nonce, true);
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.programIdAsAddress(),
      seeds: [addressEncoder.encode(authority), AGENT_PROFILE_SEED, nonceBuf],
    });
    return pda;
  }

  /**
   * Derive the owner-nonce PDA for a given authority.
   *
   * Seeds: [ authority, "owner-nonce" ]
   *
   * The owner-nonce account tracks how many profiles an authority has
   * registered, providing a unique nonce seed for each registration.
   */
  async ownerNoncePda(authority: Address): Promise<Address> {
    const addressEncoder = getAddressEncoder();
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.programIdAsAddress(),
      seeds: [addressEncoder.encode(authority), OWNER_NONCE_SEED],
    });
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
   * Note: returned account objects retain Anchor's native `PublicKey` shape
   * for pubkey fields (Anchor's typed coder is the source). Consumers that
   * want `Address` semantics should call `.toBase58()` at the read site;
   * the SDK does not deep-rewrite Anchor's return value to keep the type
   * graph minimal.
   *
   * @throws if the account does not exist or cannot be decoded.
   */
  async fetchProfile(authority: Address, nonce: bigint) {
    const pdaAddr = await this.profilePda(authority, nonce);
    const pda = this.addressToPublicKey(pdaAddr);
    // ADR-088: typed via `Program<AgentRegistry>.account.agentProfile`.
    return this.program.account.agentProfile.fetch(pda);
  }

  /**
   * Fetch and decode an OwnerNonce account.
   *
   * @throws if the account does not exist or cannot be decoded.
   */
  async fetchOwnerNonce(authority: Address) {
    const pdaAddr = await this.ownerNoncePda(authority);
    const pda = this.addressToPublicKey(pdaAddr);
    // ADR-088: typed via `Program<AgentRegistry>.account.ownerNonce`.
    return this.program.account.ownerNonce.fetch(pda);
  }

  /**
   * Q-S3-A: read the CDP-wallet binding for an agent profile.
   *
   * Returns the 20-byte EVM address bound to this agent (via
   * `update_cdp_wallet`), or `null` when no binding has been set. The
   * Surface-3 CCTP Hook reads this same field and refuses to auto-approve
   * milestones for an agent whose binding is `None` or does not match the
   * IC-4 payload's `cdp_recipient`.
   *
   * @example
   *   const wallet = await client.fetchCdpWallet(authority, 0n);
   *   if (wallet === null) {
   *     // no binding — Surface 4 has not yet bound this agent's CDP wallet
   *   } else {
   *     // wallet is a 20-byte Uint8Array (EVM address)
   *   }
   */
  async fetchCdpWallet(
    authority: Address,
    nonce: bigint,
  ): Promise<Uint8Array | null> {
    const profile = (await this.fetchProfile(authority, nonce)) as any;
    const raw = profile.cdpWallet;
    if (raw == null) return null;
    // Anchor's TS coder decodes [u8; 20] as a Buffer or number[]; normalize
    // to Uint8Array for a stable surface across Anchor versions.
    return new Uint8Array(raw as ArrayLike<number>);
  }

  /**
   * Q-S3-A: build a transaction that sets or clears the agent's CDP-wallet
   * binding. Caller signs with the agent's `authority` keypair.
   *
   * @param authority - The agent's authority signer (must equal the
   *                    profile's `authority` field on chain).
   * @param nonce     - The agent's registration nonce (ADR-097); usually
   *                    `0n` for first-time registrations. Use
   *                    `fetchOwnerNonce` to read the current value if the
   *                    profile has gone through a deregister cycle.
   * @param wallet    - The 20-byte EVM address to bind, or `null` to clear
   *                    the binding. Wallet must be exactly 20 bytes; passing
   *                    a different length yields an Anchor coder error at
   *                    `.rpc()` time.
   * @returns         - The instruction builder; caller can `.rpc()`,
   *                    `.transaction()`, or `.instruction()` per their
   *                    transaction-construction needs.
   */
  async updateCdpWalletIx(
    authority: Address,
    nonce: bigint,
    wallet: Uint8Array | null,
  ) {
    const profileAddr = await this.profilePda(authority, nonce);
    const ownerNonceAddr = await this.ownerNoncePda(authority);
    const profile = this.addressToPublicKey(profileAddr);
    const ownerNonce = this.addressToPublicKey(ownerNonceAddr);
    const authorityPk = this.addressToPublicKey(authority);
    const arg = wallet === null ? null : Array.from(wallet);
    return this.program.methods
      .updateCdpWallet(arg as any)
      .accounts({
        authority: authorityPk,
        ownerNonce,
        agentProfile: profile,
      } as any);
  }

  // -------------------------------------------------------------------------
  // Internal Anchor adapters
  // -------------------------------------------------------------------------

  /** Adapter: bridge kit Address → Anchor PublicKey for fetch / .accounts() boundary. */
  private addressToPublicKey(addr: Address): PublicKey {
    return new PublicKey(addr as string);
  }

  /** Adapter: Anchor PublicKey → kit Address brand for getProgramDerivedAddress. */
  private programIdAsAddress(): Address {
    return this.program.programId.toBase58() as Address;
  }
}
