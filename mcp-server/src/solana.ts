import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import { AnchorProvider, Program, BN, Idl } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/**
 * Solana connection, Anchor programs, and PDA helpers for the AEAP MCP server.
 *
 * This module initializes:
 * - Solana RPC connection (configurable via SOLANA_RPC_URL)
 * - Wallet keypair (from SOLANA_KEYPAIR_PATH or default Solana CLI path)
 * - Anchor Provider and Program instances for all three AEAP programs
 * - PDA derivation utilities matching the on-chain program seeds
 */

// ==================== SPL TOKEN CONSTANTS ====================
// ADR-050: Inlined to eliminate @solana/spl-token dependency and its
// transitive bigint-buffer CVE (GHSA-3gc7-fjrx-p6mg).

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

/**
 * Derive the associated token account (ATA) address for a given mint and owner.
 * Replaces getAssociatedTokenAddressSync from @solana/spl-token.
 * Seeds: [owner, TOKEN_PROGRAM_ID, mint] with ASSOCIATED_TOKEN_PROGRAM_ID.
 */
export function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false
): PublicKey {
  if (!allowOwnerOffCurve && PublicKey.isOnCurve(owner.toBuffer())) {
    // owner is on curve — standard case
  }
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
}

// ==================== PROGRAM IDS ====================

export const VAULT_PROGRAM_ID = new PublicKey(
  "4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN"
);
export const REGISTRY_PROGRAM_ID = new PublicKey(
  "8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh"
);
export const SETTLEMENT_PROGRAM_ID = new PublicKey(
  "GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3"
);

// ==================== SINGLETONS ====================

let _connection: Connection | null = null;
let _wallet: Keypair | null = null;
let _provider: AnchorProvider | null = null;
let _vaultProgram: Program | null = null;
let _registryProgram: Program | null = null;
let _settlementProgram: Program | null = null;

// ==================== WALLET ADAPTER ====================

/**
 * Minimal Wallet adapter for Anchor provider.
 * Wraps a Keypair to satisfy AnchorProvider's wallet interface.
 */
class KeypairWallet {
  constructor(readonly payer: Keypair) {}

  get publicKey(): PublicKey {
    return this.payer.publicKey;
  }

  async signTransaction<T extends Transaction>(tx: T): Promise<T> {
    tx.partialSign(this.payer);
    return tx;
  }

  async signAllTransactions<T extends Transaction>(txs: T[]): Promise<T[]> {
    txs.forEach((tx) => tx.partialSign(this.payer));
    return txs;
  }
}

// ==================== CONNECTION & PROVIDER ====================

/**
 * Get or create a Solana RPC connection.
 * Defaults to devnet; override with SOLANA_RPC_URL env var.
 */
export function getConnection(): Connection {
  if (!_connection) {
    const rpcUrl =
      process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    _connection = new Connection(rpcUrl, "confirmed");
  }
  return _connection;
}

/**
 * Load the agent's wallet keypair from disk.
 * Checks SOLANA_KEYPAIR_PATH env var, then falls back to ~/.config/solana/id.json.
 */
export function loadWallet(): Keypair {
  if (_wallet) return _wallet;

  let keypath = process.env.SOLANA_KEYPAIR_PATH;
  if (!keypath) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    keypath = path.join(home, ".config", "solana", "id.json");
  }

  if (!fs.existsSync(keypath)) {
    throw new Error(
      `Wallet keypair not found at: ${keypath}. ` +
        `Set SOLANA_KEYPAIR_PATH or run 'solana-keygen new'.`
    );
  }

  const secretKey = JSON.parse(fs.readFileSync(keypath, "utf-8"));
  _wallet = Keypair.fromSecretKey(Buffer.from(secretKey));
  return _wallet;
}

/**
 * Get the wallet's public key (agent address).
 */
export function getWalletPublicKey(): PublicKey {
  return loadWallet().publicKey;
}

/**
 * Get or create an AnchorProvider bound to the agent's wallet.
 */
export function getProvider(): AnchorProvider {
  if (_provider) return _provider;
  const conn = getConnection();
  const kp = loadWallet();
  const wallet = new KeypairWallet(kp);
  _provider = new AnchorProvider(conn, wallet as any, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return _provider;
}

// ==================== IDL LOADING & PROGRAMS ====================

/**
 * Load an Anchor IDL JSON file by program name.
 * IDL files are expected at ../../target/idl/<name>.json relative to dist/.
 */
function loadIdl(name: string): any {
  const idlPath = path.resolve(
    __dirname,
    "..",
    "..",
    "target",
    "idl",
    `${name}.json`
  );
  if (!fs.existsSync(idlPath)) {
    throw new Error(
      `IDL file not found: ${idlPath}. Run 'anchor build' to generate IDLs.`
    );
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

/**
 * Get the Agent Vault program instance.
 */
export function getVaultProgram(): Program {
  if (!_vaultProgram) {
    const idl = loadIdl("agent_vault");
    _vaultProgram = new Program(idl, getProvider());
  }
  return _vaultProgram;
}

/**
 * Get the Agent Registry program instance.
 */
export function getRegistryProgram(): Program {
  if (!_registryProgram) {
    const idl = loadIdl("agent_registry");
    _registryProgram = new Program(idl, getProvider());
  }
  return _registryProgram;
}

/**
 * Get the Settlement program instance.
 */
export function getSettlementProgram(): Program {
  if (!_settlementProgram) {
    const idl = loadIdl("settlement");
    _settlementProgram = new Program(idl, getProvider());
  }
  return _settlementProgram;
}

// ==================== PDA DERIVATION ====================

/**
 * Derive vault PDA. Seeds: ["vault", authority]
 */
export function deriveVaultPDA(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), authority.toBuffer()],
    VAULT_PROGRAM_ID
  );
}

/**
 * Derive agent profile PDA. Seeds: [authority, "agent-profile"]
 */
export function deriveAgentProfilePDA(
  authority: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [authority.toBuffer(), Buffer.from("agent-profile")],
    REGISTRY_PROGRAM_ID
  );
}

/**
 * Derive escrow PDA. Seeds: ["escrow", client, provider, taskId_le_bytes]
 */
export function deriveEscrowPDA(
  client: PublicKey,
  provider: PublicKey,
  taskId: number
): [PublicKey, number] {
  const taskIdBuf = Buffer.alloc(8);
  taskIdBuf.writeBigUInt64LE(BigInt(taskId));
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("escrow"),
      client.toBuffer(),
      provider.toBuffer(),
      taskIdBuf,
    ],
    SETTLEMENT_PROGRAM_ID
  );
}

/**
 * Derive the escrow's associated token account (ATA).
 * Uses allowOwnerOffCurve=true since the escrow is a PDA.
 */
export function deriveEscrowTokenAccount(
  escrowPDA: PublicKey,
  tokenMint: PublicKey
): PublicKey {
  return getAssociatedTokenAddressSync(tokenMint, escrowPDA, true);
}

/**
 * Finding #19: Derive the singleton ProtocolConfig PDA.
 * Seeds: [b"protocol_config"] under the Settlement program.
 * Every escrow/dispute/approve/expire path now takes this account so the
 * governance-owned tunables (min_escrow, dispute_timeout, reputation
 * deltas) are read at runtime instead of baked into the binary.
 */
export function deriveProtocolConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    SETTLEMENT_PROGRAM_ID
  );
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Validate a base58-encoded Solana public key string.
 */
export function isValidPublicKey(key: string): boolean {
  try {
    new PublicKey(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a base58 string into a PublicKey, throwing on invalid input.
 */
export function parsePublicKey(key: string): PublicKey {
  if (!isValidPublicKey(key)) {
    throw new Error(`Invalid Solana public key: ${key}`);
  }
  return new PublicKey(key);
}

/**
 * Convert SOL to lamports.
 */
export function solToLamports(sol: number): number {
  return Math.floor(sol * LAMPORTS_PER_SOL);
}

/**
 * Convert lamports to SOL.
 */
export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/**
 * Get the SOL balance of an address.
 */
export async function getBalance(pubkey: PublicKey): Promise<number> {
  const conn = getConnection();
  const balance = await conn.getBalance(pubkey);
  return balance / LAMPORTS_PER_SOL;
}

/**
 * SHA-256 hash a string and return as a 32-byte array (for description hashes).
 */
export function hashDescription(description: string): number[] {
  const hash = crypto.createHash("sha256").update(description).digest();
  return Array.from(hash);
}

// Re-exports for convenience
export {
  PublicKey,
  BN,
  LAMPORTS_PER_SOL,
};
