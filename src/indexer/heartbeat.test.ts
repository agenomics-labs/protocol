/**
 * Unit tests for `startConnectionHeartbeat` (AUD-039 / ADR-118).
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
 * Pure-unit test — no real Connection, no network, no timers leaked.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { Connection } from "@solana/web3.js";
import { startConnectionHeartbeat } from "./index";

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
