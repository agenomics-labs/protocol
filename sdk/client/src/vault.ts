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
 *   const VAULT_PROGRAM_ID = new PublicKey("28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw");
 *   const client = new AgentVaultClient(provider, agentVaultIdl as Idl, VAULT_PROGRAM_ID);
 *
 *   const pda = client.vaultPda(authority);
 *   const vault = await client.fetchVault(authority);
 */

import { Program, AnchorProvider } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import * as crypto from "node:crypto";

import type { AgentVault } from "./idl-types.js";

/** On-chain seed for the vault PDA. */
const VAULT_SEED = Buffer.from("vault");

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
export const VAULT_IDENTITY_BIND_DOMAIN: Uint8Array = Buffer.concat([
  Buffer.from("AEP_VAULT_IDENTITY_BIND_V1", "utf8"),
  Buffer.from([0]),
]);

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
  authority: PublicKey,
  agentIdentity: PublicKey,
): Buffer {
  return crypto
    .createHash("sha256")
    .update(VAULT_IDENTITY_BIND_DOMAIN)
    .update(authority.toBuffer())
    .update(agentIdentity.toBuffer())
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
 */
export function buildVaultIdentityBindInstruction(args: {
  agentIdentity: PublicKey;
  message: Buffer;
  signature: Buffer;
}): TransactionInstruction {
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
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: args.agentIdentity.toBuffer(),
    message: args.message,
    signature: args.signature,
  });
}

/**
 * Client for the agent-vault program.
 *
 * The vault PDA is the canonical account that holds spending policy and
 * per-token rate limiting for an agent. It is linked to an AgentProfile
 * via the `vault_address` field on registration (ADR-041).
 */
export class AgentVaultClient {
  /** The underlying Anchor Program instance. ADR-088 typed via `AgentVault`. */
  readonly program: Program<AgentVault>;

  constructor(provider: AnchorProvider, idl: AgentVault, programId: PublicKey) {
    this.program = new Program<AgentVault>(idl, provider);
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
   * Seeds: [ "vault", authority.toBytes() ]
   *
   * Matches the on-chain `seeds = [b"vault", authority.key().as_ref()]`
   * declaration in `programs/agent-vault/src/contexts.rs`. Pre-AUD-003
   * the SDK had these reversed, so every vault operation routed through
   * `@agenomics/client` failed on-chain.
   */
  vaultPda(authority: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, authority.toBytes()],
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
  async fetchVault(authority: PublicKey) {
    const pda = this.vaultPda(authority);
    // ADR-088: typed via `Program<AgentVault>.account.vault`. Return type
    // is Anchor's typed `Vault` projection (`agentIdentity: PublicKey`,
    // `policy.perTxLimitLamports: BN`, etc.) — no `Record<string, unknown>`
    // pass-through.
    return this.program.account.vault.fetch(pda);
  }
}
