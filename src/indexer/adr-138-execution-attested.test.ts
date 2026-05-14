/**
 * ADR-138: ExecutionAttested decoder + SQLite/PG projection.
 *
 * Pins the wire-layout decode contract for the on-chain event emitted by
 * every value-moving or authority-changing instruction in the
 * agent-vault program. Mirrors the AUD-200 pin pattern used for
 * ReputationDeltaProposed in `decoder.test.ts` so a future reorder of
 * the Rust `ActionKind` enum (positional borsh tag) or the
 * `ExecutionAttested` struct fields surfaces as a loud test failure
 * BEFORE it lands as silently mis-decoded historical data.
 *
 * Pure-unit test — no real RPC, no DB writes (the SQLite projection is
 * exercised separately by the indexer integration tests).
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { getAddressDecoder } from "@solana/kit";
import { parseLogsForEvents } from "./index";

const ADDRESS_DECODER = getAddressDecoder();

function fixturePubkey(): { bytes: Buffer; base58: string } {
  const bytes = crypto.randomBytes(32);
  const base58 = ADDRESS_DECODER.decode(bytes) as string;
  return { bytes, base58 };
}

const DISC_EXECUTION_ATTESTED = "6715b47fb9c66172";

function encU32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
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
function encArr32(fill: number): Buffer {
  return Buffer.alloc(32, fill);
}
function encOptionPubkey(bytes: Buffer | null): Buffer {
  if (bytes === null) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), bytes]);
}

/**
 * Encode the borsh wire layout for ExecutionAttested:
 *   pub vault: Pubkey
 *   pub agent_identity: Pubkey
 *   pub authority: Pubkey
 *   pub action_kind: ActionKind          // 1-byte positional enum tag
 *   pub tool_id: [u8; 32]
 *   pub manifest_hash: [u8; 32]
 *   pub policy_version: u32
 *   pub delegation_grant: Option<Pubkey>
 *   pub amount: u64
 *   pub mint: Option<Pubkey>
 *   pub recipient: Option<Pubkey>
 *   pub slot: u64
 *   pub timestamp: i64
 */
function encodeExecutionAttested(args: {
  vault: Buffer;
  agentIdentity: Buffer;
  authority: Buffer;
  actionKindTag: number;
  toolId: Buffer; // 32 bytes
  manifestHash: Buffer; // 32 bytes
  policyVersion: number;
  delegationGrant: Buffer | null;
  amount: bigint;
  mint: Buffer | null;
  recipient: Buffer | null;
  slot: bigint;
  timestamp: bigint | number;
}): Buffer {
  return Buffer.concat([
    args.vault,
    args.agentIdentity,
    args.authority,
    Buffer.from([args.actionKindTag]),
    args.toolId,
    args.manifestHash,
    encU32(args.policyVersion),
    encOptionPubkey(args.delegationGrant),
    encU64(args.amount),
    encOptionPubkey(args.mint),
    encOptionPubkey(args.recipient),
    encU64(args.slot),
    encI64(args.timestamp),
  ]);
}

function programDataLog(discHex: string, payload: Buffer): string {
  const disc = Buffer.from(discHex, "hex");
  const full = Buffer.concat([disc, payload]);
  return `Program data: ${full.toString("base64")}`;
}

describe("ADR-138: ExecutionAttested decoder", () => {
  it("round-trips a Transfer attestation with all Some(...) fields populated", () => {
    const vault = fixturePubkey();
    const agentIdentity = fixturePubkey();
    const authority = fixturePubkey();
    const grant = fixturePubkey();
    const mint = fixturePubkey();
    const recipient = fixturePubkey();

    const toolId = encArr32(0xab);
    const manifestHash = encArr32(0xcd);

    const payload = encodeExecutionAttested({
      vault: vault.bytes,
      agentIdentity: agentIdentity.bytes,
      authority: authority.bytes,
      actionKindTag: 0, // Transfer
      toolId,
      manifestHash,
      policyVersion: 7,
      delegationGrant: grant.bytes,
      amount: 1_000_000n,
      mint: mint.bytes,
      recipient: recipient.bytes,
      slot: 1_234_567n,
      timestamp: 1_700_000_000n,
    });

    const events = parseLogsForEvents(
      [programDataLog(DISC_EXECUTION_ATTESTED, payload)],
      "vault",
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].name, "ExecutionAttested");
    const d = events[0].data as Record<string, unknown>;
    assert.equal(d.vault, vault.base58);
    assert.equal(d.agent_identity, agentIdentity.base58);
    assert.equal(d.authority, authority.base58);
    assert.equal(d.action_kind, "Transfer");
    assert.equal(d.tool_id, toolId.toString("hex"));
    assert.equal(d.manifest_hash, manifestHash.toString("hex"));
    assert.equal(d.policy_version, 7);
    assert.equal(d.delegation_grant, grant.base58);
    assert.equal(d.amount, 1_000_000);
    assert.equal(d.mint, mint.base58);
    assert.equal(d.recipient, recipient.base58);
    assert.equal(d.slot, 1_234_567);
    assert.equal(d.timestamp, 1_700_000_000);
  });

  it("round-trips a PolicyUpdate attestation with all None fields and zero sentinels", () => {
    const vault = fixturePubkey();
    const agentIdentity = fixturePubkey();
    const authority = fixturePubkey();

    const payload = encodeExecutionAttested({
      vault: vault.bytes,
      agentIdentity: agentIdentity.bytes,
      authority: authority.bytes,
      actionKindTag: 2, // PolicyUpdate
      toolId: Buffer.alloc(32, 0),
      manifestHash: Buffer.alloc(32, 0),
      policyVersion: 1,
      delegationGrant: null,
      amount: 0n,
      mint: null,
      recipient: null,
      slot: 99n,
      timestamp: 1_700_000_000n,
    });

    const events = parseLogsForEvents(
      [programDataLog(DISC_EXECUTION_ATTESTED, payload)],
      "vault",
    );
    assert.equal(events.length, 1);
    const d = events[0].data as Record<string, unknown>;
    assert.equal(d.action_kind, "PolicyUpdate");
    assert.equal(d.tool_id, "0".repeat(64));
    assert.equal(d.manifest_hash, "0".repeat(64));
    assert.equal(d.delegation_grant, null);
    assert.equal(d.mint, null);
    assert.equal(d.recipient, null);
    assert.equal(d.amount, 0);
  });

  it("pins the ActionKind variant order against Rust declaration order", () => {
    // Iterate every tag and confirm the decoder emits the expected
    // string. A reorder of the Rust enum (silent-mis-classification
    // hazard) would fail one or more of these.
    const cases: Array<[number, string]> = [
      [0, "Transfer"],
      [1, "TokenTransfer"],
      [2, "PolicyUpdate"],
      [3, "AllowlistManage"],
      [4, "IdentityRotation"],
      [5, "PauseToggle"],
      [6, "GrantTransfer"],
      [7, "GrantTokenTransfer"],
    ];
    const vault = fixturePubkey();
    const agentIdentity = fixturePubkey();
    const authority = fixturePubkey();
    for (const [tag, expected] of cases) {
      const payload = encodeExecutionAttested({
        vault: vault.bytes,
        agentIdentity: agentIdentity.bytes,
        authority: authority.bytes,
        actionKindTag: tag,
        toolId: Buffer.alloc(32, 0),
        manifestHash: Buffer.alloc(32, 0),
        policyVersion: 0,
        delegationGrant: null,
        amount: 0n,
        mint: null,
        recipient: null,
        slot: 1n,
        timestamp: 1n,
      });
      const events = parseLogsForEvents(
        [programDataLog(DISC_EXECUTION_ATTESTED, payload)],
        "vault",
      );
      assert.equal(events.length, 1, `tag ${tag} -> single event`);
      const d = events[0].data as Record<string, unknown>;
      assert.equal(d.action_kind, expected, `tag ${tag} expected ${expected}`);
    }
  });

  it("falls back to Unknown(tag) for out-of-range ActionKind", () => {
    // A future Rust enum that adds a new variant ahead of an indexer
    // upgrade should surface as `Unknown(N)` rather than panic or
    // mis-classify. This is the forward-compat guarantee.
    const vault = fixturePubkey();
    const agentIdentity = fixturePubkey();
    const authority = fixturePubkey();
    const payload = encodeExecutionAttested({
      vault: vault.bytes,
      agentIdentity: agentIdentity.bytes,
      authority: authority.bytes,
      actionKindTag: 99,
      toolId: Buffer.alloc(32, 0),
      manifestHash: Buffer.alloc(32, 0),
      policyVersion: 0,
      delegationGrant: null,
      amount: 0n,
      mint: null,
      recipient: null,
      slot: 1n,
      timestamp: 1n,
    });
    const events = parseLogsForEvents(
      [programDataLog(DISC_EXECUTION_ATTESTED, payload)],
      "vault",
    );
    assert.equal(events.length, 1);
    const d = events[0].data as Record<string, unknown>;
    assert.equal(d.action_kind, "Unknown(99)");
  });
});
