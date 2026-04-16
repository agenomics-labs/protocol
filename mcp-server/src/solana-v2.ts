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
