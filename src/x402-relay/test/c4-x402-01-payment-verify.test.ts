/**
 * C4-X402-01 — payment-verification spoofing (CRITICAL) regression test.
 *
 * THE BUG (pre-fix `verifyPaymentOnChain`, src/x402-relay/index.ts):
 * payment validity was computed from `postBalances[recipientIndex] -
 * preBalances[recipientIndex]`. That delta rises for ANY reason the
 * recipient's lamports went up in the transaction — a third party paying
 * the recipient, a rent top-up, a bundled/CPI credit, an unrelated
 * transfer in a multi-instruction tx. Because `txSignature` is
 * unauthenticated client input, an attacker could submit ANY finalized
 * signature where the recipient balance happened to rise >= threshold and
 * mint a valid JWT, with `sender` bound to `accountKeys[0]` (the fee
 * payer, not necessarily the payer). No caller<->payer binding existed,
 * so a third party's genuine payment was replayable by anyone.
 *
 * THE FIX (this module):
 *   1. Decode the tx's compiled instructions; require an EXPLICIT
 *      SystemProgram::Transfer (or SPL Transfer/TransferChecked) FROM a
 *      single source TO the configured recipient for >= the required
 *      amount. Never infer from balance deltas. Reject multi-source /
 *      ambiguous cases. Bind JWT `sender` to the transfer's source.
 *   2. Require a relay-issued single-use nonce in an SPL-Memo
 *      instruction (caller<->payer binding). Issued by /challenge,
 *      consumed exactly once via the AUD-208/209/ADR-126 replay infra.
 *
 * What this pins (all driven against the pure exported helpers — no
 * validator, no RPC, deterministic):
 *
 *   - spoofed third-party-credit (no transfer to us) -> rejected
 *   - bundled-tx credit (transfer to someone else, recipient credited via
 *     an unrelated instruction) -> rejected
 *   - balance-delta-only (no explicit transfer instruction at all) ->
 *     rejected
 *   - multi-source ambiguous (two distinct payers) -> rejected
 *   - missing nonce -> rejected
 *   - already-consumed nonce (replay) -> rejected
 *   - legitimate single-source transfer + valid fresh nonce -> accepted,
 *     sender bound to the transfer SOURCE (not accountKeys[0])
 *
 * Strategy: `extractTransfersAndMemos` + `selectPayingSource` are pure
 * functions of (accountKeys, compiledInstructions, recipient). We
 * construct synthetic compiled instructions with hand-built base58 data
 * matching the on-chain SystemProgram / SPL / Memo layouts, exactly as
 * `getTransaction(encoding:"json")` would surface them. The nonce gate
 * (`issuePaymentNonce` / `consumePaymentNonce`) is driven directly. This
 * mirrors the AUD-209 strategy: exercise the lower-level invariant the
 * route handler maps onto HTTP, without standing up a validator.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import type { Server } from "node:http";
import { getBase58Decoder } from "@solana/kit";

// Module-load env (same discipline as the AUD-209 suite): JWT_SECRET for
// the AUD-027 gate, RELAY_PORT=0 so the listen() side-effect uses an
// ephemeral port, PAYMENT_RECIPIENT non-empty.
process.env.JWT_SECRET ??= crypto.randomBytes(32).toString("hex");
process.env.RELAY_PORT = "0";
process.env.PAYMENT_RECIPIENT ??= "RECIPIENT11111111111111111111111111111111";

const b58 = getBase58Decoder();
const toB58 = (bytes: number[]): string =>
  b58.decode(new Uint8Array(bytes));

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// Build the 12-byte SystemProgram::Transfer data: u32 LE discriminator
// (2) + u64 LE lamports.
function systemTransferData(lamports: bigint): string {
  const buf = Buffer.alloc(12);
  buf.writeUInt32LE(2, 0);
  buf.writeBigUInt64LE(lamports, 4);
  return toB58(Array.from(buf));
}

// SPL Token Transfer data: [tag=3 u8][amount u64 LE].
function splTransferData(amount: bigint): string {
  const buf = Buffer.alloc(9);
  buf.writeUInt8(3, 0);
  buf.writeBigUInt64LE(amount, 1);
  return toB58(Array.from(buf));
}

function memoData(text: string): string {
  return toB58(Array.from(Buffer.from(text, "utf-8")));
}

type RelayModule = typeof import("../index.js");
let relay: RelayModule;

const RECIPIENT = "RECIPIENT11111111111111111111111111111111";
const PAYER = "PAYER1111111111111111111111111111111111111";
const FEE_PAYER = "FEEPAYER111111111111111111111111111111111";
const OTHER = "OTHER1111111111111111111111111111111111111";
const SECOND_PAYER = "PAYER2222222222222222222222222222222222222";
const MIN_LAMPORTS = 10_000_000n; // 0.01 SOL

describe("C4-X402-01: payment-verification spoofing", () => {
  before(async () => {
    relay = await import("../index.js");
  });

  after(async () => {
    // Importing index.ts runs `app.listen(...)` at module load. Close the
    // listener so node:test exits cleanly (mirrors the AUD-209 suite).
    relay.__resetNonceStateForTests();
    await new Promise<void>((resolve, reject) => {
      (relay.server as Server).close((err) =>
        err ? reject(err) : resolve(),
      );
    });
  });

  beforeEach(() => {
    relay.__resetNonceStateForTests();
  });

  it("rejects a spoofed third-party credit: no transfer instruction TO us", () => {
    // Recipient appears in accountKeys (its balance rose, as the
    // pre-fix delta check would have observed) but there is NO explicit
    // SystemProgram transfer whose destination is the recipient. This is
    // the core spoof: an attacker submits any finalized sig where our
    // balance happened to rise.
    const accountKeys = [FEE_PAYER, PAYER, OTHER, RECIPIENT, SYSTEM_PROGRAM_ID];
    const instructions = [
      // A transfer FROM payer TO OTHER (not us). Recipient is only a
      // passive account whose balance the runtime credited elsewhere
      // (rent, CPI) — invisible at the instruction layer.
      {
        programIdIndex: 4,
        accounts: [1, 2],
        data: systemTransferData(50_000_000n),
      },
    ];
    const { transfers } = relay.extractTransfersAndMemos(
      accountKeys,
      instructions,
      RECIPIENT,
    );
    assert.equal(
      transfers.length,
      0,
      "no transfer should be attributed to the recipient",
    );
    const picked = relay.selectPayingSource(transfers, MIN_LAMPORTS);
    assert.equal(picked.ok, false, "spoofed credit must be rejected");
  });

  it("rejects a bundled-tx: transfer to someone else in a multi-ix tx", () => {
    const accountKeys = [
      FEE_PAYER,
      PAYER,
      OTHER,
      RECIPIENT,
      SYSTEM_PROGRAM_ID,
    ];
    const instructions = [
      // ix0: legit-looking transfer but destination is OTHER.
      { programIdIndex: 4, accounts: [1, 2], data: systemTransferData(99_000_000n) },
      // ix1: a transfer to RECIPIENT but BELOW threshold (e.g. dust /
      // rent), which the balance-delta bug would have summed into the
      // recipient's credit alongside unrelated movement.
      { programIdIndex: 4, accounts: [1, 3], data: systemTransferData(1n) },
    ];
    const { transfers } = relay.extractTransfersAndMemos(
      accountKeys,
      instructions,
      RECIPIENT,
    );
    // Only the 1-lamport transfer is attributed to us; it is below
    // threshold so selection must fail (we never sum across instructions
    // or infer from deltas).
    const picked = relay.selectPayingSource(transfers, MIN_LAMPORTS);
    assert.equal(
      picked.ok,
      false,
      "below-threshold bundled credit must be rejected",
    );
  });

  it("rejects balance-delta-only: zero instructions touch the recipient", () => {
    const accountKeys = [FEE_PAYER, PAYER, RECIPIENT];
    // An empty instruction list: the pre-fix code would still have
    // computed postBalance-preBalance and could pass. The fix has no
    // instruction to decode, so nothing is attributed.
    const { transfers } = relay.extractTransfersAndMemos(
      accountKeys,
      [],
      RECIPIENT,
    );
    assert.equal(transfers.length, 0);
    assert.equal(
      relay.selectPayingSource(transfers, MIN_LAMPORTS).ok,
      false,
    );
  });

  it("rejects a multi-source ambiguous payment (two distinct payers)", () => {
    const accountKeys = [
      FEE_PAYER,
      PAYER,
      SECOND_PAYER,
      RECIPIENT,
      SYSTEM_PROGRAM_ID,
    ];
    const instructions = [
      { programIdIndex: 4, accounts: [1, 3], data: systemTransferData(20_000_000n) },
      { programIdIndex: 4, accounts: [2, 3], data: systemTransferData(20_000_000n) },
    ];
    const { transfers } = relay.extractTransfersAndMemos(
      accountKeys,
      instructions,
      RECIPIENT,
    );
    assert.equal(transfers.length, 2, "both transfers target the recipient");
    const picked = relay.selectPayingSource(transfers, MIN_LAMPORTS);
    assert.equal(
      picked.ok,
      false,
      "ambiguous multi-source payment must be rejected (cannot bind a single sender)",
    );
  });

  it("accepts a legitimate single-source transfer and binds sender to the SOURCE (not accountKeys[0])", () => {
    const accountKeys = [
      FEE_PAYER, // accountKeys[0] — the pre-fix code mis-bound sender here
      PAYER,
      RECIPIENT,
      SYSTEM_PROGRAM_ID,
    ];
    const instructions = [
      { programIdIndex: 3, accounts: [1, 2], data: systemTransferData(15_000_000n) },
    ];
    const { transfers } = relay.extractTransfersAndMemos(
      accountKeys,
      instructions,
      RECIPIENT,
    );
    const picked = relay.selectPayingSource(transfers, MIN_LAMPORTS);
    assert.equal(picked.ok, true, "valid payment must be accepted");
    if (picked.ok) {
      assert.equal(
        picked.source,
        PAYER,
        "sender must be the transfer SOURCE, never the fee payer",
      );
      assert.notEqual(
        picked.source,
        FEE_PAYER,
        "regression: sender must NOT be accountKeys[0]",
      );
      assert.equal(picked.amountRaw, 15_000_000n);
    }
  });

  it("attributes an SPL-token transfer's owner as the sender", () => {
    const SRC_ATA = "SRCATA11111111111111111111111111111111111";
    const DST_ATA = RECIPIENT; // configured recipient is the dest ATA
    const accountKeys = [
      FEE_PAYER,
      SRC_ATA,
      DST_ATA,
      PAYER, // owner / authority
      SPL_TOKEN_PROGRAM_ID,
    ];
    const instructions = [
      { programIdIndex: 4, accounts: [1, 2, 3], data: splTransferData(25_000_000n) },
    ];
    const { transfers } = relay.extractTransfersAndMemos(
      accountKeys,
      instructions,
      RECIPIENT,
    );
    const picked = relay.selectPayingSource(transfers, MIN_LAMPORTS);
    assert.equal(picked.ok, true);
    if (picked.ok) {
      assert.equal(
        picked.source,
        PAYER,
        "SPL sender must be the transfer authority (owner), not the token account",
      );
    }
  });

  it("nonce gate: missing nonce memo is rejected", async () => {
    const ok = await relay.consumePaymentNonce([]);
    assert.equal(ok, false, "no memo => no caller<->payer binding => reject");
  });

  it("nonce gate: unrelated memo text is rejected", async () => {
    const ok = await relay.consumePaymentNonce(["hello world", "gm"]);
    assert.equal(ok, false);
  });

  it("nonce gate: a relay-issued nonce is accepted exactly once (single-use)", async () => {
    const issued = relay.issuePaymentNonce();
    assert.ok("nonce" in issued, "relay should issue a nonce");
    const nonce = (issued as { nonce: string }).nonce;
    assert.ok(nonce.startsWith("aep-x402:"));

    // First consume: accepted.
    assert.equal(await relay.consumePaymentNonce([nonce]), true);
    // Replay of the SAME nonce (e.g. third party replays the genuine
    // payment tx): rejected — it was burned on first use.
    assert.equal(
      await relay.consumePaymentNonce([nonce]),
      false,
      "single-use: a consumed nonce must not be accepted again",
    );
  });

  it("nonce gate: a forged 'aep-x402:' memo not issued by the relay is rejected", async () => {
    const forged = `aep-x402:${crypto.randomBytes(16).toString("hex")}`;
    assert.equal(
      await relay.consumePaymentNonce([forged]),
      false,
      "a nonce-shaped string the relay never issued must be rejected",
    );
  });

  it("end-to-end pure path: valid transfer + valid memo nonce, then replay rejected", async () => {
    const issued = relay.issuePaymentNonce();
    const nonce = (issued as { nonce: string }).nonce;

    const accountKeys = [
      FEE_PAYER,
      PAYER,
      RECIPIENT,
      SYSTEM_PROGRAM_ID,
      MEMO_PROGRAM_ID,
    ];
    const instructions = [
      { programIdIndex: 3, accounts: [1, 2], data: systemTransferData(12_000_000n) },
      { programIdIndex: 4, accounts: [], data: memoData(nonce) },
    ];
    const { transfers, memos } = relay.extractTransfersAndMemos(
      accountKeys,
      instructions,
      RECIPIENT,
    );
    const picked = relay.selectPayingSource(transfers, MIN_LAMPORTS);
    assert.equal(picked.ok, true);
    if (picked.ok) assert.equal(picked.source, PAYER);
    assert.deepEqual(memos, [nonce], "memo must decode back to the nonce");

    // First redemption consumes the nonce.
    assert.equal(await relay.consumePaymentNonce(memos), true);
    // Replaying the identical tx (same memo) is now rejected — the
    // caller<->payer binding is single-use.
    assert.equal(await relay.consumePaymentNonce(memos), false);
  });
});
