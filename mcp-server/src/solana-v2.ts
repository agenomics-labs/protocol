/**
 * ADR-012 / ADR-033 — @solana/kit v2 surface for the AEP MCP server.
 *
 * This module is the Kit-native (web3.js v2) boundary. It is additive in PR2:
 * callers continue to use `src/solana.ts` (v1 / Anchor) for now. PR3 will begin
 * routing new read paths through the v2 surface, and the tx-pipeline work
 * (preflight, idempotency mutex, compute budget helpers) lands in that PR.
 *
 * Design notes:
 *  - We initialize the v2 RPC lazily (same pattern as `src/solana.ts`) so that
 *    tests can import this module without requiring an RPC endpoint.
 *  - PDA derivation here MUST be seed-identical to the v1 derivations in
 *    `src/solana.ts` (see `test/solana-v2.test.ts` for the fidelity proof).
 *  - No transaction building / signing is done in PR2. The `createSigner*`
 *    helpers are provided so PR3 can swap in `@solana/keychain-core` without
 *    moving the boundary again.
 *  - For Anchor compat conversions, see the `Adapter` section at the bottom of
 *    `src/solana.ts`. Do NOT duplicate them here.
 */

import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  getAddressEncoder,
  getProgramDerivedAddress,
  address as toAddressBrand,
  isAddress,
  createKeyPairSignerFromBytes,
  type Address,
  type ProgramDerivedAddress,
  type KeyPairSigner,
} from "@solana/kit";
import * as fs from "fs";
import * as path from "path";

// ==================== PROGRAM IDS (v2 Address brand) ====================
//
// These MUST stay aligned with the same-named constants in `src/solana.ts`.
// The byte values are identical; only the TypeScript brand differs.

export const VAULT_PROGRAM_ADDRESS: Address =
  "D2y1dEi4dj1pcxw6GvkFWX34RRbuFJCaGWdPNJAasQ5q" as Address;
export const REGISTRY_PROGRAM_ADDRESS: Address =
  "26KETQPxeMmbakxpVbUEpQBQmVgpabHAweTHBRgBHjW7" as Address;
export const SETTLEMENT_PROGRAM_ADDRESS: Address =
  "AwjdsNvhR2uwPNbU6F2fsYB33VcNGL5XaANdgsyvZDia" as Address;

export const TOKEN_PROGRAM_ADDRESS: Address =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS: Address =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;

// ==================== RPC ====================

type SolanaRpc = ReturnType<typeof createSolanaRpc>;
export type SolanaRpcSubscriptions = ReturnType<typeof createRpcSubscriptions>;

let _rpc: SolanaRpc | null = null;
let _rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions> | null = null;

/**
 * Lazily create (or return the cached) Kit RPC client.
 *
 * The endpoint falls back through the same env vars as the v1 surface so the
 * two sides point at the same cluster during dev/test.
 */
export function createRpc(): SolanaRpc {
  if (!_rpc) {
    const url = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    _rpc = createSolanaRpc(url);
  }
  return _rpc;
}

/**
 * Derive a WebSocket URL for the Kit RPC-subscriptions client.
 *
 * Precedence (highest → lowest):
 *   1. `SOLANA_WS_URL`           — explicit override (any ws:// or wss:// URL)
 *   2. `SOLANA_RPC_URL` rewritten — `http://` → `ws://`, `https://` → `wss://`
 *   3. `wss://api.devnet.solana.com` — matches the HTTP default above
 *
 * Exported for unit tests; the runtime caller should use
 * {@link createRpcSubscriptions}.
 */
export function resolveWsUrl(): string {
  const explicit = process.env.SOLANA_WS_URL;
  if (explicit && explicit.length > 0) return explicit;
  const http = process.env.SOLANA_RPC_URL;
  if (http && http.length > 0) {
    if (http.startsWith("https://")) return "wss://" + http.slice("https://".length);
    if (http.startsWith("http://")) return "ws://" + http.slice("http://".length);
    // If it's already a ws(s):// URL or something else, pass it through verbatim.
    return http;
  }
  return "wss://api.devnet.solana.com";
}

/**
 * Lazily create (or return the cached) Kit RPC-subscriptions (WebSocket)
 * client.
 *
 * Shape mirrors {@link createRpc}: module-level memoization, env-driven URL,
 * devnet default. Used by `handlers-v2/vault.ts` to build the real
 * `sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })` when the
 * v2 env flag flips on.
 */
export function createRpcSubscriptions(): ReturnType<typeof createSolanaRpcSubscriptions> {
  if (!_rpcSubscriptions) {
    _rpcSubscriptions = createSolanaRpcSubscriptions(resolveWsUrl());
  }
  return _rpcSubscriptions;
}

/**
 * Reset the cached RPC + RPC-subscriptions clients. Intended for tests only.
 */
export function __resetRpcForTests(): void {
  _rpc = null;
  _rpcSubscriptions = null;
}

// ==================== SIGNER ====================

/**
 * Create a Kit `KeyPairSigner` from a 64-byte secret-key array on disk.
 *
 * Accepts the standard Solana CLI JSON-array format so keypairs generated
 * with `solana-keygen new` work unmodified on the v2 side.
 *
 * NOTE: The full signer abstraction (hot-wallet vs. `@solana/keychain-core`
 * HSM-backed signers) is PR3 scope. This helper exists now so the Action
 * shape's `signer` field can be typed in PR2 without committing to an
 * implementation strategy.
 */
export async function createSigner(
  keypairPath?: string,
): Promise<KeyPairSigner> {
  const resolved = keypairPath ?? defaultKeypairPath();
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Wallet keypair not found at: ${resolved}. ` +
        `Set SOLANA_KEYPAIR_PATH or run 'solana-keygen new'.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  const bytes = new Uint8Array(raw);
  return createKeyPairSignerFromBytes(bytes);
}

function defaultKeypairPath(): string {
  const envPath = process.env.SOLANA_KEYPAIR_PATH;
  if (envPath) return envPath;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".config", "solana", "id.json");
}

// ==================== PDA DERIVATION (v2, seed-compatible) ====================

// The Kit API renames `findProgramAddressFromSeeds` → `getProgramDerivedAddress`
// (single options-object call). Seeds are either strings or byte arrays;
// Address seeds must be encoded first. These wrappers keep the seed layout
// identical to `src/solana.ts`, which is asserted in `test/solana-v2.test.ts`.

const addressEncoder = getAddressEncoder();

/**
 * Derive vault PDA. Seeds: ["vault", authority]
 * Equivalent to `deriveVaultPDA` in `src/solana.ts`.
 */
export async function deriveVaultPda(
  authority: Address,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: VAULT_PROGRAM_ADDRESS,
    seeds: ["vault", addressEncoder.encode(authority)],
  });
}

/**
 * ADR-097: Derive agent profile PDA. Seeds:
 *   [authority, "agent-profile", nonce-le-u64]
 * Equivalent to `deriveAgentProfilePDA` in `src/solana.ts`. Fresh users use
 * `nonce = 0n`; re-registered users supply their current owner_nonce value.
 */
export async function deriveAgentProfilePda(
  authority: Address,
  nonce: bigint = 0n,
): Promise<ProgramDerivedAddress> {
  const nonceBuf = new Uint8Array(8);
  new DataView(nonceBuf.buffer).setBigUint64(0, nonce, true);
  return getProgramDerivedAddress({
    programAddress: REGISTRY_PROGRAM_ADDRESS,
    seeds: [addressEncoder.encode(authority), "agent-profile", nonceBuf],
  });
}

/**
 * ADR-097: Derive owner-nonce PDA. Seeds: [authority, "owner-nonce"].
 * Equivalent to `deriveOwnerNoncePDA` in `src/solana.ts`.
 */
export async function deriveOwnerNoncePda(
  authority: Address,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: REGISTRY_PROGRAM_ADDRESS,
    seeds: [addressEncoder.encode(authority), "owner-nonce"],
  });
}

/**
 * Derive escrow PDA. Seeds: ["escrow", client, provider, taskId_le_bytes]
 * Equivalent to `deriveEscrowPDA` in `src/solana.ts`.
 */
export async function deriveEscrowPda(
  client: Address,
  provider: Address,
  taskId: number | bigint,
): Promise<ProgramDerivedAddress> {
  const taskIdBuf = new Uint8Array(8);
  new DataView(taskIdBuf.buffer).setBigUint64(0, BigInt(taskId), true);
  return getProgramDerivedAddress({
    programAddress: SETTLEMENT_PROGRAM_ADDRESS,
    seeds: [
      "escrow",
      addressEncoder.encode(client),
      addressEncoder.encode(provider),
      taskIdBuf,
    ],
  });
}

/**
 * Derive the singleton ProtocolConfig PDA.
 * Equivalent to `deriveProtocolConfigPDA` in `src/solana.ts`.
 */
export async function deriveProtocolConfigPda(): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: SETTLEMENT_PROGRAM_ADDRESS,
    seeds: ["protocol_config"],
  });
}

// ==================== BLOCKHASH ====================

/**
 * Fetch the latest blockhash over the Kit RPC.
 *
 * Returned to the caller verbatim — PR3 will compose this into the tx-pipeline
 * (preflight + compute budget). In PR2 this exists for the test harness and
 * future consumers only.
 */
export async function getLatestBlockhash(): Promise<{
  blockhash: string;
  lastValidBlockHeight: bigint;
}> {
  const rpc = createRpc();
  const { value } = await rpc.getLatestBlockhash().send();
  return {
    blockhash: value.blockhash,
    lastValidBlockHeight: value.lastValidBlockHeight,
  };
}

// ==================== UTILITIES ====================

/**
 * Narrow an arbitrary string to the branded `Address` type, validating that
 * it is a well-formed base58 address.
 */
export function parseAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new Error(`Invalid Solana address: ${value}`);
  }
  return toAddressBrand(value);
}

/**
 * Type-only re-exports — so downstream code can `import type { Address, ... }
 * from "./solana-v2"` without pulling in the full Kit surface transitively.
 */
export type { Address, ProgramDerivedAddress, KeyPairSigner };
