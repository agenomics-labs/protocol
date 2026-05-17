/**
 * C4-X402-05 — a throwing verifier RELEASES the redis dedup lock.
 *
 * Source: docs/audits/_cycle4-drafts/05-x402-relay.md (C4-X402-05).
 *
 * THE BUG: `processPaymentRequest` acquires the cross-instance redis
 * dedup lock at the TOP (ADR-126 SET-NX), then awaits the verifier. The
 * release sites (verify-failed / saturation) are all AFTER the await. A
 * verifier that THREW (vs resolved valid:false) propagated the raw
 * exception out of `processPaymentRequest`, skipping every release site
 * → the slot stayed locked for the full SIGNATURE_TTL_MS across ALL
 * instances (a self-inflicted DoS on a single bad/transient request) AND
 * the raw exception escaped the ADR-117 envelope.
 *
 * THE FIX: the verifier `await` inside `processPaymentRequest` is wrapped
 * in a try/catch AT THE SITE THAT OWNS THE RELEASE TOKEN. A throw is
 * classified, the lock is released with the owner token (OFF-205 CAS-DEL),
 * and the failure is mapped to `kind:"upstream"` (→ ADR-117 5xx envelope).
 *
 * This suite MUST be its own file: `RELAY_REDIS_URL` has to be set BEFORE
 * the deferred dynamic import so `LiveRedisDedup` is selected, and the
 * relay module (with its `app.listen` side-effect) is a singleton per
 * process — sharing it with a redis-disabled suite would make
 * `redisDedup.enabled` whichever suite imported first. ioredis is
 * intercepted via the require.cache poke (identical SET-NX / Lua CAS-DEL
 * semantics to real Redis — same pattern as aud-126-redis-dedup).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import type { Server } from "node:http";
import { getBase58Decoder } from "@solana/kit";

// Env BEFORE the deferred import.
process.env.JWT_SECRET ??= crypto.randomBytes(32).toString("hex");
process.env.RELAY_PORT = "0";
process.env.PAYMENT_RECIPIENT ??= "RECIPIENT11111111111111111111111111111111";
process.env.RELAY_REDIS_URL = "redis://mock-host:6379/0";
process.env.RELAY_INSTANCE_ID = "test-instance-C4-X402-05";

const b58 = getBase58Decoder();
function validSig(): string {
  return b58.decode(new Uint8Array(crypto.randomBytes(64)));
}

describe("C4-X402-05 — throwing verifier releases the redis dedup lock", () => {
  type Relay = typeof import("../index.js");
  let relay: Relay;

  before(async () => {
    // Intercept `require("ioredis")` inside redis-dedup.ts so
    // LiveRedisDedup constructs an ioredis-mock instance. Mirrors the
    // aud-126 deferred-import + require.cache pattern exactly.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require("node:module");
    const requireForRelay = Module.createRequire(
      require.resolve("../redis-dedup.ts"),
    );
    const ioredisResolvedPath = requireForRelay.resolve("ioredis");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RedisMockCtor = require("ioredis-mock");
    require.cache[ioredisResolvedPath] = {
      id: ioredisResolvedPath,
      filename: ioredisResolvedPath,
      loaded: true,
      exports: RedisMockCtor,
    } as NodeJS.Module;

    relay = await import("../index.js");
    relay.__resetRedemptionStateForTests();
  });

  after(async () => {
    relay.__resetRedemptionStateForTests();
    if (relay.redisDedup.enabled) {
      await relay.redisDedup.close();
    }
    await new Promise<void>((resolve, reject) => {
      (relay.server as Server).close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    relay.__resetRedemptionStateForTests();
  });

  it("redisDedup is enabled (sanity — the lock path is actually exercised)", () => {
    assert.equal(
      relay.redisDedup.enabled,
      true,
      "RELAY_REDIS_URL was set before the deferred import; LiveRedisDedup must be selected",
    );
  });

  it("after a throwing verifier, the SAME signature's slot is reclaimable by another instance", async () => {
    const sig = validSig();
    const throwingVerifier = async () => {
      throw new Error("connect ECONNREFUSED http://rpc.example:8899");
    };

    const result = await relay.processPaymentRequest(
      sig,
      throwingVerifier,
      "MOCK_RECIPIENT",
    );
    // Containment: the throw did NOT escape processPaymentRequest.
    assert.equal(
      result.kind,
      "upstream",
      "a throwing verifier must be caught and mapped to kind:'upstream'",
    );

    // THE C4-X402-05 INVARIANT: the lock acquired at the TOP of
    // processPaymentRequest was released on the throw path. A FRESH
    // tryRedeem from a DIFFERENT instance must return kind:"ok"
    // (slot free). A leaked lock would return "redeemed" and stay
    // locked for the full SIGNATURE_TTL_MS.
    const probe = await relay.redisDedup.tryRedeem(
      sig,
      60_000,
      "different-instance-probe",
    );
    assert.equal(
      probe.kind,
      "ok",
      `the redis lock MUST be released on the verifier-throw path — slot leaked (got kind:'${probe.kind}')`,
    );
  });

  it("a genuine rejection (valid:false) ALSO releases the lock (no-regression guard)", async () => {
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
    const r = await relay.processPaymentRequest(
      sig,
      rejectVerifier,
      "MOCK_RECIPIENT",
    );
    assert.equal(r.kind, "invalid");
    const probe = await relay.redisDedup.tryRedeem(
      sig,
      60_000,
      "different-instance-probe-2",
    );
    assert.equal(
      probe.kind,
      "ok",
      "the verify-failed path must continue to release the lock (no regression)",
    );
  });
});
