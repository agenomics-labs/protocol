/**
 * Surface 3 — `cctp-hook` SDK encoder/decoder unit tests.
 *
 * Pins the wire-format byte layout of `ReflexHookPayload` to the IC-4 spec
 * (master spec §"Surface 3 — Interface contract — IC-4"). The on-chain
 * Borsh decode in `programs/cctp-hook/src/payload.rs` MUST round-trip these
 * bytes; if either side drifts, the integration breaks silently at
 * deserialize time. The Rust counterpart lives in
 * `programs/cctp-hook/src/payload.rs::tests`.
 *
 * ADR-087: the wire format (73 bytes) is unchanged across the
 * `@solana/web3.js` v1 → `@solana/kit` v2 migration. The public API
 * accepts/returns `Address` (kit's branded base58 string) rather than
 * `PublicKey` (web3.js class).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { web3 } from "@coral-xyz/anchor";
import { getAddressEncoder, type Address } from "@solana/kit";

import {
  REFLEX_HOOK_PAYLOAD_LEN,
  encodeReflexHookPayload,
  decodeReflexHookPayload,
  hookSignerPda,
  hookReplayPda,
  type ReflexHookPayload,
} from "../src/index.js";

const { PublicKey } = web3;

const HOOK_PROGRAM_ID_BS58 = "3yifMBDVChLzcihZWh4or9zxgzbmQVghdNZzpuP814vb";
const HOOK_PROGRAM_ID = HOOK_PROGRAM_ID_BS58 as Address;

const ESCROW_PDA_BS58 = "9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95";
const ESCROW_PDA = ESCROW_PDA_BS58 as Address;

function fixturePayload(): ReflexHookPayload {
  return {
    escrowPda: ESCROW_PDA,
    milestoneIndex: 7,
    baseTxHash: new Uint8Array(32).fill(0xab),
    amountReturnedMicros: 80_000n, // $0.08 in 6-decimal USDC micros
  };
}

// ---------------------------------------------------------------------------
// Wire-format pins
// ---------------------------------------------------------------------------

test("REFLEX_HOOK_PAYLOAD_LEN equals 73 bytes (32+1+32+8)", () => {
  assert.equal(REFLEX_HOOK_PAYLOAD_LEN, 73);
});

test("encodeReflexHookPayload produces a 73-byte buffer", () => {
  const bytes = encodeReflexHookPayload(fixturePayload());
  assert.equal(bytes.length, REFLEX_HOOK_PAYLOAD_LEN);
});

test("encode/decode round-trip preserves all fields exactly", () => {
  const original = fixturePayload();
  const bytes = encodeReflexHookPayload(original);
  const decoded = decodeReflexHookPayload(bytes);

  assert.equal(decoded.escrowPda, original.escrowPda);
  assert.equal(decoded.milestoneIndex, original.milestoneIndex);
  assert.deepEqual(decoded.baseTxHash, original.baseTxHash);
  assert.equal(decoded.amountReturnedMicros, original.amountReturnedMicros);
});

test("encoded layout is escrow_pda(32) + milestone(1) + base_tx_hash(32) + amount_le(8)", () => {
  const payload: ReflexHookPayload = {
    escrowPda: ESCROW_PDA,
    milestoneIndex: 0x42,
    baseTxHash: new Uint8Array(32).fill(0xcd),
    amountReturnedMicros: 1n, // 1 micro
  };
  const bytes = encodeReflexHookPayload(payload);

  // escrow_pda — must equal the raw 32-byte encoding of the base58 address.
  // We compare against (a) kit's encoder and (b) v1 PublicKey.toBytes() to
  // pin both encodings agree byte-for-byte (cross-stack invariant).
  const expectedFromKit = getAddressEncoder().encode(payload.escrowPda) as Uint8Array;
  const expectedFromV1 = new PublicKey(payload.escrowPda as string).toBytes();
  assert.deepEqual(new Uint8Array(bytes.subarray(0, 32)), expectedFromKit);
  assert.deepEqual(new Uint8Array(bytes.subarray(0, 32)), expectedFromV1);

  // milestone_index
  assert.equal(bytes[32], 0x42);
  // base_tx_hash
  assert.deepEqual(
    new Uint8Array(bytes.subarray(33, 65)),
    payload.baseTxHash,
  );
  // amount_returned_micros — u64 little-endian, value = 1 → byte 65 = 0x01
  assert.equal(bytes[65], 0x01);
  for (let i = 66; i < 73; i++) assert.equal(bytes[i], 0x00);
});

// ---------------------------------------------------------------------------
// Validation guards
// ---------------------------------------------------------------------------

test("encode rejects milestoneIndex out of u8 range", () => {
  const base = fixturePayload();
  assert.throws(
    () => encodeReflexHookPayload({ ...base, milestoneIndex: 256 }),
    /milestoneIndex must be a u8/,
  );
  assert.throws(
    () => encodeReflexHookPayload({ ...base, milestoneIndex: -1 }),
    /milestoneIndex must be a u8/,
  );
});

test("encode rejects baseTxHash with wrong length", () => {
  const base = fixturePayload();
  assert.throws(
    () => encodeReflexHookPayload({ ...base, baseTxHash: new Uint8Array(31) }),
    /baseTxHash must be 32 bytes/,
  );
});

test("encode rejects negative amountReturnedMicros", () => {
  const base = fixturePayload();
  assert.throws(
    () => encodeReflexHookPayload({ ...base, amountReturnedMicros: -1n }),
    /amountReturnedMicros must be >= 0/,
  );
});

test("decode rejects buffers that are not exactly 73 bytes", () => {
  assert.throws(
    () => decodeReflexHookPayload(new Uint8Array(72)),
    /expected 73 bytes/,
  );
  assert.throws(
    () => decodeReflexHookPayload(new Uint8Array(74)),
    /expected 73 bytes/,
  );
});

// ---------------------------------------------------------------------------
// PDA derivations
// ---------------------------------------------------------------------------

test("hookSignerPda is deterministic across calls for the same agent", async () => {
  const agent = "8vj7tBNqdqWzgfM2tCVTLiBXiqsRPZbKDRtuvL3RMqKz" as Address;
  const [pda1] = await hookSignerPda(HOOK_PROGRAM_ID, agent);
  const [pda2] = await hookSignerPda(HOOK_PROGRAM_ID, agent);
  assert.equal(pda1, pda2);
});

test("hookReplayPda is deterministic across calls for the same triple", async () => {
  const baseTx = new Uint8Array(32).fill(0xab);
  const [pda1] = await hookReplayPda(HOOK_PROGRAM_ID, ESCROW_PDA, 7, baseTx);
  const [pda2] = await hookReplayPda(HOOK_PROGRAM_ID, ESCROW_PDA, 7, baseTx);
  assert.equal(pda1, pda2);
});

test("hookReplayPda differs when any seed component differs", async () => {
  const baseTxA = new Uint8Array(32).fill(0xab);
  const baseTxB = new Uint8Array(32).fill(0xcd);

  const [a] = await hookReplayPda(HOOK_PROGRAM_ID, ESCROW_PDA, 7, baseTxA);
  const [b] = await hookReplayPda(HOOK_PROGRAM_ID, ESCROW_PDA, 7, baseTxB);
  const [c] = await hookReplayPda(HOOK_PROGRAM_ID, ESCROW_PDA, 8, baseTxA);

  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("hookReplayPda rejects invalid milestoneIndex", async () => {
  const baseTx = new Uint8Array(32);
  await assert.rejects(
    async () => hookReplayPda(HOOK_PROGRAM_ID, ESCROW_PDA, 256, baseTx),
    /milestoneIndex must be a u8/,
  );
});
