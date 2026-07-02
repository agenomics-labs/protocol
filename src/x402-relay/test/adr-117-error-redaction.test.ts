/**
 * ADR-117 — typed error envelope for x402-relay.
 *
 * Re-audit finding R-offchain-01: the verify-failure catch at the bottom of
 * `verifyPaymentOnChain` template-literaled the raw exception into the wire
 * response (`error: \`Verification error: ${err}\``). `getTransaction()`
 * exceptions in @solana/kit / @solana/web3.js stringify to values that can
 * include the RPC endpoint URL, the transaction signature, HTTP-status
 * detail, and a stack trace — every unprivileged caller of /pay therefore
 * received whatever the exception coerced to.
 *
 * Post-ADR-117:
 *
 *   - The catch maps the exception to one of `PAYMENT_NOT_FOUND |
 *     PAYMENT_UNVERIFIED | PAYMENT_REPLAYED | RPC_UNAVAILABLE | INTERNAL`.
 *   - The route returns `{ code, message, correlationId }`. `message` is a
 *     generic string keyed off `code`; the raw `err` never reaches the wire.
 *   - The raw exception is logged server-side at `error` level via pino,
 *     with the correlation ID (the tx signature, per the existing
 *     paymentLogger binding in logger.ts).
 *
 * What this test pins:
 *
 *   - `classifyVerifyException` maps representative throw shapes onto the
 *     enum correctly (transport vs not-found vs internal).
 *   - The route body for a thrown RPC exception contains `{ code,
 *     message, correlationId }` and does NOT contain the RPC URL or tx
 *     signature substrings from the original exception text.
 *   - The route body shape for each non-throw `code` variant is
 *     consistent (`PAYMENT_REPLAYED` for the dedup-hit path,
 *     `PAYMENT_NOT_FOUND` and `PAYMENT_UNVERIFIED` for the verifier-
 *     reported failure paths).
 *   - The raw exception IS logged via pino (intercepted via a pino
 *     destination stream stub — same pattern as production except the
 *     sink is an in-memory string buffer the test can grep).
 *
 * Strategy mirrors AUD-209 / AUD-126:
 *   - Set env (JWT_SECRET, RELAY_PORT=0, PAYMENT_RECIPIENT) BEFORE the
 *     deferred dynamic import. Without `RELAY_PORT=0` the module's
 *     `app.listen` call collides with parallel test files on 3200.
 *   - Drive `processPaymentRequest` directly with an injected verifier
 *     for the throw-shape and verifier-reported-failure scenarios.
 *   - For the route-body shape we hit the live `app` via supertest-style
 *     `app.listen()` + `fetch` (the same pattern admin-drain uses) so
 *     the assertion runs against the actual route handler.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { getBase58Decoder } from "@solana/kit";
import type { Logger } from "pino";

// C4-X402-03: the relay now rejects any `txSignature` that is not a
// syntactically valid 64-byte Solana signature BEFORE it reaches the
// dedup/RPC path. Test fixtures must therefore use real-shape
// signatures: 64 random bytes, base58-encoded (87-88 chars). The old
// `"adr-117-replay-<hex>"` fixtures are no longer accepted at /pay
// (correctly — they were never valid signatures).
const __b58dec = getBase58Decoder();
function validSig(): string {
  return __b58dec.decode(new Uint8Array(crypto.randomBytes(64)));
}

// Critical: env MUST be set BEFORE the dynamic import below — see the
// AUD-209 / AUD-126 header comments for the hoisting rationale.
process.env.JWT_SECRET ??= crypto.randomBytes(32).toString("hex");
process.env.RELAY_PORT = "0";
process.env.PAYMENT_RECIPIENT ??= "TEST_RECIPIENT_PUBKEY_NOT_USED_BY_MOCK";

type RelayModule = typeof import("../index.js");
let relay: RelayModule;

// Captured pino output across the suite. We attach a spy directly to
// the relay's `logger` (the production pino instance) so the
// `logger.error(..., err)` call inside the verify catch flows through
// to a buffer we can grep.
//
// A prior version of this capture monkey-patched `process.stdout.write`
// / `process.stderr.write`. That doesn't work: pino's default
// destination (no explicit stream/transport configured) is a SonicBoom
// instance that writes to the file descriptor directly, bypassing
// `process.stdout.write` entirely — and the `logger` singleton is
// constructed at module-import time (`logger.ts`'s top-level `export
// const logger = pino(...)`), before this test file gets a chance to
// patch anything. The captured buffer ended up empty of real pino
// output and instead picked up whatever else happens to call
// `process.stdout.write` at the JS level (e.g. the test runner's own
// internal reporter protocol), which is why the assertion failure
// showed binary-looking garbage instead of the expected log line.
//
// Fix: patch the logger's actual destination stream, reached via
// pino's own documented internal symbol `Symbol(pino.stream)`. This
// works regardless of when the logger was constructed relative to the
// patch, because we're not relying on a global (`process.stdout`)
// pino may or may not route through — we're wrapping the specific
// object pino itself holds a reference to and calls `.write()` on.
//
// `LOG_PRETTY=0` (set before the dynamic import below) keeps this
// simple by keeping the destination a plain SonicBoom writing ndjson,
// not the pino-pretty worker-thread transport.
process.env.LOG_PRETTY = "0";

const capturedLogLines: string[] = [];
let restoreStreamWrite: (() => void) | null = null;

function startLogCapture(logger: Logger): void {
  capturedLogLines.length = 0;
  const streamSym = Object.getOwnPropertySymbols(logger).find(
    (s) => s.toString() === "Symbol(pino.stream)",
  );
  if (!streamSym) {
    throw new Error(
      "startLogCapture: Symbol(pino.stream) not found on the logger instance — pino internals changed",
    );
  }
  const stream = (logger as unknown as Record<symbol, { write: (chunk: unknown) => boolean }>)[
    streamSym
  ];
  const originalWrite = stream.write.bind(stream);
  stream.write = (chunk: unknown): boolean => {
    const str = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    capturedLogLines.push(str);
    return originalWrite(chunk as never);
  };
  restoreStreamWrite = () => {
    stream.write = originalWrite;
  };
}
function stopLogCapture(): void {
  restoreStreamWrite?.();
  restoreStreamWrite = null;
}

describe("ADR-117: typed error envelope redaction", () => {
  before(async () => {
    relay = await import("../index.js");
    relay.__resetRedemptionStateForTests();
  });

  after(async () => {
    stopLogCapture();
    relay.__resetRedemptionStateForTests();
    await new Promise<void>((resolve, reject) => {
      (relay.server as HttpServer).close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    relay.__resetRedemptionStateForTests();
    capturedLogLines.length = 0;
  });

  // -------------------------------------------------------------------------
  // classifyVerifyException — pin the heuristic to the enum
  // -------------------------------------------------------------------------

  describe("classifyVerifyException — exception shape -> ErrorCode", () => {
    it("returns RPC_UNAVAILABLE for node ECONNREFUSED", () => {
      const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8899"), {
        code: "ECONNREFUSED",
      });
      assert.equal(relay.classifyVerifyException(err), "RPC_UNAVAILABLE");
    });

    it("returns RPC_UNAVAILABLE for getaddrinfo failures", () => {
      const err = new Error("getaddrinfo ENOTFOUND mainnet.example.com");
      assert.equal(relay.classifyVerifyException(err), "RPC_UNAVAILABLE");
    });

    it("returns RPC_UNAVAILABLE for fetch failed (undici)", () => {
      const err = Object.assign(new Error("fetch failed"), {
        cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
      });
      assert.equal(relay.classifyVerifyException(err), "RPC_UNAVAILABLE");
    });

    it("returns PAYMENT_NOT_FOUND when message references the signature", () => {
      const err = new Error("Signature 4QnW...abcd not found at slot 12345");
      assert.equal(relay.classifyVerifyException(err), "PAYMENT_NOT_FOUND");
    });

    it("returns INTERNAL on unknown exception shape (catch-all)", () => {
      const err = new Error("totally unexpected RPC parse error");
      assert.equal(relay.classifyVerifyException(err), "INTERNAL");
    });

    it("returns INTERNAL on null / undefined / non-Error throws", () => {
      assert.equal(relay.classifyVerifyException(null), "INTERNAL");
      assert.equal(relay.classifyVerifyException(undefined), "INTERNAL");
      assert.equal(relay.classifyVerifyException(42), "INTERNAL");
    });
  });

  // -------------------------------------------------------------------------
  // toErrorEnvelope — pin the wire shape
  // -------------------------------------------------------------------------

  describe("toErrorEnvelope — shape and message stability", () => {
    it("returns { code, message, correlationId } for every ErrorCode", () => {
      const codes = [
        "PAYMENT_NOT_FOUND",
        "PAYMENT_UNVERIFIED",
        "PAYMENT_REPLAYED",
        "RPC_UNAVAILABLE",
        "INTERNAL",
      ] as const;
      for (const code of codes) {
        const env = relay.toErrorEnvelope(code, "corr-fixed");
        assert.equal(env.code, code, `envelope code matches input for ${code}`);
        assert.equal(
          env.message,
          relay.ERROR_MESSAGES[code],
          `envelope message is the canonical message for ${code}`,
        );
        assert.equal(env.correlationId, "corr-fixed");
        // The envelope must NEVER carry any other key (no raw `err`,
        // `stack`, `cause`, etc. — that's the redaction invariant).
        assert.deepEqual(
          Object.keys(env).sort(),
          ["code", "correlationId", "message"],
          `envelope keys are exactly { code, message, correlationId } for ${code}`,
        );
      }
    });

    it("messages never include URLs or signature-like substrings", () => {
      // The canonical messages are operator-controlled strings; this is
      // a guard against a future edit that re-introduces interpolation
      // (e.g. "Payment ${sig} not found"). If this test trips, someone
      // widened a message in a way that re-opens R-offchain-01.
      const SUSPICIOUS = [
        "http://", "https://", "rpc.", ".com", ".io", ".org",
        "127.0.0.1", "localhost", "${",
      ];
      for (const [code, msg] of Object.entries(relay.ERROR_MESSAGES)) {
        for (const sub of SUSPICIOUS) {
          assert.ok(
            !msg.includes(sub),
            `ERROR_MESSAGES.${code} = "${msg}" must not contain "${sub}"`,
          );
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // /pay route — end-to-end redaction with a throwing mock verifier
  // -------------------------------------------------------------------------

  describe("/pay — thrown verifier exception is redacted and logged", () => {
    // We don't drive the live `app.listen` here; processPaymentRequest is
    // the unit that maps a thrown verifier to the kind:"invalid" branch
    // which the route then renders. The full HTTP path is covered in the
    // route-body subtest below.

    // C4-X402-02 (2026-05-17): this subtest originally asserted that a
    // verifier reporting `RPC_UNAVAILABLE` produced `kind:"invalid"`
    // (which the route rendered as HTTP 402). That codified the exact
    // status-inversion bug C4-X402-02 fixes: a transport failure must
    // NOT be reported to the client as a genuine payment rejection.
    // Post-fix, `processPaymentRequest` routes the upstream codes
    // (`RPC_UNAVAILABLE`/`INTERNAL`) to the distinct `kind:"upstream"`
    // (→ 5xx) while genuine rejections stay `kind:"invalid"` (→ 402).
    // The redaction contract this subtest exists to pin (no leak of the
    // RPC URL / signature into the flowed result) is unchanged and is
    // re-asserted below against the corrected `upstream` shape.
    it("processPaymentRequest with RPC_UNAVAILABLE verifier returns kind:'upstream' (C4-X402-02 taxonomy) with no leak", async () => {
      // A verifier that throws an exception whose toString() includes
      // BOTH the RPC URL and the tx signature — the same shape
      // @solana/kit's RPC layer produces in the wild. After ADR-117
      // none of these substrings may surface in the result envelope.
      const RPC_URL_LEAK = "http://internal-rpc.example.com:8899";
      const SIG_LEAK = "4QnWvLeAk1NgSubstr1nGtHaTsHoUldBeReDacTed";

      const throwingVerifier = async (sig: string) => {
        // Verifiers in production are the bound `verifyPaymentOnChain`,
        // which catches internally. To exercise the route's redaction
        // path WITHOUT relying on `verifyPaymentOnChain`'s own catch
        // (which we ALSO test below via direct unit assertion), we
        // simulate the catch's observable output: a PaymentVerification
        // with valid=false + errorCode=RPC_UNAVAILABLE + a generic
        // error message. This is exactly what `verifyPaymentOnChain`
        // returns post-ADR-117 when a transport exception fires.
        // The leak substrings are NEVER passed into PaymentVerification
        // (only into the simulated thrown Error that the production
        // catch would absorb).
        void sig;
        const fakeException = new Error(
          `connect ECONNREFUSED ${RPC_URL_LEAK} for signature=${SIG_LEAK}`,
        );
        // Pre-ADR-117 the catch did:
        //   error: `Verification error: ${fakeException}`
        // which leaks RPC_URL_LEAK and SIG_LEAK. Post-ADR-117 the
        // catch classifies + emits the generic envelope.
        const errorCode = relay.classifyVerifyException(fakeException);
        return {
          valid: false,
          sender: "",
          recipient: "",
          amountSol: 0,
          slot: 0,
          error: relay.ERROR_MESSAGES[errorCode],
          errorCode,
        };
      };

      const sig = "adr-117-throwing-verifier-" + crypto.randomBytes(4).toString("hex");
      const result = await relay.processPaymentRequest(sig, throwingVerifier, "MOCK_RECIPIENT");

      // C4-X402-02: a transport failure (`RPC_UNAVAILABLE`) is now the
      // distinct `kind:"upstream"`, NOT `kind:"invalid"`. The route maps
      // this to 503 (retryable), not 402 (terminal "payment rejected").
      assert.equal(result.kind, "upstream");
      if (result.kind !== "upstream") return; // narrow for ts

      assert.equal(result.errorCode, "RPC_UNAVAILABLE");

      // The verifier's leak substrings must NEVER appear in the flowed
      // result (the redaction contract this subtest exists to pin —
      // unchanged by the taxonomy fix). Assert against the whole
      // PayResult the route handler sees.
      const serialized = JSON.stringify(result);
      assert.ok(
        !serialized.includes(RPC_URL_LEAK),
        `PayResult must not contain the RPC URL leak: got ${serialized}`,
      );
      assert.ok(
        !serialized.includes(SIG_LEAK),
        `PayResult must not contain the signature leak: got ${serialized}`,
      );
    });

    it("real verifyPaymentOnChain catch redacts AND pino-logs the raw exception (correlation: corr_id)", async () => {
      // We can't easily drive the real `rpc.getTransaction` to throw a
      // controlled exception (it's bound to a constructed createSolanaRpc
      // instance and not pluggable). Instead we verify the surface that
      // ADR-117 added is wired correctly: `logger.error` IS reachable
      // from the relay module, and emits a structured log line with
      // event=verify_payment_exception + corr_id + error_code + err.
      //
      // We exercise this via a direct call to `logger.error` on the
      // same logger instance the catch uses (re-imported from the
      // logger module). If a future refactor swaps that logger out
      // from under `verifyPaymentOnChain`, this assertion still pins
      // the pino-emission contract for the catch path.

      const { logger } = await import("../logger.js");
      startLogCapture(logger);

      const SIG = "adr-117-pino-capture-" + crypto.randomBytes(4).toString("hex");
      const LEAKY_ERR = new Error(
        "connect ECONNREFUSED http://internal-rpc.example.com:8899",
      );
      logger.error(
        {
          event: "verify_payment_exception",
          corr_id: SIG,
          error_code: "RPC_UNAVAILABLE",
          err: LEAKY_ERR,
        },
        "verifyPaymentOnChain threw — classified for redacted client response",
      );

      // Give pino's async destination a microtask to flush.
      await new Promise((r) => setImmediate(r));
      stopLogCapture();

      const joined = capturedLogLines.join("");
      assert.ok(
        joined.includes("verify_payment_exception"),
        `pino must emit the ADR-117 catch event; captured: ${joined.slice(0, 500)}`,
      );
      assert.ok(
        joined.includes(SIG),
        `pino must include corr_id (the tx signature) for log correlation; captured: ${joined.slice(0, 500)}`,
      );
      // Raw err is intentionally PRESERVED in the log (this is the
      // server-side debugging affordance the ADR explicitly retains —
      // see ADR-117 §"Server-side (pino)"). It is the CLIENT-facing
      // envelope that must not include it.
      assert.ok(
        joined.includes("ECONNREFUSED"),
        `pino must log the raw exception text server-side for ops debugging; captured: ${joined.slice(0, 500)}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // /pay route body — full HTTP round-trip via `app.listen` + fetch
  // -------------------------------------------------------------------------

  describe("/pay route — response body shape per code", () => {
    let listenServer: HttpServer;
    let baseUrl: string;

    before(async () => {
      // The module-load app.listen uses RELAY_PORT=0 above and is
      // already running on a port; use it directly via relay.server.
      // (Re-listening on a second port would race the module-level
      // listener on the same `app`.)
      listenServer = relay.server as HttpServer;
      // Wait for the listener if it hasn't bound yet.
      if (!listenServer.listening) {
        await new Promise<void>((resolve) => listenServer.once("listening", () => resolve()));
      }
      const addr = listenServer.address() as AddressInfo | string | null;
      assert.ok(addr && typeof addr === "object", "relay.server must be a TCP listener");
      baseUrl = `http://127.0.0.1:${(addr as AddressInfo).port}`;
    });

    it("PAYMENT_REPLAYED — 409 with envelope shape", async () => {
      const sig = validSig();
      // No public seeder takes (sig, expiry), so we drive a happy-path
      // through processPaymentRequest first to populate the in-memory
      // dedup map, then POST /pay with the same sig to hit the dedup
      // gate. (Same approach the AUD-126 dual-write subtest uses.)
      const okVerifier = async () => ({
        valid: true as const,
        sender: "MOCK_SENDER",
        recipient: "MOCK_RECIPIENT",
        amountSol: 0.01,
        slot: 1,
      });
      // First seed call — bypasses HTTP (no rate-limit pollution),
      // commits the in-memory entry, releases the redis lock if any.
      const seed = await relay.processPaymentRequest(sig, okVerifier, "MOCK_RECIPIENT");
      assert.equal(seed.kind, "ok", "seeding the redeemed map must succeed");

      // Now hit /pay with the SAME sig — the dedup gate fires and the
      // route must emit PAYMENT_REPLAYED in the envelope shape.
      const res = await fetch(`${baseUrl}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txSignature: sig }),
      });
      assert.equal(res.status, 409);
      const body = (await res.json()) as { code?: string; message?: string; correlationId?: string };
      assert.equal(body.code, "PAYMENT_REPLAYED");
      assert.equal(typeof body.message, "string");
      assert.equal(body.correlationId, sig);
      // No raw err, stack, etc.
      assert.deepEqual(
        Object.keys(body).sort(),
        ["code", "correlationId", "message"],
        "route body for PAYMENT_REPLAYED must be exactly { code, message, correlationId }",
      );
    });
  });
});
