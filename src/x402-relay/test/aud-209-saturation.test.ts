/**
 * AUD-209 — Redeemed-signature map saturation guard regression test.
 *
 * Background (commit 23baed7, cycle-2 audit closure):
 *
 * The pre-fix `pruneRedeemedSignatures` had two passes — TTL eviction
 * (correct) plus a cap-eviction loop that, once `redeemedSignatures.size`
 * exceeded `MAX_REDEEMED_SIGNATURES = 100_000`, dropped the OLDEST entries
 * in insertion order. That cap-evict path was fail-OPEN: under sustained
 * saturation it silently dropped unexpired signatures and re-opened the
 * replay window for them.
 *
 * The fix moves the saturation decision out of the pruner and into the
 * `/pay` commit step:
 *
 *   - `pruneRedeemedSignatures` no longer cap-evicts (only TTL eviction).
 *   - `PayResult` gains a `kind: "saturated"` variant.
 *   - `processPaymentRequest` returns `{ kind: "saturated" }` when the
 *     map is at MAX_REDEEMED_SIGNATURES and the incoming signature is
 *     not already present (re-checked atomically post-RPC).
 *   - `/pay` maps `saturated` -> 503 with body
 *     `{ error: "Relay redeemed-signature capacity exhausted; retry shortly" }`.
 *
 * What this test pins:
 *
 *   `processPaymentRequest` returns `{ kind: "saturated" }` when the
 *   redeemed-signature map is at cap and a new (unique) signature arrives.
 *   This is the lower-level behavior the `/pay` route handler maps onto
 *   HTTP 503; the route mapping itself is a single-line `if (result.kind
 *   === "saturated") return res.status(503).json(...)` whose correctness
 *   is verified by code inspection. End-to-end HTTP coverage would need
 *   to mock `verifyPaymentOnChain` (saturation is checked POST-RPC), and
 *   the relay does not expose a verifier-injection seam — adding one
 *   solely for this test would expand the production-code surface beyond
 *   what AUD-209's regression contract requires.
 *
 * Strategy:
 *
 * `MAX_REDEEMED_SIGNATURES = 100_000`. Driving 100k unique signatures
 * through `processPaymentRequest` with a real verifier would either need
 * 100k mock-verify resolutions (slow, allocation-heavy) or a smaller cap
 * (would require changing production code beyond a test hook). Instead
 * we use the `__fillRedemptionStateForTests` hook to pre-seed the map
 * with 100k synthetic entries — same observable end state that 100k
 * real redemptions would produce, but in O(n) Map.set calls without any
 * Promise scheduling. The hook is documented in `index.ts` as test-only
 * and parallels the existing `__resetRedemptionStateForTests` (AUD-208).
 *
 * Importing `index.ts` runs `app.listen(PORT, ...)` at module load, which
 * normally keeps the Node event loop alive past test completion. We pin
 * `RELAY_PORT=0` (ephemeral) so concurrent runs don't collide on the
 * default 3200, and call `server.close()` in `after()` so the suite
 * exits cleanly. JWT_SECRET is also set before import to satisfy the
 * AUD-027 length-floor gate.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import type { Server } from "node:http";

// JWT_SECRET, RELAY_PORT and PAYMENT_RECIPIENT MUST be set before the
// module under test loads:
//
// - JWT_SECRET: the AUD-027 gate at module load throws if it's < 32 bytes.
// - RELAY_PORT=0: the module calls `app.listen(PORT, ...)` immediately
//   at load time; pinning to 0 lets the OS allocate an ephemeral port so
//   parallel test runs don't collide on the hardcoded default 3200.
// - PAYMENT_RECIPIENT: must be a non-empty string, otherwise
//   `processPaymentRequest` short-circuits with `kind: "no-config"`
//   *before* reaching the saturation check we want to exercise.
//
// CRITICAL: a top-level `import { ... } from "../index.js"` is hoisted
// above these `process.env` writes (ESM static-import semantics — and
// even under tsx's CJS interop, the import-fold can run before the
// assignments depending on loader transform). We use a deferred dynamic
// `await import(...)` inside `before()` to guarantee the env is set
// before the module's top-level side effects (the env-reads, the
// listen call, the AUD-027 gate) run.
process.env.JWT_SECRET ??= crypto.randomBytes(32).toString("hex");
process.env.RELAY_PORT = "0";
process.env.PAYMENT_RECIPIENT ??= "TEST_RECIPIENT_PUBKEY_NOT_USED_BY_MOCK";

// MAX_REDEEMED_SIGNATURES is module-private; mirror its current value
// here. If the production constant ever changes, the saturation subtest
// will fail loudly (the post-fill `processPaymentRequest` would either
// commit normally rather than saturate, or — if the constant *grew* —
// the fill would be a partial fill and miss the cap by definition).
const MAX_REDEEMED_SIGNATURES = 100_000;

// Hoisting guard: declared `let` and assigned in `before()` after the
// env is set. The dynamic import below resolves a CJS module under
// `tsx --test`; the `default` export is the relay's namespace.
type RelayModule = typeof import("../index.js");
let relay: RelayModule;

describe("AUD-209: redeemed-signature saturation guard (fail-closed 503)", () => {
  before(async () => {
    // Deferred dynamic import: env is fully set above before we trigger
    // the relay's module-load side effects. If we'd imported statically
    // at the top of the file, ESM hoisting (or the CJS-equivalent
    // import-fold under tsx's loader) could run the relay's
    // `process.env.PAYMENT_RECIPIENT` read *before* our assignment —
    // the symptom is a 500 ("Relay not configured") instead of the 503
    // we're asserting on, with the relay log line
    // `recipient: "(not configured)"`.
    relay = await import("../index.js");
    // Make sure we start from a clean slate even if some other test
    // module ran first and mutated module state.
    relay.__resetRedemptionStateForTests();
  });

  after(async () => {
    // Drop the pre-seeded entries and shut the listener down so
    // `node:test` exits cleanly. Without `server.close()` the event loop
    // stays alive and the runner hangs past the last subtest.
    relay.__resetRedemptionStateForTests();
    await new Promise<void>((resolve, reject) => {
      (relay.server as Server).close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    // Each subtest starts with an empty map; the saturation subtest
    // re-fills explicitly. Prevents earlier subtests from leaking state.
    relay.__resetRedemptionStateForTests();
  });

  it("processPaymentRequest returns kind:'saturated' at cap for a new signature", async () => {
    // Pre-seed the map up to the saturation threshold without driving
    // 100k real `processPaymentRequest` calls through the verifier.
    relay.__fillRedemptionStateForTests(MAX_REDEEMED_SIGNATURES);

    // The verifier MUST report a valid payment — we want the saturation
    // branch (post-verify, post-redeemed-recheck) to fire, not the
    // `kind: "invalid"` branch that runs when verification fails.
    const verifier = async () => ({
      valid: true,
      sender: "MOCK_SENDER",
      recipient: "MOCK_RECIPIENT",
      amountSol: 0.01,
      slot: 1,
    });

    // A signature we have NOT seen before — guarantees the
    // `redeemedSignatures.has(txSignature)` recheck returns false, so
    // execution proceeds to the size-cap check. (If we'd reused a
    // pre-seeded `__test-fill-N` key we'd hit the redeemed-recheck and
    // return `kind: "redeemed"` instead — a different code path.)
    const newSignature = `aud-209-saturation-probe-${crypto.randomBytes(8).toString("hex")}`;
    const result = await relay.processPaymentRequest(newSignature, verifier, "MOCK_RECIPIENT");

    assert.equal(
      result.kind,
      "saturated",
      `expected kind:'saturated' at map cap; got kind:'${result.kind}'`,
    );

    // Saturation must NOT register the rejected signature in the
    // redemption map. We can't introspect the private map directly, but
    // we verify the observable consequence: a second call with the same
    // new signature must again return "saturated" (not "redeemed"),
    // proving the first call did not commit. Adding it would (a) cross
    // the cap and (b) mark a never-redeemed signature as redeemed,
    // breaking the 1-payment-1-token invariant on the eventual retry.
    const secondCall = await relay.processPaymentRequest(newSignature, verifier, "MOCK_RECIPIENT");
    assert.equal(
      secondCall.kind,
      "saturated",
      "saturated branch must NOT commit the signature; second call should still saturate, not return 'redeemed'",
    );
  });
});
