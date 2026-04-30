/**
 * ADR-129 §"Resilience primitives" — tests for the EVO subprocess transport
 * resilience surface (MCP-300/301/302/305/307).
 *
 * Coverage targets:
 *
 *   MCP-300 — per-call timeout
 *     1. Wedged subprocess (no response) → caller rejects with
 *        EvoBridgeTimeoutError after callTimeoutMs.
 *     2. Late stdout response after timeout is silently dropped (does not
 *        resolve a different inflight or surface as unmatched-line).
 *
 *   MCP-301 — restart + circuit-breaker
 *     3. Subprocess "close" event triggers restart (not breaker_open) when
 *        restartCount < maxRestarts; next send re-spawns.
 *     4. After maxRestarts is exceeded, breaker locks open permanently;
 *        further send() calls reject with EvoBridgeBreakerOpenError.
 *
 *   MCP-302 — bounded queue
 *     5. queue.length >= maxQueueDepth → new send() rejects synchronously
 *        with EvoBridgeBackpressureError.
 *
 *   MCP-305 — version handshake
 *     6. EVO returns { ok: true, protocol_version: "1.4" } → ok, transport
 *        records "1.4" and proceeds.
 *     7. EVO returns { ok: true, protocol_version: "2.0" } → breaker locks
 *        open with EvoBridgeVersionMismatchError (or breaker-open).
 *     8. EVO rejects { ok: false, error: "unknown command" } → treated as
 *        legacy v1, transport proceeds (no version bump available, but
 *        legacy version string set).
 *
 *   MCP-307 — multi-line startup error capture
 *     9. Two unsolicited stdout lines before close → both appear in the
 *        rejection reason (joined), neither is silently overwritten.
 *
 * Tests inject a fake child process AND a fake line source so they don't
 * pay the cost of real readline buffering — `line` events fire
 * synchronously via `lineSource.emit("line", "...")`.
 *
 * Runs under `node --import tsx --test`.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  EvoSubprocessTransport,
  EvoBridgeTimeoutError,
  EvoBridgeBackpressureError,
  EvoBridgeBreakerOpenError,
} from "../src/adapters/evo-subprocess-transport.js";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  written: string[];
  killCalled: number;
  kill(signal?: NodeJS.Signals): boolean;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      ee.written.push(chunk.toString("utf8"));
      cb();
    },
    final(cb) {
      cb();
    },
  });
  ee.stdin = stdin;
  ee.stdout = stdout;
  ee.stderr = stderr;
  ee.written = [];
  ee.killCalled = 0;
  ee.kill = () => {
    ee.killCalled += 1;
    return true;
  };
  return ee;
}

/** Tracks the currently-active line source per-spawn so tests emit
 *  `line` events synchronously without going through readline. */
interface SpawnHandle {
  child: FakeChild;
  lineSource: EventEmitter;
  /** Synchronously emit a stdout line into the transport. */
  emitLine(line: string): void;
  /** Synchronously close the subprocess. */
  emitClose(code?: number | null): void;
}

function makeSpawnFleet() {
  const handles: SpawnHandle[] = [];
  const spawnFn = () => {
    const child = makeFakeChild();
    const lineSource = new EventEmitter();
    handles.push({
      child,
      lineSource,
      emitLine: (line) => lineSource.emit("line", line),
      emitClose: (code = 0) => child.emit("close", code, null),
    });
    return child as unknown as ChildProcess;
  };
  const lineSourceFactory = (proc: ChildProcess) => {
    const handle = handles.find((h) => (h.child as unknown) === proc);
    if (!handle) throw new Error("test scaffolding: lineSource for unknown child");
    return handle.lineSource;
  };
  return { handles, spawnFn, lineSourceFactory };
}

class ManualScheduler {
  private currentTime = 0;
  private nextId = 0;
  private timers = new Map<number, { fireAt: number; cb: () => void }>();

  setTimeout(cb: () => void, ms: number): NodeJS.Timeout {
    const id = ++this.nextId;
    this.timers.set(id, { fireAt: this.currentTime + ms, cb });
    return id as unknown as NodeJS.Timeout;
  }
  clearTimeout(t: NodeJS.Timeout): void {
    this.timers.delete(t as unknown as number);
  }
  now(): number {
    return this.currentTime;
  }
  advance(ms: number): void {
    const target = this.currentTime + ms;
    while (true) {
      let earliest: { id: number; fireAt: number; cb: () => void } | null = null;
      for (const [id, t] of this.timers) {
        if (t.fireAt > target) continue;
        if (!earliest || t.fireAt < earliest.fireAt) {
          earliest = { id, ...t };
        }
      }
      if (!earliest) break;
      this.timers.delete(earliest.id);
      this.currentTime = earliest.fireAt;
      earliest.cb();
    }
    this.currentTime = target;
  }
}

/** Drain microtasks so any `.then` chains after a synchronous emit run. */
async function drain(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EvoSubprocessTransport — MCP-300 per-call timeout", () => {
  it("rejects with EvoBridgeTimeoutError when subprocess does not respond", async () => {
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: { callTimeoutMs: 1000, failureThreshold: 999 },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    const sendPromise = transport.send({ cmd: "observe_text" });
    await drain();
    fleet.handles[0]!.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
    await drain();

    scheduler.advance(1500);
    await drain();

    await assert.rejects(sendPromise, (err: unknown) => {
      assert.ok(err instanceof EvoBridgeTimeoutError, `expected timeout error, got ${err}`);
      assert.equal((err as EvoBridgeTimeoutError).timeoutMs, 1000);
      return true;
    });
  });

  it("drops late stdout response after caller already timed out", async () => {
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: { callTimeoutMs: 1000, failureThreshold: 999 },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    const sendPromise = transport.send({ cmd: "observe_text" });
    await drain();
    fleet.handles[0]!.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
    await drain();

    scheduler.advance(1500);
    await drain();
    await assert.rejects(sendPromise, EvoBridgeTimeoutError);

    // Late response must not throw, must not resolve any other promise.
    fleet.handles[0]!.emitLine(JSON.stringify({ ok: true, late: true }));
    await drain();
  });
});

describe("EvoSubprocessTransport — MCP-301 restart + breaker", () => {
  it("re-spawns after subprocess close + cooldown when send is queued", async () => {
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: {
        callTimeoutMs: 60_000,
        failureThreshold: 999,
        restartCooldownMs: 100,
        maxRestarts: 5,
      },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    // Trigger first spawn
    const p1 = transport.send({ cmd: "first" });
    await drain();
    fleet.handles[0]!.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
    await drain();

    // Subprocess dies before responding to the user cmd
    fleet.handles[0]!.emitClose(137);
    await drain();
    await assert.rejects(p1, /subprocess|close/i);
    assert.equal(transport.getState(), "restarting");

    // Wait cooldown then enqueue a new cmd → triggers respawn
    scheduler.advance(150);
    await drain();
    const p2 = transport.send({ cmd: "second" });
    await drain();
    assert.equal(fleet.handles.length, 2, "expected respawn after cooldown");
    fleet.handles[1]!.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
    await drain();
    fleet.handles[1]!.emitLine(JSON.stringify({ ok: true, second: true }));
    await drain();
    const result = await p2;
    assert.deepEqual(result, { ok: true, second: true });
  });

  it("locks breaker open after maxRestarts exhausted", async () => {
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: {
        callTimeoutMs: 60_000,
        failureThreshold: 999,
        restartCooldownMs: 10,
        maxRestarts: 2,
      },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    // Each iteration: spawn → handshake → close → cooldown
    for (let i = 0; i < 3; i++) {
      const p = transport.send({ cmd: `iter${i}` });
      await drain();
      const h = fleet.handles[fleet.handles.length - 1]!;
      h.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
      await drain();
      h.emitClose(1);
      await drain();
      await assert.rejects(p);
      scheduler.advance(50);
      await drain();
    }

    // Next send should reject with breaker-open
    const final = transport.send({ cmd: "after-breaker" });
    await assert.rejects(final, EvoBridgeBreakerOpenError);
    assert.equal(transport.getState(), "breaker_open");
  });
});

describe("EvoSubprocessTransport — MCP-302 bounded queue", () => {
  it("rejects synchronously when queue depth exceeded", async () => {
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: { callTimeoutMs: 60_000, maxQueueDepth: 3 },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    // First send fires spawn — handshake (unshift, becomes inflight) + p1 (queued).
    // Inflight=1 + queue=1 → totalDepth=2. One more send → totalDepth=3.
    // Next send should hit max=3 → reject.
    const p1 = transport.send({ cmd: "a" });
    await drain();
    const p2 = transport.send({ cmd: "b" });
    await drain();
    await assert.rejects(
      transport.send({ cmd: "c" }),
      (err: unknown) => err instanceof EvoBridgeBackpressureError,
    );

    // Cleanup — fail handshake to unwind pending
    fleet.handles[0]!.emitLine(JSON.stringify({ ok: false, error: "test cleanup" }));
    await drain();
    fleet.handles[0]!.emitLine(JSON.stringify({ ok: false, error: "test cleanup p1" }));
    await drain();
    fleet.handles[0]!.emitLine(JSON.stringify({ ok: false, error: "test cleanup p2" }));
    await drain();
    await Promise.allSettled([p1, p2]);
  });
});

describe("EvoSubprocessTransport — MCP-305 version handshake", () => {
  it("accepts matching protocol major and proceeds", async () => {
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: { protocolMajor: 1, callTimeoutMs: 60_000 },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    const p = transport.send({ cmd: "ping" });
    await drain();
    fleet.handles[0]!.emitLine(JSON.stringify({ ok: true, protocol_version: "1.4" }));
    await drain();
    fleet.handles[0]!.emitLine(JSON.stringify({ ok: true, pong: true }));
    await drain();
    const result = await p;
    assert.deepEqual(result, { ok: true, pong: true });
    assert.equal(transport.getProtocolVersion(), "1.4");
  });

  it("locks breaker on version mismatch", async () => {
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: { protocolMajor: 1, callTimeoutMs: 60_000 },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    const p = transport.send({ cmd: "ping" });
    await drain();
    fleet.handles[0]!.emitLine(JSON.stringify({ ok: true, protocol_version: "2.0" }));
    await drain();

    await assert.rejects(p, () => true);
    assert.equal(transport.getState(), "breaker_open");
  });

  it("treats 'unknown command' rejection as legacy v1 and proceeds", async () => {
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: { protocolMajor: 1, callTimeoutMs: 60_000 },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    const p = transport.send({ cmd: "ping" });
    await drain();
    // Handshake response: legacy binary returns ok=false for `version` cmd.
    // Transport's onHandshakeOk parses it: no protocol_version field → legacy.
    fleet.handles[0]!.emitLine(JSON.stringify({ ok: false, error: "unknown command" }));
    await drain();
    // User cmd response — should resolve the user promise.
    fleet.handles[0]!.emitLine(JSON.stringify({ ok: true, pong: true }));
    await drain();

    const result = await p;
    assert.deepEqual(result, { ok: true, pong: true });
    assert.match(transport.getProtocolVersion() ?? "", /legacy/);
  });
});

describe("EvoSubprocessTransport — MCP-307 multi-line startup error", () => {
  it("accumulates multiple unsolicited stdout lines and surfaces both in close reason", async () => {
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: { callTimeoutMs: 60_000, failureThreshold: 999, maxRestarts: 5 },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    // Phase 1: drive a complete send/response cycle so inflight returns to
    // null and queue is empty. Now we have a "gap" where any subsequent
    // lineSource emissions go through the unsolicited path.
    const p1 = transport.send({ cmd: "first" });
    await drain();
    fleet.handles[0]!.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
    await drain();
    fleet.handles[0]!.emitLine(JSON.stringify({ ok: true, first: true }));
    await drain();
    await p1;

    // Phase 2: emit two unsolicited banner lines while inflight is null.
    // Both should accumulate (MCP-307 — pre-fix code would overwrite the
    // first with the second).
    fleet.handles[0]!.emitLine(JSON.stringify({ error: "model dir not found" }));
    fleet.handles[0]!.emitLine(JSON.stringify({ error: "falling back to blake3" }));
    await drain();

    // Phase 3: queue a new send, then close the subprocess so the close
    // handler renders a reason that includes both banner lines.
    const p2 = transport.send({ cmd: "second" });
    await drain();
    fleet.handles[0]!.emitClose(1);
    await drain();

    await assert.rejects(p2, (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /model dir not found/, `expected first banner: ${msg}`);
      assert.match(msg, /falling back to blake3/, `expected second banner: ${msg}`);
      return true;
    });
  });
});

describe("EvoSubprocessTransport — CYCLE4-MCP-002 sustained-healthy restart reset", () => {
  it("restartCount resets after a sustained-healthy window between failure clusters", async () => {
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    // maxRestarts=3, restartCountResetAfterMs=10_000 — small numbers so
    // virtual time advances stay readable. 2 failure clusters of 2 restarts
    // each, separated by 15s of healthy uptime; without the reset the
    // 4th restart would trip breaker.
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: {
        callTimeoutMs: 60_000,
        failureThreshold: 999,
        restartCooldownMs: 100,
        maxRestarts: 3,
        restartCountResetAfterMs: 10_000,
      },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    // Cluster 1: 2 restarts.
    for (let i = 0; i < 2; i++) {
      const p = transport.send({ cmd: `c1-${i}` });
      await drain();
      const h = fleet.handles[fleet.handles.length - 1]!;
      h.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
      await drain();
      // Drive a successful response so lastSuccessAt updates.
      h.emitLine(JSON.stringify({ ok: true, c1: i }));
      await drain();
      const result = await p;
      assert.deepEqual(result, { ok: true, c1: i });
      // Force a subprocess close → restart.
      h.emitClose(1);
      await drain();
      scheduler.advance(2_000); // cooldown (well above exponential-backoff max for this test)
      await drain();
    }
    assert.equal(transport.getState(), "idle", "post-cluster-1: idle");

    // Sustained-healthy window: drive a successful call so lastSuccessAt
    // is fresh, then advance virtual time past restartCountResetAfterMs.
    const healthy = transport.send({ cmd: "healthy-ping" });
    await drain();
    fleet.handles[fleet.handles.length - 1]!.emitLine(
      JSON.stringify({ ok: true, protocol_version: "1.0" }),
    );
    await drain();
    fleet.handles[fleet.handles.length - 1]!.emitLine(
      JSON.stringify({ ok: true, healthy: true }),
    );
    await drain();
    await healthy;

    scheduler.advance(15_000); // > restartCountResetAfterMs (10_000)
    await drain();

    // Cluster 2: 2 close-mid-flight restarts. CRUCIAL — neither iteration
    // emits a successful USER response; if we did, the response would
    // refresh `lastSuccessAt` and the reset would never fire (the bug
    // the audit reviewer caught in the original v of this test). Iter 0
    // closes mid-flight while c2-0 is inflight; that triggers
    // scheduleRestart with `lastSuccessAt` still pointing at the
    // healthy-ping timestamp ~15s ago → reset fires → restartCount=0→1.
    // Iter 1 closes after the handshake response (handshakes don't
    // refresh lastSuccessAt by design). With the audit-followup
    // `lastSuccessAt = null` after-reset clear, iter-1's reset condition
    // is false (null), so restartCount goes 1→2; without that clear,
    // iter-1 would reset again to 0→1. Either path keeps state out of
    // breaker_open with maxRestarts=3.
    {
      const p = transport.send({ cmd: "c2-0" });
      await drain();
      const h = fleet.handles[fleet.handles.length - 1]!;
      h.emitClose(1); // close mid-flight, no response
      await drain();
      try { await p; } catch { /* expected: closed mid-flight */ }
      scheduler.advance(2_000);
      await drain();
    }
    {
      const p = transport.send({ cmd: "c2-1" });
      await drain();
      const h = fleet.handles[fleet.handles.length - 1]!;
      // Settle ONLY the handshake — don't drive a user response so
      // lastSuccessAt stays untouched.
      h.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
      await drain();
      h.emitClose(1);
      await drain();
      try { await p; } catch { /* expected */ }
      scheduler.advance(2_000);
      await drain();
    }

    // Critical assertion: breaker did NOT trip (cluster-2 was a fresh
    // 2-restart count post-reset, not 4-restart cumulative).
    assert.notEqual(
      transport.getState(),
      "breaker_open",
      "sustained-healthy reset must prevent breaker trip across long-tail failure clusters",
    );
  });

  it("WITHOUT sustained-healthy window, accumulated restarts still trip breaker", async () => {
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: {
        callTimeoutMs: 60_000,
        failureThreshold: 999,
        restartCooldownMs: 10,
        maxRestarts: 2,
        restartCountResetAfterMs: 60 * 60 * 1_000, // 1 hour
      },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    // 3 tight-window failure-restart cycles → exceeds maxRestarts=2 → breaker.
    for (let i = 0; i < 3; i++) {
      const p = transport.send({ cmd: `tight-${i}` });
      await drain();
      const h = fleet.handles[fleet.handles.length - 1]!;
      h.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
      await drain();
      h.emitClose(1);
      await drain();
      try { await p; } catch { /* expected */ }
      scheduler.advance(50); // small advance, well under reset threshold
      await drain();
    }

    const final = transport.send({ cmd: "after-tight-cluster" });
    await assert.rejects(final, EvoBridgeBreakerOpenError);
    assert.equal(transport.getState(), "breaker_open");
  });

  // -------------------------------------------------------------------------
  // CYCLE4-MCP-002 audit follow-up — required tests added after adversarial
  // review flagged: (i) boundary, (ii) multi-reset durability,
  // (iii) handshake-only must NOT refresh lastSuccessAt, (iv) recordFailure
  // path interacts cleanly with the reset, plus the new lifetime-cap brick.
  // -------------------------------------------------------------------------

  it("(i) reset fires at the EXACT boundary (now - lastSuccessAt === restartCountResetAfterMs)", async () => {
    // The reset condition uses `>=`. This test confirms the boundary
    // is inclusive: at exactly the threshold, the reset MUST fire. If
    // the comparison were `>`, the third restart in this scenario
    // would push restartCount past maxRestarts=2 and trip the breaker.
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: {
        callTimeoutMs: 60_000,
        failureThreshold: 999,
        restartCooldownMs: 100,
        maxRestarts: 2,
        restartCountResetAfterMs: 10_000,
      },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    // Setup: 2 successful round-trips that each close → restartCount=2,
    // lastSuccessAt = scheduler.now() at the second user-response.
    for (let i = 0; i < 2; i++) {
      const p = transport.send({ cmd: `setup-${i}` });
      await drain();
      const h = fleet.handles[fleet.handles.length - 1]!;
      h.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
      await drain();
      h.emitLine(JSON.stringify({ ok: true, setup: i }));
      await drain();
      await p;
      h.emitClose(1);
      await drain();
      scheduler.advance(1_000);
      await drain();
    }
    const tAfterSetup = scheduler.now();
    // lastSuccessAt was set at the moment the SECOND emitLine was
    // processed — that moment had scheduler.now() === tAfterSetup - 1_000
    // (one advance of 1_000 happened after). Need to advance such that
    // (tNow - lastSuccessAt) is EXACTLY 10_000.
    const targetDelta = 10_000;
    const elapsedSinceLastSuccess = 1_000; // the advance after iter 1's emitLine
    scheduler.advance(targetDelta - elapsedSinceLastSuccess);
    await drain();

    // Trigger scheduleRestart via close-mid-flight on a fresh spawn.
    // We MUST emit the handshake response first so the user command
    // becomes inflight; otherwise the close fails only the handshake
    // and `boundary-probe` is left orphaned in the queue with no
    // settler, which hangs the test. The handshake response does not
    // refresh `lastSuccessAt` (filtered by `isHandshake`), so the
    // boundary check still reads the setup-phase timestamp.
    const p = transport.send({ cmd: "boundary-probe" });
    await drain();
    {
      const h = fleet.handles[fleet.handles.length - 1]!;
      h.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
      await drain();
      h.emitClose(1);
      await drain();
    }
    try { await p; } catch { /* expected */ }

    // If the reset fired at the boundary (`>=` semantic), restartCount
    // went 2 → 0 → 1, no breaker. If the reset DID NOT fire (`>`
    // semantic), restartCount went 2 → 3 > maxRestarts(2) → breaker.
    assert.notEqual(
      transport.getState(),
      "breaker_open",
      "reset must fire at the exact >= boundary",
    );
    void tAfterSetup; // keep tsc happy when unused
  });

  it("(ii) multiple sequential resets — 3 clusters with healthy gaps stay non-breaker", async () => {
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: {
        callTimeoutMs: 60_000,
        failureThreshold: 999,
        restartCooldownMs: 100,
        maxRestarts: 2,
        restartCountResetAfterMs: 5_000,
        // Lifetime cap well above 3 clusters × 2 restarts = 6.
        restartCountLifetimeCap: 100,
      },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    // 3 clusters of (healthy ping → 2 close-mid-flight restarts), with
    // a 6_000ms healthy gap between clusters (> reset threshold). After
    // each cluster, restartCount should reset to 0 before the next
    // cluster's increments. State stays non-breaker throughout.
    for (let cluster = 0; cluster < 3; cluster++) {
      // Healthy ping first to set lastSuccessAt.
      {
        const p = transport.send({ cmd: `healthy-${cluster}` });
        await drain();
        const h = fleet.handles[fleet.handles.length - 1]!;
        h.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
        await drain();
        h.emitLine(JSON.stringify({ ok: true, healthy: cluster }));
        await drain();
        await p;
      }

      // Wait > reset threshold so the next failure cluster triggers reset.
      scheduler.advance(6_000);
      await drain();

      // 2 close-mid-flight restarts.
      for (let i = 0; i < 2; i++) {
        const p = transport.send({ cmd: `cluster-${cluster}-${i}` });
        await drain();
        const h = fleet.handles[fleet.handles.length - 1]!;
        // Iter 0: close mid-flight before any response (so lastSuccessAt
        // stays the healthy-ping timestamp on iter 0; iter 1 will see
        // lastSuccessAt=null after iter 0's reset clears it).
        if (i === 1) {
          h.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
          await drain();
        }
        h.emitClose(1);
        await drain();
        try { await p; } catch { /* expected */ }
        scheduler.advance(1_000);
        await drain();
      }

      assert.notEqual(
        transport.getState(),
        "breaker_open",
        `cluster ${cluster}: state should not be breaker_open`,
      );
    }
  });

  it("(iii) handshake-only success does NOT refresh lastSuccessAt — pure-handshake flap still bricks", async () => {
    // Regression guard for the `isHandshake` filter at
    // evo-subprocess-transport.ts:530. If a future edit forgot to mark
    // the handshake's enqueue as `isHandshake=true`, the handshake's
    // response would silently refresh lastSuccessAt on every (re-)spawn,
    // perpetually deferring the brick during a tight-window failure
    // cluster — the slow-flap blind spot the audit reviewer flagged.
    //
    // Setup: only handshake responses fire (no user-command responses).
    // lastSuccessAt MUST stay null. With reset never firing, the brick
    // path goes through maxRestarts in the normal way.
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: {
        callTimeoutMs: 60_000,
        failureThreshold: 999,
        restartCooldownMs: 50,
        maxRestarts: 2,
        // Long enough that the test's wall-time advance would PASS the
        // reset threshold IF lastSuccessAt were ever set. The point of
        // this test is to prove it never gets set when only handshakes
        // succeed, so the reset never fires regardless of advance.
        restartCountResetAfterMs: 5_000,
        restartCountLifetimeCap: 100,
      },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    // 3 cycles: spawn → handshake-OK → close. Advance 10_000ms between
    // each (≫ reset threshold). If handshakes leaked into lastSuccessAt,
    // the reset would fire on cycles 2 and 3 and the breaker would NOT
    // trip — that's the regression we're guarding against.
    for (let i = 0; i < 3; i++) {
      const p = transport.send({ cmd: `hs-only-${i}` });
      await drain();
      const h = fleet.handles[fleet.handles.length - 1]!;
      h.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
      await drain();
      h.emitClose(1);
      await drain();
      try { await p; } catch { /* expected */ }
      // Advance well past the reset threshold — proves the threshold
      // is moot when lastSuccessAt is null.
      scheduler.advance(10_000);
      await drain();
    }

    // After 3 cumulative restarts and maxRestarts=2, breaker MUST be open.
    // If `lastSuccessAt` had been incorrectly refreshed by handshake
    // responses, the reset would have fired between cycles and we'd be
    // in `idle`/`restarting` instead.
    const final = transport.send({ cmd: "after-handshake-flap" });
    await assert.rejects(final, EvoBridgeBreakerOpenError);
    assert.equal(
      transport.getState(),
      "breaker_open",
      "handshake-only successes must NOT refresh lastSuccessAt; breaker must trip on cumulative maxRestarts",
    );
  });

  it("(iv) recordFailure-driven scheduleRestart goes through the same lifetime + reset bookkeeping", async () => {
    // Earlier tests trigger scheduleRestart via close-mid-flight
    // (handleSubprocessFailure path). This test triggers it via the
    // call-timeout → recordFailure → scheduleRestart path. The reset
    // logic lives inside scheduleRestart and is path-agnostic; this
    // test guards the property by exercising the failureThreshold arm.
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: {
        callTimeoutMs: 100,
        failureThreshold: 1, // every recorded failure → scheduleRestart
        restartCooldownMs: 50,
        maxRestarts: 2,
        restartCountResetAfterMs: 60 * 60 * 1_000, // long; not tested here
        restartCountLifetimeCap: 100,
      },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    // Two timeout-driven restarts, then one more — third hits maxRestarts.
    for (let i = 0; i < 3; i++) {
      const p = transport.send({ cmd: `timeout-${i}` });
      await drain();
      // Settle the handshake so the user command becomes inflight.
      const h = fleet.handles[fleet.handles.length - 1]!;
      h.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
      await drain();
      // Advance past the call timeout — recordFailure fires →
      // failureThreshold(1) hit → scheduleRestart.
      scheduler.advance(200);
      await drain();
      try { await p; } catch { /* expected: timeout */ }
      // Cooldown advance so the next iteration finds state=idle.
      scheduler.advance(200);
      await drain();
    }

    // 3 timeouts → restartCount = 3 > maxRestarts(2) → breaker. This
    // mirrors the close-mid-flight tight-cluster path.
    const final = transport.send({ cmd: "after-timeout-cluster" });
    await assert.rejects(final, EvoBridgeBreakerOpenError);
    assert.equal(transport.getState(), "breaker_open");
  });

  it("(v) lifetime cap bricks a slow-flap process even with healthy gaps between clusters", async () => {
    // Closes the slow-flap blind spot the audit reviewer flagged: an
    // EVO bug crashing once per (resetWindow + ε), with healthy traffic
    // in between, would otherwise reset `restartCount` indefinitely
    // and never brick. The never-reset `restartCountLifetimeCap` is
    // the hard ceiling that preserves the cycle-3 invariant
    // ("evidence the binary is structurally broken").
    const scheduler = new ManualScheduler();
    const fleet = makeSpawnFleet();
    const transport = new EvoSubprocessTransport({
      binaryPath: "evo",
      dbPath: "/tmp/evo.db",
      policy: {
        callTimeoutMs: 60_000,
        failureThreshold: 999,
        restartCooldownMs: 50,
        maxRestarts: 100, // disable the windowed cap; we want the lifetime cap to fire
        restartCountResetAfterMs: 5_000,
        restartCountLifetimeCap: 4, // small for test
      },
      spawnFn: fleet.spawnFn,
      lineSourceFactory: fleet.lineSourceFactory,
      scheduler,
    });

    // 5 close-mid-flight cycles, each preceded by a 10s healthy gap so
    // the windowed reset would fire on every cycle — but the lifetime
    // cap (4) is hit on the 5th cycle's scheduleRestart and bricks.
    for (let i = 0; i < 5; i++) {
      // Healthy ping to set lastSuccessAt fresh.
      {
        const p = transport.send({ cmd: `lt-healthy-${i}` });
        await drain();
        const h = fleet.handles[fleet.handles.length - 1]!;
        h.emitLine(JSON.stringify({ ok: true, protocol_version: "1.0" }));
        await drain();
        h.emitLine(JSON.stringify({ ok: true, healthy: i }));
        await drain();
        await p;
      }
      scheduler.advance(10_000); // > resetWindow → reset would fire on next failure
      await drain();
      // Close-mid-flight failure. After the healthy ping above the
      // process is still alive (no close in the healthy branch), so
      // state=running and the user command goes inflight directly. No
      // handshake-in-the-way; close fails the user command cleanly.
      const p = transport.send({ cmd: `lt-fail-${i}` });
      await drain();
      const h = fleet.handles[fleet.handles.length - 1]!;
      h.emitClose(1);
      await drain();
      try { await p; } catch { /* expected */ }
      scheduler.advance(200);
      await drain();
      if (transport.getState() === "breaker_open") {
        // Lifetime cap should fire on the 5th iteration's scheduleRestart.
        assert.ok(i >= 3, `lifetime cap should fire on iteration > cap (${i})`);
        return;
      }
    }
    assert.fail("lifetime cap never fired — slow-flap was not bricked");
  });
});
