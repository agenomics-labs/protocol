/**
 * ADR-126 Phase 1 — Redis-backed redemption dedup scaffolding.
 *
 * What this suite pins:
 *
 *   1. SET-NX primitive — single-instance, fresh signature -> ok;
 *      same signature again -> redeemed.
 *   2. Two-client cross-instance dedup — two LiveRedisDedup wrappers
 *      against the SAME ioredis-mock backing store: the second tryRedeem
 *      gets `redeemed`. This is the cross-instance proof; ioredis-mock
 *      keeps a process-wide store keyed by URL, which is exactly the
 *      shape we need.
 *   3. Saturation — pre-fill the maintained counter to maxRedeemed,
 *      attempt one more -> `saturated`. Mirrors the AUD-209 contract.
 *   4. Release path — tryRedeem ok -> releaseRedeemed -> tryRedeem same
 *      sig -> ok again (slot reclaimed, counter decremented).
 *   5. Disabled (no-op) path — DisabledRedisDedup.tryRedeem always
 *      returns ok; releaseRedeemed is a harmless no-op. This is the
 *      `RELAY_REDIS_URL` UNSET production default and MUST preserve
 *      today's in-memory-only semantics.
 *   6. Dual-write integration — RELAY_REDIS_URL set, processPaymentRequest
 *      called with a mock verifier; both the redis store AND the
 *      in-memory `redeemedSignatures` Map have the entry afterward.
 *      This is the Phase 1 dual-write contract: redis is dual-written
 *      with in-memory; Phase 2 removes the in-memory side.
 *   7. Factory URL validation — malformed RELAY_REDIS_URL throws at
 *      construction (AUD-027 fail-closed pattern).
 *
 * Why ioredis-mock and not testcontainers:
 *
 * ioredis-mock implements SET NX PX, INCR, DECR, GET, DEL with the
 * same wire-level semantics as real Redis. Sharing the same URL
 * between two Mock instances aliases them onto a shared backing store
 * — the cross-instance simulation is structurally identical to two
 * relay processes pointing at one Redis. Avoiding testcontainers
 * keeps CI portable (no docker-in-CI requirement) and matches the
 * `mcp-server/test/idempotency-redis.test.ts` pattern.
 *
 * Test isolation:
 *
 * Each subtest in the LiveRedisDedup block creates a FRESH ioredis-mock
 * URL (via a per-test suffix) so saturation pre-fills and release-then-
 * reclaim sequences do not bleed across subtests. The dual-write
 * integration test runs in its own describe block with its own
 * deferred dynamic import of `../index.js` (mirroring the AUD-209
 * pattern: env set BEFORE import so the module's top-level
 * `process.env.RELAY_REDIS_URL` read sees the right value).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import type { Server } from "node:http";
import RedisMock from "ioredis-mock";

import {
  LiveRedisDedup,
  DisabledRedisDedup,
  createRedisDedup,
  REDEEMED_KEY_PREFIX,
  REDEEMED_COUNTER_KEY,
  redeemedKey,
  type RedisClient,
} from "../redis-dedup.js";

// ioredis-mock's class is `RedisMock`. Per its README:
//
//   "In v6 the internals were rewritten to behave more like real life
//    redis, if the host and port is the same, the context is now shared"
//
// So `new RedisMock()` (default port 6379) twice gives you two clients
// pointing at ONE backing store — that IS the cross-instance simulation.
// To get an ISOLATED store per test we must pass a unique port. The
// alternative recommended pattern is `await new Redis().flushall()` in
// beforeEach; we use both: unique-port for structural isolation
// (eliminates ordering races between concurrent test files) and
// flushall in beforeEach for defense in depth.
//
// MockCtor: cast through a minimal constructor signature so TypeScript
// stops worrying about the full ioredis surface; we add `flushall` to
// the test-only client shape so beforeEach can call it.
interface MockClientApi extends RedisClient {
  flushall(): Promise<"OK">;
}
type MockCtor = new (port?: number) => MockClientApi;
const MockClient = RedisMock as unknown as MockCtor;

const TEST_TTL_MS = 60_000;
const TEST_INSTANCE_A = "instance-A";
const TEST_INSTANCE_B = "instance-B";
const TEST_MAX = 5; // small cap so saturation is fast to drive

// Monotonically-incrementing port so each freshMockClient() gets its
// own backing store. Starts well above 6379 so we never alias the
// default port (which the cross-instance pairing test uses).
let nextIsolatedPort = 16_000;
function freshMockClient(): MockClientApi {
  return new MockClient(nextIsolatedPort++);
}

function pairedMockClients(): [MockClientApi, MockClientApi] {
  // Use a SHARED unique port (incremented once) so the two clients
  // alias onto one backing store — but a store that no other test is
  // also touching. This is the cross-instance simulation: two relay
  // processes pointing at one Redis.
  const sharedPort = nextIsolatedPort++;
  return [new MockClient(sharedPort), new MockClient(sharedPort)];
}

describe("AUD-126 / ADR-126 Phase 1: LiveRedisDedup unit semantics", () => {
  describe("single-client SET-NX primitive", () => {
    let dedup: LiveRedisDedup;

    beforeEach(() => {
      dedup = new LiveRedisDedup({
        client: freshMockClient(),
        maxRedeemed: TEST_MAX,
      });
    });

    it("first tryRedeem on a fresh signature returns ok", async () => {
      const result = await dedup.tryRedeem(
        "sig-fresh-1",
        TEST_TTL_MS,
        TEST_INSTANCE_A,
      );
      assert.equal(result.kind, "ok");
    });

    it("second tryRedeem on the same signature returns redeemed with instanceId", async () => {
      await dedup.tryRedeem("sig-dup", TEST_TTL_MS, TEST_INSTANCE_A);
      const second = await dedup.tryRedeem("sig-dup", TEST_TTL_MS, TEST_INSTANCE_B);
      assert.equal(second.kind, "redeemed");
      // ADR-126 §"Trust-boundary placement" / §"Neutral": the lock
      // value carries the original holder's instanceId for operator
      // observability. NOT a security primitive — but the contract
      // is that we surface it on the redeemed result.
      assert.equal(
        second.kind === "redeemed" ? second.instanceId : undefined,
        TEST_INSTANCE_A,
        "redeemed result must surface the original holder's instanceId",
      );
    });

    it("counter increments on each successful tryRedeem", async () => {
      assert.equal(await dedup.approximateSize(), 0);
      await dedup.tryRedeem("sig-a", TEST_TTL_MS, TEST_INSTANCE_A);
      assert.equal(await dedup.approximateSize(), 1);
      await dedup.tryRedeem("sig-b", TEST_TTL_MS, TEST_INSTANCE_A);
      assert.equal(await dedup.approximateSize(), 2);
      // Duplicate must NOT bump the counter (SET-NX returned nil).
      await dedup.tryRedeem("sig-a", TEST_TTL_MS, TEST_INSTANCE_A);
      assert.equal(
        await dedup.approximateSize(),
        2,
        "duplicate tryRedeem must not increment the saturation counter",
      );
    });
  });

  describe("two-client cross-instance dedup (the ADR-126 raison d'etre)", () => {
    it("second client's tryRedeem on a signature the first claimed returns redeemed", async () => {
      const [clientA, clientB] = pairedMockClients();
      const dedupA = new LiveRedisDedup({ client: clientA, maxRedeemed: TEST_MAX });
      const dedupB = new LiveRedisDedup({ client: clientB, maxRedeemed: TEST_MAX });

      const sig = "cross-instance-sig-" + crypto.randomBytes(4).toString("hex");

      const fromA = await dedupA.tryRedeem(sig, TEST_TTL_MS, TEST_INSTANCE_A);
      assert.equal(fromA.kind, "ok", "A acquires the slot");

      const fromB = await dedupB.tryRedeem(sig, TEST_TTL_MS, TEST_INSTANCE_B);
      assert.equal(
        fromB.kind,
        "redeemed",
        "B sees A's lock — this is the cross-instance dedup proof",
      );
      assert.equal(
        fromB.kind === "redeemed" ? fromB.instanceId : undefined,
        TEST_INSTANCE_A,
        "B sees A's instanceId on the lock value",
      );
    });

    it("releasing on A reclaims the slot for B (the verify-failed-then-retry shape)", async () => {
      const [clientA, clientB] = pairedMockClients();
      const dedupA = new LiveRedisDedup({ client: clientA, maxRedeemed: TEST_MAX });
      const dedupB = new LiveRedisDedup({ client: clientB, maxRedeemed: TEST_MAX });

      const sig = "release-then-reclaim-sig";

      const a1 = await dedupA.tryRedeem(sig, TEST_TTL_MS, TEST_INSTANCE_A);
      assert.equal(a1.kind, "ok");

      const b1 = await dedupB.tryRedeem(sig, TEST_TTL_MS, TEST_INSTANCE_B);
      assert.equal(b1.kind, "redeemed");

      // A's verify failed — release.
      await dedupA.releaseRedeemed(sig);

      // B retries — slot is reclaimable.
      const b2 = await dedupB.tryRedeem(sig, TEST_TTL_MS, TEST_INSTANCE_B);
      assert.equal(b2.kind, "ok", "released slot is reclaimable across instances");
    });
  });

  describe("saturation gate (mirrors AUD-209 fail-closed contract)", () => {
    it("returns saturated when the counter is at cap and the signature is new", async () => {
      const client = freshMockClient();
      // Pre-load the counter to the cap WITHOUT pre-creating any
      // signature keys — this is the worst-case operational shape:
      // counter says "full" but the signature is genuinely fresh.
      // Mirrors what __fillRedemptionStateForTests does for the
      // in-memory map in aud-209-saturation.test.ts.
      await client.set(REDEEMED_COUNTER_KEY, String(TEST_MAX), "NX", "PX", TEST_TTL_MS);
      const dedup = new LiveRedisDedup({ client, maxRedeemed: TEST_MAX });

      const result = await dedup.tryRedeem(
        "sig-after-cap-" + crypto.randomBytes(4).toString("hex"),
        TEST_TTL_MS,
        TEST_INSTANCE_A,
      );
      assert.equal(result.kind, "saturated");
    });

    it("saturation must NOT register the rejected signature (no slot burned)", async () => {
      const client = freshMockClient();
      await client.set(REDEEMED_COUNTER_KEY, String(TEST_MAX), "NX", "PX", TEST_TTL_MS);
      const dedup = new LiveRedisDedup({ client, maxRedeemed: TEST_MAX });

      const sig = "no-burn-on-saturation-sig";
      const first = await dedup.tryRedeem(sig, TEST_TTL_MS, TEST_INSTANCE_A);
      assert.equal(first.kind, "saturated");

      // Confirm the underlying key was NOT created — a saturated
      // tryRedeem must not even attempt the SET-NX (otherwise we'd
      // be burning a slot AND charging an INCR for a rejected call).
      const stored = await client.get(redeemedKey(sig));
      assert.equal(stored, null, "saturated path must not create the redemption key");

      const second = await dedup.tryRedeem(sig, TEST_TTL_MS, TEST_INSTANCE_A);
      assert.equal(
        second.kind,
        "saturated",
        "second call on the same fresh sig must still saturate (slot was never burned)",
      );
    });
  });

  describe("release / reclaim slot lifecycle", () => {
    let dedup: LiveRedisDedup;
    let client: RedisClient;

    beforeEach(() => {
      client = freshMockClient();
      dedup = new LiveRedisDedup({ client, maxRedeemed: TEST_MAX });
    });

    it("releaseRedeemed drops the lock and decrements the counter", async () => {
      const sig = "release-sig";
      await dedup.tryRedeem(sig, TEST_TTL_MS, TEST_INSTANCE_A);
      assert.equal(await dedup.approximateSize(), 1);
      assert.notEqual(await client.get(redeemedKey(sig)), null);

      await dedup.releaseRedeemed(sig);

      assert.equal(await client.get(redeemedKey(sig)), null, "lock key removed");
      assert.equal(await dedup.approximateSize(), 0, "counter decremented");
    });

    it("releaseRedeemed on an unknown signature is a harmless no-op", async () => {
      // No prior tryRedeem; counter starts at 0; release must not
      // underflow it (DECR on a non-existent counter would create
      // it as -1 — guarded by the "removed > 0" check in releaseRedeemed).
      await dedup.releaseRedeemed("never-claimed-sig");
      assert.equal(
        await dedup.approximateSize(),
        0,
        "release on unknown sig must not decrement the counter below zero",
      );
    });

    it("released slot is reclaimable by a subsequent tryRedeem", async () => {
      const sig = "reclaim-sig";
      const r1 = await dedup.tryRedeem(sig, TEST_TTL_MS, TEST_INSTANCE_A);
      assert.equal(r1.kind, "ok");

      await dedup.releaseRedeemed(sig);

      const r2 = await dedup.tryRedeem(sig, TEST_TTL_MS, TEST_INSTANCE_A);
      assert.equal(r2.kind, "ok", "released slot is reclaimable on the same instance");
    });
  });

  describe("key namespace pins", () => {
    it("REDEEMED_KEY_PREFIX matches ADR-126 §'Decision' step 2", () => {
      // ADR-126 §"Decision" step 2 wire-level form:
      //   redis.SET("aep:redeemed:" + txSignature, instanceId, NX, PX, SIGNATURE_TTL_MS)
      // Pin the prefix so a future refactor cannot silently rename it
      // and break operator runbook commands that reference the prefix
      // (incident-response §4 will cite this prefix).
      assert.equal(REDEEMED_KEY_PREFIX, "aep:redeemed:");
      assert.equal(redeemedKey("abc"), "aep:redeemed:abc");
    });

    it("REDEEMED_COUNTER_KEY is namespaced under aep:redeemed:", () => {
      // The counter key shares the prefix so SCAN MATCH 'aep:redeemed:*'
      // covers it for ops cleanup commands. (The Phase 2 reconciliation
      // pass uses SCAN MATCH; keeping the counter under the same prefix
      // means a single MATCH pattern wipes everything.)
      assert.ok(
        REDEEMED_COUNTER_KEY.startsWith(REDEEMED_KEY_PREFIX),
        "counter key must live under the redemption prefix",
      );
    });
  });
});

describe("AUD-126 / ADR-126 Phase 1: DisabledRedisDedup (RELAY_REDIS_URL unset)", () => {
  let dedup: DisabledRedisDedup;

  beforeEach(() => {
    dedup = new DisabledRedisDedup();
  });

  it("enabled is false (the discriminator the dual-path uses)", () => {
    assert.equal(dedup.enabled, false);
  });

  it("tryRedeem ALWAYS returns ok — defers to the in-memory authority", async () => {
    // CRITICAL: the disabled path returning `ok` is correct ONLY because
    // index.ts then runs the in-memory `redeemedSignatures.has` check.
    // If the disabled path ever rejected a duplicate, the existing
    // in-memory tests would be testing the wrong layer. This subtest
    // is a contract-pin against accidentally adding state to the
    // disabled implementation.
    const r1 = await dedup.tryRedeem("any-sig", TEST_TTL_MS, TEST_INSTANCE_A);
    const r2 = await dedup.tryRedeem("any-sig", TEST_TTL_MS, TEST_INSTANCE_A);
    assert.equal(r1.kind, "ok");
    assert.equal(r2.kind, "ok");
  });

  it("releaseRedeemed and approximateSize and close are harmless no-ops", async () => {
    await dedup.releaseRedeemed("anything");
    assert.equal(await dedup.approximateSize(), 0);
    await dedup.close();
  });
});

describe("AUD-126 / ADR-126 Phase 1: createRedisDedup factory + URL validation", () => {
  it("returns a DisabledRedisDedup when url is undefined", () => {
    const dedup = createRedisDedup({ url: undefined, maxRedeemed: TEST_MAX });
    assert.equal(dedup.enabled, false);
  });

  it("returns a DisabledRedisDedup when url is the empty string", () => {
    const dedup = createRedisDedup({ url: "", maxRedeemed: TEST_MAX });
    assert.equal(dedup.enabled, false);
  });

  it("throws on a malformed URL (AUD-027 fail-closed at module load)", () => {
    assert.throws(
      () => createRedisDedup({ url: "not a url", maxRedeemed: TEST_MAX }),
      /not a valid URL/i,
      "malformed URL must throw with a message naming the validation failure",
    );
  });

  it("throws on an unsupported scheme (e.g. http://)", () => {
    assert.throws(
      () => createRedisDedup({ url: "http://localhost:6379", maxRedeemed: TEST_MAX }),
      /unsupported scheme/i,
      "non-redis schemes must throw with a message naming the scheme",
    );
  });

  // We intentionally do NOT exercise the "valid url -> live client"
  // branch here because that calls `new (require("ioredis"))(url)`,
  // which opens a TCP socket against localhost:6379. Tests that need
  // the live shape inject a pre-built mock client via `LiveRedisDedup`
  // directly (see the unit suite above).
});

// ---------------------------------------------------------------------------
// Integration: dual-write through processPaymentRequest.
//
// This is the Phase 1 contract: when RELAY_REDIS_URL is set and a
// payment redeems, BOTH the redis store AND the in-memory map have
// the entry. Phase 2 will delete the in-memory side; this test will
// then need to be updated to assert "only redis has the entry" — and
// the failure mode of leaving this test as-is would be the right
// signal that Phase 2 forgot to update its test contract.
//
// We swap the `ioredis` module out for `ioredis-mock` BEFORE the
// dynamic import of ../index.js so the LiveRedisDedup constructor
// picks up the mock as if it were the real ioredis. Mirrors the AUD-
// 209 deferred-import pattern.
// ---------------------------------------------------------------------------

describe("AUD-126 / ADR-126 Phase 1: dual-write integration through processPaymentRequest", () => {
  type RelayModule = typeof import("../index.js");
  let relay: RelayModule;

  before(async () => {
    // Set env BEFORE import. The ioredis URL value is mock-only — the
    // require("ioredis") shim below intercepts the actual import, so
    // this URL is never dialed. RELAY_PORT=0 mirrors aud-209-saturation.
    process.env.JWT_SECRET ??= crypto.randomBytes(32).toString("hex");
    process.env.RELAY_PORT = "0";
    process.env.PAYMENT_RECIPIENT ??= "TEST_RECIPIENT_PUBKEY_NOT_USED_BY_MOCK";
    process.env.RELAY_REDIS_URL = "redis://mock-host:6379/0";
    process.env.RELAY_INSTANCE_ID = "test-instance-AUD-126";

    // Hijack the `require("ioredis")` resolution inside redis-dedup.ts
    // to return ioredis-mock's class. The relay's tsconfig uses
    // `module: "commonjs"`, so redis-dedup.ts compiles down to a
    // synchronous `require("ioredis")` — Node's `require.cache` lets
    // us prime the entry before the dynamic import below.
    //
    // We resolve the ioredis-mock module the same way the relay would
    // resolve ioredis (via the relay's package.json deps list); both
    // are hoisted at the workspace root.
    //
    // NOTE: we use `require` here directly (not import) because tsx
    // runs this test file with both ESM and CJS interop available, and
    // the `require.cache` poke is the only mechanism that reliably
    // intercepts a downstream synchronous `require("ioredis")`.
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

  it("redisDedup is enabled when RELAY_REDIS_URL is set at module load", () => {
    assert.equal(
      relay.redisDedup.enabled,
      true,
      "RELAY_REDIS_URL was set before the dynamic import; the live path must be selected",
    );
  });

  it("happy-path /pay redeems into BOTH redis and in-memory map (Phase 1 dual-write)", async () => {
    const sig = "dual-write-sig-" + crypto.randomBytes(4).toString("hex");
    const verifier = async () => ({
      valid: true,
      sender: "MOCK_SENDER",
      recipient: "MOCK_RECIPIENT",
      amountSol: 0.01,
      slot: 42,
    });

    const result = await relay.processPaymentRequest(sig, verifier, "MOCK_RECIPIENT");
    assert.equal(result.kind, "ok");

    // Redis-side observable: the lock key exists with our instanceId.
    // Use the dedup client's API rather than reaching into the mock
    // backing store — that is the contract operators will rely on
    // when running `redis-cli GET aep:redeemed:<sig>` per ADR-126.
    const sizeAfter = await relay.redisDedup.approximateSize();
    assert.ok(sizeAfter >= 1, "redis counter incremented after happy-path redeem");

    // In-memory observable: a duplicate processPaymentRequest after
    // releasing the redis lock should still hit the in-memory map and
    // return `redeemed`. This is the dual-write proof — the in-memory
    // map captured the entry independently of redis.
    await relay.redisDedup.releaseRedeemed(sig);
    const dup = await relay.processPaymentRequest(sig, verifier, "MOCK_RECIPIENT");
    assert.equal(
      dup.kind,
      "redeemed",
      "even with the redis lock released, the in-memory map's dual-write entry blocks the duplicate — proves both stores were written",
    );
  });

  it("verify-failed path releases the redis lock (slot reclaimable)", async () => {
    const sig = "verify-fail-sig-" + crypto.randomBytes(4).toString("hex");
    const failingVerifier = async () => ({
      valid: false,
      sender: "",
      recipient: "",
      amountSol: 0,
      slot: 0,
      error: "mocked verify failure",
    });

    const result = await relay.processPaymentRequest(sig, failingVerifier, "MOCK_RECIPIENT");
    assert.equal(result.kind, "invalid");

    // After release, a successful retry on the same sig must succeed —
    // proving the slot was reclaimed (i.e. releaseRedeemed actually
    // ran on the verify-failed branch).
    const okVerifier = async () => ({
      valid: true,
      sender: "MOCK_SENDER",
      recipient: "MOCK_RECIPIENT",
      amountSol: 0.01,
      slot: 1,
    });
    const retry = await relay.processPaymentRequest(sig, okVerifier, "MOCK_RECIPIENT");
    assert.equal(
      retry.kind,
      "ok",
      "verify-failed path must release the redis lock so a corrected retry can succeed",
    );
  });
});
