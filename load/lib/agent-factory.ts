/**
 * Agent / mint / token-account factory for load scenarios.
 *
 * A "load agent" in Phase 1 is a fresh Solana keypair that owns:
 *   - an `AgentProfile` PDA (registered via `register_agent`)
 *   - an `AgentVault` PDA (initialized via the post-ADR-124 flow:
 *     ed25519 precompile sibling ix + `agent_identity_signature` arg)
 *
 * For the full-lifecycle scenario each flow needs TWO agents — one
 * acting as `client` (escrow funder) and one as `provider` (task
 * executor). The provider must be registered for the
 * approve_milestone CPI to find their AgentProfile; the client need
 * not be registered. We register both anyway to keep the surface
 * symmetric and exercise the registry handler twice per flow.
 *
 * The factory also creates a per-flow SPL token mint and a pair of
 * associated token accounts. Per-flow mints (rather than a shared
 * mint) keep flows independent on-chain — a mint authority issue in
 * one flow can't block others.
 *
 * ADR-124 (vault identity bind): the ed25519 precompile + signature
 * scheme is implemented inline here, mirroring `tests/agent-vault.ts`'s
 * `initVaultWithBindProof` helper. We do NOT import from `tests/` —
 * Phase 1 keeps `load/` self-contained per the fuzz/ pattern, and
 * `tests/` is parallel-agent territory in this wave.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as crypto from "crypto";
import {
  REGISTRY_PROGRAM_ID,
  VAULT_PROGRAM_ID,
  deriveAgentProfilePDA,
  deriveOwnerNoncePDA,
  deriveVaultPDA,
} from "./pdas";

const VAULT_IDENTITY_BIND_DOMAIN = Buffer.concat([
  Buffer.from("AEP_VAULT_IDENTITY_BIND_V1", "utf8"),
  Buffer.from([0]),
]);

/**
 * ADR-124: the 32-byte domain-separated bind message that the
 * `agent_identity` private key must sign for `initialize_vault` to
 * accept the binding. Mirrors the on-chain
 * `vault_identity_bind_message(authority, agent_identity)` helper.
 */
function vaultIdentityBindMessage(
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
 * Minimal ed25519 signer surface used by ADR-124 vault-bind. Matches
 * the `noble/curves/ed25519` `ed25519` export shape so callers can
 * pass it directly without a wrapper. Kept as a structural interface
 * so the agent-factory module doesn't depend on noble at parse time.
 */
export interface Ed25519Signer {
  sign: (message: Uint8Array, secretKey: Uint8Array) => Uint8Array;
}

/**
 * Sign the bind message with the agent_identity keypair. Solana's
 * `Keypair.secretKey` is `[seed(32) || pubkey(32)]`; noble EdDSA takes
 * the 32-byte seed.
 */
function signBindMessage(
  message: Buffer,
  agentIdentity: Keypair,
  signer: Ed25519Signer,
): Buffer {
  const seed = agentIdentity.secretKey.slice(0, 32);
  return Buffer.from(signer.sign(message, seed));
}

function bindProofIx(
  agentIdentity: PublicKey,
  message: Buffer,
  signature: Buffer,
): TransactionInstruction {
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: agentIdentity.toBuffer(),
    message,
    signature,
  });
}

/**
 * One spawned load agent: keypair + derived PDAs. Fully on-chain
 * after `provisionAgent` returns success.
 */
export interface LoadAgent {
  authority: Keypair;
  agentIdentity: Keypair;
  profilePDA: PublicKey;
  vaultPDA: PublicKey;
  ownerNoncePDA: PublicKey;
}

export interface ProvisionAgentArgs {
  registryProgram: Program;
  vaultProgram: Program;
  connection: Connection;
  /** Lamports to airdrop to each fresh keypair. */
  airdropLamports: number;
  /** Per-vault daily / per-tx / rate-limit policy. Generous defaults for load. */
  vaultPolicy?: {
    dailyLimitLamports: number | bigint;
    perTxLimitLamports: number | bigint;
    maxTxsPerHour: number;
  };
  /** Tag for the registered agent's name (e.g. `client-${i}`). */
  nameTag: string;
  /** Token mint to register as accepted_tokens — the per-flow mint. */
  acceptedToken: PublicKey;
  /** noble-ed25519-style signer; injected so we don't pull in noble at module-load. */
  ed25519Signer: Ed25519Signer;
}

const DEFAULT_VAULT_POLICY = {
  dailyLimitLamports: BigInt(LAMPORTS_PER_SOL),
  perTxLimitLamports: BigInt(LAMPORTS_PER_SOL / 10),
  maxTxsPerHour: 100,
};

/**
 * Spin up one fresh load agent: airdrop → register → init vault.
 * Throws on any step failure; callers wrap in try/catch and account
 * the failure as a flow-setup failure (distinct from lifecycle ix
 * failure — Phase 1 reports both).
 */
export async function provisionAgent(
  args: ProvisionAgentArgs,
): Promise<LoadAgent> {
  const authority = Keypair.generate();
  const agentIdentity = Keypair.generate();

  const [profilePDA] = deriveAgentProfilePDA(authority.publicKey);
  const [vaultPDA] = deriveVaultPDA(authority.publicKey);
  const [ownerNoncePDA] = deriveOwnerNoncePDA(authority.publicKey);

  // Airdrop. On localnet this returns ~immediately; on devnet it can be
  // rate-limited, in which case the caller should pre-fund a faucet
  // wallet and seed the load agents from it (Phase 2 add-on).
  const sig = await args.connection.requestAirdrop(
    authority.publicKey,
    args.airdropLamports,
  );
  await args.connection.confirmTransaction(sig, "confirmed");

  // register_agent: AUD-008 ordering — Registry must precede Vault so
  // the OwnerNonce PDA exists when initialize_vault deserializes it.
  await args.registryProgram.methods
    .registerAgent(
      args.nameTag.slice(0, 64), // NameTooLong guard (≤ 64)
      "load harness",
      "load",
      ["load-test"],
      { perTask: {} },
      new BN(0),
      [args.acceptedToken],
    )
    .accounts({
      authority: authority.publicKey,
      ownerNonce: ownerNoncePDA,
      agentProfile: profilePDA,
      vault: vaultPDA,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();

  // initialize_vault with ADR-124 proof-of-control: build bind
  // message → sign with agent_identity → prepend ed25519 precompile
  // sibling ix → call handler with `agent_identity_signature` arg.
  const policy = args.vaultPolicy ?? DEFAULT_VAULT_POLICY;
  const message = vaultIdentityBindMessage(
    authority.publicKey,
    agentIdentity.publicKey,
  );
  const signature = signBindMessage(message, agentIdentity, args.ed25519Signer);
  const precompileIx = bindProofIx(
    agentIdentity.publicKey,
    message,
    signature,
  );

  await args.vaultProgram.methods
    .initializeVault(
      agentIdentity.publicKey,
      new BN(policy.dailyLimitLamports.toString()),
      new BN(policy.perTxLimitLamports.toString()),
      policy.maxTxsPerHour,
      Array.from(signature),
    )
    .accounts({
      vault: vaultPDA,
      authority: authority.publicKey,
      ownerNonce: ownerNoncePDA,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([precompileIx])
    .signers([authority])
    .rpc();

  return { authority, agentIdentity, profilePDA, vaultPDA, ownerNoncePDA };
}

/**
 * Per-flow token plumbing: a fresh mint with the load-driver's wallet
 * as mint authority, plus client + provider associated token accounts,
 * plus an initial mint to the client so they can fund the escrow.
 */
export interface FlowTokens {
  mintAuthority: Keypair;
  tokenMint: PublicKey;
  clientTokenAccount: PublicKey;
  providerTokenAccount: PublicKey;
}

export async function provisionFlowTokens(args: {
  connection: Connection;
  client: Keypair;
  provider: Keypair;
  /** Initial supply minted to the client, in raw token base units. */
  initialClientBalance: bigint;
  /** Tokens-per-decimal (USDC-like = 6). */
  decimals?: number;
}): Promise<FlowTokens> {
  const mintAuthority = Keypair.generate();

  // Mint authority needs SOL for the mint-account rent + 2 × ATA rent.
  const sig = await args.connection.requestAirdrop(
    mintAuthority.publicKey,
    LAMPORTS_PER_SOL,
  );
  await args.connection.confirmTransaction(sig, "confirmed");

  const tokenMint = await createMint(
    args.connection,
    mintAuthority,
    mintAuthority.publicKey,
    null,
    args.decimals ?? 6,
  );

  const clientAta = await getOrCreateAssociatedTokenAccount(
    args.connection,
    mintAuthority, // payer
    tokenMint,
    args.client.publicKey,
  );
  const providerAta = await getOrCreateAssociatedTokenAccount(
    args.connection,
    mintAuthority,
    tokenMint,
    args.provider.publicKey,
  );

  await mintTo(
    args.connection,
    mintAuthority,
    tokenMint,
    clientAta.address,
    mintAuthority.publicKey,
    args.initialClientBalance,
  );

  return {
    mintAuthority,
    tokenMint,
    clientTokenAccount: clientAta.address,
    providerTokenAccount: providerAta.address,
  };
}

/**
 * Resolve the workspace's IDL JSON for the named program. Prefers
 * `target/idl/` (post-`anchor build`), falls back to the checked-in
 * `idl/` directory so the harness runs without a fresh build.
 */
export function loadProgram(
  name: "agent_registry" | "agent_vault" | "settlement",
  provider: anchor.AnchorProvider,
  programId: PublicKey,
): Program {
  // anchor.workspace would be cleaner but it requires the harness to
  // be invoked under `anchor test`. The load harness runs standalone
  // (operator-driven, possibly against devnet), so we resolve the IDL
  // by file path the same way scripts/smoke-test-devnet.ts does.
  const path = require("path");
  const fs = require("fs");
  // Walk up from this file (in load/lib/ → load/ → repo root).
  const repoRoot = path.resolve(__dirname, "..", "..");
  const candidates = [
    path.join(repoRoot, "target", "idl", `${name}.json`),
    path.join(repoRoot, "idl", `${name}.json`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const idl = JSON.parse(fs.readFileSync(p, "utf-8"));
      return new Program(idl, provider);
    }
  }
  throw new Error(
    `IDL not found for ${name} (searched ${candidates.join(", ")})`,
  );
}

/** Re-export for callers; matches the constants used by load scenarios. */
export { REGISTRY_PROGRAM_ID, VAULT_PROGRAM_ID };
