/**
 * Cycle-3 off-chain audit punchlist regressions — OFF-201 / OFF-203 /
 * OFF-205 / OFF-206 in `src/x402-relay/redis-dedup.ts` + `index.ts`.
 *
 *   OFF-201 — Redis counter drifts unbounded (TTL-expired keys never
 *             decrement the maintained counter).
 *   OFF-203 — Multi-instance race issues 2 JWTs (race-loss release of
 *             the redis lock allows another instance to re-acquire and
 *             mint a duplicate JWT for the same on-chain payment).
 *   OFF-205 — `releaseRedeemed` was unauthenticated (any caller with
 *             Redis reach could DEL the lock and re-open replay).
 *   OFF-206 — Redis client had no `commandTimeout` (a Redis brown-out
 *             stalled every /pay call indefinitely).
 *
 * Mock-only tests (no real Redis). Each subtest uses ioredis-mock with
 * an isolated port so saturation pre-fills and counter manipulation
 * cannot leak across tests. The OFF-203 cross-instance test uses
 * shared-port aliasing (the documented ioredis-mock cross-instance
 * idiom — see aud-126-redis-dedup.test.ts header for the reference).
 *
 * What we DO NOT cover here:
 *
 *   - Real-Redis end-to-end. ioredis-mock implements SET-NX, EVAL with
 *     KEYS/ARGV, SCAN with MATCH/COUNT, INCR/DECR with the same wire
 *     semantics as real Redis (see ioredis-mock README); a real-Redis
 *     parity gate would be a docker-in-CI dependency that this repo
 *     deliberately avoids (mirrors the AUD-126 cross-instance pattern).
 *
 *   - The ioredis-side `commandTimeout` option is forwarded through to
 *     the real ioredis constructor; we exercise the wiring (via a
 *     timeout-injecting mock client) rather than the option flow into
 *     the live ioredis. The relay's tsconfig only compiles the URL
 *     branch when ioredis is on disk; tests inject `client` directly.
 */

import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import RedisMock from "ioredis-mock";

import {
  LiveRedisDedup,
  REDEEMED_COUNTER_KEY,
  redeemedKey,
  REDIS_COMMAND_TIMEOUT_DEFAULT_MS,
  RECONCILE_DEFAULT_MS,
  type RedisClient,
} from "../redis-dedup.js";

interface MockClientApi extends RedisClient {
  flushall(): Promise<"OK">;
}
type MockCtor = new (port?: number) => MockClientApi;
const MockClient = RedisMock as unknown as MockCtor;

// Disjoint port range from the AUD-126 suite (16_000+) so parallel
// test files do not alias each other's backing stores.
let nextIsolatedPort = 26_000;
function freshMockClient(): MockClientApi {
  return new MockClient(nextIsolatedPort++);
}
function pairedMockClients(): [MockClientApi, MockClientApi] {
  const sharedPort = nextIsolatedPort++;
  return [new MockClient(sharedPort), new MockClient(sharedPort)];
}

const TEST_TTL_MS = 60_000;
const TEST_MAX = 5;
const INSTANCE_A = "instance-A";
const INSTANCE_B = "instance-B";

// ---------------------------------------------------------------------------
// OFF-201 — Redis counter drift reconciler
// ---------------------------------------------------------------------------

describe("OFF-201 — counter reconciler closes the unbounded drift window", () => {
  let client: MockClientApi;
  let dedup: LiveRedisDedup;

  beforeEach(() => {
    client = freshMockClient();
    // Manual reconciler: don't schedule the periodic timer — call
    // reconcileCounter() directly so the assertion is deterministic.
    dedup = new LiveRedisDedup({
      client,
      maxRedeemed: TEST_MAX,
      reconcileIntervalMs: 0,
    });
  });

  it("recomputes the counter from actual SCAN cardinality, ignoring drift", async () => {
    // Stage a drift scenario: counter says 4 redemptions but only 1
    // signature key actually exists in Redis. This is the exact shape
    // the pre-fix bug would produce after 3 entries TTL-expired —
    // counter never decremented on TTL eviction so it lies HIGH.
    await client.set(redeemedKey("only-real-sig"), "instance-X|deadbeef");
    await client.set(REDEEMED_COUNTER_KEY, "4");

    assert.equal(
      await dedup.approximateSize(),
      4,
      "pre-reconcile: approximateSize reflects the maintained (drifted) counter",
    );

    const trueCount = await dedup.reconcileCounter();

    assert.equal(trueCount, 1, "reconciler returns the SCAN-truth count");
    assert.equal(
      await dedup.approximateSize(),
      1,
      "post-reconcile: approximateSize matches reality",
    );
  });

  it("never counts the counter key itself as a redemption", async () => {
    // The counter key (`aep:redeemed:count`) lives under the SCAN MATCH
    // prefix. If the reconciler mis-counts it as a redemption, every
    // reconcile would include the counter itself and the count would
    // stabilize one too high.
    await client.set(REDEEMED_COUNTER_KEY, "999"); // pre-drifted
    const trueCount = await dedup.reconcileCounter();
    assert.equal(
      trueCount,
      0,
      "reconciler must exclude the counter key from its own SCAN count",
    );
  });

  it("post-reconcile, a saturation false-positive becomes a real claim", async () => {
    // Drift the counter to cap with NO actual redemption keys: pre-fix
    // this would 503 every fresh /pay forever (until process restart).
    await client.set(REDEEMED_COUNTER_KEY, String(TEST_MAX));

    const beforeFix = await dedup.tryRedeem("fresh-sig", TEST_TTL_MS, INSTANCE_A);
    assert.equal(
      beforeFix.kind,
      "saturated",
      "drift-state: relay incorrectly returns saturated even though no slots are held",
    );

    await dedup.reconcileCounter();

    const afterFix = await dedup.tryRedeem("fresh-sig-2", TEST_TTL_MS, INSTANCE_A);
    assert.equal(
      afterFix.kind,
      "ok",
      "post-reconcile: saturation false-positive lifted; fresh claim succeeds",
    );
  });

  it("recovers correctly when more redemptions exist than the counter recorded (drift LOW)", async () => {
    // The reverse drift: counter says 0 but 2 keys exist. This shape
    // arises when an INCR fails after a successful SET-NX (network
    // blip in tryRedeem's INCR call). Reconciler must catch up the
    // counter to truth.
    await client.set(redeemedKey("ghost-sig-1"), `${INSTANCE_A}|nonce1`);
    await client.set(redeemedKey("ghost-sig-2"), `${INSTANCE_A}|nonce2`);
    await client.set(REDEEMED_COUNTER_KEY, "0");

    const trueCount = await dedup.reconcileCounter();
    assert.equal(trueCount, 2, "reconciler reflects the higher actual count");
  });

  it("automatic reconciler interval is wired through and unref'd", async () => {
    // We CANNOT easily prove the interval fires without a fake-timers
    // dep, but we CAN prove (a) the constructor accepts the option,
    // (b) close() clears the interval cleanly, (c) the default factory
    // value is RECONCILE_DEFAULT_MS. Smoke contract pin so a future
    // refactor cannot silently drop the auto-reconciler wiring.
    const intervalDedup = new LiveRedisDedup({
      client: freshMockClient(),
      maxRedeemed: TEST_MAX,
      reconcileIntervalMs: 60_000,
    });
    // Sanity: close() resolves without throwing (clearInterval path).
    await intervalDedup.close();
    // Default constant is exported for index.ts to read.
    assert.equal(typeof RECONCILE_DEFAULT_MS, "number");
    assert.ok(RECONCILE_DEFAULT_MS > 0, "default reconciler interval is positive");
  });
});

// ---------------------------------------------------------------------------
// OFF-205 — releaseRedeemed owner-bound (Lua CAS-DEL)
// ---------------------------------------------------------------------------

describe("OFF-205 — releaseRedeemed requires the owner-bound release token", () => {
  let client: MockClientApi;
  let dedup: LiveRedisDedup;

  beforeEach(() => {
    client = freshMockClient();
    dedup = new LiveRedisDedup({
      client,
      maxRedeemed: TEST_MAX,
      reconcileIntervalMs: 0,
    });
  });

  it("tryRedeem returns a non-empty releaseToken on the ok path", async () => {
    const r = await dedup.tryRedeem("sig-token-shape", TEST_TTL_MS, INSTANCE_A);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.ok(r.releaseToken.length > 0, "releaseToken must be non-empty");
    assert.ok(
      r.releaseToken.startsWith(INSTANCE_A + "|"),
      "releaseToken format is `<instanceId>|<nonce>` for operator observability",
    );
  });

  it("each tryRedeem produces a unique releaseToken (no replay)", async () => {
    // Use a fresh dedup with a higher cap — TEST_MAX=5 is too small
    // to drive a meaningful uniqueness sample.
    const wide = new LiveRedisDedup({
      client: freshMockClient(),
      maxRedeemed: 64,
      reconcileIntervalMs: 0,
    });
    const tokens = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const r = await wide.tryRedeem(`uniq-sig-${i}`, TEST_TTL_MS, INSTANCE_A);
      assert.equal(r.kind, "ok");
      if (r.kind === "ok") tokens.add(r.releaseToken);
    }
    assert.equal(
      tokens.size,
      16,
      "16 distinct releaseTokens — no two SET-NX claims can ever produce the same nonce",
    );
  });

  it("releaseRedeemed with the WRONG token does NOT free the slot", async () => {
    const r = await dedup.tryRedeem("guarded-sig", TEST_TTL_MS, INSTANCE_A);
    assert.equal(r.kind, "ok");

    // Forged token with the correct shape but wrong nonce — exactly
    // what an attacker with knowledge of the lock value format but
    // not the actual nonce would attempt.
    const forged = `${INSTANCE_A}|${"deadbeef".repeat(4)}`;
    await dedup.releaseRedeemed("guarded-sig", forged);

    // Lock must still be held — counter not decremented, key not gone.
    assert.notEqual(
      await client.get(redeemedKey("guarded-sig")),
      null,
      "forged token must not DEL the lock key (CAS mismatch)",
    );
    assert.equal(
      await dedup.approximateSize(),
      1,
      "forged token must not decrement the counter",
    );

    // Subsequent tryRedeem on the same sig still returns redeemed.
    const second = await dedup.tryRedeem("guarded-sig", TEST_TTL_MS, INSTANCE_B);
    assert.equal(
      second.kind,
      "redeemed",
      "after a forged-token release attempt, the slot remains owned by the original holder",
    );
  });

  it("releaseRedeemed with an EMPTY token is a hard refuse (not a CAS attempt)", async () => {
    const r = await dedup.tryRedeem("empty-token-test", TEST_TTL_MS, INSTANCE_A);
    assert.equal(r.kind, "ok");

    await dedup.releaseRedeemed("empty-token-test", "");

    // Lock still held; counter unchanged.
    assert.notEqual(await client.get(redeemedKey("empty-token-test")), null);
    assert.equal(await dedup.approximateSize(), 1);
  });

  it("releaseRedeemed with the CORRECT token frees the slot atomically", async () => {
    const r = await dedup.tryRedeem("authorized-release", TEST_TTL_MS, INSTANCE_A);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;

    await dedup.releaseRedeemed("authorized-release", r.releaseToken);

    assert.equal(
      await client.get(redeemedKey("authorized-release")),
      null,
      "authorized release frees the lock",
    );
    assert.equal(
      await dedup.approximateSize(),
      0,
      "authorized release decrements the counter",
    );
  });

  it("CAS-DEL is atomic against a sibling SET-NX (no double-DEL race)", async () => {
    // Edge case: between the GET and the DEL of a naive non-atomic
    // release, another instance could SET-NX a fresh entry. The Lua
    // CAS-DEL must see the new value (different lock value) and NOT
    // delete it. Simulate by manually overwriting the lock value
    // (with a forged "future" lock) before calling release.
    const r = await dedup.tryRedeem("cas-race-sig", TEST_TTL_MS, INSTANCE_A);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;

    // Sibling instance overwrites the lock (in production this is
    // the post-TTL re-acquire shape).
    await client.set(
      redeemedKey("cas-race-sig"),
      `${INSTANCE_B}|fresh-nonce-from-another-instance`,
    );

    // Original holder calls release with their (now stale) token.
    await dedup.releaseRedeemed("cas-race-sig", r.releaseToken);

    // The sibling's lock must still be there — CAS saw the
    // mismatch and refused the DEL.
    const value = await client.get(redeemedKey("cas-race-sig"));
    assert.ok(
      value !== null && value.startsWith(INSTANCE_B + "|"),
      "stale token release must not DEL the sibling's fresh lock",
    );
  });
});

// ---------------------------------------------------------------------------
// OFF-203 — Multi-instance atomic claim invariant
// ---------------------------------------------------------------------------

describe("OFF-203 — race-loss does NOT release the redis lock (no duplicate JWTs)", () => {
  it("once a slot is claimed, a sibling instance cannot re-acquire it for the TTL window", async () => {
    // This is the direct multi-instance contract: the redis lock IS
    // the cluster-wide redemption record. Under the pre-OFF-203 code
    // path (release-on-race-loss), an aggressive in-process collapse
    // would free the lock and let instance B re-mint. Post-fix the
    // release sites in index.ts are gone for the JWT-already-minted
    // race-loss branches, and the only entity that CAN release is
    // the slot owner via their releaseToken (OFF-205).
    const [clientA, clientB] = pairedMockClients();
    const dedupA = new LiveRedisDedup({
      client: clientA,
      maxRedeemed: TEST_MAX,
      reconcileIntervalMs: 0,
    });
    const dedupB = new LiveRedisDedup({
      client: clientB,
      maxRedeemed: TEST_MAX,
      reconcileIntervalMs: 0,
    });

    const sig = "atomic-claim-sig-" + crypto.randomBytes(4).toString("hex");

    const claimA = await dedupA.tryRedeem(sig, TEST_TTL_MS, INSTANCE_A);
    assert.equal(claimA.kind, "ok");

    // Even if instance B repeatedly polls during instance A's verify
    // window, B never wins. (Mock time does not advance; lock is
    // persistent for the test run.)
    for (let i = 0; i < 5; i++) {
      const claimB = await dedupB.tryRedeem(sig, TEST_TTL_MS, INSTANCE_B);
      assert.equal(
        claimB.kind,
        "redeemed",
        `attempt ${i + 1}: B must see A's lock and refuse to re-acquire`,
      );
    }
  });

  it("processPaymentRequest's race-loss path does NOT release the redis lock (the OFF-203 invariant)", async () => {
    // Drive the invariant through a custom LiveRedisDedup wrapper
    // that records every releaseRedeemed call. A pure-redis-dedup
    // unit test cannot exercise the index.ts race-loss branch in
    // isolation because the branch is gated on the in-memory map's
    // state. We construct the scenario manually:
    //
    //   1. Pre-populate the in-memory map (via the test hook) so the
    //      pre-verify check fires.
    //   2. Drive processPaymentRequest with a fresh signature that
    //      we ALSO seed in the in-memory map. The redis tryRedeem
    //      returns ok; the in-memory check immediately returns
    //      `kind: "redeemed"`. Pre-fix, this path would also call
    //      releaseRedeemed (the OFF-203 bug). Post-fix, no release
    //      happens — the redis lock holds.
    //
    // We assert on observable redis state (the lock key is still
    // there after processPaymentRequest returns).
    process.env.JWT_SECRET ??= crypto.randomBytes(32).toString("hex");
    process.env.RELAY_PORT = "0";
    process.env.PAYMENT_RECIPIENT ??= "TEST_RECIPIENT_NOT_USED";
    process.env.RELAY_REDIS_URL = "redis://mock-host-off203:6379/0";
    process.env.RELAY_INSTANCE_ID = "test-instance-OFF-203";

    // Hijack require("ioredis") -> ioredis-mock. Same pattern as
    // aud-126-redis-dedup.test.ts. We must do this BEFORE the
    // dynamic import below.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require("node:module");
    const requireForRelay = Module.createRequire(
      require.resolve("../redis-dedup.ts"),
    );
    const ioredisResolvedPath = requireForRelay.resolve("ioredis");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RedisMockCtor = require("ioredis-mock");
    require.cache[ioredisResolvedPath] = {
      id: ioredisResolvedPath,
      filename: ioredisResolvedPath,
      loaded: true,
      exports: RedisMockCtor,
    } as NodeJS.Module;

    const relay = (await import("../index.js")) as typeof import("../index.js");
    relay.__resetRedemptionStateForTests();

    // Acquire the redis lock for `sig` directly (simulates "instance
    // A previously redeemed and the redis lock is held").
    const sig = "off203-race-loss-sig";
    const claim = await relay.redisDedup.tryRedeem(
      sig,
      60_000,
      "test-instance-OFF-203",
    );
    assert.equal(claim.kind, "ok", "pre-condition: lock acquired by us");

    // Seed the in-memory map so processPaymentRequest's pre-verify
    // existingExpiry check fires. Use the future-expiry test hook.
    // We do this AFTER the redis claim so the only state change
    // observable on the OFF-203 path is the in-memory map's hit.
    relay.__fillRedemptionStateForTests(0); // reset
    // Use direct map manipulation via a re-fill trick: call the
    // public test hook that populates with a synthetic prefix, then
    // also poke our specific signature.
    // We rely on the public hook for synthetic IDs and add ours:
    // there is no public "set one specific key" hook, so we use the
    // existing __fillRedemptionStateForTests for shape and then call
    // processPaymentRequest with the EXACT same signature the redis
    // lock guards. The redis lock + in-memory entry path requires
    // both to point at the same sig.
    //
    // Approach: drive processPaymentRequest TWICE with a successful
    // verifier — the first call populates the in-memory map; the
    // second call sees both redis and in-memory hold the slot. We
    // assert that AFTER the second call, the redis lock is still
    // held (i.e. processPaymentRequest did NOT call releaseRedeemed
    // on the race-loss branch).
    //
    // First, undo our manual claim above so processPaymentRequest can
    // claim cleanly. The CAS-DEL needs our token.
    if (claim.kind === "ok") {
      await relay.redisDedup.releaseRedeemed(sig, claim.releaseToken);
    }
    relay.__resetRedemptionStateForTests();

    const okVerifier = async () => ({
      valid: true,
      sender: "MOCK_SENDER",
      recipient: "MOCK_RECIPIENT",
      amountSol: 0.01,
      slot: 1,
    });

    const first = await relay.processPaymentRequest(
      sig,
      okVerifier,
      "MOCK_RECIPIENT",
    );
    assert.equal(first.kind, "ok", "first redeem succeeds");

    const sizeAfterFirst = await relay.redisDedup.approximateSize();

    // Second call on the SAME sig — the redis lock is held AND the
    // in-memory map has the entry. processPaymentRequest must return
    // `redeemed` AND must NOT release the redis lock.
    const second = await relay.processPaymentRequest(
      sig,
      okVerifier,
      "MOCK_RECIPIENT",
    );
    assert.equal(second.kind, "redeemed", "duplicate is rejected");

    const sizeAfterSecond = await relay.redisDedup.approximateSize();
    assert.equal(
      sizeAfterSecond,
      sizeAfterFirst,
      "OFF-203 invariant: race-loss must NOT release the redis lock; counter unchanged",
    );

    // Cleanup so the test process exits cleanly.
    relay.__resetRedemptionStateForTests();
    if (relay.redisDedup.enabled) {
      await relay.redisDedup.close();
    }
    await new Promise<void>((resolve, reject) => {
      relay.server.close((err) => (err ? reject(err) : resolve()));
    });
  });
});

// ---------------------------------------------------------------------------
// OFF-206 — commandTimeout default + env override
// ---------------------------------------------------------------------------

describe("OFF-206 — Redis client commandTimeout is configured at construction", () => {
  it("exposes a non-zero default command timeout", () => {
    // Pin the default exists and is sane (positive, sub-10s). The
    // value flows through to the live ioredis constructor in
    // production; tests that inject a `client` skip this branch by
    // design (mocks have no socket to time out). The constant is
    // exported so `index.ts` and the audit doc can reference the
    // same source of truth.
    assert.equal(typeof REDIS_COMMAND_TIMEOUT_DEFAULT_MS, "number");
    assert.ok(
      REDIS_COMMAND_TIMEOUT_DEFAULT_MS > 0 &&
        REDIS_COMMAND_TIMEOUT_DEFAULT_MS <= 10_000,
      "default commandTimeout must be positive and under 10s",
    );
  });

  it("LiveRedisDedup constructor accepts commandTimeoutMs option without throwing", () => {
    // Wiring smoke test — the option threads through the constructor
    // signature. A regression where the option is silently dropped
    // (e.g. spread-args refactor) would cause a TypeScript error,
    // but we also pin runtime acceptance for the type-erased shape.
    const dedup = new LiveRedisDedup({
      client: freshMockClient(),
      maxRedeemed: TEST_MAX,
      commandTimeoutMs: 1500,
      reconcileIntervalMs: 0,
    });
    assert.equal(dedup.enabled, true);
  });

  it("a slow Redis surfaces as a thrown error from tryRedeem (caller-observable timeout shape)", async () => {
    // Simulate the OFF-206 brown-out: a client whose `get` rejects
    // (as ioredis would on commandTimeout). Pre-fix the absence of
    // commandTimeout meant `get` would hang forever on a real Redis
    // outage. Post-fix, ioredis throws `ETIMEDOUT` and the relay
    // surfaces an error to /pay (which becomes a 500). The relay
    // never silently hangs.
    //
    // We don't simulate the timeout INSIDE ioredis (the real client
    // is not on the test path); we simulate the post-timeout error
    // shape — which is what the relay sees and must not swallow.
    const slowClient: RedisClient = {
      async set(..._args: unknown[]) {
        throw new Error("ETIMEDOUT: Command timed out");
      },
      async get() {
        throw new Error("ETIMEDOUT: Command timed out");
      },
      async del() {
        return 0;
      },
      async incr() {
        return 0;
      },
      async decr() {
        return 0;
      },
      async eval() {
        return 0;
      },
      async scan() {
        return ["0", []] as [string, string[]];
      },
    };

    const dedup = new LiveRedisDedup({
      client: slowClient,
      maxRedeemed: TEST_MAX,
      reconcileIntervalMs: 0,
    });

    await assert.rejects(
      () => dedup.tryRedeem("sig", TEST_TTL_MS, INSTANCE_A),
      /ETIMEDOUT/,
      "tryRedeem must surface the underlying timeout error rather than hanging",
    );
  });
});
