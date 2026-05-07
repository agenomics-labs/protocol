/**
 * Surface 3 — `cctp-hook` SDK encoder/decoder unit tests.
 *
 * Pins the wire-format byte layout of `ReflexHookPayload` to the IC-4 spec
 * (master spec §"Surface 3 — Interface contract — IC-4"). The on-chain
 * Borsh decode in `programs/cctp-hook/src/payload.rs` MUST round-trip these
 * bytes; if either side drifts, the integration breaks silently at
 * deserialize time. The Rust counterpart lives in
 * `programs/cctp-hook/src/payload.rs::tests`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  REFLEX_HOOK_PAYLOAD_LEN,
  encodeReflexHookPayload,
  decodeReflexHookPayload,
  hookSignerPda,
  hookReplayPda,
  type ReflexHookPayload,
} from "../src/index.js";

const HOOK_PROGRAM_ID = new PublicKey(
  "3yifMBDVChLzcihZWh4or9zxgzbmQVghdNZzpuP814vb",
);

function fixturePayload(): ReflexHookPayload {
  return {
    escrowPda: new PublicKey("9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95"),
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

  assert.equal(decoded.escrowPda.toBase58(), original.escrowPda.toBase58());
  assert.equal(decoded.milestoneIndex, original.milestoneIndex);
  assert.deepEqual(decoded.baseTxHash, original.baseTxHash);
  assert.equal(decoded.amountReturnedMicros, original.amountReturnedMicros);
});

test("encoded layout is escrow_pda(32) + milestone(1) + base_tx_hash(32) + amount_le(8)", () => {
  const payload: ReflexHookPayload = {
    escrowPda: new PublicKey("9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95"),
    milestoneIndex: 0x42,
    baseTxHash: new Uint8Array(32).fill(0xcd),
    amountReturnedMicros: 1n, // 1 micro
  };
  const bytes = encodeReflexHookPayload(payload);

  // escrow_pda
  assert.deepEqual(
    new Uint8Array(bytes.subarray(0, 32)),
    payload.escrowPda.toBytes(),
  );
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

test("hookSignerPda is deterministic across calls for the same agent", () => {
  const agent = new PublicKey("8vj7tBNqdqWzgfM2tCVTLiBXiqsRPZbKDRtuvL3RMqKz");
  const [pda1] = hookSignerPda(HOOK_PROGRAM_ID, agent);
  const [pda2] = hookSignerPda(HOOK_PROGRAM_ID, agent);
  assert.equal(pda1.toBase58(), pda2.toBase58());
});

test("hookReplayPda is deterministic across calls for the same triple", () => {
  const escrow = new PublicKey("9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95");
  const baseTx = new Uint8Array(32).fill(0xab);
  const [pda1] = hookReplayPda(HOOK_PROGRAM_ID, escrow, 7, baseTx);
  const [pda2] = hookReplayPda(HOOK_PROGRAM_ID, escrow, 7, baseTx);
  assert.equal(pda1.toBase58(), pda2.toBase58());
});

test("hookReplayPda differs when any seed component differs", () => {
  const escrow = new PublicKey("9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95");
  const baseTxA = new Uint8Array(32).fill(0xab);
  const baseTxB = new Uint8Array(32).fill(0xcd);

  const [a] = hookReplayPda(HOOK_PROGRAM_ID, escrow, 7, baseTxA);
  const [b] = hookReplayPda(HOOK_PROGRAM_ID, escrow, 7, baseTxB);
  const [c] = hookReplayPda(HOOK_PROGRAM_ID, escrow, 8, baseTxA);

  assert.notEqual(a.toBase58(), b.toBase58());
  assert.notEqual(a.toBase58(), c.toBase58());
});

test("hookReplayPda rejects invalid milestoneIndex", () => {
  const escrow = new PublicKey("9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95");
  const baseTx = new Uint8Array(32);
  assert.throws(
    () => hookReplayPda(HOOK_PROGRAM_ID, escrow, 256, baseTx),
    /milestoneIndex must be a u8/,
  );
});
