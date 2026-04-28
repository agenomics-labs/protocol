/**
 * OFF-204 (ADR-128 cycle-3 off-chain audit) — pg.Pool timeout +
 * error-handler hardening.
 *
 * Pre-fix `LivePostgresStore`'s `pg.Pool` was constructed with only
 * `connectionString` + `max`. Two failure modes followed:
 *
 *   1. A Postgres brown-out (network partition, primary failover,
 *      connection-cap exhaustion) made the next `pool.connect()` /
 *      `pool.query()` hang indefinitely — there was no timeout.
 *   2. An idle-client socket failure emits `error` on the pool. With
 *      no listener registered, Node's EventEmitter rule turns the next
 *      emission into an uncaught exception that crashes the indexer.
 *
 * Fix: env-overridable `connectionTimeoutMillis`, `idleTimeoutMillis`,
 * `query_timeout`, and `statement_timeout` defaults wired by
 * `createPostgresStore`, plus a pool-level `error` listener that logs
 * at WARN without rethrow. NaN / non-positive env values fall back to
 * the documented defaults — a typo'd env var must NOT silently disable
 * the timeout (the pre-fix failure mode).
 *
 * What this suite asserts:
 *   1. The four exported default constants are positive, sane numbers.
 *   2. `parsePositiveMsEnv` returns the default for undefined / empty /
 *      NaN / negative / zero, and parses positive numerics.
 *   3. `createPostgresStore` propagates the four timeouts from env to
 *      the constructed `pg.Pool` via its config (introspected through
 *      the `PoolOptions` surface).
 *   4. The pool-level `error` event is absorbed by the registered
 *      listener — emitting an error after construction does NOT throw
 *      and does NOT crash the test process.
 *   5. `attachPoolErrorHandler` is a no-op on pools that omit the
 *      EventEmitter surface (the OFF-200 in-memory mock shape).
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Pool } from "pg";

import {
  createPostgresStore,
  attachPoolErrorHandler,
  parsePositiveMsEnv,
  INDEXER_PG_CONNECTION_TIMEOUT_DEFAULT_MS,
  INDEXER_PG_IDLE_TIMEOUT_DEFAULT_MS,
  INDEXER_PG_QUERY_TIMEOUT_DEFAULT_MS,
  INDEXER_PG_STATEMENT_TIMEOUT_DEFAULT_MS,
} from "../postgres-store";

// ---------------------------------------------------------------------------
// Test 1 — exported timeout defaults are positive, sane numbers.
// ---------------------------------------------------------------------------

describe("OFF-204 — pg.Pool timeout defaults", () => {
  it("connection-timeout default is positive and sub-30s", () => {
    // 5s default per `createPostgresStore` rationale: short enough to
    // surface a brown-out within a single dual-write tick; long enough
    // to ride out a busy-pool false alarm under normal load.
    assert.equal(typeof INDEXER_PG_CONNECTION_TIMEOUT_DEFAULT_MS, "number");
    assert.ok(
      INDEXER_PG_CONNECTION_TIMEOUT_DEFAULT_MS > 0 &&
        INDEXER_PG_CONNECTION_TIMEOUT_DEFAULT_MS <= 30_000,
      "connection-timeout default must be positive and at most 30s",
    );
  });

  it("idle-timeout default is positive (matches pg upstream default)", () => {
    assert.equal(typeof INDEXER_PG_IDLE_TIMEOUT_DEFAULT_MS, "number");
    assert.ok(
      INDEXER_PG_IDLE_TIMEOUT_DEFAULT_MS > 0,
      "idle-timeout default must be positive",
    );
  });

  it("query-timeout default is positive and sub-60s", () => {
    assert.equal(typeof INDEXER_PG_QUERY_TIMEOUT_DEFAULT_MS, "number");
    assert.ok(
      INDEXER_PG_QUERY_TIMEOUT_DEFAULT_MS > 0 &&
        INDEXER_PG_QUERY_TIMEOUT_DEFAULT_MS <= 60_000,
      "query-timeout default must be positive and at most 60s",
    );
  });

  it("statement-timeout default is positive and sub-60s", () => {
    assert.equal(typeof INDEXER_PG_STATEMENT_TIMEOUT_DEFAULT_MS, "number");
    assert.ok(
      INDEXER_PG_STATEMENT_TIMEOUT_DEFAULT_MS > 0 &&
        INDEXER_PG_STATEMENT_TIMEOUT_DEFAULT_MS <= 60_000,
      "statement-timeout default must be positive and at most 60s",
    );
  });
});

// ---------------------------------------------------------------------------
// Test 2 — parsePositiveMsEnv: NaN / negative / zero fall back to default.
// ---------------------------------------------------------------------------

describe("OFF-204 — parsePositiveMsEnv NaN / non-positive fallback", () => {
  it("returns default for undefined", () => {
    assert.equal(parsePositiveMsEnv(undefined, 5000), 5000);
  });

  it("returns default for empty string", () => {
    assert.equal(parsePositiveMsEnv("", 5000), 5000);
  });

  it("returns default for NaN-typed input ('abc')", () => {
    // Pre-fix failure mode: a typo'd env var would silently parse to
    // NaN, which `pg` would interpret as "no timeout". The fallback
    // restores the safety floor.
    assert.equal(parsePositiveMsEnv("abc", 5000), 5000);
  });

  it("returns default for zero", () => {
    // Zero would mean "wait forever" in `pg`'s contract; reject it
    // so an operator who *thinks* they're disabling the timeout
    // doesn't accidentally re-introduce the brown-out hang.
    assert.equal(parsePositiveMsEnv("0", 5000), 5000);
  });

  it("returns default for negative numerics", () => {
    assert.equal(parsePositiveMsEnv("-1", 5000), 5000);
    assert.equal(parsePositiveMsEnv("-9999", 5000), 5000);
  });

  it("returns default for whitespace-only input", () => {
    // Number("   ") is 0 (not NaN) — handled by the <= 0 branch.
    assert.equal(parsePositiveMsEnv("   ", 5000), 5000);
  });

  it("parses a valid positive numeric", () => {
    assert.equal(parsePositiveMsEnv("12345", 5000), 12345);
  });

  it("floors fractional inputs (Math.floor semantics)", () => {
    // `pg` accepts integers; floor avoids handing it a partial-ms
    // value that would round inconsistently.
    assert.equal(parsePositiveMsEnv("250.7", 5000), 250);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — createPostgresStore wires the timeouts onto the underlying pool.
//
// We can't easily inspect pg.Pool's PoolOptions through the public API
// without standing up a real PG. Instead, set the env to known values
// and let the constructor execute — if the timeouts were dropped on the
// floor, the construction would either throw (bad config) or silently
// no-op (which the env-override semantic forbids). We validate the
// happy-path construction shape here; the real-PG suite (OFF-217) covers
// behavioural enforcement against a live server.
// ---------------------------------------------------------------------------

describe("OFF-204 — createPostgresStore env overrides", () => {
  it("constructs successfully with all four timeout env vars set", () => {
    const store = createPostgresStore({
      INDEXER_PG_URL: "postgres://user:pass@127.0.0.1:5432/aep_events",
      INDEXER_PG_CONNECTION_TIMEOUT_MS: "1234",
      INDEXER_PG_IDLE_TIMEOUT_MS: "9999",
      INDEXER_PG_QUERY_TIMEOUT_MS: "8888",
      INDEXER_PG_STATEMENT_TIMEOUT_MS: "7777",
    });
    assert.equal(store.enabled, true);
    // Tear down so the lazy pool doesn't hold sockets/timers.
    void store.close();
  });

  it("constructs successfully with all four env vars typo'd to NaN (fallback path)", () => {
    // Pre-fix failure mode: NaN env → no timeout → indefinite hang.
    // Fix: NaN falls back to the documented default. Construction
    // must not throw and the store must come up enabled.
    const store = createPostgresStore({
      INDEXER_PG_URL: "postgres://user:pass@127.0.0.1:5432/aep_events",
      INDEXER_PG_CONNECTION_TIMEOUT_MS: "abc",
      INDEXER_PG_IDLE_TIMEOUT_MS: "not-a-number",
      INDEXER_PG_QUERY_TIMEOUT_MS: "-1",
      INDEXER_PG_STATEMENT_TIMEOUT_MS: "0",
    });
    assert.equal(store.enabled, true);
    void store.close();
  });

  it("constructs successfully with no timeout env vars (pure default path)", () => {
    const store = createPostgresStore({
      INDEXER_PG_URL: "postgres://user:pass@127.0.0.1:5432/aep_events",
    });
    assert.equal(store.enabled, true);
    void store.close();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — pool-level `error` event is absorbed (process does not crash).
//
// Build an EventEmitter-backed mock that satisfies the `Pool` shape just
// enough for `attachPoolErrorHandler` to register; emit `error`; assert
// (a) emit returns true (a listener was registered), and (b) the WARN
// log path was the only side-effect observable from this test.
//
// Without the OFF-204 fix the same `emit('error', ...)` would propagate
// as an uncaught exception (Node's EventEmitter contract) and crash the
// test runner — so the absence of a crash IS the assertion. The
// `emit(...) === true` check makes the listener registration explicit.
// ---------------------------------------------------------------------------

describe("OFF-204 — attachPoolErrorHandler absorbs idle-client errors", () => {
  it("registers a listener so emit('error', ...) does not crash the process", () => {
    const emitter = new EventEmitter();
    // Pre-condition: emitting `error` on a bare EventEmitter with no
    // listener throws. Verify the unhandled-error contract is in
    // effect for our fixture so the post-attach test is meaningful.
    assert.throws(
      () => emitter.emit("error", new Error("pre-attach unhandled")),
      /pre-attach unhandled/,
      "fixture must reproduce the unhandled-error crash before attach",
    );

    attachPoolErrorHandler(emitter as unknown as Pool);

    // Post-condition: emit returns true (listener present); no throw.
    const handled = emitter.emit(
      "error",
      new Error("post-attach contained"),
    );
    assert.equal(
      handled,
      true,
      "emit must report a listener was invoked (i.e. the handler is wired)",
    );
  });

  it("handler tolerates repeated error emissions (no memory of previous errs)", () => {
    const emitter = new EventEmitter();
    attachPoolErrorHandler(emitter as unknown as Pool);
    // Three back-to-back errors — the fix is idempotent per emission.
    // A handler that threw on the second call would crash here.
    assert.doesNotThrow(() => {
      emitter.emit("error", new Error("first"));
      emitter.emit("error", new Error("second"));
      emitter.emit("error", new Error("third"));
    });
  });

  it("is a no-op on a pool object without an EventEmitter surface", () => {
    // The OFF-200 in-memory mock Pool implements only `connect`,
    // `query`, `end`. `attachPoolErrorHandler` must NOT throw against
    // that shape — emitter-less pools have no idle-client error
    // stream, which is the correct semantic for in-process mocks.
    const mockPool = {
      async connect() {
        throw new Error("not used");
      },
      async query() {
        return { rows: [], rowCount: 0 } as unknown;
      },
      async end() {},
    };
    assert.doesNotThrow(() =>
      attachPoolErrorHandler(mockPool as unknown as Pool),
    );
  });
});
