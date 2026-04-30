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

// ---------------------------------------------------------------------------
// ADR-131 byte-layout pins for the settlement-side decoders added in the
// same wiring pass. The wire formats are sourced from
// `programs/settlement/src/events.rs` and re-asserted here so a future
// struct re-order, field rename, or accidental field deletion fails the
// test rather than silently producing mis-decoded events downstream.
//
// Pre-existing tech debt (per Agent B's report on the indexer wiring):
// no decoder unit tests existed for any of the three settlement events
// before this change. Adding them now closes the gap that ADR-082's
// discriminator-only coverage gate cannot catch (see scripts/check-event-
// coverage.ts header for the ADR-082 field-coverage limitation).
// ---------------------------------------------------------------------------

const DISC_ESCROW_CREATED   = "467f69665c6107ad";
const DISC_DISPUTE_RESOLVED = "7940f9998b80ecbb";
const DISC_DISPUTE_RAISED   = "f6a76d258e2d26b0";

function encU32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}
function encU64(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

describe("ADR-131: EscrowCreated decoder pins token_mint at the tail", () => {
  it("decodes all 8 fields including the ADR-131 token_mint", () => {
    const escrow      = Keypair.generate().publicKey;
    const client      = Keypair.generate().publicKey;
    const provider    = Keypair.generate().publicKey;
    const tokenMint   = Keypair.generate().publicKey;

    // Wire layout from programs/settlement/src/events.rs::EscrowCreated.
    // token_mint is the LAST field — appended in the ADR-131 wiring pass
    // to preserve the binary layout of the seven existing fields.
    const payload = Buffer.concat([
      encPubkey(escrow),
      encPubkey(client),
      encPubkey(provider),
      encU64(42),                  // task_id
      encU64(1_000_000),           // total_amount (1 USDC)
      encI64(1_700_000_000),       // deadline
      encU32(3),                   // milestone_count
      encPubkey(tokenMint),        // ADR-131
    ]);

    const events = parseLogsForEvents(
      [makeLog(DISC_ESCROW_CREATED, payload)],
      "settlement",
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].name, "EscrowCreated");

    const data = events[0].data as Record<string, unknown>;
    assert.equal(data.escrow,          escrow.toBase58());
    assert.equal(data.client,          client.toBase58());
    assert.equal(data.provider,        provider.toBase58());
    assert.equal(data.task_id,         42);
    assert.equal(data.total_amount,    1_000_000);
    assert.equal(data.deadline,        1_700_000_000);
    assert.equal(data.milestone_count, 3);
    // The load-bearing assertion: the trailing token_mint MUST decode
    // to the right pubkey. ADR-131's median-escrow trigger metric is
    // bucketed by this field; if it ever stops being decoded the
    // dashboard's "Median Escrow (30d)" card silently aggregates
    // SOL + USDC into a single meaningless number.
    assert.equal(
      data.token_mint,
      tokenMint.toBase58(),
      "token_mint failed to decode at byte offset 32+32+32+8+8+8+4 = 124",
    );
  });
});

describe("ADR-131: DisputeResolved decoder pins refund-split layout", () => {
  it("decodes all 5 fields in declaration order", () => {
    const escrow   = Keypair.generate().publicKey;
    const resolver = Keypair.generate().publicKey;

    // Wire layout from programs/settlement/src/events.rs::DisputeResolved.
    const payload = Buffer.concat([
      encPubkey(escrow),
      encPubkey(resolver),
      encU64(750_000),    // client_refund
      encU64(250_000),    // provider_refund
      encU64(99),         // task_id
    ]);

    const events = parseLogsForEvents(
      [makeLog(DISC_DISPUTE_RESOLVED, payload)],
      "settlement",
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].name, "DisputeResolved");

    const data = events[0].data as Record<string, unknown>;
    assert.equal(data.escrow,          escrow.toBase58());
    assert.equal(data.resolver,        resolver.toBase58());
    // The refund-split fields are the input to vw_dispute_resolved's
    // winner_side derivation (Client/Provider/Split/Unknown). If the
    // u64 byte-order ever flips, the cluster trigger view aggregates
    // wrong-side counts.
    assert.equal(data.client_refund,   750_000);
    assert.equal(data.provider_refund, 250_000);
    assert.equal(data.task_id,         99);
  });
});

describe("ADR-131: DisputeRaised decoder pins 3-field shape", () => {
  it("decodes escrow, requester, task_id", () => {
    const escrow    = Keypair.generate().publicKey;
    const requester = Keypair.generate().publicKey;

    const payload = Buffer.concat([
      encPubkey(escrow),
      encPubkey(requester),
      encU64(7),
    ]);

    const events = parseLogsForEvents(
      [makeLog(DISC_DISPUTE_RAISED, payload)],
      "settlement",
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].name, "DisputeRaised");

    const data = events[0].data as Record<string, unknown>;
    assert.equal(data.escrow,    escrow.toBase58());
    assert.equal(data.requester, requester.toBase58());
    assert.equal(data.task_id,   7);
  });
});
