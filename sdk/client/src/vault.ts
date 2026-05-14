/**
 * AgentVaultClient — typed wrapper for the agent-vault Anchor program.
 *
 * Provides PDA derivation and typed account fetch methods. Instruction builders
 * (initVault, executeTransfer, etc.) are out of scope for v0.1.0.
 *
 * Usage:
 *   import agentVaultIdl from "path/to/idl/agent_vault.json" assert { type: "json" };
 *   import { Idl } from "@coral-xyz/anchor";
 *   import type { Address } from "@solana/kit";
 *
 *   const VAULT_PROGRAM_ID = "28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw" as Address;
 *   const client = new AgentVaultClient(provider, agentVaultIdl as Idl, VAULT_PROGRAM_ID);
 *
 *   const pda = await client.vaultPda(authority);  // Address
 *   const vault = await client.fetchVault(authority);
 */

import { Program, AnchorProvider, web3 } from "@coral-xyz/anchor";
import {
  getProgramDerivedAddress,
  getAddressEncoder,
  type Address,
} from "@solana/kit";
import * as crypto from "node:crypto";

import type { AgentVault } from "./idl-types.js";

/**
 * ADR-087: PublicKey is reached via Anchor's `web3` re-export so the
 * SDK does not carry a direct `@solana/web3.js` dependency.
 */
type PublicKey = web3.PublicKey;
const PublicKey = web3.PublicKey;

/** On-chain seed for the vault PDA. */
const VAULT_SEED = "vault";

/**
 * ADR-138: domain prefix for the MCP tool identifier hash. The on-chain
 * `tool_id_hash` argument to `execute_transfer` / `execute_token_transfer`
 * is `sha256("agenomics.tool." + name)`, pinned here so caller code and
 * indexer-side reverse lookups produce the same 32-byte digest.
 *
 * Why a hash and not the raw name: a 32-byte fixed-width field keeps the
 * on-chain instruction args bounded; a hash is also a stable
 * canonicalised key that survives tool renames (within the same
 * `name`) without an on-chain migration. Indexers reverse the hash via
 * an off-chain catalogue (the MCP server's `allTools` aggregation in
 * `mcp-server/src/tools/index.ts`).
 */
export const TOOL_ID_HASH_DOMAIN = "agenomics.tool.";

/**
 * ADR-138: 32-byte all-zeros sentinel for callers that haven't yet
 * adopted the tool-id convention. Accepted on-chain; indexers MAY
 * surface a `tool_id_zero_count` metric. Convenience for SDK consumers
 * who want to log the migration debt.
 */
export const TOOL_ID_ZERO: Uint8Array = new Uint8Array(32);

/**
 * ADR-138: compute the on-chain `tool_id_hash` for an MCP tool name.
 *
 * Returns `sha256(TOOL_ID_HASH_DOMAIN + name)` as a 32-byte `Uint8Array`
 * suitable for the `execute_transfer` / `execute_token_transfer`
 * instruction's `tool_id_hash` argument. Pure function — no I/O, no
 * timing leakage that the caller need worry about.
 */
export function toolIdHash(toolName: string): Uint8Array {
  if (typeof toolName !== "string" || toolName.length === 0) {
    throw new Error("toolIdHash: toolName must be a non-empty string");
  }
  const digest = crypto.createHash("sha256");
  digest.update(TOOL_ID_HASH_DOMAIN);
  digest.update(toolName);
  // crypto.Hash.digest() returns a Buffer; convert to a plain Uint8Array
  // so consumers on the kit v2 stack (which prefers Uint8Array) get the
  // expected shape without an extra cast.
  return new Uint8Array(digest.digest());
}

/** Solana Ed25519 native precompile program address (immutable). */
export const ED25519_PROGRAM_ADDRESS: Address =
  "Ed25519SigVerify111111111111111111111111111" as Address;

/**
 * ADR-124 (AUD-116 path-a): vault-side domain tag for the proof-of-control
 * signature required by `initialize_vault`. MUST stay in lockstep with
 * `VAULT_IDENTITY_BIND_DOMAIN` in `programs/agent-vault/src/lib.rs`
 * (= `b"AEP_VAULT_IDENTITY_BIND_V1\x00"`, 26 ASCII chars + a trailing NUL
 * terminator, 27 bytes total). We pin the bytes here so a typo on either
 * side surfaces as a test failure (see
 * `sdk/client/test/vault-identity-bind.test.ts`) rather than a runtime
 * mismatch on `initialize_vault`.
 *
 * **Domain separation**: this tag MUST differ from the registry's
 * `MANIFEST_HASH_DOMAIN` (`AEP_CAPABILITY_MANIFEST_V1\0`) so a captured
 * manifest signature cannot be replayed against a vault init. The two
 * protocols sign distinct domain-tagged hashes; each signature is bound
 * to its originating handler.
 */
export const VAULT_IDENTITY_BIND_DOMAIN: Uint8Array = (() => {
  const out = new Uint8Array(27);
  out.set(new TextEncoder().encode("AEP_VAULT_IDENTITY_BIND_V1"), 0);
  out[26] = 0;
  return out;
})();

/**
 * Minimal `IInstruction`-shaped output for the Ed25519 precompile.
 *
 * ADR-087: post v2 migration we no longer return v1's
 * `TransactionInstruction`. The Ed25519 precompile takes no on-chain
 * accounts; only `programAddress` + `data` are populated. Consumers on
 * the kit v2 stack can pass this directly to `Transaction` builders that
 * accept the `IInstruction` shape.
 */
export interface Ed25519VerifyInstruction {
  readonly programAddress: Address;
  readonly accounts: readonly [];
  readonly data: Uint8Array;
}

/**
 * ADR-124 (AUD-116 path-a): Compute the 32-byte domain-separated bind
 * message that the `agent_identity` private-key holder must sign for
 * `initialize_vault` to succeed. Mirrors
 * `vault_identity_bind_message(authority, agent_identity)` in
 * `programs/agent-vault/src/lib.rs` byte-for-byte.
 *
 * The message binds **both** the vault `authority` and the candidate
 * `agentIdentity` so a single captured signature cannot be replayed:
 *   - against a different authority's vault init (binding to `authority`
 *     rules out cross-vault replay), or
 *   - to bind a different `agent_identity` to the same vault (binding to
 *     `agent_identity` rules out swap-the-key replay against the same
 *     authority).
 */
export function vaultIdentityBindMessage(
  authority: Address,
  agentIdentity: Address,
): Buffer {
  const encoder = getAddressEncoder();
  return crypto
    .createHash("sha256")
    .update(VAULT_IDENTITY_BIND_DOMAIN)
    .update(encoder.encode(authority) as Uint8Array)
    .update(encoder.encode(agentIdentity) as Uint8Array)
    .digest();
}

/**
 * ADR-124 (AUD-116 path-a): Build the paired `Ed25519Program::verify`
 * instruction that the on-chain `initialize_vault` handler introspects via
 * the Instructions sysvar. Caller is responsible for prepending (or
 * appending) this instruction to the same transaction that carries
 * `initialize_vault` and for passing the matching `signature` bytes as the
 * `agent_identity_signature` handler argument.
 *
 * The runtime verifies the signature for free at pre-execution time; the
 * on-chain handler then asserts the precompile's inline pubkey / signature
 * / message bytes equal the supplied handler arguments. Mismatches surface
 * as `AgentIdentityBindSignatureMismatch` (or
 * `MissingAgentIdentityBindSignature` if this ix is omitted).
 *
 * ADR-087: hand-rolled instruction data (replacing the v1
 * `Ed25519Program.createInstructionWithPublicKey` helper) so the SDK no
 * longer needs a direct `@solana/web3.js` dependency. Byte layout is the
 * documented Solana Ed25519 native-precompile format:
 *
 *   offset 0 : num_signatures (u8) = 1
 *   offset 1 : padding (u8)        = 0
 *   offset 2 : Ed25519SignatureOffsets struct (14 bytes)
 *               signature_offset:           u16 LE = 16 + 32 = 48
 *               signature_instruction_index:u16 LE = u16::MAX
 *               public_key_offset:          u16 LE = 16
 *               public_key_instruction_index:u16 LE= u16::MAX
 *               message_data_offset:        u16 LE = 16 + 32 + 64 = 112
 *               message_data_size:          u16 LE = 32
 *               message_instruction_index:  u16 LE = u16::MAX
 *   offset 16: public_key (32 bytes)
 *   offset 48: signature (64 bytes)
 *   offset 112: message (32 bytes)
 *
 * Total: 16 + 32 + 64 + 32 = 144 bytes (matches the legacy v1 output).
 */
export function buildVaultIdentityBindInstruction(args: {
  agentIdentity: Address;
  message: Uint8Array;
  signature: Uint8Array;
}): Ed25519VerifyInstruction {
  if (args.message.length !== 32) {
    throw new Error(
      `buildVaultIdentityBindInstruction: message must be 32 bytes, got ${args.message.length}`,
    );
  }
  if (args.signature.length !== 64) {
    throw new Error(
      `buildVaultIdentityBindInstruction: signature must be 64 bytes, got ${args.signature.length}`,
    );
  }

  const pubkeyBytes = getAddressEncoder().encode(args.agentIdentity) as Uint8Array;
  // Defense-in-depth: kit's address encoder always returns 32 bytes for a
  // base58 Address, but pin the assumption here for the same reason the
  // on-chain handler pins the precompile layout.
  if (pubkeyBytes.length !== 32) {
    throw new Error(
      `buildVaultIdentityBindInstruction: agentIdentity must encode to 32 bytes, got ${pubkeyBytes.length}`,
    );
  }

  const NUM_SIGS = 1;
  const HEADER_LEN = 2 + 14 * NUM_SIGS; // 16 for one signature
  const PUBKEY_OFFSET = HEADER_LEN; // 16
  const SIG_OFFSET = HEADER_LEN + 32; // 48
  const MSG_OFFSET = HEADER_LEN + 32 + 64; // 112
  const TOTAL_LEN = MSG_OFFSET + args.message.length; // 144
  const U16_MAX = 0xffff;

  const data = new Uint8Array(TOTAL_LEN);
  const view = new DataView(data.buffer);

  data[0] = NUM_SIGS;
  data[1] = 0; // padding
  view.setUint16(2, SIG_OFFSET, true);
  view.setUint16(4, U16_MAX, true); // signature_instruction_index = self (sentinel)
  view.setUint16(6, PUBKEY_OFFSET, true);
  view.setUint16(8, U16_MAX, true); // public_key_instruction_index = self
  view.setUint16(10, MSG_OFFSET, true);
  view.setUint16(12, args.message.length, true);
  view.setUint16(14, U16_MAX, true); // message_instruction_index = self

  data.set(pubkeyBytes, PUBKEY_OFFSET);
  data.set(args.signature, SIG_OFFSET);
  data.set(args.message, MSG_OFFSET);

  return {
    programAddress: ED25519_PROGRAM_ADDRESS,
    accounts: [],
    data,
  };
}

/**
 * Client for the agent-vault program.
 *
 * The vault PDA is the canonical account that holds spending policy and
 * per-token rate limiting for an agent. It is linked to an AgentProfile
 * via the `vault_address` field on registration (ADR-041).
 *
 * ADR-087: public API accepts/returns `Address` (kit). Anchor account
 * fetches retain Anchor's typed shape (which still contains `PublicKey`
 * fields decoded by Anchor's coder — that is the Anchor return contract).
 */
export class AgentVaultClient {
  /** The underlying Anchor Program instance. ADR-088 typed via `AgentVault`. */
  readonly program: Program<AgentVault>;

  constructor(provider: AnchorProvider, idl: AgentVault, programId: Address) {
    this.program = new Program<AgentVault>(idl, provider);
    if (this.program.programId.toBase58() !== (programId as string)) {
      throw new Error(
        `AgentVaultClient: IDL programId ${this.program.programId.toBase58()} ` +
          `does not match supplied programId ${programId}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // PDA derivation
  // -------------------------------------------------------------------------

  /**
   * Derive the vault PDA for a given authority.
   *
   * Seeds: [ "vault", authority ]
   *
   * Matches the on-chain `seeds = [b"vault", authority.key().as_ref()]`
   * declaration in `programs/agent-vault/src/contexts.rs`. Pre-AUD-003
   * the SDK had these reversed, so every vault operation routed through
   * `@agenomics/client` failed on-chain.
   */
  async vaultPda(authority: Address): Promise<Address> {
    const addressEncoder = getAddressEncoder();
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.programIdAsAddress(),
      seeds: [VAULT_SEED, addressEncoder.encode(authority)],
    });
    return pda;
  }

  // -------------------------------------------------------------------------
  // Account fetches
  // -------------------------------------------------------------------------

  /**
   * Fetch and decode a Vault account.
   *
   * Returns the raw Anchor-decoded account object. Notable fields (Anchor
   * coder still returns `PublicKey` for pubkey fields — call `.toBase58()`
   * at the read site if you want `Address` semantics):
   *   - `agentIdentity: PublicKey`
   *   - `authority: PublicKey`
   *   - `paused: boolean`
   *   - `policy.perTxLimitLamports: BN`
   *   - `policy.dailyLimitLamports: BN`
   *   - `tokenSpendRecords: Array<{ mint: PublicKey, perTxLimit: BN, dailyLimit: BN, ... }>`
   *
   * @throws if the account does not exist or cannot be decoded.
   */
  async fetchVault(authority: Address) {
    const pdaAddr = await this.vaultPda(authority);
    const pda = new PublicKey(pdaAddr as string);
    // ADR-088: typed via `Program<AgentVault>.account.vault`. Return type
    // is Anchor's typed `Vault` projection — no `Record<string, unknown>`
    // pass-through.
    return this.program.account.vault.fetch(pda);
  }

  // -------------------------------------------------------------------------
  // Internal Anchor adapters
  // -------------------------------------------------------------------------

  private programIdAsAddress(): Address {
    return this.program.programId.toBase58() as Address;
  }
}
