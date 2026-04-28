/**
 * MCP-310 (cycle-3) — InMemoryIdempotencyStore TTL semantics.
 *
 * Pre-fix behavior armed `setTimeout(... ttlMs)` at acquire-start time;
 * a long-running `fn()` whose duration exceeded ttlMs could be evicted
 * mid-execution, allowing a concurrent caller to spawn a second
 * invocation with the same key.
 *
 * Post-fix: TTL eviction is armed at SETTLE time. While `fn()` is
 * in-flight, the entry has `expiresAt = null` and no timer, so concurrent
 * callers piggyback on the same promise indefinitely.
 *
 * Coverage:
 *   1. Long-running `fn()` (longer than ttlMs) — concurrent acquire
 *      receives the SAME result. fn is invoked exactly once.
 *   2. After settle, TTL is honored — eviction fires at settle + ttlMs.
 *   3. After eviction, a new acquire calls fn again (cache miss).
 *
 * Runs under `node --import tsx --test`.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import { InMemoryIdempotencyStore } from "../src/pipeline/idempotency.js";
import type { Result } from "../src/types/action.js";

/** Manual clock + timer harness so the test deterministically advances time. */
class ManualClock {
  private nowMs = 1_000_000;
  private nextId = 0;
  private timers = new Map<number, { fireAt: number; cb: () => void }>();

  setTimeout = (cb: () => void, ms: number): NodeJS.Timeout => {
    const id = ++this.nextId;
    this.timers.set(id, { fireAt: this.nowMs + ms, cb });
    return id as unknown as NodeJS.Timeout;
  };

  clearTimeout = (t: NodeJS.Timeout): void => {
    this.timers.delete(t as unknown as number);
  };

  now = (): number => this.nowMs;

  advance(ms: number): void {
    const target = this.nowMs + ms;
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
      this.nowMs = earliest.fireAt;
      earliest.cb();
    }
    this.nowMs = target;
  }
}

async function drain(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("InMemoryIdempotencyStore — MCP-310 settle-time TTL", () => {
  it("long-running fn() outliving ttlMs is NOT evicted; concurrent acquire piggybacks", async () => {
    const clock = new ManualClock();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    // Patch global setTimeout/clearTimeout so the store uses our clock.
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
      clock.setTimeout as unknown as typeof setTimeout;
    (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout =
      clock.clearTimeout as unknown as typeof clearTimeout;

    try {
      const store = new InMemoryIdempotencyStore({ ttlMs: 100, now: clock.now });

      let invocations = 0;
      // Manually-resolved promise so we control when fn settles.
      let resolveFn: ((v: Result<{ value: number }>) => void) | null = null;
      const fn = async (): Promise<Result<{ value: number }>> => {
        invocations++;
        return new Promise<Result<{ value: number }>>((r) => {
          resolveFn = r;
        });
      };

      // First acquire — fn starts, returns the in-flight promise
      const p1 = store.acquire("k", fn);
      await drain();
      assert.equal(invocations, 1);

      // Advance well past ttlMs; pre-fix code would have evicted by now.
      clock.advance(500);
      await drain();
      assert.equal(store.size(), 1, "in-flight entry must NOT be evicted");

      // Second acquire AFTER would-be ttl expiry — must piggyback on the
      // SAME promise, NOT call fn again.
      const p2 = store.acquire("k", fn);
      await drain();
      assert.equal(invocations, 1, "fn must be called exactly once");

      // Settle the in-flight promise. Both callers should observe it.
      resolveFn!({ ok: true, value: { value: 42 } });
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.deepEqual(r1, { ok: true, value: { value: 42 } });
      assert.deepEqual(r2, { ok: true, value: { value: 42 } });
    } finally {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
        originalSetTimeout;
      (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout =
        originalClearTimeout;
    }
  });

  it("after settle, TTL is honored from settle time and eviction fires", async () => {
    const clock = new ManualClock();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
      clock.setTimeout as unknown as typeof setTimeout;
    (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout =
      clock.clearTimeout as unknown as typeof clearTimeout;

    try {
      const store = new InMemoryIdempotencyStore({ ttlMs: 100, now: clock.now });
      let invocations = 0;
      const fn = async (): Promise<Result<{ value: string }>> => {
        invocations++;
        return { ok: true, value: { value: `call${invocations}` } };
      };

      const r1 = await store.acquire("k", fn);
      await drain(); // let promise.finally fire to arm the timer
      assert.deepEqual(r1, { ok: true, value: { value: "call1" } });
      assert.equal(invocations, 1);
      assert.equal(store.size(), 1);

      // Within TTL → cache hit
      clock.advance(50);
      await drain();
      const r2 = await store.acquire("k", fn);
      assert.deepEqual(r2, { ok: true, value: { value: "call1" } });
      assert.equal(invocations, 1);

      // Past TTL → eviction fires; next acquire calls fn again.
      clock.advance(200);
      await drain();
      const r3 = await store.acquire("k", fn);
      await drain();
      assert.deepEqual(r3, { ok: true, value: { value: "call2" } });
      assert.equal(invocations, 2);
    } finally {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
        originalSetTimeout;
      (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout =
        originalClearTimeout;
    }
  });
});
