/**
 * Admin /drain endpoint integration test.
 *
 * Background:
 *
 * `docs/INCIDENT_RESPONSE.md` §4 (commit bbeb240) called out that
 * operators had no in-app way to gracefully stop accepting new /pay
 * requests during incident response — the only mitigation was
 * coarse network-edge blocking that was asymmetric across instances.
 * This test pins the lifecycle of the new admin surface that closes
 * that gap:
 *
 *   - POST /admin/drain        (auth required) → flips draining=true
 *   - POST /admin/undrain      (auth required) → flips draining=false
 *   - GET  /admin/status       (no auth)       → returns current state
 *   - POST /pay while draining → 503 with body
 *     `{ error: "Relay is draining; retry against another instance" }`
 *
 * What this test pins:
 *
 *   1. Drain → /pay 503 → undrain → /pay served normally.
 *   2. Auth shape: missing/wrong bearer token → 401; wrong-length token
 *      → 401 (not a length-leaking 400).
 *   3. GET /admin/status is always reachable, no auth, and reflects the
 *      live drain flag.
 *   4. Boundary: a /pay request that started BEFORE drain (i.e. is
 *      already mid-verify) completes normally, because drain is graceful
 *      not a circuit breaker.
 *
 * Test pattern follows AUD-209's `aud-209-saturation.test.ts` exactly:
 *   - Set env BEFORE the dynamic import inside `before()` so the
 *     module's top-level side effects (env reads, app.listen, the
 *     RELAY_ADMIN_TOKEN length-floor gate) see the right values.
 *   - RELAY_PORT=0 so the OS allocates an ephemeral port (parallel
 *     test runs do not collide on 3200).
 *   - server.close() in `after()` so node:test exits cleanly.
 *   - __resetRedemptionStateForTests + __resetDrainStateForTests in
 *     beforeEach so each subtest starts from a known baseline.
 *
 * /pay coverage strategy:
 *
 * The drain gate sits BEFORE `processPaymentRequest`, so we can drive
 * it without a real Solana validator — the 503 response fires before
 * the verifier runs. For the "in-flight request completes" subtest we
 * exercise `processPaymentRequest` directly with an injected mock
 * verifier, the same seam AUD-208 / AUD-209 use, because the drain gate
 * is a route-level check and `processPaymentRequest` itself is drain-
 * agnostic — that is the contract we want to pin.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import type { Server, AddressInfo } from "node:net";

// JWT_SECRET, RELAY_ADMIN_TOKEN, RELAY_PORT, PAYMENT_RECIPIENT MUST be
// set before the module under test loads:
//
// - JWT_SECRET: AUD-027 32-byte gate at module load.
// - RELAY_ADMIN_TOKEN: 32-byte gate at module load (mirrors AUD-027).
//   We pin a known value so the auth-positive subtest can present it.
// - RELAY_PORT=0: the module calls app.listen(PORT, ...) at module
//   load; pin to 0 to avoid the hardcoded-3200 collision in parallel
//   test runs.
// - PAYMENT_RECIPIENT: must be non-empty, otherwise the /pay route
//   short-circuits with `kind: "no-config"` (500) before the drain
//   gate can demonstrate its 503 in the negative-control subtest.
//
// CRITICAL hoisting note (mirrors aud-209-saturation.test.ts):
// a top-level `import { ... } from "../index.js"` is hoisted above
// these env writes. We use deferred dynamic `await import(...)` inside
// `before()` to guarantee env is set before the module's side effects.
const ADMIN_TOKEN = crypto.randomBytes(32).toString("hex"); // 64 bytes
process.env.JWT_SECRET ??= crypto.randomBytes(32).toString("hex");
process.env.RELAY_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.RELAY_PORT = "0";
process.env.PAYMENT_RECIPIENT ??= "TEST_RECIPIENT_PUBKEY_NOT_USED_BY_MOCK";

type RelayModule = typeof import("../index.js");
let relay: RelayModule;
let baseUrl: string;

/** Helper: resolve the ephemeral port the OS picked for this test run. */
function getBaseUrl(server: Server): string {
  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr !== "object") {
    throw new Error("server.address() did not return an AddressInfo");
  }
  return `http://127.0.0.1:${addr.port}`;
}

describe("admin /drain endpoint lifecycle", () => {
  before(async () => {
    relay = await import("../index.js");
    relay.__resetRedemptionStateForTests();
    relay.__resetDrainStateForTests();
    baseUrl = getBaseUrl(relay.server as Server);
  });

  after(async () => {
    relay.__resetRedemptionStateForTests();
    relay.__resetDrainStateForTests();
    await new Promise<void>((resolve, reject) => {
      const server = relay.server as Server;
      // Node's undici `fetch()` keeps HTTP keep-alive sockets open after
      // the response resolves. `server.close()`'s callback does not fire
      // until every connection closes, and an idle keep-alive socket can
      // sit open well past the test run — this hung a CI runner for 2h43m
      // (see PR #297 investigation). Force-close idle sockets so close()
      // resolves promptly; safe here because all assertions have already
      // awaited their responses by this point.
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    // Each subtest starts from a known baseline. The drain reset is
    // critical: a subtest that drained but did not undrain would
    // leak into subsequent subtests' /pay assertions.
    relay.__resetRedemptionStateForTests();
    relay.__resetDrainStateForTests();
  });

  it("GET /admin/status is reachable without auth and reflects baseline", async () => {
    const r = await fetch(`${baseUrl}/admin/status`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      draining: boolean;
      adminTokenConfigured: boolean;
    };
    assert.equal(body.draining, false, "baseline drain flag must be false");
    assert.equal(
      body.adminTokenConfigured,
      true,
      "test set RELAY_ADMIN_TOKEN, so this must be true",
    );
  });

  it("POST /admin/drain without Authorization header returns 401", async () => {
    const r = await fetch(`${baseUrl}/admin/drain`, { method: "POST" });
    assert.equal(r.status, 401);
    // Drain flag must NOT have flipped on a rejected request.
    const status = (await (await fetch(`${baseUrl}/admin/status`)).json()) as {
      draining: boolean;
    };
    assert.equal(status.draining, false);
  });

  it("POST /admin/drain with wrong bearer token returns 401", async () => {
    const r = await fetch(`${baseUrl}/admin/drain`, {
      method: "POST",
      headers: { Authorization: `Bearer ${"x".repeat(64)}` },
    });
    assert.equal(r.status, 401);
  });

  it("POST /admin/drain with shorter-than-expected token returns 401 (length-mismatch path)", async () => {
    // Length-mismatch branch in requireAdmin — distinct from the
    // timingSafeEqual-mismatch branch above. Ensures we don't accidentally
    // 400 or 500 on the length check.
    const r = await fetch(`${baseUrl}/admin/drain`, {
      method: "POST",
      headers: { Authorization: "Bearer short" },
    });
    assert.equal(r.status, 401);
  });

  it("POST /admin/drain with correct bearer token flips draining to true", async () => {
    const r = await fetch(`${baseUrl}/admin/drain`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      draining: boolean;
      wasAlreadyDraining: boolean;
    };
    assert.equal(body.draining, true);
    assert.equal(body.wasAlreadyDraining, false, "fresh drain — was not already draining");

    // Status endpoint must reflect the new state.
    const status = (await (await fetch(`${baseUrl}/admin/status`)).json()) as {
      draining: boolean;
    };
    assert.equal(status.draining, true);
  });

  it("full lifecycle: drain → /pay 503 → undrain → /pay no-longer-blocked", async () => {
    // 1. Drain.
    const drainRes = await fetch(`${baseUrl}/admin/drain`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(drainRes.status, 200);

    // 2. /pay must now 503 with the drain-specific body. We do NOT
    //    need a real Solana validator here — the drain gate fires
    //    BEFORE input validation and BEFORE processPaymentRequest, so
    //    the 503 lands regardless of the body shape.
    const payDrained = await fetch(`${baseUrl}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txSignature: "any-sig-doesnt-matter-while-draining" }),
    });
    assert.equal(payDrained.status, 503);
    const payDrainedBody = (await payDrained.json()) as { error: string };
    assert.match(
      payDrainedBody.error,
      /draining/i,
      "503 body must identify drain (not the AUD-209 saturation 503)",
    );
    assert.doesNotMatch(
      payDrainedBody.error,
      /capacity exhausted/i,
      "must NOT be the AUD-209 saturation 503 message",
    );

    // 3. Undrain.
    const undrainRes = await fetch(`${baseUrl}/admin/undrain`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(undrainRes.status, 200);
    const undrainBody = (await undrainRes.json()) as {
      draining: boolean;
      wasDraining: boolean;
    };
    assert.equal(undrainBody.draining, false);
    assert.equal(undrainBody.wasDraining, true);

    // 4. /pay must no longer be drain-blocked. We send a malformed body
    //    so the route lands in the 400 ("Missing txSignature") branch —
    //    that proves we're past the drain gate without needing to mock
    //    the on-chain verifier. A 503 here would mean the drain flag
    //    did not clear; a 400 means the drain gate let us through and
    //    we hit the next layer (input validation).
    const payAfterUndrain = await fetch(`${baseUrl}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(
      payAfterUndrain.status,
      400,
      "after undrain, /pay must reach input validation (not the 503 drain branch)",
    );
  });

  it("POST /admin/undrain on an already-undrained relay is idempotent (200, wasDraining=false)", async () => {
    const r = await fetch(`${baseUrl}/admin/undrain`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { draining: boolean; wasDraining: boolean };
    assert.equal(body.draining, false);
    assert.equal(body.wasDraining, false);
  });

  it("POST /admin/drain twice is idempotent (200, wasAlreadyDraining=true on the second call)", async () => {
    const first = await fetch(`${baseUrl}/admin/drain`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { wasAlreadyDraining: boolean };
    assert.equal(firstBody.wasAlreadyDraining, false);

    const second = await fetch(`${baseUrl}/admin/drain`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { wasAlreadyDraining: boolean };
    assert.equal(secondBody.wasAlreadyDraining, true);
  });

  it("in-flight /pay request that started BEFORE drain completes normally", async () => {
    // The drain gate is a route-level check; once execution is past
    // it, the request runs to completion regardless of subsequent
    // drain calls. We exercise this at the processPaymentRequest
    // level (the same seam AUD-208 / AUD-209 use) because that
    // function is drain-agnostic by design — drain is a /pay route
    // gate, not a verifier-level circuit breaker. This subtest pins
    // that contract: a drain mid-verify must not corrupt the
    // already-running request.
    let resolveVerifier: (v: {
      valid: boolean;
      sender: string;
      recipient: string;
      amountSol: number;
      slot: number;
    }) => void;
    const verifierPromise = new Promise<{
      valid: boolean;
      sender: string;
      recipient: string;
      amountSol: number;
      slot: number;
    }>((resolve) => {
      resolveVerifier = resolve;
    });
    const slowVerifier = () => verifierPromise;

    // Kick off the /pay processing — verifier will block until we
    // resolve the promise below.
    const inFlightSig = `inflight-${crypto.randomBytes(8).toString("hex")}`;
    const inFlightPay = relay.processPaymentRequest(
      inFlightSig,
      slowVerifier,
      "MOCK_RECIPIENT",
    );

    // Drain mid-flight. The in-flight request is past any route-level
    // gate (we called processPaymentRequest directly, simulating the
    // route having let it through).
    await fetch(`${baseUrl}/admin/drain`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    // Confirm a NEW /pay request is now blocked by the drain gate.
    const newPay = await fetch(`${baseUrl}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txSignature: "new-while-draining" }),
    });
    assert.equal(newPay.status, 503);

    // Now resolve the in-flight verifier and assert it completes
    // successfully — drain must NOT have aborted the in-flight call.
    resolveVerifier!({
      valid: true,
      sender: "MOCK_SENDER",
      recipient: "MOCK_RECIPIENT",
      amountSol: 0.01,
      slot: 1,
    });
    const result = await inFlightPay;
    assert.equal(
      result.kind,
      "ok",
      `in-flight request must complete despite mid-flight drain; got ${result.kind}`,
    );
  });
});
