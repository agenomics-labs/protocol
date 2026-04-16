/**
 * Solana Web3.js v2 Compatibility Layer
 *
 * Provides v2-style utilities alongside the existing v1 implementation.
 * This module enables gradual migration from @solana/web3.js v1 to v2
 * without breaking existing handlers.
 *
 * Once @coral-xyz/anchor releases a v2-compatible client, handlers can
 * be migrated one-by-one to use these utilities instead of solana.ts.
 *
 * Key differences from v1:
 * - Addresses are strings, not PublicKey objects
 * - Amounts use native BigInt, not BN.js
 * - Functions are tree-shakeable (no class instances)
 * - PDA derivation uses getProgramDerivedAddress (async)
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
// ==================== CONSTANTS ====================

export const VAULT_PROGRAM_ID = "4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN";
export const REGISTRY_PROGRAM_ID = "8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh";
export const SETTLEMENT_PROGRAM_ID = "GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3";

export const LAMPORTS_PER_SOL = 1_000_000_000n;

// ==================== AMOUNT UTILITIES ====================

/**
 * Convert SOL to lamports using native BigInt.
 * Avoids BN.js dependency and floating-point precision issues.
 */
export function solToLamports(sol: number): bigint {
  // Use string conversion to avoid floating-point precision loss
  const parts = sol.toString().split(".");
  const whole = BigInt(parts[0]) * LAMPORTS_PER_SOL;
  if (parts.length === 1) return whole;

  const decimals = parts[1].padEnd(9, "0").slice(0, 9);
  return whole + BigInt(decimals);
}

/**
 * Convert lamports to SOL.
 */
export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}

// ==================== HASHING ====================

/**
 * SHA-256 hash a string and return as Uint8Array.
 */
export function hashDescription(description: string): Uint8Array {
  return new Uint8Array(
    crypto.createHash("sha256").update(description).digest()
  );
}

// ==================== ADDRESS VALIDATION ====================

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Validate a base58 Solana address string.
 * v2 uses string addresses instead of PublicKey objects.
 */
export function isValidAddress(address: string): boolean {
  if (address.length < 32 || address.length > 44) return false;
  for (const char of address) {
    if (!BASE58_ALPHABET.includes(char)) return false;
  }
  return true;
}

/**
 * Assert address is valid, throwing on invalid input.
 */
export function assertValidAddress(address: string): string {
  if (!isValidAddress(address)) {
    throw new Error(`Invalid Solana address: ${address}`);
  }
  return address;
}

// ==================== PDA DERIVATION ====================

/**
 * Derive vault PDA (v2-style, returns string address).
 * Seeds: ["vault", authority]
 * Uses v1 PublicKey.findProgramAddressSync as a bridge until full v2 kit is available.
 */
export function deriveVaultPDAv2(authority: string): [string, number] {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), new PublicKey(authority).toBuffer()],
    new PublicKey(VAULT_PROGRAM_ID)
  );
  return [pda.toBase58(), bump];
}

/**
 * Derive agent profile PDA (v2-style, returns string address).
 * Seeds: [authority, "agent-profile"]
 */
export function deriveAgentProfilePDAv2(authority: string): [string, number] {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new PublicKey(authority).toBuffer(), Buffer.from("agent-profile")],
    new PublicKey(REGISTRY_PROGRAM_ID)
  );
  return [pda.toBase58(), bump];
}

/**
 * Derive escrow PDA (v2-style, returns string address).
 * Seeds: ["escrow", client, provider, taskId_le_bytes]
 */
export function deriveEscrowPDAv2(
  client: string,
  provider: string,
  taskId: number
): [string, number] {
  const taskIdBuf = Buffer.alloc(8);
  taskIdBuf.writeBigUInt64LE(BigInt(taskId));
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("escrow"),
      new PublicKey(client).toBuffer(),
      new PublicKey(provider).toBuffer(),
      taskIdBuf,
    ],
    new PublicKey(SETTLEMENT_PROGRAM_ID)
  );
  return [pda.toBase58(), bump];
}

/**
 * Derive the escrow's associated token account (v2-style, returns string address).
 * Uses allowOwnerOffCurve=true since the escrow is a PDA.
 */
export function deriveEscrowTokenAccountv2(
  escrowPDA: string,
  tokenMint: string
): string {
  const TOKEN_PID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const ATA_PID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const [ata] = PublicKey.findProgramAddressSync(
    [new PublicKey(escrowPDA).toBuffer(), TOKEN_PID.toBuffer(), new PublicKey(tokenMint).toBuffer()],
    ATA_PID
  );
  return ata.toBase58();
}

// ==================== CONNECTION HELPER ====================

/**
 * Create a Solana RPC connection.
 * Defaults to devnet; override with rpcUrl param or SOLANA_RPC_URL env var.
 */
export function createConnection(rpcUrl?: string): Connection {
  const url = rpcUrl || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  return new Connection(url, "confirmed");
}

// ==================== KEYPAIR LOADING ====================

/**
 * Load a Keypair from a JSON secret-key file on disk.
 * Checks the provided path, then SOLANA_KEYPAIR_PATH env var,
 * then falls back to ~/.config/solana/id.json.
 */
export function loadKeypairv2(filePath?: string): Keypair {
  let keypath = filePath || process.env.SOLANA_KEYPAIR_PATH;
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
  return Keypair.fromSecretKey(Buffer.from(secretKey));
}

// ==================== TYPE DEFINITIONS ====================

/** v2-style transaction result */
export interface TransactionResult {
  signature: string;
  slot: bigint;
  confirmationStatus: "processed" | "confirmed" | "finalized";
}

/** v2-style account info */
export interface AccountInfo {
  address: string;
  lamports: bigint;
  owner: string;
  executable: boolean;
  data: Uint8Array;
}

// ==================== MIGRATION HELPERS ====================

/**
 * Convert a v1 BN to native BigInt.
 * Use during migration to bridge v1 Anchor client responses to v2 code.
 */
export function bnToBigInt(bn: { toNumber?: () => number; toString: () => string }): bigint {
  return BigInt(bn.toString());
}

/**
 * Convert a v1 PublicKey to v2 address string.
 * Use during migration to bridge v1 Anchor client responses to v2 code.
 */
export function pubkeyToAddress(pubkey: { toBase58: () => string }): string {
  return pubkey.toBase58();
}
