/**
 * AUD-200: BorshReader.i16 + ReputationDeltaProposed decoder.
 *
 * On-chain `pub delta: i16` was being read via `r.u16()`, so any negative
 * value (e.g. -5 from a registry slash) wrapped to its unsigned alias
 * (65531) by the time it reached dashboards. This test pins the fix to
 * the wire format defined in
 *   programs/agent-registry/src/events.rs::ReputationDeltaProposed.
 *
 * Pure-unit test — no real Connection, no DB writes.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { PublicKey, Keypair } from "@solana/web3.js";
import { parseLogsForEvents } from "./index";

// Discriminator from the DISCRIMINATOR_MAP — sha256("event:ReputationDeltaProposed")[..8].
const DISC_REPUTATION_DELTA_PROPOSED = "483cc896eed8c2fc";

function encI16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16LE(n, 0);
  return b;
}
function encI64(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return b;
}
function encPubkey(pk: PublicKey): Buffer {
  return Buffer.from(pk.toBytes());
}

/**
 * Encode the borsh wire layout for ReputationDeltaProposed:
 *   pub authority: Pubkey
 *   pub delta: i16            // <-- AUD-200: signed two's-complement
 *   pub reason: u8
 *   pub old_score: u8
 *   pub new_score: u8
 *   pub timestamp: i64
 */
function encodeReputationDeltaProposed(args: {
  authority: PublicKey;
  delta: number;
  reason: number;
  oldScore: number;
  newScore: number;
  timestamp: number | bigint;
}): Buffer {
  return Buffer.concat([
    encPubkey(args.authority),
    encI16(args.delta),
    Buffer.from([args.reason]),
    Buffer.from([args.oldScore]),
    Buffer.from([args.newScore]),
    encI64(args.timestamp),
  ]);
}

function makeLog(discriminatorHex: string, payload: Buffer): string {
  const disc = Buffer.from(discriminatorHex, "hex");
  return `Program data: ${Buffer.concat([disc, payload]).toString("base64")}`;
}

describe("AUD-200: ReputationDeltaProposed.delta is decoded as i16", () => {
  it("decodes delta = -5 as -5 (not 65531)", () => {
    const authority = Keypair.generate().publicKey;
    const payload = encodeReputationDeltaProposed({
      authority,
      delta: -5,
      reason: 1,
      oldScore: 50,
      newScore: 45,
      timestamp: 1_700_000_000,
    });

    const events = parseLogsForEvents(
      [makeLog(DISC_REPUTATION_DELTA_PROPOSED, payload)],
      "registry",
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].name, "ReputationDeltaProposed");

    const data = events[0].data as Record<string, unknown>;
    assert.equal(data.authority, authority.toBase58());
    // Core AUD-200 assertion. Pre-fix the indexer reported 65531 here
    // because `r.u16()` reads readUInt16LE without sign-extension.
    assert.equal(data.delta, -5, `expected delta=-5, got ${String(data.delta)}`);
    assert.notEqual(data.delta, 65531, "delta still bit-aliased to unsigned (regression)");
    assert.equal(data.reason, 1);
    assert.equal(data.old_score, 50);
    assert.equal(data.new_score, 45);
    assert.equal(data.timestamp, 1_700_000_000);
  });

  it("round-trips the full i16 negative range without aliasing", () => {
    const authority = Keypair.generate().publicKey;
    // Boundary samples covering the negative half-line.
    const samples = [-1, -100, -32768];
    for (const delta of samples) {
      const payload = encodeReputationDeltaProposed({
        authority,
        delta,
        reason: 0,
        oldScore: 80,
        newScore: 80,
        timestamp: 0,
      });
      const events = parseLogsForEvents(
        [makeLog(DISC_REPUTATION_DELTA_PROPOSED, payload)],
        "registry",
      );
      assert.equal(events.length, 1);
      const data = events[0].data as Record<string, unknown>;
      assert.equal(
        data.delta,
        delta,
        `expected delta=${delta}, got ${String(data.delta)}`,
      );
    }
  });

  it("preserves positive i16 values unchanged", () => {
    const authority = Keypair.generate().publicKey;
    const samples = [0, 1, 100, 32767];
    for (const delta of samples) {
      const payload = encodeReputationDeltaProposed({
        authority,
        delta,
        reason: 0,
        oldScore: 0,
        newScore: 0,
        timestamp: 0,
      });
      const events = parseLogsForEvents(
        [makeLog(DISC_REPUTATION_DELTA_PROPOSED, payload)],
        "registry",
      );
      assert.equal(events.length, 1);
      const data = events[0].data as Record<string, unknown>;
      assert.equal(
        data.delta,
        delta,
        `expected delta=${delta}, got ${String(data.delta)}`,
      );
    }
  });
});
