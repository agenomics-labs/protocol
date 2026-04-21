// ADR-059 PR3 — pipeline unit tests.
//
// Covers:
//   - IdempotencyStore: mutex-per-key serialization + TTL eviction.
//   - executePreflight: cluster_health gate (mocked RPC) — fail short-circuits handler.
//   - capability-gated-tool: preflight failure prevents handler invocation.
//   - sendAndConfirmWithBlockhashExpiry: BLOCK_HEIGHT_EXCEEDED → retry, then succeed.
//
// Runs under `node --import tsx --test` — same harness as
// action-shape.test.ts and solana-v2.test.ts.

import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import {
  InMemoryIdempotencyStore,
  createIdempotencyStore,
  activeIdempotencyBackend,
} from "../src/pipeline/idempotency.js";
import { RedisIdempotencyStore } from "../src/pipeline/idempotency-redis.js";
// `ioredis-mock` ships a CommonJS default export whose constructor implements
// the subset of the `ioredis` surface we touch (`set`, `get`, `del`, `eval`,
// `quit`, …). We treat it as an opaque `RedisClient` for typing here — the
// Redis store only needs structural compatibility (see RedisClient in
// ../src/pipeline/idempotency-redis.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const IoRedisMock = require("ioredis-mock") as new () => any;
import {
  executePreflight,
  __resetClusterHealthCacheForTests,
  type PreflightDeps,
} from "../src/pipeline/preflight.js";
import {
  sendAndConfirmWithBlockhashExpiry,
  isBlockHeightExceeded,
} from "../src/pipeline/confirm.js";
import { capabilityGated } from "../src/adapters/capability-gated-tool.js";
import { ok, err } from "../src/types/action.js";
import type { Action, ActionContext, Result } from "../src/types/action.js";
import type { Capability } from "../src/types/capability.js";

const ZERO_PUBKEY = new PublicKey("11111111111111111111111111111111");

function ctxWith(caps: Capability[]): ActionContext {
  return {
    mode: "signed",
    wallet: { publicKey: ZERO_PUBKEY, capabilities: new Set(caps) },
    signer: {},
  };
}

// Small utility — resolves on a microtask tick so we can test concurrency
// without real timers.
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ==========================================================================
// IdempotencyStore
// ==========================================================================

describe("ADR-059 §5 InMemoryIdempotencyStore", () => {
  it("serializes concurrent calls with the same key (fn invoked once)", async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 60_000 });
    let invocations = 0;
    let release: ((v: Result<number>) => void) | null = null;

    const fn = () =>
      new Promise<Result<number>>((resolve) => {
        invocations++;
        release = resolve;
      });

    const p1 = store.acquire("k1", fn);
    const p2 = store.acquire("k1", fn);
    const p3 = store.acquire("k1", fn);

    // All three acquires should see the same in-flight promise.
    await tick();
    assert.equal(invocations, 1, "fn should run exactly once");

    release!(ok(42));
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.deepEqual(r1, { ok: true, data: 42 });
    assert.deepEqual(r2, { ok: true, data: 42 });
    assert.deepEqual(r3, { ok: true, data: 42 });
    assert.equal(invocations, 1);
    assert.equal(store.size(), 1);
  });

  it("parallelizes calls with different keys", async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 60_000 });
    let invocA = 0;
    let invocB = 0;

    const fnA = async () => {
      invocA++;
      return ok("A");
    };
    const fnB = async () => {
      invocB++;
      return ok("B");
    };

    const [rA, rB] = await Promise.all([
      store.acquire("a", fnA),
      store.acquire("b", fnB),
    ]);

    assert.deepEqual(rA, { ok: true, data: "A" });
    assert.deepEqual(rB, { ok: true, data: "B" });
    assert.equal(invocA, 1);
    assert.equal(invocB, 1);
    assert.equal(store.size(), 2);
  });

  it("evicts entries after TTL elapses", async () => {
    // Short TTL to keep the test quick.
    const store = new InMemoryIdempotencyStore({ ttlMs: 50 });
    let invocations = 0;
    const fn = async () => {
      invocations++;
      return ok(invocations);
    };

    const r1 = await store.acquire("k", fn);
    assert.deepEqual(r1, { ok: true, data: 1 });
    assert.equal(store.size(), 1);

    // Before TTL expiry — cache hit, same result, same count.
    const r1b = await store.acquire("k", fn);
    assert.deepEqual(r1b, { ok: true, data: 1 });
    assert.equal(invocations, 1);

    // Wait past TTL so the entry is evicted.
    await new Promise((resolve) => setTimeout(resolve, 80));

    const r2 = await store.acquire("k", fn);
    assert.deepEqual(r2, { ok: true, data: 2 }, "should re-run after TTL");
    assert.equal(invocations, 2);
    assert.equal(store.size(), 1);
  });
});

// ==========================================================================
// RedisIdempotencyStore (against ioredis-mock)
// ==========================================================================

describe("ADR-059 §5 RedisIdempotencyStore (ioredis-mock)", () => {
  // Each test gets a fresh mock client so keys don't bleed across cases.
  function freshClient() {
    return new IoRedisMock();
  }

  it("serializes concurrent calls with the same key (fn invoked once)", async () => {
    const client = freshClient();
    const store = new RedisIdempotencyStore({
      client,
      prefix: "t1:",
      resultTtlMs: 60_000,
      pendingTtlMs: 5_000,
      // Make the polling loop snappy so the test finishes quickly.
      pollInitialMs: 2,
      pollMaxMs: 10,
      inflightWaitMs: 2_000,
    });

    let invocations = 0;
    let release: ((v: Result<number>) => void) | null = null;
    const fn = () =>
      new Promise<Result<number>>((resolve) => {
        invocations++;
        release = resolve;
      });

    const p1 = store.acquire("same", fn);
    // Yield so p1 takes the pending marker before p2/p3 try to SET NX.
    await tick();
    const p2 = store.acquire("same", fn);
    const p3 = store.acquire("same", fn);
    await tick();

    assert.equal(invocations, 1, "fn should run exactly once");

    release!(ok(42));
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.deepEqual(r1, { ok: true, data: 42 });
    assert.deepEqual(r2, { ok: true, data: 42 });
    assert.deepEqual(r3, { ok: true, data: 42 });
    assert.equal(invocations, 1);
  });

  it("returns the cached result on a subsequent acquire without re-invoking fn", async () => {
    const client = freshClient();
    const store = new RedisIdempotencyStore({
      client,
      prefix: "t2:",
      resultTtlMs: 60_000,
      pendingTtlMs: 5_000,
    });

    let invocations = 0;
    const fn = async () => {
      invocations++;
      return ok({ answer: invocations });
    };

    const r1 = await store.acquire("k", fn);
    assert.deepEqual(r1, { ok: true, data: { answer: 1 } });

    const r2 = await store.acquire("k", fn);
    assert.deepEqual(r2, { ok: true, data: { answer: 1 } }, "cache hit");
    assert.equal(invocations, 1, "fn only ran on the first acquire");
  });

  it("evicts the cached result after TTL elapses (Redis PX expiry)", async () => {
    const client = freshClient();
    const store = new RedisIdempotencyStore({
      client,
      prefix: "t3:",
      // Very short result TTL so the test stays quick.
      resultTtlMs: 40,
      pendingTtlMs: 5_000,
    });

    let invocations = 0;
    const fn = async () => {
      invocations++;
      return ok(invocations);
    };

    const r1 = await store.acquire("k", fn);
    assert.deepEqual(r1, { ok: true, data: 1 });

    await new Promise((resolve) => setTimeout(resolve, 80));

    const r2 = await store.acquire("k", fn);
    assert.deepEqual(r2, { ok: true, data: 2 }, "should re-run after TTL");
    assert.equal(invocations, 2);
  });

  it("releases the pending marker when the handler throws (next acquire re-enters)", async () => {
    const client = freshClient();
    const store = new RedisIdempotencyStore({
      client,
      prefix: "t4:",
      resultTtlMs: 60_000,
      pendingTtlMs: 60_000,
    });

    let attempts = 0;
    const flakyFn = async (): Promise<Result<string>> => {
      attempts++;
      if (attempts === 1) throw new Error("boom");
      return ok("ok");
    };

    await assert.rejects(
      () => store.acquire("k", flakyFn),
      /boom/,
    );

    // Marker must be gone — next acquire must re-enter and succeed.
    const pending = await client.get("t4:k");
    assert.equal(pending, null, "pending marker should be released");

    const r2 = await store.acquire("k", flakyFn);
    assert.deepEqual(r2, { ok: true, data: "ok" });
    assert.equal(attempts, 2, "handler was re-entered after the first throw");
  });

  it("factory selects Redis when AEAP_REDIS_URL is set, memory otherwise", () => {
    const prev = process.env.AEAP_REDIS_URL;
    try {
      delete process.env.AEAP_REDIS_URL;
      assert.equal(activeIdempotencyBackend(), "memory");
      const memStore = createIdempotencyStore();
      assert.ok(memStore instanceof InMemoryIdempotencyStore);

      // Note: we don't instantiate with a live URL here — ioredis would
      // attempt a real connection. activeIdempotencyBackend() reports the
      // env-selected backend without constructing anything, which is the
      // invariant we care about at startup logging time.
      process.env.AEAP_REDIS_URL = "redis://localhost:6379";
      assert.equal(activeIdempotencyBackend(), "redis");
    } finally {
      if (prev === undefined) delete process.env.AEAP_REDIS_URL;
      else process.env.AEAP_REDIS_URL = prev;
    }
  });
});

// ==========================================================================
// Preflight — executePreflight + integration with capabilityGated
// ==========================================================================

describe("ADR-059 §6 executePreflight", () => {
  beforeEach(() => {
    __resetClusterHealthCacheForTests();
  });

  function mockRpcHealthy(): PreflightDeps["rpc"] {
    let slotCounter = 1000n;
    return {
      getSlot: () => ({
        send: async () => {
          const s = slotCounter;
          slotCounter += 1n;
          return s;
        },
      }),
      getRecentPerformanceSamples: () => ({
        send: async () => [
          { numSlots: 60n, numTransactions: 12_000n },
        ],
      }),
      getMinimumBalanceForRentExemption: () => ({
        send: async () => 890_880n,
      }),
      getAccountInfo: () => ({
        send: async () => ({ value: null }),
      }),
    };
  }

  function mockRpcUnhealthy(): PreflightDeps["rpc"] {
    return {
      getSlot: () => ({
        send: async () => 1000n,
      }),
      getRecentPerformanceSamples: () => ({
        send: async () => [{ numSlots: 60n, numTransactions: 0n }],
      }),
      getMinimumBalanceForRentExemption: () => ({
        send: async () => 0n,
      }),
      getAccountInfo: () => ({
        send: async () => ({ value: null }),
      }),
    };
  }

  it("passes when no gates are declared", async () => {
    const r = await executePreflight(undefined, ctxWith([]), {});
    assert.equal(r.ok, true);
  });

  it("passes cluster_health with healthy mock RPC", async () => {
    const r = await executePreflight(
      ["cluster_health"],
      ctxWith([]),
      { rpc: mockRpcHealthy() },
    );
    assert.equal(r.ok, true);
  });

  it("fails cluster_health when tx/slot is below floor", async () => {
    const r = await executePreflight(
      ["cluster_health"],
      ctxWith([]),
      { rpc: mockRpcUnhealthy() },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /cluster_health/);
    }
  });

  it("account_rent_exempt passes when no accounts declared", async () => {
    const r = await executePreflight(
      ["account_rent_exempt"],
      ctxWith([]),
      { rpc: mockRpcHealthy() },
    );
    assert.equal(r.ok, true);
  });

  it("stubbed gates (daily_cap, dispute_window) pass today (TODO in next PR)", async () => {
    const r = await executePreflight(
      ["daily_cap_not_exhausted", "dispute_window_open"],
      ctxWith([]),
      {},
    );
    assert.equal(r.ok, true);
  });
});

describe("capability-gated preflight wiring", () => {
  beforeEach(() => {
    __resetClusterHealthCacheForTests();
  });

  function makeAction(
    handlerCallsRef: { count: number },
  ): Action<{ foo: string }, number> {
    return {
      name: "test_preflight_action",
      title: "t",
      description: "d",
      inputSchema: { foo: z.string() } as const,
      outputSchema: z.number(),
      similes: [],
      examples: [],
      readOnly: false,
      capabilities: ["sign:settlement"],
      preflight: ["cluster_health"],
      requiresSigner: true,
      handler: async (_ctx, _input) => {
        handlerCallsRef.count++;
        return ok(1);
      },
    };
  }

  it("preflight FAIL → handler is NOT called and PREFLIGHT_FAILED is returned", async () => {
    const calls = { count: 0 };
    const action = makeAction(calls);

    const wrapped = capabilityGated(action, {
      preflightDeps: {
        rpc: {
          getSlot: () => ({ send: async () => 1000n }),
          getRecentPerformanceSamples: () => ({
            send: async () => [{ numSlots: 60n, numTransactions: 0n }],
          }),
          getMinimumBalanceForRentExemption: () => ({ send: async () => 0n }),
          getAccountInfo: () => ({ send: async () => ({ value: null }) }),
        },
      },
    });

    const ctx = ctxWith(["sign:settlement"]);
    const r = await wrapped.handler(ctx, { foo: "bar" });

    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "PREFLIGHT_FAILED");
    assert.equal(calls.count, 0, "handler should not have run");
  });

  it("preflight PASS → handler IS called", async () => {
    const calls = { count: 0 };
    const action = makeAction(calls);
    let slotCounter = 500n;

    const wrapped = capabilityGated(action, {
      preflightDeps: {
        rpc: {
          getSlot: () => ({
            send: async () => {
              const s = slotCounter;
              slotCounter += 1n;
              return s;
            },
          }),
          getRecentPerformanceSamples: () => ({
            send: async () => [{ numSlots: 60n, numTransactions: 12_000n }],
          }),
          getMinimumBalanceForRentExemption: () => ({
            send: async () => 890_880n,
          }),
          getAccountInfo: () => ({ send: async () => ({ value: null }) }),
        },
      },
    });

    const ctx = ctxWith(["sign:settlement"]);
    const r = await wrapped.handler(ctx, { foo: "bar" });

    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.data, 1);
    assert.equal(calls.count, 1);
  });
});

// ==========================================================================
// sendAndConfirmWithBlockhashExpiry
// ==========================================================================

describe("ADR-059 §4 sendAndConfirmWithBlockhashExpiry", () => {
  // Stand-in "signed tx" shape — single signature in map form.
  function makeSigned(sigByte: number) {
    const sig = new Uint8Array(64);
    sig.fill(sigByte);
    return { signatures: { somePubkey: sig } } as const;
  }

  it("retries on BLOCK_HEIGHT_EXCEEDED and returns signature after success", async () => {
    let buildAndSignCalls = 0;
    let sendCalls = 0;

    const r = await sendAndConfirmWithBlockhashExpiry(
      async () => {
        buildAndSignCalls++;
        return makeSigned(buildAndSignCalls); // distinguishable per attempt
      },
      {
        maxRetries: 2,
        sendAndConfirm: async (_signed) => {
          sendCalls++;
          if (sendCalls === 1) {
            throw new Error(
              "SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED: blockhash expired",
            );
          }
        },
      },
    );

    assert.equal(r.ok, true, "wrapper should resolve on retry success");
    assert.equal(buildAndSignCalls, 2, "buildAndSign called per attempt");
    assert.equal(sendCalls, 2);
    if (r.ok) assert.equal(typeof r.data, "string");
  });

  it("gives up with RPC_ERROR after maxRetries exhausted", async () => {
    let sendCalls = 0;
    const r = await sendAndConfirmWithBlockhashExpiry(
      async () => ({ signatures: { x: new Uint8Array(64) } }) as const,
      {
        maxRetries: 1,
        sendAndConfirm: async () => {
          sendCalls++;
          throw new Error("BLOCK_HEIGHT_EXCEEDED");
        },
      },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "RPC_ERROR");
    // maxRetries=1 means the loop runs attempts 0 and 1 → 2 send calls.
    assert.equal(sendCalls, 2);
  });

  it("returns RPC_ERROR immediately on a non-expiry failure", async () => {
    let sendCalls = 0;
    const r = await sendAndConfirmWithBlockhashExpiry(
      async () => ({ signatures: { x: new Uint8Array(64) } }) as const,
      {
        maxRetries: 5,
        sendAndConfirm: async () => {
          sendCalls++;
          throw new Error("PROGRAM_FAILED: custom program error 0x42");
        },
      },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "RPC_ERROR");
    assert.equal(sendCalls, 1, "non-expiry errors are terminal");
  });

  it("isBlockHeightExceeded detects the typed error code by string", () => {
    assert.equal(
      isBlockHeightExceeded(new Error("SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED")),
      true,
    );
    assert.equal(
      isBlockHeightExceeded(new Error("blockhash not found")),
      true,
    );
    assert.equal(isBlockHeightExceeded(new Error("unrelated")), false);
    assert.equal(isBlockHeightExceeded(null), false);
  });
});
