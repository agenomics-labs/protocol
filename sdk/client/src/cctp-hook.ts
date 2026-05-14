/**
 * Reflex CCTP V2 Hook — TypeScript SDK (Surface 3).
 *
 * Encoder/decoder for the IC-4 `ReflexHookPayload` and PDA derivation helpers
 * for the `cctp-hook` Anchor program. Mirrors `programs/cctp-hook/src/payload.rs`
 * + `programs/cctp-hook/src/lib.rs` byte-for-byte.
 *
 * Wire format (Borsh, total 73 bytes):
 *   - escrow_pda             : 32 bytes (Pubkey, raw)
 *   - milestone_index        :  1 byte  (u8)
 *   - base_tx_hash           : 32 bytes
 *   - amount_returned_micros :  8 bytes (u64 little-endian)
 *
 * The same byte sequence is what the Base-side CCTP V2 burn-message payload
 * MUST encode (Open Question Q-S3-C — Surface 4 owner pins this on Day 2).
 *
 * ADR-087: the public API migrated from `@solana/web3.js` v1 `PublicKey` to
 * `@solana/kit` v2 `Address` (base58 string brand). The 73-byte wire format
 * is unchanged.
 */

import {
  getProgramDerivedAddress,
  getAddressEncoder,
  getAddressDecoder,
  type Address,
  type ProgramDerivedAddressBump,
} from "@solana/kit";

/** Byte length of a Borsh-encoded `ReflexHookPayload`. */
export const REFLEX_HOOK_PAYLOAD_LEN = 73;

/** Seed for the CCTP-Hook replay-guard PDA. */
export const HOOK_REPLAY_SEED = "hook-replay";

/** Seed for the CCTP-Hook signer PDA (= upstream escrow's `client`). */
export const HOOK_SIGNER_SEED = "hook_signer";

const ADDRESS_ENCODER = getAddressEncoder();
const ADDRESS_DECODER = getAddressDecoder();

/**
 * IC-4 — ReflexHookPayload (verbatim from master spec).
 */
export interface ReflexHookPayload {
  /** AEP Settlement escrow PDA. */
  escrowPda: Address;
  /** Which milestone to approve (u8, 0..=255). */
  milestoneIndex: number;
  /** Base-side x402 settle / CCTP burn tx hash (32 bytes). */
  baseTxHash: Uint8Array;
  /** USDC returned to Solana, in 6-decimal "micros". `bigint` for u64 safety. */
  amountReturnedMicros: bigint;
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/**
 * Borsh-encode an IC-4 `ReflexHookPayload` to the exact 73-byte sequence the
 * on-chain `cctp_hook::auto_approve_milestone` instruction expects.
 *
 * @throws if `milestoneIndex` is out of u8 range, `baseTxHash` is not 32 bytes,
 *         or `amountReturnedMicros` is negative / over u64::MAX.
 */
export function encodeReflexHookPayload(p: ReflexHookPayload): Buffer {
  if (!Number.isInteger(p.milestoneIndex) || p.milestoneIndex < 0 || p.milestoneIndex > 255) {
    throw new Error(
      `encodeReflexHookPayload: milestoneIndex must be a u8 (0..=255); got ${p.milestoneIndex}`,
    );
  }
  if (p.baseTxHash.length !== 32) {
    throw new Error(
      `encodeReflexHookPayload: baseTxHash must be 32 bytes; got ${p.baseTxHash.length}`,
    );
  }
  if (typeof p.amountReturnedMicros !== "bigint") {
    throw new Error(
      `encodeReflexHookPayload: amountReturnedMicros must be a bigint`,
    );
  }
  if (p.amountReturnedMicros < 0n) {
    throw new Error(
      `encodeReflexHookPayload: amountReturnedMicros must be >= 0; got ${p.amountReturnedMicros}`,
    );
  }
  const U64_MAX = (1n << 64n) - 1n;
  if (p.amountReturnedMicros > U64_MAX) {
    throw new Error(
      `encodeReflexHookPayload: amountReturnedMicros must fit in u64; got ${p.amountReturnedMicros}`,
    );
  }

  const out = Buffer.alloc(REFLEX_HOOK_PAYLOAD_LEN);
  let cursor = 0;
  // escrow_pda: 32 bytes
  out.set(ADDRESS_ENCODER.encode(p.escrowPda) as Uint8Array, cursor);
  cursor += 32;
  // milestone_index: 1 byte
  out.writeUInt8(p.milestoneIndex, cursor);
  cursor += 1;
  // base_tx_hash: 32 bytes
  out.set(p.baseTxHash, cursor);
  cursor += 32;
  // amount_returned_micros: u64 LE
  out.writeBigUInt64LE(p.amountReturnedMicros, cursor);
  cursor += 8;

  if (cursor !== REFLEX_HOOK_PAYLOAD_LEN) {
    // Defense-in-depth — should be unreachable.
    throw new Error(
      `encodeReflexHookPayload: serialized ${cursor} bytes, expected ${REFLEX_HOOK_PAYLOAD_LEN}`,
    );
  }
  return out;
}

/**
 * Borsh-decode a 73-byte sequence into a `ReflexHookPayload`. Inverse of
 * {@link encodeReflexHookPayload}. Useful for tests, indexer code, and the
 * relayer fallback that needs to re-construct the payload from a captured
 * Base-side burn message.
 *
 * @throws if `bytes.length !== 73`.
 */
export function decodeReflexHookPayload(bytes: Uint8Array): ReflexHookPayload {
  if (bytes.length !== REFLEX_HOOK_PAYLOAD_LEN) {
    throw new Error(
      `decodeReflexHookPayload: expected ${REFLEX_HOOK_PAYLOAD_LEN} bytes; got ${bytes.length}`,
    );
  }
  const buf = Buffer.from(bytes);
  // ADR-087: `getAddressDecoder().decode()` returns the `Address` brand
  // directly; matches the v1 `new PublicKey(buf.subarray(0,32)).toBase58()`
  // round-trip byte-for-byte.
  const escrowPda = ADDRESS_DECODER.decode(buf.subarray(0, 32)) as Address;
  const milestoneIndex = buf.readUInt8(32);
  const baseTxHash = new Uint8Array(buf.subarray(33, 65));
  const amountReturnedMicros = buf.readBigUInt64LE(65);
  return {
    escrowPda,
    milestoneIndex,
    baseTxHash,
    amountReturnedMicros,
  };
}

// ---------------------------------------------------------------------------
// PDA derivations
// ---------------------------------------------------------------------------

/**
 * Derive the Hook's signer PDA for a given agent authority.
 *
 * Seeds: `["hook_signer", agentAuthority]`. Upstream `create_escrow` MUST
 * have used this PDA as the escrow's `client` for the Hook to be authorized
 * to call `approve_milestone` on it (Q-S3-G).
 */
export async function hookSignerPda(
  cctpHookProgramId: Address,
  agentAuthority: Address,
): Promise<readonly [Address, ProgramDerivedAddressBump]> {
  return getProgramDerivedAddress({
    programAddress: cctpHookProgramId,
    seeds: [HOOK_SIGNER_SEED, ADDRESS_ENCODER.encode(agentAuthority)],
  });
}

/**
 * Derive the replay-guard PDA for an IC-4 triple.
 *
 * Seeds: `["hook-replay", escrowPda, milestoneIndex (u8 LE), baseTxHash]`.
 * Initialization with this PDA is the Hook program's idempotency mechanism —
 * a duplicate triple reverts atomically before any CPI fires.
 */
export async function hookReplayPda(
  cctpHookProgramId: Address,
  escrowPda: Address,
  milestoneIndex: number,
  baseTxHash: Uint8Array,
): Promise<readonly [Address, ProgramDerivedAddressBump]> {
  if (!Number.isInteger(milestoneIndex) || milestoneIndex < 0 || milestoneIndex > 255) {
    throw new Error(
      `hookReplayPda: milestoneIndex must be a u8 (0..=255); got ${milestoneIndex}`,
    );
  }
  if (baseTxHash.length !== 32) {
    throw new Error(
      `hookReplayPda: baseTxHash must be 32 bytes; got ${baseTxHash.length}`,
    );
  }
  return getProgramDerivedAddress({
    programAddress: cctpHookProgramId,
    seeds: [
      HOOK_REPLAY_SEED,
      ADDRESS_ENCODER.encode(escrowPda),
      new Uint8Array([milestoneIndex]),
      baseTxHash,
    ],
  });
}
