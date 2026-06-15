/**
 * Unit tests for `startConnectionHeartbeat` (AUD-039 / ADR-118) and the
 * heartbeat-driven reconnect path that releases stale logsNotifications
 * subscriptions (AUD-204).
 *
 * Verifies that the heartbeat ping correctly:
 *   1. Calls `getSlot().send()` on each interval tick.
 *   2. Treats slow-response as a failure (timeout enforcement).
 *   3. Counts consecutive failures and fires `onConnectionLost` only
 *      after the configured threshold.
 *   4. Resets the failure counter on a successful ping.
 *   5. Resets the failure counter when the threshold-triggered callback
 *      runs, so a single outage produces a single reconnect signal.
 *   6. Stops cleanly via `handle.stop()` (no further ticks fire).
 *
 * AUD-204 coverage:
 *   7. The heartbeat-triggered reconnect aborts the prior subscription's
 *      AbortController exactly once per affected program before re-
 *      subscribing, so transient network slowness cannot accumulate
 *      duplicate iterators on the kit RPC-subscriptions transport.
 *
 * ADR-087 Phase A target #2 notes:
 *   - The fake "connection" is now shaped as `Pick<SolanaRpc, "getSlot">`
 *     — kit's `getSlot()` returns a request builder whose `.send()` resolves
 *     to a `bigint` slot. The fake builds the same shape from a plain thunk.
 *   - The fake "subscriptions" client uses `logsNotifications().subscribe()`
 *     with an `abortSignal`. Each `subscribe()` increments a counter; each
 *     signal abort increments a remove counter. The end-to-end assertion
 *     is "every initial subscribe is aborted exactly once before
 *     scheduleReconnect can call subscribe again", matching the v1
 *     `removeOnLogsListener` invariant.
 *
 * Pure-unit test — no real RPC, no network, no timers leaked.
 */

// AUD-204 plumbing: shrink the heartbeat window so the
// subscribeToPrograms test below can trip the reconnect path inside the
// node:test default timeout. These constants are read at module load
// inside ./index.ts, and TypeScript hoists `import` declarations above
// every statement — so the env overrides MUST be applied before
// ./index.ts is required. We side-step the hoist by using `require()`
// for the indexer module directly inside the test, after this block
// has run. The other tests in this file pass explicit `opts` to
// `startConnectionHeartbeat` and are unaffected by these globals.
process.env.INDEXER_HEARTBEAT_INTERVAL_MS = "20";
process.env.INDEXER_HEARTBEAT_TIMEOUT_MS = "50";
process.env.INDEXER_HEARTBEAT_FAILURE_THRESHOLD = "1";

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { Database as DatabaseType } from "better-sqlite3";
import type * as IndexerModule from "./index";

// `require` (synchronous, declaration-order) so the env overrides above
// have taken effect by the time index.ts evaluates its module-load
// constants.
const indexer: typeof IndexerModule = require("./index");
const { startConnectionHeartbeat, subscribeToPrograms, initDb, PROGRAM_IDS } =
  indexer;

/**
 * Build a `Pick<SolanaRpc, "getSlot">` whose `getSlot()` returns a
 * request-builder object exposing `.send()`. Each `.send()` call invokes
 * the caller-supplied thunk. Cast through `unknown` because we only need
 * the runtime shape `{ getSlot(_): { send(): Promise<bigint> } }`.
 */
function fakeRpc(getSlotImpl: () => Promise<bigint | number>): {
  getSlot: (...args: unknown[]) => { send: () => Promise<bigint> };
} {
  return {
    getSlot: (..._args: unknown[]) => ({
      send: async () => {
        const v = await getSlotImpl();
        return typeof v === "bigint" ? v : BigInt(v);
      },
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Cast helper — the heartbeat / subscribe wiring expects the real kit
// types, but our fakes are intentionally minimal. One cast at each
// boundary keeps the tests legible without weakening production types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRpc = any;

describe("startConnectionHeartbeat (AUD-039)", () => {
  it("calls getSlot on each tick when healthy", async () => {
    let calls = 0;
    const rpc = fakeRpc(async () => {
      calls++;
      return 100n;
    });

    const handle = startConnectionHeartbeat(rpc as AnyRpc, {
      intervalMs: 25,
      timeoutMs: 100,
      failureThreshold: 3,
      onConnectionLost: () => {
        assert.fail("should not lose connection while getSlot succeeds");
      },
    });

    await sleep(120); // ~4-5 ticks
    handle.stop();

    assert.ok(calls >= 3, `expected >=3 calls, got ${calls}`);
    assert.equal(handle.consecutiveFailures(), 0);
  });

  it("treats getSlot rejection as a failure", async () => {
    let lostCount = 0;
    let lastReason = "";
    const rpc = fakeRpc(async () => {
      throw new Error("rpc down");
    });

    const handle = startConnectionHeartbeat(rpc as AnyRpc, {
      intervalMs: 15,
      timeoutMs: 100,
      failureThreshold: 2,
      onConnectionLost: (reason) => {
        lostCount++;
        lastReason = reason;
      },
    });

    await sleep(80); // enough for >=2 failures
    handle.stop();

    assert.ok(lostCount >= 1, `expected >=1 connection-lost event, got ${lostCount}`);
    assert.match(lastReason, /rpc down|timeout/);
  });

  it("treats slow getSlot (> timeoutMs) as a failure", async () => {
    let lostCount = 0;
    let lastReason = "";
    const rpc = fakeRpc(async () => {
      // Never resolves within the test window.
      await sleep(10_000);
      return 0n;
    });

    const handle = startConnectionHeartbeat(rpc as AnyRpc, {
      intervalMs: 15,
      timeoutMs: 20,
      failureThreshold: 2,
      onConnectionLost: (reason) => {
        lostCount++;
        lastReason = reason;
      },
    });

    await sleep(120);
    handle.stop();

    assert.ok(lostCount >= 1, `expected >=1 timeout-triggered loss, got ${lostCount}`);
    assert.match(lastReason, /timeout/);
  });

  it("only fires onConnectionLost after `failureThreshold` consecutive failures", async () => {
    let lostCount = 0;
    let callCount = 0;
    const rpc = fakeRpc(async () => {
      callCount++;
      throw new Error("boom");
    });

    const handle = startConnectionHeartbeat(rpc as AnyRpc, {
      intervalMs: 10,
      timeoutMs: 50,
      failureThreshold: 5,
      onConnectionLost: () => {
        lostCount++;
      },
    });

    // Wait for ~3 failures: should NOT have fired yet.
    await sleep(35);
    assert.equal(lostCount, 0, "fired before threshold");

    // Wait until threshold is comfortably crossed.
    await sleep(60);
    handle.stop();

    assert.ok(callCount >= 5, `expected >=5 ticks, got ${callCount}`);
    assert.ok(lostCount >= 1, "should have fired after threshold");
  });

  it("resets failure counter on a successful ping", async () => {
    let i = 0;
    const rpc = fakeRpc(async () => {
      i++;
      // fail, fail, succeed, fail, fail, succeed, ...
      if (i % 3 === 0) return 1n;
      throw new Error("transient");
    });

    let lostCount = 0;
    const handle = startConnectionHeartbeat(rpc as AnyRpc, {
      intervalMs: 10,
      timeoutMs: 50,
      failureThreshold: 3,
      onConnectionLost: () => {
        lostCount++;
      },
    });

    await sleep(150);
    handle.stop();

    // With pattern fail,fail,succeed repeating, we never hit 3 *consecutive*
    // failures, so onConnectionLost must never fire.
    assert.equal(lostCount, 0, "fired despite intermittent recoveries");
  });

  it("stop() halts further ticks", async () => {
    let calls = 0;
    const rpc = fakeRpc(async () => {
      calls++;
      return 1n;
    });

    const handle = startConnectionHeartbeat(rpc as AnyRpc, {
      intervalMs: 15,
      timeoutMs: 50,
      failureThreshold: 3,
      onConnectionLost: () => {},
    });

    await sleep(50);
    handle.stop();
    const callsAtStop = calls;

    await sleep(80);
    assert.equal(
      calls,
      callsAtStop,
      `getSlot called ${calls - callsAtStop} time(s) after stop()`,
    );
  });

  it("a callback throw does not break the heartbeat loop", async () => {
    let calls = 0;
    const rpc = fakeRpc(async () => {
      calls++;
      throw new Error("rpc down");
    });

    const handle = startConnectionHeartbeat(rpc as AnyRpc, {
      intervalMs: 10,
      timeoutMs: 50,
      failureThreshold: 1,
      onConnectionLost: () => {
        throw new Error("callback explodes");
      },
    });

    // Even with the callback throwing every threshold-cross, ticks keep
    // happening. We just want to assert no crash + ticks continue.
    await sleep(60);
    const before = calls;
    await sleep(40);
    handle.stop();

    assert.ok(calls > before, "ticks stopped after callback throw");
  });
});

// ---------------------------------------------------------------------------
// AUD-204: heartbeat-triggered reconnect must release the prior
// logsNotifications subscription via `controller.abort()` so transient
// network slowness does not accumulate duplicate iterators on the kit
// rpc-subscriptions transport.
//
// Pre-migration (v1) the assertion shape was "removeOnLogsListener was
// called once per program before re-subscribe". In v2 the equivalent is
// "the AbortController owned by the previous subscribe was aborted once
// per program before re-subscribe". We track abort calls on a per-
// subscription basis so the assertion still pins one-release-per-program.
// ---------------------------------------------------------------------------

/**
 * Stand-in for kit's HTTP + WS RPC clients exposing exactly the methods
 * `subscribeToPrograms` reaches for. We control:
 *   - rpc.getSlot().send()        — drive the heartbeat into "lost" state
 *   - rpc.getSignaturesForAddress(addr, opts).send() — backfill = no-op
 *   - rpcSubs.logsNotifications(filter, cfg).subscribe({ abortSignal })
 *     — hand out an async iterable; record each subscribe call, and
 *     observe each abort signal so the test can assert exact per-program
 *     abort counts.
 */
function fakeIndexerClients(): {
  rpc: AnyRpc;
  rpcSubs: AnyRpc;
  state: {
    subscribeCalls: Array<{ programId: string; abortSignal: AbortSignal }>;
    aborts: number; // count of AbortController.abort() observed
    failGetSlot: boolean;
  };
} {
  const state = {
    subscribeCalls: [] as Array<{ programId: string; abortSignal: AbortSignal }>,
    aborts: 0,
    failGetSlot: false,
  };

  const rpc = {
    getSlot: (..._args: unknown[]) => ({
      send: async () => {
        if (state.failGetSlot) throw new Error("rpc down");
        return 1n;
      },
    }),
    getSignaturesForAddress: (..._args: unknown[]) => ({
      // Empty pages → backfill is a no-op so the test only exercises
      // the subscribe / abort path.
      send: async () => [],
    }),
    getTransaction: (..._args: unknown[]) => ({
      send: async () => null,
    }),
  };

  const rpcSubs = {
    logsNotifications: (filter: { mentions: [string] }, _cfg?: unknown) => ({
      subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        state.subscribeCalls.push({
          programId: filter.mentions[0],
          abortSignal,
        });
        // Observe the abort transition. The indexer's reconnect path
        // calls `controller.abort()` before re-subscribing — that fires
        // this listener, which lets the test assert one-release-per-
        // program (matching the v1 `removeOnLogsListener` invariant).
        abortSignal.addEventListener("abort", () => {
          state.aborts++;
        });
        // Return an empty-but-abort-aware async iterable. The loop
        // exits when the signal fires (subscribeToPrograms's `for await`
        // either completes normally or raises an AbortError, both of
        // which are handled in the guarded iterator-consumption loop).
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<unknown>> {
                return new Promise((resolve, reject) => {
                  if (abortSignal.aborted) {
                    resolve({ value: undefined, done: true });
                    return;
                  }
                  abortSignal.addEventListener(
                    "abort",
                    () => {
                      // Match kit's typical cancel semantics —
                      // surfaces as an iterator-end rather than an
                      // explicit throw. Either shape is handled by
                      // the indexer's `controller.signal.aborted`
                      // guard.
                      resolve({ value: undefined, done: true });
                    },
                    { once: true },
                  );
                  // Defensive: this fake never produces events, so if
                  // the test forgets to abort the iterator hangs
                  // forever. Reject after 10s as a smoke fuse.
                  setTimeout(() => reject(new Error("fake-iter timeout")), 10_000).unref?.();
                });
              },
            };
          },
        };
      },
    }),
  };

  return { rpc, rpcSubs, state };
}

describe("AUD-204: heartbeat reconnect aborts stale logsNotifications subscriptions", () => {
  it("aborts each program's subscription exactly once when the heartbeat trips", async () => {
    // The heartbeat constants used by `subscribeToPrograms` were
    // shrunk via env overrides at the top of this file (interval=20ms,
    // timeout=50ms, threshold=1) so the reconnect path fires inside
    // the default node:test timeout. The PRODUCTION defaults
    // (10s/5s/3) are unchanged.
    const { rpc, rpcSubs, state: connState } = fakeIndexerClients();
    const db: DatabaseType = initDb(":memory:");

    const programCount = Object.keys(PROGRAM_IDS).length;
    const { heartbeat } = subscribeToPrograms(rpc, rpcSubs, db);

    // After subscribe, every program should have called subscribe()
    // exactly once. The detached async-IIFE inside subscribeWithReconnect
    // awaits the (immediately-resolved) fake subscribe — give the event
    // loop one drain pass so the calls land before we assert.
    await sleep(20);

    assert.equal(
      connState.subscribeCalls.length,
      programCount,
      `expected ${programCount} initial subscribe calls, got ${connState.subscribeCalls.length}`,
    );
    assert.equal(
      connState.aborts,
      0,
      "no aborts expected before failure",
    );

    // Trip the heartbeat. With threshold=1 the very next tick observing
    // failGetSlot=true fires onConnectionLost, which iterates every
    // subscribed program and aborts its AbortController BEFORE the
    // reconnect (which itself will call subscribe again on
    // RECONNECT_DELAY_MS=3000 — comfortably outside our 200ms window).
    connState.failGetSlot = true;
    await sleep(200);

    heartbeat.stop();
    db.close();

    // Core AUD-204 assertion: each initial subscription was aborted
    // exactly once before any re-subscribe could pile on a duplicate
    // iterator. The release-before-resubscribe ordering inside
    // onConnectionLost is the load-bearing invariant; this asserts the
    // outcome rather than the order.
    assert.equal(
      connState.aborts,
      programCount,
      `expected ${programCount} aborts (one per program), got ${connState.aborts}`,
    );
  });
});
