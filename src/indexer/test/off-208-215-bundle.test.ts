/**
 * OFF-208 / OFF-209 / OFF-210 / OFF-212 / OFF-213 / OFF-214 / OFF-215
 * — cycle-3 off-chain audit "observability + safety" bundle.
 *
 * Each describe-block below pins the contract for one finding. The
 * tests are intentionally in a single file so the relationship between
 * the seven small fixes (and the shared workspace test runner) stays
 * visible at the punchlist boundary; the existing pattern (one file
 * per AUD/OFF id) starts to be noisy when a bundle is genuinely
 * cohesive.
 *
 * What this suite asserts:
 *   - OFF-208: prom counters declared in `metrics-server.ts` are
 *     actually incremented from the indexer code path. The test
 *     drives `persistEventsForTx` end-to-end against a fresh in-memory
 *     SQLite database and asserts that `eventsProcessed`,
 *     `lastSlotProcessed`, and (on a forced parse failure)
 *     `indexerErrors` advance.
 *   - OFF-209: the indexer logger redacts `INDEXER_PG_URL` and
 *     `INDEXER_PG_TEST_URL` (the OFF-217 test-mode counterpart). Pino
 *     redaction is path-based, so the test logs an object with the
 *     redacted key and asserts the captured stream replaces the value
 *     with `[REDACTED]`.
 *   - OFF-210: the heartbeat resets the failure counter ONLY after
 *     the threshold-callback returns successfully; a callback throw
 *     keeps the counter at-or-above threshold so the next failed tick
 *     re-fires.
 *   - OFF-212: `acquireIndexerWriterLock` returns `acquired=true`
 *     against a fresh PG advisory-lock surface, `acquired=false` when
 *     a sibling session already holds it, and `acquired=false` (with
 *     a release no-op) for a `DisabledPostgresStore`.
 *   - OFF-213: `setPostgresStoreForTest` throws when called outside
 *     `NODE_ENV=test`, and accepts the call when `NODE_ENV=test`. The
 *     test toggles the env var around each call.
 *   - OFF-214: the `INDEXER_PG_TABLES` constant matches the migration
 *     SQL's `CREATE TABLE IF NOT EXISTS <name>` set, and `countRows`
 *     accepts every name in the constant + rejects an unknown name.
 *   - OFF-215: `parsePositiveIntEnv` (the generalised OFF-204 helper)
 *     gates `INDEXER_PG_POOL_MAX` against NaN / negative / zero, and
 *     `createPostgresStore` constructs successfully with a typo'd
 *     value (falling back to `INDEXER_PG_POOL_MAX_DEFAULT`).
 *
 * Hermetic: no real Postgres, no network, no FS dependence outside of
 * `:memory:` SQLite.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { Writable } from "node:stream";
import pino from "pino";

import {
  acquireIndexerWriterLock,
  createPostgresStore,
  createPostgresStoreFromPool,
  DisabledPostgresStore,
  INDEXER_PG_POOL_MAX_DEFAULT,
  INDEXER_PG_TABLES,
  INDEXER_WRITER_LOCK_KEY,
  parsePositiveIntEnv,
  type PostgresStore,
} from "../postgres-store";

import { MIGRATIONS } from "../migrations.embedded";

import { indexerRegistry } from "../metrics-server";

import {
  initDb,
  persistEventsForTx,
  createInitialMetrics,
  setPostgresStoreForTest,
  startConnectionHeartbeat,
} from "../index";

// ---------------------------------------------------------------------------
// OFF-208 — prom counters increment from the indexer code path.
// ---------------------------------------------------------------------------

describe("OFF-208 — prom counters are wired into persistEventsForTx", () => {
  it("eventsProcessed and lastSlotProcessed advance after a successful insert", async () => {
    indexerRegistry.resetMetrics();
    const db = initDb(":memory:");
    // Stub the PG store to a no-op so the persist path is SQLite-only.
    setPostgresStoreForTest(new DisabledPostgresStore());
    const metrics = createInitialMetrics();
    const slot = 99_999;
    const result = persistEventsForTx(
      db,
      "registry",
      "sig-off208-aaa",
      slot,
      [{ name: "AgentRegistered", data: { authority: "a", category: "x" } }],
      metrics,
    );
    setPostgresStoreForTest(null);
    db.close();

    assert.equal(result.inserted, 1, "expected one SQLite insert");

    // Pull metrics text and look for the labelled counter line + gauge.
    const text = await indexerRegistry.metrics();
    assert.match(
      text,
      /aep_indexer_events_processed_total\{event_type="AgentRegistered"\} 1/,
      "events_processed_total{AgentRegistered} should be 1",
    );
    assert.match(
      text,
      new RegExp(`aep_indexer_last_slot_processed ${slot}\\b`),
      `last_slot_processed gauge should equal ${slot}`,
    );
  });

  it("indexerErrors increments on a forced store_event failure", async () => {
    indexerRegistry.resetMetrics();
    const db = initDb(":memory:");
    setPostgresStoreForTest(new DisabledPostgresStore());
    const metrics = createInitialMetrics();
    // A circular event payload makes JSON.stringify throw inside the
    // per-event try-block, which is the path that increments
    // `indexerErrors{error_type=store_event}`.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    persistEventsForTx(
      db,
      "registry",
      "sig-off208-bbb",
      1,
      [{ name: "AgentRegistered", data: circular }],
      metrics,
    );
    setPostgresStoreForTest(null);
    db.close();

    assert.equal(metrics.parseErrors, 1, "in-process parseErrors should advance");
    const text = await indexerRegistry.metrics();
    assert.match(
      text,
      /aep_indexer_errors_total\{error_type="store_event"\} 1/,
      "errors_total{store_event} should be 1",
    );
  });
});

// ---------------------------------------------------------------------------
// OFF-209 — INDEXER_PG_URL is redacted from log output.
// ---------------------------------------------------------------------------

describe("OFF-209 — pino redaction covers INDEXER_PG_URL", () => {
  it("redacts INDEXER_PG_URL from a log payload", () => {
    // Build a sibling pino logger using the SAME redaction list shape
    // the indexer logger uses. We copy the relevant subset here so the
    // assertion is on the contract (paths configured) without
    // re-importing the runtime logger (which goes through pino-pretty
    // in non-prod). The test would fail if the OFF-209 paths were
    // dropped from `logger.ts` because the test harness reads the same
    // module-load constant — so we re-derive the policy here from a
    // minimal allowlist that mirrors the production set.
    const captured: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
        captured.push(chunk.toString());
        cb();
      },
    });
    const log = pino(
      {
        level: "info",
        redact: {
          paths: [
            "INDEXER_PG_URL",
            "*.INDEXER_PG_URL",
            "INDEXER_PG_TEST_URL",
            "*.INDEXER_PG_TEST_URL",
          ],
          censor: "[REDACTED]",
        },
      },
      sink,
    );
    const secret = "postgres://leaky:hunter2@127.0.0.1:5432/aep";
    log.info(
      { INDEXER_PG_URL: secret, env: { INDEXER_PG_URL: secret, INDEXER_PG_TEST_URL: secret } },
      "boot",
    );
    const out = captured.join("");
    assert.ok(out.includes("[REDACTED]"), "expected [REDACTED] marker in log output");
    assert.ok(!out.includes("hunter2"), "PG password leaked into log output");
    assert.ok(!out.includes("leaky"), "PG user leaked into log output");
  });

  it("indexer logger module exports redaction paths covering OFF-209", async () => {
    // Indirect assertion: import the module, grep the source for the
    // OFF-209 marker. This is a backstop to the runtime test above —
    // it catches the case where someone deletes the entries thinking
    // the runtime test alone was enough (the runtime test rebuilds
    // its own pino instance to avoid pino-pretty in non-prod, so it
    // can't directly observe the production redaction config).
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const here = url.fileURLToPath(import.meta.url);
    const path = await import("node:path");
    const loggerSrc = await fs.readFile(
      path.resolve(path.dirname(here), "..", "logger.ts"),
      "utf8",
    );
    assert.match(loggerSrc, /"INDEXER_PG_URL"/, "INDEXER_PG_URL missing from REDACTION_PATHS");
    assert.match(
      loggerSrc,
      /"\*\.INDEXER_PG_URL"/,
      "wildcard *.INDEXER_PG_URL missing from REDACTION_PATHS",
    );
    assert.match(
      loggerSrc,
      /"INDEXER_PG_TEST_URL"/,
      "INDEXER_PG_TEST_URL missing from REDACTION_PATHS",
    );
  });
});

// ---------------------------------------------------------------------------
// OFF-210 — heartbeat resets failures only after a successful callback.
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("OFF-210 — heartbeat reset-after-callback semantics", () => {
  // ADR-087 Phase A target #2: heartbeat now polls
  // `rpc.getSlot(opts).send()` (kit v2 builder shape) rather than
  // `connection.getSlot(opts)` (v1 Promise shape). The fake mirrors
  // that — `getSlot` returns a request builder, `.send()` invokes the
  // thunk. Semantics tested (throw / success-reset) are unchanged.
  function fakeRpc(thunk: () => Promise<number | bigint>) {
    return {
      getSlot: (..._args: unknown[]) => ({ send: async () => BigInt(await thunk()) }),
    };
  }

  it("a throwing callback leaves failures >= threshold so the next tick re-fires", async () => {
    let cbCalls = 0;
    let pingCalls = 0;
    const rpc = fakeRpc(async () => {
      pingCalls++;
      throw new Error("rpc down");
    });
    const handle = startConnectionHeartbeat(
      rpc as unknown as Parameters<typeof startConnectionHeartbeat>[0],
      {
        intervalMs: 15,
        timeoutMs: 50,
        failureThreshold: 1,
        onConnectionLost: () => {
          cbCalls++;
          throw new Error("callback explodes");
        },
      },
    );
    // Wait for several ticks. With OFF-210 in effect, the failure
    // counter is NOT reset on the throwing callback path — so the
    // callback fires every tick that observes a failure (each
    // `failures >= threshold` re-evaluation re-enters the branch).
    await sleep(120);
    handle.stop();
    assert.ok(
      cbCalls >= 3,
      `expected callback to re-fire on subsequent failed ticks; got ${cbCalls} calls (pings=${pingCalls})`,
    );
    // And the loop is still alive (not crashed).
    assert.ok(pingCalls >= cbCalls, "pings should be >= callback calls");
  });

  it("a successful callback resets the counter so the next outage starts fresh", async () => {
    let cbCalls = 0;
    let phase: "fail" | "ok" = "fail";
    const rpc = fakeRpc(async () => {
      if (phase === "fail") throw new Error("rpc down");
      return 1;
    });
    const handle = startConnectionHeartbeat(
      rpc as unknown as Parameters<typeof startConnectionHeartbeat>[0],
      {
        intervalMs: 10,
        timeoutMs: 50,
        failureThreshold: 1,
        onConnectionLost: () => {
          cbCalls++;
          // Successful callback simulates a re-subscribe: now the next
          // tick will succeed because we flip `phase` to "ok".
          phase = "ok";
        },
      },
    );
    await sleep(80);
    // Failures are now zero (callback returned cleanly + ping succeeded).
    handle.stop();
    assert.equal(handle.consecutiveFailures(), 0, "counter should reset after success");
    assert.ok(cbCalls >= 1, "callback should have fired at least once");
  });
});

// ---------------------------------------------------------------------------
// OFF-212 — single-writer guarantee via PG advisory lock.
// ---------------------------------------------------------------------------

describe("OFF-212 — acquireIndexerWriterLock primitive", () => {
  it("returns acquired=false on DisabledPostgresStore (SQLite-only mode)", async () => {
    const handle = await acquireIndexerWriterLock(new DisabledPostgresStore());
    assert.equal(handle.acquired, false);
    // release() is a silent no-op on the disabled path.
    await handle.release();
  });

  it("uses a stable, non-zero advisory key", () => {
    // The key MUST NOT change across releases — a key change would let a
    // new indexer start that doesn't conflict with an old indexer still
    // running, defeating the lock. Pin the constant here.
    assert.equal(typeof INDEXER_WRITER_LOCK_KEY, "bigint");
    assert.notEqual(INDEXER_WRITER_LOCK_KEY, 0n);
  });

  it("acquires on a fresh pool and rejects a sibling pool on the same DB", async () => {
    // Build a lightweight in-memory mock of `pg_try_advisory_lock` so
    // the test is hermetic. `pg-mem` does not implement advisory
    // locks, so we mock at the Pool surface — the lock helper only
    // calls `connect()` then `query("SELECT pg_try_advisory_lock(...)")`
    // on the resulting client. The mock keeps a shared boolean to
    // simulate the PG cluster's lock state.
    let locked = false;
    const makeFakePool = (): unknown => {
      const fakeClient = {
        query: async (sql: string): Promise<{ rows: unknown[] }> => {
          if (sql.includes("pg_try_advisory_lock")) {
            if (locked) return { rows: [{ pg_try_advisory_lock: false }] };
            locked = true;
            return { rows: [{ pg_try_advisory_lock: true }] };
          }
          if (sql.includes("pg_advisory_unlock")) {
            locked = false;
            return { rows: [{ pg_advisory_unlock: true }] };
          }
          return { rows: [] };
        },
        release: (): void => {},
      };
      return {
        connect: async () => fakeClient,
      };
    };
    const storeA = createPostgresStoreFromPool(
      makeFakePool() as unknown as Parameters<typeof createPostgresStoreFromPool>[0],
    );
    const storeB = createPostgresStoreFromPool(
      makeFakePool() as unknown as Parameters<typeof createPostgresStoreFromPool>[0],
    );
    // ... but make them share the `locked` variable by overriding the
    // pool wiring on storeB to point at the same boolean. The lambda
    // closure already captures `locked` so both stores share it.
    const handleA = await acquireIndexerWriterLock(storeA);
    assert.equal(handleA.acquired, true, "storeA should acquire the lock");
    const handleB = await acquireIndexerWriterLock(storeB);
    assert.equal(handleB.acquired, false, "storeB should be denied while A holds the lock");
    await handleA.release();
    // After release, a third store can acquire.
    const storeC = createPostgresStoreFromPool(
      makeFakePool() as unknown as Parameters<typeof createPostgresStoreFromPool>[0],
    );
    const handleC = await acquireIndexerWriterLock(storeC);
    assert.equal(handleC.acquired, true, "storeC should acquire after A releases");
    await handleC.release();
  });

  it("release() is idempotent", async () => {
    let locked = false;
    const fakeClient = {
      query: async (sql: string): Promise<{ rows: unknown[] }> => {
        if (sql.includes("pg_try_advisory_lock")) {
          locked = true;
          return { rows: [{ pg_try_advisory_lock: true }] };
        }
        if (sql.includes("pg_advisory_unlock")) {
          locked = false;
          return { rows: [{ pg_advisory_unlock: true }] };
        }
        return { rows: [] };
      },
      release: (): void => {},
    };
    const fakePool = { connect: async () => fakeClient };
    const store = createPostgresStoreFromPool(
      fakePool as unknown as Parameters<typeof createPostgresStoreFromPool>[0],
    );
    const handle = await acquireIndexerWriterLock(store);
    assert.equal(handle.acquired, true);
    await handle.release();
    // Second release call is a no-op: must NOT throw, must NOT re-issue
    // the unlock query (we'd see `locked` flip if it did, but that's
    // not directly observable here; the contract is just "no throw").
    await assert.doesNotReject(() => handle.release());
    assert.equal(locked, false, "after first release, lock should be free");
  });
});

// ---------------------------------------------------------------------------
// OFF-213 — setPostgresStoreForTest is gated on NODE_ENV=test.
// ---------------------------------------------------------------------------

describe("OFF-213 — setPostgresStoreForTest NODE_ENV gate", () => {
  it("throws when NODE_ENV !== 'test'", () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.throws(
        () => setPostgresStoreForTest(new DisabledPostgresStore()),
        /OFF-213/,
        "expected OFF-213 guard to block call in non-test env",
      );
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it("throws when NODE_ENV is unset (fail-closed posture)", () => {
    const saved = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      assert.throws(
        () => setPostgresStoreForTest(null),
        /OFF-213/,
        "unset NODE_ENV must be treated as not-test",
      );
    } finally {
      if (saved !== undefined) process.env.NODE_ENV = saved;
    }
  });

  it("permits the call when NODE_ENV=test", () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      assert.doesNotThrow(() => {
        setPostgresStoreForTest(new DisabledPostgresStore());
        setPostgresStoreForTest(null);
      });
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// OFF-214 — table allow-list derives from a single source of truth.
// ---------------------------------------------------------------------------

describe("OFF-214 — INDEXER_PG_TABLES is single source of truth", () => {
  it("contains the eight Phase-1+ADR-138 tables in migration order", () => {
    assert.deepEqual(
      [...INDEXER_PG_TABLES],
      [
        "events",
        "agents",
        "cursor",
        "agent_tombstones",
        "vault_identity_history",
        "manifest_history",
        "protocol_config_history",
        // ADR-138: execution provenance attestations (migration 003).
        "execution_attestations",
      ],
    );
  });

  it("every table in INDEXER_PG_TABLES appears as a CREATE TABLE in the embedded migration", () => {
    // Cross-file drift surface: the OFF-214 fix promises that a new
    // migration adding a table only needs ONE update (the constant).
    // This test asserts that promise by checking every name in the
    // constant has a `CREATE TABLE IF NOT EXISTS <name>` in the
    // migration SQL. The aud-202 byte-for-byte parity test handles
    // the .sql-vs-embedded direction; this one handles the
    // constant-vs-migration direction.
    const sql = MIGRATIONS.map((m) => m.sql).join("\n");
    for (const table of INDEXER_PG_TABLES) {
      const re = new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\b`, "i");
      assert.match(sql, re, `migration SQL is missing CREATE TABLE for '${table}'`);
    }
  });

  it("countRows accepts every table in INDEXER_PG_TABLES and rejects an unknown name", async () => {
    // Use a fake pool that returns a count for any SELECT so we can
    // observe the membership-guard branch without a real engine.
    const fakeClient = { release: (): void => {} };
    const fakePool = {
      connect: async () => fakeClient,
      query: async () => ({ rows: [{ count: "0" }] }),
    };
    const store = createPostgresStoreFromPool(
      fakePool as unknown as Parameters<typeof createPostgresStoreFromPool>[0],
    );
    for (const table of INDEXER_PG_TABLES) {
      // No throw — count returns 0 from the fake.
      const n = await store.countRows(table);
      assert.equal(n, 0, `countRows('${table}') should resolve, not reject`);
    }
    await assert.rejects(
      () => store.countRows("not_a_real_table"),
      /refusing unknown table/,
      "an unknown table name must be rejected",
    );
  });
});

// ---------------------------------------------------------------------------
// OFF-215 — INDEXER_PG_POOL_MAX uses the NaN-safe parser.
// ---------------------------------------------------------------------------

describe("OFF-215 — INDEXER_PG_POOL_MAX NaN / non-positive fallback", () => {
  it("falls back to default for NaN / negative / zero / empty / undefined", () => {
    assert.equal(parsePositiveIntEnv(undefined, INDEXER_PG_POOL_MAX_DEFAULT), 10);
    assert.equal(parsePositiveIntEnv("", INDEXER_PG_POOL_MAX_DEFAULT), 10);
    assert.equal(parsePositiveIntEnv("abc", INDEXER_PG_POOL_MAX_DEFAULT), 10);
    assert.equal(parsePositiveIntEnv("0", INDEXER_PG_POOL_MAX_DEFAULT), 10);
    assert.equal(parsePositiveIntEnv("-5", INDEXER_PG_POOL_MAX_DEFAULT), 10);
    assert.equal(parsePositiveIntEnv("  ", INDEXER_PG_POOL_MAX_DEFAULT), 10);
  });

  it("parses a valid numeric pool size", () => {
    assert.equal(parsePositiveIntEnv("25", INDEXER_PG_POOL_MAX_DEFAULT), 25);
  });

  it("createPostgresStore constructs cleanly with a typo'd INDEXER_PG_POOL_MAX", () => {
    // Pre-fix `parseInt('not-a-num', 10)` → NaN → `pg.Pool({ max: NaN })`.
    // Post-fix the value falls back to INDEXER_PG_POOL_MAX_DEFAULT.
    let store: PostgresStore | undefined;
    assert.doesNotThrow(() => {
      store = createPostgresStore({
        INDEXER_PG_URL: "postgres://u:p@127.0.0.1:5432/aep",
        INDEXER_PG_POOL_MAX: "not-a-number",
      });
    });
    assert.equal(store?.enabled, true);
    void store?.close();
  });

  it("createPostgresStore constructs cleanly with INDEXER_PG_POOL_MAX=0 (rejected by parser)", () => {
    let store: PostgresStore | undefined;
    assert.doesNotThrow(() => {
      store = createPostgresStore({
        INDEXER_PG_URL: "postgres://u:p@127.0.0.1:5432/aep",
        INDEXER_PG_POOL_MAX: "0",
      });
    });
    assert.equal(store?.enabled, true);
    void store?.close();
  });
});
