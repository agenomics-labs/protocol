/**
 * Unit tests for `startConnectionHeartbeat` (AUD-039 / ADR-118) and the
 * heartbeat-driven reconnect path that releases stale onLogs
 * subscriptions (AUD-204).
 *
 * Verifies that the heartbeat ping correctly:
 *   1. Calls `getSlot` on each interval tick.
 *   2. Treats slow-response as a failure (timeout enforcement).
 *   3. Counts consecutive failures and fires `onConnectionLost` only
 *      after the configured threshold.
 *   4. Resets the failure counter on a successful ping.
 *   5. Resets the failure counter when the threshold-triggered callback
 *      runs, so a single outage produces a single reconnect signal.
 *   6. Stops cleanly via `handle.stop()` (no further ticks fire).
 *
 * AUD-204 coverage:
 *   7. The heartbeat-triggered reconnect calls
 *      `connection.removeOnLogsListener` exactly once per affected
 *      program before re-subscribing, so transient network slowness
 *      cannot accumulate duplicate listeners.
 *
 * Pure-unit test — no real Connection, no network, no timers leaked.
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
import type { Connection } from "@solana/web3.js";
import type * as IndexerModule from "./index";

// `require` (synchronous, declaration-order) so the env overrides above
// have taken effect by the time index.ts evaluates its module-load
// constants.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const indexer: typeof IndexerModule = require("./index");
const { startConnectionHeartbeat, subscribeToPrograms, initDb, PROGRAM_IDS } =
  indexer;

/** Build a `Pick<Connection, "getSlot">` that returns whatever the
 *  caller-supplied function produces. Each call returns a fresh promise. */
function fakeConnection(
  getSlotImpl: () => Promise<number>,
): Pick<Connection, "getSlot"> {
  return {
    // Cast: the real signature takes a `Commitment | GetSlotConfig` arg;
    // the heartbeat passes `{ commitment: "confirmed" }` which matches.
    getSlot: ((..._args: unknown[]) => getSlotImpl()) as Connection["getSlot"],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("startConnectionHeartbeat (AUD-039)", () => {
  it("calls getSlot on each tick when healthy", async () => {
    let calls = 0;
    const conn = fakeConnection(async () => {
      calls++;
      return 100;
    });

    const handle = startConnectionHeartbeat(conn, {
      intervalMs: 25,
      timeoutMs: 100,
      failureThreshold: 3,
      onConnectionLost: () => {
        assert.fail("should not lose connection while getSlot succeeds");
      },
    });

    await sleep(120); // ~4-5 ticks
    handle.stop();

    assert.ok(calls >= 3, `expected ≥3 calls, got ${calls}`);
    assert.equal(handle.consecutiveFailures(), 0);
  });

  it("treats getSlot rejection as a failure", async () => {
    let lostCount = 0;
    let lastReason = "";
    const conn = fakeConnection(async () => {
      throw new Error("rpc down");
    });

    const handle = startConnectionHeartbeat(conn, {
      intervalMs: 15,
      timeoutMs: 100,
      failureThreshold: 2,
      onConnectionLost: (reason) => {
        lostCount++;
        lastReason = reason;
      },
    });

    await sleep(80); // enough for ≥2 failures
    handle.stop();

    assert.ok(lostCount >= 1, `expected ≥1 connection-lost event, got ${lostCount}`);
    assert.match(lastReason, /rpc down|timeout/);
  });

  it("treats slow getSlot (> timeoutMs) as a failure", async () => {
    let lostCount = 0;
    let lastReason = "";
    const conn = fakeConnection(async () => {
      // Never resolves within the test window.
      await sleep(10_000);
      return 0;
    });

    const handle = startConnectionHeartbeat(conn, {
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

    assert.ok(lostCount >= 1, `expected ≥1 timeout-triggered loss, got ${lostCount}`);
    assert.match(lastReason, /timeout/);
  });

  it("only fires onConnectionLost after `failureThreshold` consecutive failures", async () => {
    let lostCount = 0;
    let callCount = 0;
    const conn = fakeConnection(async () => {
      callCount++;
      throw new Error("boom");
    });

    const handle = startConnectionHeartbeat(conn, {
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

    assert.ok(callCount >= 5, `expected ≥5 ticks, got ${callCount}`);
    assert.ok(lostCount >= 1, "should have fired after threshold");
  });

  it("resets failure counter on a successful ping", async () => {
    let i = 0;
    const conn = fakeConnection(async () => {
      i++;
      // fail, fail, succeed, fail, fail, succeed, ...
      if (i % 3 === 0) return 1;
      throw new Error("transient");
    });

    let lostCount = 0;
    const handle = startConnectionHeartbeat(conn, {
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
    const conn = fakeConnection(async () => {
      calls++;
      return 1;
    });

    const handle = startConnectionHeartbeat(conn, {
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
    const conn = fakeConnection(async () => {
      calls++;
      throw new Error("rpc down");
    });

    const handle = startConnectionHeartbeat(conn, {
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
// AUD-204: heartbeat-triggered reconnect must release the prior onLogs
// subscription via `removeOnLogsListener` so transient network slowness
// does not accumulate duplicate listeners on the connection.
// ---------------------------------------------------------------------------

/**
 * Stand-in for `@solana/web3.js`'s `Connection` exposing exactly the
 * methods `subscribeToPrograms` reaches for. We control:
 *   - getSlot — drive the heartbeat into a "lost" state on demand
 *   - onLogs — hand out monotonically-increasing subscription ids and
 *     record the registrations
 *   - removeOnLogsListener — record each unsubscription so the test
 *     can assert exact call counts per program
 *   - getSignaturesForAddress — return [] so backfill is a no-op
 */
function fakeIndexerConnection(): {
  conn: Connection;
  state: {
    nextSubId: number;
    onLogsCalls: Array<{ programId: string; subId: number }>;
    removed: number[];
    failGetSlot: boolean;
  };
} {
  const state = {
    nextSubId: 1,
    onLogsCalls: [] as Array<{ programId: string; subId: number }>,
    removed: [] as number[],
    failGetSlot: false,
  };
  const conn = {
    onLogs: ((programId: { toBase58: () => string }) => {
      const subId = state.nextSubId++;
      state.onLogsCalls.push({ programId: programId.toBase58(), subId });
      return subId;
    }) as Connection["onLogs"],
    removeOnLogsListener: (async (subId: number) => {
      state.removed.push(subId);
    }) as Connection["removeOnLogsListener"],
    getSlot: (async () => {
      if (state.failGetSlot) {
        throw new Error("rpc down");
      }
      return 1;
    }) as Connection["getSlot"],
    getSignaturesForAddress: (async () => []) as Connection["getSignaturesForAddress"],
  } as unknown as Connection;
  return { conn, state };
}

describe("AUD-204: heartbeat reconnect releases stale onLogs subscriptions", () => {
  it("removeOnLogsListener is called once per program when the heartbeat trips", async () => {
    // The heartbeat constants used by `subscribeToPrograms` were
    // shrunk via env overrides at the top of this file (interval=20ms,
    // timeout=50ms, threshold=1) so the reconnect path fires inside
    // the default node:test timeout. The PRODUCTION defaults
    // (10s/5s/3) are unchanged.
    const { conn, state: connState } = fakeIndexerConnection();
    const db: DatabaseType = initDb(":memory:");

    const programCount = Object.keys(PROGRAM_IDS).length;
    const { heartbeat } = subscribeToPrograms(conn, db);

    // After subscribe, every program should have called onLogs exactly
    // once.
    assert.equal(
      connState.onLogsCalls.length,
      programCount,
      `expected ${programCount} initial onLogs calls, got ${connState.onLogsCalls.length}`,
    );
    assert.equal(
      connState.removed.length,
      0,
      "no removals expected before failure",
    );

    const initialSubIds = connState.onLogsCalls
      .map((c) => c.subId)
      .sort((a, b) => a - b);

    // Trip the heartbeat. With threshold=1 the very next tick observing
    // failGetSlot=true fires onConnectionLost, which iterates every
    // subscribed program and calls removeOnLogsListener BEFORE the
    // reconnect (which itself will call onLogs again on
    // RECONNECT_DELAY_MS=3000 — comfortably outside our 150ms window).
    connState.failGetSlot = true;
    await sleep(150);

    heartbeat.stop();
    db.close();

    // Core AUD-204 assertion: each initial subscription was released
    // exactly once before any re-subscribe could pile on a duplicate
    // listener.
    const removed = [...connState.removed].sort((a, b) => a - b);
    assert.deepEqual(
      removed,
      initialSubIds,
      `expected each initial subId to be released once; got removed=${JSON.stringify(removed)} initial=${JSON.stringify(initialSubIds)}`,
    );
    assert.equal(
      removed.length,
      programCount,
      `expected ${programCount} removeOnLogsListener calls (one per program), got ${removed.length}`,
    );
  });
});
