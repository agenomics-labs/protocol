/**
 * ADR-082 / audit-2026-04-23 item 6: tests for the four newly-added
 * indexer event handlers.
 *
 * Runs under node:test + tsx. For each new event we:
 *   1. Borsh-encode a known fixture matching the Rust struct layout.
 *   2. Build a Solana log line containing the discriminator + payload.
 *   3. Feed it through parseLogsForEvents to verify field-level decode
 *      (no off-by-one in offsets).
 *   4. Persist via updateAgentFromEvent to verify the side-effect
 *      table receives the row with the expected shape.
 *
 * Encoder helpers mirror the existing test fixture in tests/indexer.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  initDb,
  parseLogsForEvents,
  updateAgentFromEvent,
} from "../src/indexer/index";

// --- Borsh wire-encoding helpers (mirror tests/indexer.test.ts). ---
function encU16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function encU64(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}
function encI64(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return b;
}
function encPubkey(pk: PublicKey): Buffer {
  return Buffer.from(pk.toBytes());
}
function encFixedBytes(hex: string, n: number): Buffer {
  const buf = Buffer.from(hex.padEnd(n * 2, "0"), "hex");
  if (buf.length !== n) {
    throw new Error(`encFixedBytes: bad length ${buf.length} != ${n}`);
  }
  return buf;
}
function makeLog(discriminatorHex: string, payload: Buffer): string {
  const disc = Buffer.from(discriminatorHex, "hex");
  return `Program data: ${Buffer.concat([disc, payload]).toString("base64")}`;
}

// Discriminators recorded here as constants — duplicated from
// DISCRIMINATOR_MAP intentionally so a refactor that breaks the map is
// caught by these tests, not silently masked.
const DISC_AGENT_IDENTITY_UPDATED = "aa69af3aa3095577";
const DISC_MANIFEST_UPDATED = "6941986a36affdb3";
const DISC_PROTOCOL_CONFIG_INITIALIZED = "f3451bee6fa957e7";
const DISC_PROTOCOL_CONFIG_UPDATED = "146320ed6f56c3c7";

// ============================================================================
// AgentIdentityUpdated (agent-vault, ADR-069)
// ============================================================================

test("AgentIdentityUpdated decodes vault / old_identity / new_identity", () => {
  const vault = Keypair.generate().publicKey;
  const oldIdentity = Keypair.generate().publicKey;
  const newIdentity = Keypair.generate().publicKey;
  const payload = Buffer.concat([
    encPubkey(vault),
    encPubkey(oldIdentity),
    encPubkey(newIdentity),
  ]);
  const events = parseLogsForEvents(
    [makeLog(DISC_AGENT_IDENTITY_UPDATED, payload)],
    "vault"
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "AgentIdentityUpdated");
  assert.equal(events[0].data.vault, vault.toBase58());
  assert.equal(events[0].data.old_identity, oldIdentity.toBase58());
  assert.equal(events[0].data.new_identity, newIdentity.toBase58());
});

test("AgentIdentityUpdated persists into vault_identity_history", () => {
  const db = initDb(":memory:");
  try {
    const vault = Keypair.generate().publicKey.toBase58();
    const oldId = Keypair.generate().publicKey.toBase58();
    const newId = Keypair.generate().publicKey.toBase58();
    updateAgentFromEvent(
      db,
      {
        name: "AgentIdentityUpdated",
        data: { vault, old_identity: oldId, new_identity: newId },
      },
      12345,
      "sigA"
    );
    const row = db
      .prepare("SELECT vault, old_identity, new_identity, slot, signature FROM vault_identity_history WHERE vault = ?")
      .get(vault) as Record<string, unknown>;
    assert.equal(row.vault, vault);
    assert.equal(row.old_identity, oldId);
    assert.equal(row.new_identity, newId);
    assert.equal(row.slot, 12345);
    assert.equal(row.signature, "sigA");
  } finally {
    db.close();
  }
});

test("AgentIdentityUpdated INSERT OR IGNORE prevents duplicate rows on backfill replay", () => {
  const db = initDb(":memory:");
  try {
    const vault = Keypair.generate().publicKey.toBase58();
    const oldId = Keypair.generate().publicKey.toBase58();
    const newId = Keypair.generate().publicKey.toBase58();
    const event = {
      name: "AgentIdentityUpdated",
      data: { vault, old_identity: oldId, new_identity: newId },
    };
    updateAgentFromEvent(db, event, 100, "dupSig");
    updateAgentFromEvent(db, event, 100, "dupSig"); // replay
    const rows = db
      .prepare("SELECT * FROM vault_identity_history WHERE vault = ?")
      .all(vault) as Record<string, unknown>[];
    assert.equal(rows.length, 1, "live + backfill replay must be idempotent");
  } finally {
    db.close();
  }
});

// ============================================================================
// ManifestUpdated (agent-registry, ADR-060)
// ============================================================================

test("ManifestUpdated decodes authority / cid / hash / version / timestamp", () => {
  const authority = Keypair.generate().publicKey;
  // Realistic CIDv1 string: "bafybeigdyrzt..." — we'll stuff hex bytes.
  const cidHex = "62616679626569" + "00".repeat(64 - 7); // "bafybei" + zero pad
  const hashHex = "deadbeef".repeat(8); // 32 bytes
  const payload = Buffer.concat([
    encPubkey(authority),
    encFixedBytes(cidHex, 64),
    encFixedBytes(hashHex, 32),
    encU16(7),
    encI64(1_700_000_042),
  ]);
  const events = parseLogsForEvents(
    [makeLog(DISC_MANIFEST_UPDATED, payload)],
    "registry"
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "ManifestUpdated");
  assert.equal(events[0].data.authority, authority.toBase58());
  assert.equal(events[0].data.manifest_cid, cidHex);
  assert.equal(events[0].data.manifest_hash, hashHex);
  assert.equal(events[0].data.manifest_version, 7);
  assert.equal(events[0].data.timestamp, 1_700_000_042);
});

test("ManifestUpdated persists into manifest_history with the full snapshot", () => {
  const db = initDb(":memory:");
  try {
    const authority = Keypair.generate().publicKey.toBase58();
    updateAgentFromEvent(
      db,
      {
        name: "ManifestUpdated",
        data: {
          authority,
          manifest_cid: "ab".repeat(64),
          manifest_hash: "cd".repeat(32),
          manifest_version: 3,
          timestamp: 1_700_000_000,
        },
      },
      9999,
      "sigManifest"
    );
    const row = db
      .prepare("SELECT * FROM manifest_history WHERE authority = ?")
      .get(authority) as Record<string, unknown>;
    assert.equal(row.authority, authority);
    assert.equal(row.manifest_cid, "ab".repeat(64));
    assert.equal(row.manifest_hash, "cd".repeat(32));
    assert.equal(row.manifest_version, 3);
    assert.equal(row.event_timestamp, 1_700_000_000);
    assert.equal(row.slot, 9999);
    assert.equal(row.signature, "sigManifest");
  } finally {
    db.close();
  }
});

test("ManifestUpdated decode fails cleanly on a truncated payload (no off-by-one)", () => {
  // A payload that's only authority + 60 bytes of CID (cut short).
  // The decoder should fail field-level but the classification is preserved.
  const authority = Keypair.generate().publicKey;
  const truncated = Buffer.concat([encPubkey(authority), Buffer.alloc(60, 0xff)]);
  const events = parseLogsForEvents(
    [makeLog(DISC_MANIFEST_UPDATED, truncated)],
    "registry"
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "ManifestUpdated");
  assert.ok(
    typeof events[0].data.decodeError === "string",
    "expected decodeError marker on truncated input"
  );
});

// ============================================================================
// ProtocolConfigInitialized (settlement)
// ============================================================================

test("ProtocolConfigInitialized decodes all six fields in declaration order", () => {
  const authority = Keypair.generate().publicKey;
  const payload = Buffer.concat([
    encPubkey(authority),
    encU64(1_000_000n),    // min_escrow_amount
    encI64(86400),         // dispute_timeout_seconds (1 day)
    encI64(10),            // reputation_delta_task_completed
    encI64(-15),           // reputation_delta_dispute_loss
    encI64(-5),            // reputation_delta_expiry_undelivered
  ]);
  const events = parseLogsForEvents(
    [makeLog(DISC_PROTOCOL_CONFIG_INITIALIZED, payload)],
    "settlement"
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "ProtocolConfigInitialized");
  assert.equal(events[0].data.authority, authority.toBase58());
  assert.equal(events[0].data.min_escrow_amount, 1_000_000);
  assert.equal(events[0].data.dispute_timeout_seconds, 86400);
  assert.equal(events[0].data.reputation_delta_task_completed, 10);
  assert.equal(events[0].data.reputation_delta_dispute_loss, -15);
  assert.equal(events[0].data.reputation_delta_expiry_undelivered, -5);
});

test("ProtocolConfigInitialized persists with kind='Initialized'", () => {
  const db = initDb(":memory:");
  try {
    const authority = Keypair.generate().publicKey.toBase58();
    updateAgentFromEvent(
      db,
      {
        name: "ProtocolConfigInitialized",
        data: {
          authority,
          min_escrow_amount: 500_000,
          dispute_timeout_seconds: 3600,
          reputation_delta_task_completed: 5,
          reputation_delta_dispute_loss: -10,
          reputation_delta_expiry_undelivered: -3,
        },
      },
      111,
      "sigInit"
    );
    const row = db
      .prepare("SELECT * FROM protocol_config_history WHERE signature = ?")
      .get("sigInit") as Record<string, unknown>;
    assert.equal(row.kind, "Initialized");
    assert.equal(row.authority, authority);
    assert.equal(row.min_escrow_amount, "500000");
    assert.equal(row.dispute_timeout_seconds, 3600);
    assert.equal(row.reputation_delta_task_completed, 5);
    assert.equal(row.reputation_delta_dispute_loss, -10);
    assert.equal(row.reputation_delta_expiry_undelivered, -3);
    assert.equal(row.slot, 111);
  } finally {
    db.close();
  }
});

// ============================================================================
// ProtocolConfigUpdated (settlement)
// ============================================================================

test("ProtocolConfigUpdated has the same wire layout as ProtocolConfigInitialized", () => {
  // Both decoders should accept identical payloads. Stage one, decode
  // both, assert equivalent shape. This is the regression that catches
  // any future field-order divergence between the two struct decoders.
  const authority = Keypair.generate().publicKey;
  const payload = Buffer.concat([
    encPubkey(authority),
    encU64(2_500_000n),
    encI64(7200),
    encI64(20),
    encI64(-25),
    encI64(-8),
  ]);
  const initEvents = parseLogsForEvents(
    [makeLog(DISC_PROTOCOL_CONFIG_INITIALIZED, payload)],
    "settlement"
  );
  const updEvents = parseLogsForEvents(
    [makeLog(DISC_PROTOCOL_CONFIG_UPDATED, payload)],
    "settlement"
  );
  assert.equal(initEvents.length, 1);
  assert.equal(updEvents.length, 1);
  assert.deepEqual(
    { ...updEvents[0].data },
    { ...initEvents[0].data },
    "Initialized and Updated must decode identically (same wire layout)"
  );
});

test("ProtocolConfigUpdated persists with kind='Updated' and supports successive deltas", () => {
  const db = initDb(":memory:");
  try {
    const authority = Keypair.generate().publicKey.toBase58();
    // Initial.
    updateAgentFromEvent(
      db,
      {
        name: "ProtocolConfigInitialized",
        data: {
          authority,
          min_escrow_amount: 100_000,
          dispute_timeout_seconds: 3600,
          reputation_delta_task_completed: 1,
          reputation_delta_dispute_loss: -1,
          reputation_delta_expiry_undelivered: -1,
        },
      },
      1,
      "sigA"
    );
    // First update.
    updateAgentFromEvent(
      db,
      {
        name: "ProtocolConfigUpdated",
        data: {
          authority,
          min_escrow_amount: 200_000,
          dispute_timeout_seconds: 7200,
          reputation_delta_task_completed: 2,
          reputation_delta_dispute_loss: -2,
          reputation_delta_expiry_undelivered: -2,
        },
      },
      2,
      "sigB"
    );
    // Second update.
    updateAgentFromEvent(
      db,
      {
        name: "ProtocolConfigUpdated",
        data: {
          authority,
          min_escrow_amount: 300_000,
          dispute_timeout_seconds: 14400,
          reputation_delta_task_completed: 3,
          reputation_delta_dispute_loss: -3,
          reputation_delta_expiry_undelivered: -3,
        },
      },
      3,
      "sigC"
    );

    const rows = db
      .prepare("SELECT kind, min_escrow_amount, slot FROM protocol_config_history ORDER BY slot ASC")
      .all() as Array<{ kind: string; min_escrow_amount: string; slot: number }>;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].kind, "Initialized");
    assert.equal(rows[0].min_escrow_amount, "100000");
    assert.equal(rows[1].kind, "Updated");
    assert.equal(rows[1].min_escrow_amount, "200000");
    assert.equal(rows[2].kind, "Updated");
    assert.equal(rows[2].min_escrow_amount, "300000");
  } finally {
    db.close();
  }
});

test("ProtocolConfig u64 string round-trips losslessly for out-of-safe-integer values", () => {
  const db = initDb(":memory:");
  try {
    const authority = Keypair.generate().publicKey.toBase58();
    // 2^53 + 1 — first integer that loses precision as JS number.
    const big = "9007199254740993";
    updateAgentFromEvent(
      db,
      {
        name: "ProtocolConfigInitialized",
        data: {
          authority,
          min_escrow_amount: big,
          dispute_timeout_seconds: 0,
          reputation_delta_task_completed: 0,
          reputation_delta_dispute_loss: 0,
          reputation_delta_expiry_undelivered: 0,
        },
      },
      1,
      "sigBig"
    );
    const row = db
      .prepare("SELECT min_escrow_amount FROM protocol_config_history WHERE signature = ?")
      .get("sigBig") as { min_escrow_amount: string };
    assert.equal(row.min_escrow_amount, big);
  } finally {
    db.close();
  }
});

// ============================================================================
// End-to-end: every new discriminator hits a working decoder
// ============================================================================

test("every newly-added discriminator round-trips through parseLogsForEvents without 'event_<hex>' fallback", () => {
  // Build trivially-valid payloads (variable-length where possible)
  // and assert each is classified with its proper name, not the
  // event_<hex> fallback. This is the simplest possible smoke test
  // that the DISCRIMINATOR_MAP wiring is intact.
  const cases: Array<{ disc: string; expected: string; payload: Buffer }> = [
    {
      disc: DISC_AGENT_IDENTITY_UPDATED,
      expected: "AgentIdentityUpdated",
      payload: Buffer.concat([
        encPubkey(Keypair.generate().publicKey),
        encPubkey(Keypair.generate().publicKey),
        encPubkey(Keypair.generate().publicKey),
      ]),
    },
    {
      disc: DISC_MANIFEST_UPDATED,
      expected: "ManifestUpdated",
      payload: Buffer.concat([
        encPubkey(Keypair.generate().publicKey),
        Buffer.alloc(64, 0),
        Buffer.alloc(32, 0),
        encU16(1),
        encI64(0),
      ]),
    },
    {
      disc: DISC_PROTOCOL_CONFIG_INITIALIZED,
      expected: "ProtocolConfigInitialized",
      payload: Buffer.concat([
        encPubkey(Keypair.generate().publicKey),
        encU64(0),
        encI64(0),
        encI64(0),
        encI64(0),
        encI64(0),
      ]),
    },
    {
      disc: DISC_PROTOCOL_CONFIG_UPDATED,
      expected: "ProtocolConfigUpdated",
      payload: Buffer.concat([
        encPubkey(Keypair.generate().publicKey),
        encU64(0),
        encI64(0),
        encI64(0),
        encI64(0),
        encI64(0),
      ]),
    },
  ];
  for (const { disc, expected, payload } of cases) {
    const events = parseLogsForEvents([makeLog(disc, payload)], "test");
    assert.equal(events.length, 1, `${expected}: expected 1 event`);
    assert.equal(events[0].name, expected, `${expected}: classified as ${events[0].name}`);
    assert.ok(
      !("decodeError" in events[0].data),
      `${expected}: decoder should succeed on a valid payload, got ${JSON.stringify(events[0].data)}`
    );
  }
});
