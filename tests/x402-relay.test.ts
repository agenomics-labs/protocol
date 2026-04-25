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
import { verifyAccessToken } from "../src/x402-relay/index";
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
