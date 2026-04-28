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
