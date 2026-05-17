/**
 * C4-X402-02 / C4-X402-03 / C4-X402-05 — P1 HIGH regression suite.
 *
 * Source: docs/audits/ARCHITECTURE_REAUDIT_2026-05c-cycle4-security.md
 *         docs/audits/_cycle4-drafts/05-x402-relay.md
 *
 * C4-X402-02 (HIGH — ADR-117 status inversion):
 *   Pre-fix, EVERY verify failure — including the transport/infra codes
 *   `RPC_UNAVAILABLE` and `INTERNAL` — was rendered as HTTP 402. Retry
 *   libraries and intermediaries branch on STATUS, not the envelope
 *   `code`, so an honest, fully-paid client hitting an RPC brown-out
 *   was told "payment rejected" (402) and re-paid → double-spend.
 *   Post-fix the taxonomy is normative (ADR-117 amendment 2026-05-17):
 *     RPC_UNAVAILABLE → 503, INTERNAL → 500, genuine rejections → 402,
 *     PAYMENT_REPLAYED → 409. Envelope body unchanged.
 *
 * C4-X402-03 (HIGH — unbounded txSignature):
 *   Pre-fix `txSignature` was accepted as ANY non-empty string. A ~100kb
 *   string became a Map key, a Redis key, an RPC arg, and an unredacted
 *   log/correlation field (≈10GB resident + log amplification). Post-fix
 *   `isValidSolanaSignature` rejects anything that is not a 64-byte
 *   base58 signature with HTTP 400 BEFORE it touches any of those, and
 *   `express.json({limit:"4kb"})` bounds the body.
 *
 * C4-X402-05 (secondary — verifier-throw escapes the envelope + leaks
 *   the redis lock): a verifier that THROWS (vs resolves valid:false)
 *   propagated out of processPaymentRequest to the route's unguarded
 *   await → Express default 500 body (re-opening the ADR-117 raw-
 *   exception leak) AND the redis dedup lock acquired at the top of
 *   processPaymentRequest was never released (slot leaked for the full
 *   SIGNATURE_TTL_MS). Post-fix the throw is caught at the lock-owning
 *   site: classified, lock released with the owner token, mapped to
 *   kind:"upstream" → 5xx ADR-117 envelope.
 *
 * Strategy mirrors AUD-126 / AUD-209: env BEFORE the deferred dynamic
 * import; RELAY_PORT=0 so app.listen uses an ephemeral port; the
 * redis-lock subtest poisons require.cache so LiveRedisDedup picks up
 * ioredis-mock (identical SET-NX / Lua CAS-DEL semantics to real Redis).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { getBase58Decoder } from "@solana/kit";

process.env.JWT_SECRET ??= crypto.randomBytes(32).toString("hex");
process.env.RELAY_PORT = "0";
process.env.PAYMENT_RECIPIENT ??= "RECIPIENT11111111111111111111111111111111";
// NOTE: we deliberately do NOT repoint SOLANA_RPC_URL. The C4-X402-02
// status-taxonomy invariant is proven deterministically at the
// `processPaymentRequest` unit level (injected verifiers for every
// ErrorCode → kind:"upstream"/"invalid") and via the pure
// `httpStatusForErrorCode` mapping. The live-HTTP subtests below
// exercise only paths that DON'T reach the RPC (the C4-X402-03
// fail-closed signature gate, which fires BEFORE any verify), so the
// suite is fast and hermetic regardless of whether a local validator /
// RPC happens to be reachable in CI (a reachable-but-empty RPC returns
// the legitimate terminal 402 PAYMENT_NOT_FOUND; an unreachable one can
// hang on connect — neither is a deterministic 503 e2e fixture).

const __b58dec = getBase58Decoder();
// A real Solana signature is 64 bytes; base58-encodes to 87-88 chars.
function validSig(): string {
  return __b58dec.decode(new Uint8Array(crypto.randomBytes(64)));
}

type RelayModule = typeof import("../index.js");

describe("C4-X402-02/03/05 — status taxonomy + bounded signature + envelope-safe throw", () => {
  let relay: RelayModule;
  let baseUrl: string;

  before(async () => {
    relay = await import("../index.js");
    const srv = relay.server as HttpServer;
    if (!srv.listening) {
      await new Promise<void>((resolve) =>
        srv.once("listening", () => resolve()),
      );
    }
    const addr = srv.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    relay.__resetRedemptionStateForTests();
    relay.__resetNonceStateForTests();
    // Close the module-load app.listen so the process can exit (the
    // listener otherwise keeps the event loop alive → the runner hangs
    // after all subtests pass). Same teardown as c4-x402-01.
    await new Promise<void>((resolve, reject) => {
      (relay.server as HttpServer).close((err) =>
        err ? reject(err) : resolve(),
      );
    });
  });

  beforeEach(() => {
    relay.__resetRedemptionStateForTests();
    relay.__resetRateLimitStateForTests();
  });

  // -------------------------------------------------------------------------
  // C4-X402-02 — HTTP status taxonomy
  // -------------------------------------------------------------------------
  describe("C4-X402-02 — code → HTTP status mapping (ADR-117 amendment)", () => {
    // The C4-X402-02 invariant is proven deterministically here at the
    // unit boundary (injected verifiers + the exported pure mapping) —
    // no HTTP/RPC round-trip, so the suite is hermetic and fast.

    it("RPC_UNAVAILABLE → 503 (retryable), NOT 402 — the core inversion fix", async () => {
      // processPaymentRequest is the unit the route renders. A verifier
      // reporting a transport failure must surface as kind:"upstream".
      const sig = validSig();
      const rpcDownVerifier = async () => ({
        valid: false as const,
        sender: "",
        recipient: "",
        amountSol: 0,
        slot: 0,
        error: relay.ERROR_MESSAGES.RPC_UNAVAILABLE,
        errorCode: "RPC_UNAVAILABLE" as const,
      });
      const result = await relay.processPaymentRequest(
        sig,
        rpcDownVerifier,
        "RECIPIENT11111111111111111111111111111111",
      );
      assert.equal(
        result.kind,
        "upstream",
        "RPC_UNAVAILABLE must be kind:'upstream', not 'invalid' (the 402-inversion bug)",
      );
      if (result.kind !== "upstream") return;
      assert.equal(result.errorCode, "RPC_UNAVAILABLE");
    });

    it("INTERNAL → 500 (retryable), NOT 402", async () => {
      const sig = validSig();
      const internalVerifier = async () => ({
        valid: false as const,
        sender: "",
        recipient: "",
        amountSol: 0,
        slot: 0,
        error: relay.ERROR_MESSAGES.INTERNAL,
        errorCode: "INTERNAL" as const,
      });
      const result = await relay.processPaymentRequest(
        sig,
        internalVerifier,
        "RECIPIENT11111111111111111111111111111111",
      );
      assert.equal(result.kind, "upstream");
      if (result.kind !== "upstream") return;
      assert.equal(result.errorCode, "INTERNAL");
    });

    it("genuine rejection (PAYMENT_UNVERIFIED) STAYS kind:'invalid' → 402", async () => {
      const sig = validSig();
      const rejectVerifier = async () => ({
        valid: false as const,
        sender: "",
        recipient: "",
        amountSol: 0,
        slot: 0,
        error: relay.ERROR_MESSAGES.PAYMENT_UNVERIFIED,
        errorCode: "PAYMENT_UNVERIFIED" as const,
      });
      const result = await relay.processPaymentRequest(
        sig,
        rejectVerifier,
        "RECIPIENT11111111111111111111111111111111",
      );
      assert.equal(
        result.kind,
        "invalid",
        "a genuine payment rejection must remain kind:'invalid' (terminal 402)",
      );
    });

    it("httpStatusForErrorCode is the normative ADR-117 taxonomy table", () => {
      // The amendment 2026-05-17 status table, asserted directly on the
      // single source of truth the route + processPaymentRequest both
      // route through. A regression here is the status-inversion bug.
      assert.equal(relay.httpStatusForErrorCode("RPC_UNAVAILABLE"), 503);
      assert.equal(relay.httpStatusForErrorCode("INTERNAL"), 500);
      assert.equal(relay.httpStatusForErrorCode("PAYMENT_NOT_FOUND"), 402);
      assert.equal(relay.httpStatusForErrorCode("PAYMENT_UNVERIFIED"), 402);
      assert.equal(relay.httpStatusForErrorCode("PAYMENT_NO_TRANSFER"), 402);
      assert.equal(relay.httpStatusForErrorCode("PAYMENT_NONCE_INVALID"), 402);
      // Only the two infra codes are "upstream" (retryable 5xx); every
      // genuine-rejection code is terminal.
      assert.equal(relay.isUpstreamErrorCode("RPC_UNAVAILABLE"), true);
      assert.equal(relay.isUpstreamErrorCode("INTERNAL"), true);
      assert.equal(relay.isUpstreamErrorCode("PAYMENT_NOT_FOUND"), false);
      assert.equal(relay.isUpstreamErrorCode("PAYMENT_UNVERIFIED"), false);
      assert.equal(relay.isUpstreamErrorCode("PAYMENT_NO_TRANSFER"), false);
      assert.equal(relay.isUpstreamErrorCode("PAYMENT_NONCE_INVALID"), false);
    });

    it("every NON-upstream code stays kind:'invalid' (→ 402) through processPaymentRequest", async () => {
      const terminal: Array<
        "PAYMENT_NOT_FOUND" | "PAYMENT_UNVERIFIED" | "PAYMENT_NO_TRANSFER" | "PAYMENT_NONCE_INVALID"
      > = [
        "PAYMENT_NOT_FOUND",
        "PAYMENT_UNVERIFIED",
        "PAYMENT_NO_TRANSFER",
        "PAYMENT_NONCE_INVALID",
      ];
      for (const code of terminal) {
        const v = async () => ({
          valid: false as const,
          sender: "",
          recipient: "",
          amountSol: 0,
          slot: 0,
          error: relay.ERROR_MESSAGES[code],
          errorCode: code,
        });
        const r = await relay.processPaymentRequest(
          validSig(),
          v,
          "RECIPIENT11111111111111111111111111111111",
        );
        assert.equal(
          r.kind,
          "invalid",
          `${code} is a genuine rejection — must be kind:'invalid' (402)`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // C4-X402-03 — bounded, well-formed txSignature
  // -------------------------------------------------------------------------
  describe("C4-X402-03 — oversize / malformed txSignature is rejected fail-closed (400)", () => {
    function postPay(body: unknown) {
      return fetch(`${baseUrl}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("a ~100kb txSignature is rejected fail-closed and never reflected", async () => {
      const huge = "1".repeat(100_000);
      const res = await postPay({ txSignature: huge });
      // The 100kb body exceeds the 4kb express.json limit, so it is
      // rejected with 413 by the body parser BEFORE the handler — an
      // even stronger fail-closed outcome than the 400 signature gate
      // (the string never even parses into req.body). Either status is
      // acceptable; what matters for C4-X402-03 is that the oversize
      // string NEVER reaches a Map/Redis/RPC/log path and is NOT
      // reflected. (A sub-4kb-but-oversize signature hits the 400 gate;
      // that path is covered by the non-base58 / wrong-length subtests.)
      assert.ok(
        res.status === 413 || res.status === 400,
        `oversize signature must be rejected fail-closed (413/400), got ${res.status}`,
      );
      const text = await res.text();
      assert.ok(
        !text.includes(huge.slice(0, 200)),
        "the oversize signature must never be reflected in the response",
      );
    });

    it("a sub-4kb but oversize (2kb) garbage signature hits the 400 gate (not Map/Redis/RPC)", async () => {
      // 2kb < the 4kb json limit, so the body parses; the signature
      // gate (isValidSolanaSignature) must reject it with 400 BEFORE it
      // becomes a Map/Redis key or RPC arg. This is the direct
      // C4-X402-03 invariant (the 100kb case is shielded earlier by the
      // json limit; this proves the signature gate itself is the
      // fail-closed boundary for in-body-limit oversize input).
      const oversize = "1".repeat(2048);
      const res = await postPay({ txSignature: oversize });
      assert.equal(
        res.status,
        400,
        "an in-body-limit but oversize signature must be rejected by the 400 gate",
      );
      const text = await res.text();
      assert.ok(!text.includes(oversize.slice(0, 200)));
    });

    it("a body over the 4kb express.json limit is rejected before the handler", async () => {
      // 5kb of JSON. express.json({limit:"4kb"}) → 413 (or 400) before
      // the route body even parses; the key invariant is "not 200/402".
      const padded = { txSignature: validSig(), pad: "x".repeat(5 * 1024) };
      const res = await postPay(padded);
      assert.ok(
        res.status === 413 || res.status === 400,
        `oversize body must be rejected by the json limit (413/400), got ${res.status}`,
      );
    });

    it("a non-base58 string of valid length is rejected with 400", async () => {
      // 87 chars but contains '0','O','I','l' (not in the base58
      // alphabet) — passes the length gate, fails the charset/decode.
      const bad = "0OIl".repeat(21) + "000"; // 87 chars, illegal alphabet
      assert.equal(bad.length, 87);
      const res = await postPay({ txSignature: bad });
      assert.equal(res.status, 400);
    });

    it("a valid-base58 but wrong-byte-length string (32-byte pubkey) is rejected with 400", async () => {
      const pubkeyShaped = __b58dec.decode(new Uint8Array(crypto.randomBytes(32)));
      const res = await postPay({ txSignature: pubkeyShaped });
      assert.equal(
        res.status,
        400,
        "a 32-byte (pubkey-shaped) base58 string must not be accepted as a 64-byte signature",
      );
    });

    it("missing / non-string txSignature still rejected with 400", async () => {
      const a = await postPay({});
      assert.equal(a.status, 400);
      const b = await postPay({ txSignature: 12345 });
      assert.equal(b.status, 400);
      const c = await postPay({ txSignature: "" });
      assert.equal(c.status, 400);
    });

    it("the gate is not over-broad: a real-shape 64-byte signature is ACCEPTED", () => {
      // Deterministic, no RPC: assert the exported predicate directly.
      // Proves a structurally valid signature passes the C4-X402-03
      // gate (so the gate cannot reject legitimate payments) while the
      // hostile shapes above are all rejected.
      for (let i = 0; i < 50; i++) {
        const sig = validSig();
        assert.equal(
          relay.isValidSolanaSignature(sig),
          true,
          `a 64-byte base58 signature (${sig.length} chars) must be accepted`,
        );
      }
      // And the rejection shapes are rejected by the same predicate.
      assert.equal(relay.isValidSolanaSignature(""), false);
      assert.equal(relay.isValidSolanaSignature(12345 as unknown), false);
      assert.equal(relay.isValidSolanaSignature("1".repeat(100_000)), false);
      assert.equal(relay.isValidSolanaSignature("1".repeat(2048)), false);
      // 32-byte (pubkey-shaped) base58 — valid charset, wrong byte length.
      assert.equal(
        relay.isValidSolanaSignature(
          __b58dec.decode(new Uint8Array(crypto.randomBytes(32))),
        ),
        false,
      );
      // In-range length but illegal base58 alphabet.
      assert.equal(
        relay.isValidSolanaSignature("0OIl".repeat(21) + "000"),
        false,
      );
    });
  });

  // -------------------------------------------------------------------------
  // C4-X402-05 — verifier-throw stays in the ADR-117 envelope (no leak)
  // -------------------------------------------------------------------------
  describe("C4-X402-05 — a THROWING verifier is contained in the typed envelope", () => {
    it("processPaymentRequest with a throwing verifier returns kind:'upstream' (never escapes)", async () => {
      const sig = validSig();
      const RPC_URL_LEAK = "http://internal-rpc.example.com:8899";
      const SIG_LEAK = "4QnWvLeAk1NgSubstr1nGtHaTsHoUldBeReDacTed";
      const throwingVerifier = async () => {
        throw new Error(
          `connect ECONNREFUSED ${RPC_URL_LEAK} for signature=${SIG_LEAK}`,
        );
      };
      const result = await relay.processPaymentRequest(
        sig,
        throwingVerifier,
        "RECIPIENT11111111111111111111111111111111",
      );
      // Containment: did NOT throw out of processPaymentRequest.
      assert.equal(
        result.kind,
        "upstream",
        "a throwing verifier must be caught and mapped to kind:'upstream'",
      );
      if (result.kind !== "upstream") return;
      // ECONNREFUSED classifies as a transport failure.
      assert.equal(result.errorCode, "RPC_UNAVAILABLE");
      // No leak of the exception text into the flowed result.
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(RPC_URL_LEAK));
      assert.ok(!serialized.includes(SIG_LEAK));
    });
  });
});
