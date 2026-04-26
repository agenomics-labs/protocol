/**
 * x402 Payment Relay - Unit Tests
 *
 * Tests pure functions exported by the relay module.
 * HTTP endpoint tests require `supertest` which is not currently installed.
 * To enable full HTTP testing: npm install --save-dev supertest @types/supertest
 */

// JWT_SECRET must be set BEFORE importing the relay module,
// because the module calls process.exit(1) if it is missing.
process.env.JWT_SECRET = "test-secret-for-unit-tests-32b!!";
process.env.PAYMENT_RECIPIENT = "11111111111111111111111111111111";

import { expect } from "chai";
import {
  verifyAccessToken,
  processPaymentRequest,
  __resetRedemptionStateForTests,
} from "../src/x402-relay/index";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-secret-for-unit-tests-32b!!";

describe("x402 Relay - verifyAccessToken", () => {
  it("should return null for an invalid token", () => {
    const result = verifyAccessToken("this-is-not-a-valid-jwt");
    expect(result).to.be.null;
  });

  it("should return null for a token signed with a different secret", () => {
    const token = jwt.sign(
      { sender: "abc", txSignature: "sig123", amountSol: 0.01 },
      "wrong-secret",
      { expiresIn: 3600 }
    );
    const result = verifyAccessToken(token);
    expect(result).to.be.null;
  });

  it("should return null for an expired token", () => {
    const token = jwt.sign(
      { sender: "abc", txSignature: "sig123", amountSol: 0.01 },
      JWT_SECRET,
      { expiresIn: -10 } // already expired
    );
    const result = verifyAccessToken(token);
    expect(result).to.be.null;
  });

  it("should return the payload for a valid token", () => {
    const token = jwt.sign(
      { sender: "SenderPubkey123", txSignature: "txSig456", amountSol: 0.05 },
      JWT_SECRET,
      { expiresIn: 3600 }
    );
    const result = verifyAccessToken(token);
    expect(result).to.not.be.null;
    expect(result!.sender).to.equal("SenderPubkey123");
    expect(result!.txSignature).to.equal("txSig456");
    expect(result!.amountSol).to.equal(0.05);
  });

  it("should include iat and exp in the returned payload", () => {
    const token = jwt.sign(
      { sender: "abc", txSignature: "sig", amountSol: 1 },
      JWT_SECRET,
      { expiresIn: 7200 }
    );
    const result = verifyAccessToken(token);
    expect(result).to.not.be.null;
    expect(result!.iat).to.be.a("number");
    expect(result!.exp).to.be.a("number");
    expect(result!.exp).to.be.greaterThan(result!.iat);
  });

  it("should return null for an empty string token", () => {
    const result = verifyAccessToken("");
    expect(result).to.be.null;
  });
});

/**
 * AUD-208: TOCTOU race in /pay between has(redeemedSignatures) and set(...).
 * Before the fix, two concurrent POSTs with the same txSignature could both
 * pass the existence check, both fire the 200-1000ms `verifyPaymentOnChain`
 * RPC, and both receive a fresh JWT — i.e. one on-chain payment yielded
 * multiple JWTs.
 *
 * The fix: an in-flight verify cache keyed by txSignature (concurrent
 * callers share one Promise), plus a post-verify re-check of
 * `redeemedSignatures` so only the first awaiter to wake commits.
 *
 * These tests drive the invariants directly via `processPaymentRequest`
 * rather than through HTTP; this avoids a `supertest` dependency and lets
 * us count exactly how many times the verifier was invoked.
 */
describe("x402 Relay - AUD-208 concurrent /pay redemption race", () => {
  const RECIPIENT = "11111111111111111111111111111111";
  const SIGNATURE = "concurrent-tx-sig-AUD208";

  beforeEach(() => {
    __resetRedemptionStateForTests();
  });

  it("fires verifier exactly once and issues exactly one JWT for 5 concurrent calls with the same txSignature", async () => {
    let verifierCallCount = 0;
    const verifier = async (sig: string) => {
      verifierCallCount += 1;
      // Simulate the 100-1000ms Solana RPC roundtrip described in the
      // audit. 100ms is more than enough to let all 5 concurrent
      // microtasks queue up against the same in-flight Promise.
      await new Promise((r) => setTimeout(r, 100));
      return {
        valid: true,
        sender: "SenderPubkey-AUD208",
        recipient: RECIPIENT,
        amountSol: 0.05,
        slot: 12345,
      };
    };

    // Fire 5 concurrent calls. They must all start before the verifier
    // resolves (i.e. before its 100ms timer fires) — Promise.all on the
    // same tick guarantees this because each invocation hits the
    // synchronous `inFlightVerify.has` / `redeemedSignatures.has` path
    // before yielding to the timer queue.
    const results = await Promise.all([
      processPaymentRequest(SIGNATURE, verifier, RECIPIENT),
      processPaymentRequest(SIGNATURE, verifier, RECIPIENT),
      processPaymentRequest(SIGNATURE, verifier, RECIPIENT),
      processPaymentRequest(SIGNATURE, verifier, RECIPIENT),
      processPaymentRequest(SIGNATURE, verifier, RECIPIENT),
    ]);

    // Invariant 1: in-flight dedup means the verifier ran exactly once.
    expect(verifierCallCount, "verifier called more than once").to.equal(1);

    // Invariant 2: exactly one JWT issued (the first awaiter to commit).
    const okResults = results.filter((r) => r.kind === "ok");
    expect(okResults, "expected exactly one ok result").to.have.lengthOf(1);

    // Invariant 3: the other 4 receive "redeemed" (which the route maps
    // to HTTP 409). None must receive "ok" or "invalid".
    const redeemedResults = results.filter((r) => r.kind === "redeemed");
    expect(
      redeemedResults,
      "expected the other 4 callers to be 409-redeemed",
    ).to.have.lengthOf(4);

    // Defensive: no other result kinds should appear.
    expect(
      results.filter(
        (r) => r.kind !== "ok" && r.kind !== "redeemed",
      ),
      "unexpected result kinds present",
    ).to.have.lengthOf(0);

    // Invariant 4: the issued JWT must be a non-empty string and must
    // carry the txSignature in its payload, so we know it's the genuine
    // article (not an empty placeholder).
    const ok = okResults[0];
    if (ok.kind !== "ok") throw new Error("unreachable");
    expect(ok.accessToken).to.be.a("string").and.not.empty;
    const decoded = verifyAccessToken(ok.accessToken);
    expect(decoded).to.not.be.null;
    expect(decoded!.txSignature).to.equal(SIGNATURE);
  });

  it("a sequential second call to a previously-redeemed signature returns 'redeemed' without invoking the verifier", async () => {
    let verifierCallCount = 0;
    const verifier = async (_sig: string) => {
      verifierCallCount += 1;
      return {
        valid: true,
        sender: "SenderPubkey-AUD208",
        recipient: RECIPIENT,
        amountSol: 0.05,
        slot: 99,
      };
    };

    const first = await processPaymentRequest(
      "sequential-sig-AUD208",
      verifier,
      RECIPIENT,
    );
    expect(first.kind).to.equal("ok");
    expect(verifierCallCount).to.equal(1);

    const second = await processPaymentRequest(
      "sequential-sig-AUD208",
      verifier,
      RECIPIENT,
    );
    expect(second.kind).to.equal("redeemed");
    // Fast-reject path means the verifier is NOT consulted again.
    expect(verifierCallCount, "fast-reject must skip the verifier").to.equal(
      1,
    );
  });

  it("a failed verification does not poison the in-flight cache for retries", async () => {
    let verifierCallCount = 0;
    const verifier = async (_sig: string) => {
      verifierCallCount += 1;
      // First attempt: tx not yet finalized; later retry should succeed.
      if (verifierCallCount === 1) {
        await new Promise((r) => setTimeout(r, 50));
        return {
          valid: false,
          sender: "",
          recipient: RECIPIENT,
          amountSol: 0,
          slot: 0,
          error: "Transaction not found",
        };
      }
      return {
        valid: true,
        sender: "SenderPubkey-AUD208",
        recipient: RECIPIENT,
        amountSol: 0.05,
        slot: 100,
      };
    };

    const SIG = "retry-after-fail-AUD208";
    const first = await processPaymentRequest(SIG, verifier, RECIPIENT);
    expect(first.kind).to.equal("invalid");

    // The .finally() handler must have cleared the in-flight entry by
    // the time the awaiter resumes (since `await` on the same Promise
    // is observed only after all `.then`/`.finally` for that Promise
    // have queued — and our `.finally(() => delete)` was registered
    // synchronously in `processPaymentRequest`). A retry must therefore
    // re-invoke the verifier rather than reusing the cached failure.
    const second = await processPaymentRequest(SIG, verifier, RECIPIENT);
    expect(second.kind).to.equal("ok");
    expect(verifierCallCount).to.equal(2);
  });
});

/**
 * HTTP endpoint tests (require supertest)
 *
 * To run these tests, install supertest:
 *   npm install --save-dev supertest @types/supertest
 *
 * Then uncomment the block below and import:
 *   import request from "supertest";
 *   import { app } from "../src/x402-relay/index";
 *
 * describe("x402 Relay - HTTP Endpoints", () => {
 *   it("GET /health should return 200 with status ok", async () => {
 *     const res = await request(app).get("/health");
 *     expect(res.status).to.equal(200);
 *     expect(res.body.status).to.equal("ok");
 *     expect(res.body.relay).to.equal("x402");
 *   });
 *
 *   it("POST /pay without txSignature should return 400", async () => {
 *     const res = await request(app).post("/pay").send({});
 *     expect(res.status).to.equal(400);
 *     expect(res.body.error).to.include("Missing txSignature");
 *   });
 *
 *   it("POST /pay with already-redeemed signature should return 409", async () => {
 *     // NOTE: This test requires mocking verifyPaymentOnChain to return valid: true
 *     // so the first call succeeds and the second returns 409.
 *   });
 *
 *   it("GET /verify without Bearer token should return 401", async () => {
 *     const res = await request(app).get("/verify");
 *     expect(res.status).to.equal(401);
 *     expect(res.body.valid).to.equal(false);
 *   });
 *
 *   it("GET /protected without Bearer token should return 402 with payment info", async () => {
 *     const res = await request(app).get("/protected");
 *     expect(res.status).to.equal(402);
 *     expect(res.body.error).to.equal("Payment Required");
 *     expect(res.body.payment).to.have.property("recipient");
 *     expect(res.body.payment).to.have.property("amountSol");
 *     expect(res.body.payment).to.have.property("endpoint", "/pay");
 *   });
 * });
 */
