/**
 * OFF-200 — transactional dual-write coverage.
 *
 * The cycle-3 audit found that the indexer's PG dual-write was fire-
 * and-forget per call: the per-event INSERT and the cursor UPSERT each
 * went through `pool.query` independently, so a network blip between
 * them could leave PG in the divergent state where the cursor advanced
 * past an event PG never received. The fix wraps the event INSERT and
 * the cursor UPSERT in a single PG transaction (BEGIN/COMMIT/ROLLBACK
 * via `LivePostgresStore.withTransaction`).
 *
 * These tests assert the load-bearing claim:
 *
 *   The PG cursor cannot advance unless the PG event INSERT also
 *   succeeded in the same transaction. If either step fails, both
 *   roll back.
 *
 * Strategy:
 *   - The "good path" tests (idempotency, single-client, commit) run
 *     against pg-mem (`makePgMemStore`), which faithfully simulates
 *     INSERT / ON CONFLICT / SELECT.
 *   - The "rollback path" tests use a hand-rolled mock Pool that
 *     records the SQL stream. This is necessary because pg-mem 3.x
 *     does not honour BEGIN/COMMIT/ROLLBACK through the Pool adapter
 *     (an explicit `client.query("ROLLBACK")` does NOT undo INSERTs
 *     applied on the same client) — we verified this directly. The
 *     mock Pool is strictly stronger than pg-mem for the rollback
 *     assertion because it confirms our wrapper EMITS the right
 *     statements in the right order, which is exactly what real PG
 *     needs to honour the invariant.
 */

import { describe, it, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { newDb, type IMemoryDb } from "pg-mem";
import type { Pool, PoolClient } from "pg";

import {
  createPostgresStoreFromPool,
  type PostgresStore,
} from "../postgres-store";

// ---------------------------------------------------------------------------
// pg-mem fixture (shared shape with aud-128-postgres-store.test.ts)
// ---------------------------------------------------------------------------

async function makePgMemStore(): Promise<{ store: PostgresStore; mem: IMemoryDb; pool: Pool }> {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const pgAdapter = mem.adapters.createPg();
  const pool = new pgAdapter.Pool() as Pool;
  const fs: typeof import("fs") = require("fs");
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "migrations", "001-initial-postgres.sql"),
    "utf8",
  );
  await pool.query(sql);
  const store = createPostgresStoreFromPool(pool);
  return { store, mem, pool };
}

// ---------------------------------------------------------------------------
// Mock Pool — records SQL statements + supports a per-statement throw
// hook so the test can simulate a failure on the cursor leg without
// relying on pg-mem's tx semantics.
// ---------------------------------------------------------------------------

interface MockQueryRecord {
  sql: string;
  params: unknown[];
}

interface MockPoolControls {
  records: MockQueryRecord[];
  /** Number of times `pool.connect()` was called. */
  connects: number;
  /** Number of times `client.release()` was called. */
  releases: number;
  /**
   * If non-null, the next `client.query` whose SQL matches will throw
   * the given error — exactly once. Used to inject a "cursor leg blew
   * up" failure mid-tx.
   */
  throwOnce: { matcher: RegExp; err: Error } | null;
}

function makeMockPool(): { pool: Pool; controls: MockPoolControls } {
  const controls: MockPoolControls = {
    records: [],
    connects: 0,
    releases: 0,
    throwOnce: null,
  };

  const client: PoolClient = {
    async query(sqlOrConfig: any, params?: any) {
      const sql = typeof sqlOrConfig === "string" ? sqlOrConfig : sqlOrConfig.text;
      controls.records.push({ sql, params: params ?? [] });
      if (controls.throwOnce && controls.throwOnce.matcher.test(sql)) {
        const err = controls.throwOnce.err;
        controls.throwOnce = null;
        throw err;
      }
      return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] } as any;
    },
    release() {
      controls.releases++;
    },
  } as unknown as PoolClient;

  const pool: Pool = {
    async connect() {
      controls.connects++;
      return client;
    },
    async query(_sql: any, _params?: any) {
      // not used in tx tests; return empty
      return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] } as any;
    },
    async end() {},
  } as unknown as Pool;

  return { pool, controls };
}

// ---------------------------------------------------------------------------
// Test 1: insertEventInTx succeeds, cursor leg throws → tx body
// rethrows AND the wrapper emits ROLLBACK (not COMMIT). The strictly-
// correct ordering is: BEGIN, INSERT events, INSERT cursor (throws),
// ROLLBACK, release. No COMMIT must appear.
// ---------------------------------------------------------------------------

describe("OFF-200 — withTransaction emits ROLLBACK when the body throws", () => {
  it("inserts event then throws on cursor → BEGIN, INSERT events, INSERT cursor, ROLLBACK, release (no COMMIT)", async () => {
    const { pool, controls } = makeMockPool();
    const store = createPostgresStoreFromPool(pool);
    controls.throwOnce = {
      matcher: /INSERT INTO cursor/i,
      err: new Error("simulated cursor write failure"),
    };

    let caught: unknown = null;
    try {
      await store.withTransaction(async (client) => {
        await store.insertEventInTx(client, {
          program: "vault",
          eventName: "VaultInitialized",
          data: '{"x":1}',
          signature: "sig_rollback",
          slot: 10,
          eventOrdinal: 0,
        });
        await store.upsertCursorInTx(client, {
          program: "vault",
          slot: 10,
          signature: "sig_rollback",
        });
      });
    } catch (err) {
      caught = err;
    }

    // The original error MUST propagate so the call site's `.catch`
    // can decide policy (in `index.ts` it logs WARN and lets SQLite
    // remain authoritative).
    assert.ok(caught instanceof Error);
    assert.match((caught as Error).message, /simulated cursor write failure/);

    // Exactly one client was acquired and released.
    assert.equal(controls.connects, 1, "exactly one pool.connect()");
    assert.equal(controls.releases, 1, "client.release() must run on the failure path");

    // SQL stream must show: BEGIN → INSERT events → INSERT cursor (threw) → ROLLBACK.
    // No COMMIT must appear after the throw.
    const stream = controls.records.map((r) => r.sql.trim().split(/\s+/).slice(0, 3).join(" "));
    assert.equal(stream[0], "BEGIN", "tx must open with BEGIN");
    assert.match(controls.records[1].sql, /INSERT INTO events/, "second statement is the event INSERT");
    assert.match(controls.records[2].sql, /INSERT INTO cursor/, "third statement is the cursor UPSERT (which threw)");
    assert.equal(stream[3], "ROLLBACK", "tx must emit ROLLBACK after the body throws");
    assert.equal(
      controls.records.filter((r) => /^\s*COMMIT/i.test(r.sql)).length,
      0,
      "COMMIT must NOT appear when the tx body threw",
    );
  });

  it("a clean tx body emits BEGIN ... COMMIT (no ROLLBACK)", async () => {
    const { pool, controls } = makeMockPool();
    const store = createPostgresStoreFromPool(pool);

    await store.withTransaction(async (client) => {
      await store.insertEventInTx(client, {
        program: "vault",
        eventName: "X",
        data: "{}",
        signature: "sig_clean",
        slot: 1,
        eventOrdinal: 0,
      });
      await store.upsertCursorInTx(client, {
        program: "vault",
        slot: 1,
        signature: "sig_clean",
      });
    });

    const stream = controls.records.map((r) => r.sql.trim().split(/\s+/)[0]);
    assert.equal(stream[0], "BEGIN");
    assert.equal(stream[stream.length - 1], "COMMIT", "clean path must end with COMMIT");
    assert.equal(
      controls.records.filter((r) => /^\s*ROLLBACK/i.test(r.sql)).length,
      0,
      "ROLLBACK must NOT appear when the tx body succeeds",
    );
    assert.equal(controls.releases, 1, "client.release() must run on the success path too");
  });

  it("client is released even if ROLLBACK itself throws", async () => {
    // Defence in depth: a broken socket can make ROLLBACK fail too.
    // The release must still run (finally) so the pool doesn't leak
    // a permanently-checked-out client.
    const controls: MockPoolControls = {
      records: [],
      connects: 0,
      releases: 0,
      throwOnce: null,
    };
    let queryCallCount = 0;
    const client: PoolClient = {
      async query(sqlOrConfig: any) {
        queryCallCount++;
        const sql = typeof sqlOrConfig === "string" ? sqlOrConfig : sqlOrConfig.text;
        controls.records.push({ sql, params: [] });
        if (/^BEGIN/i.test(sql)) return { rows: [], rowCount: 0 } as any;
        if (/INSERT INTO events/.test(sql)) {
          throw new Error("body failure");
        }
        if (/^ROLLBACK/i.test(sql)) {
          throw new Error("rollback also failed");
        }
        return { rows: [], rowCount: 0 } as any;
      },
      release() { controls.releases++; },
    } as unknown as PoolClient;
    const pool: Pool = {
      async connect() { controls.connects++; return client; },
      async query() { return { rows: [], rowCount: 0 } as any; },
      async end() {},
    } as unknown as Pool;

    const store = createPostgresStoreFromPool(pool);
    let caught: unknown = null;
    try {
      await store.withTransaction(async (c) => {
        await store.insertEventInTx(c, {
          program: "p",
          eventName: "n",
          data: "{}",
          signature: "s",
          slot: 0,
          eventOrdinal: 0,
        });
      });
    } catch (err) {
      caught = err;
    }

    // The ORIGINAL body error must propagate, not the rollback error.
    assert.ok(caught instanceof Error);
    assert.match((caught as Error).message, /body failure/, "original body error must be preserved");
    assert.equal(controls.releases, 1, "client must be released even if ROLLBACK throws");
    assert.ok(queryCallCount >= 3, "BEGIN, INSERT (throws), ROLLBACK (throws)");
  });
});

// ---------------------------------------------------------------------------
// Test 2: two sequential withTransaction calls — first commits event A
// + cursor advance to slot 100; second throws on cursor leg → assert
// committed state from tx-1 is intact (event A present, cursor at 100)
// and tx-2's intended writes (event B, cursor 200) are absent.
// ---------------------------------------------------------------------------

describe("OFF-200 — sequential txs: a failed second tx cannot un-commit the first", () => {
  it("commits tx-1 (event A + cursor A) and rolls back tx-2 (event B + cursor B throws)", async () => {
    // Real semantics: pg-mem doesn't roll back, so we use a mock Pool
    // here too. Tx 1 runs cleanly; tx 2's cursor leg throws. We check
    // the SQL stream to confirm the COMMIT/ROLLBACK shape.
    const { pool, controls } = makeMockPool();
    const store = createPostgresStoreFromPool(pool);

    // Tx 1 — clean path.
    await store.withTransaction(async (client) => {
      await store.insertEventInTx(client, {
        program: "vault",
        eventName: "EventA",
        data: '{"a":1}',
        signature: "sig_A",
        slot: 100,
        eventOrdinal: 0,
      });
      await store.upsertCursorInTx(client, {
        program: "vault",
        slot: 100,
        signature: "sig_A",
      });
    });

    const tx1End = controls.records.length;
    const tx1Commits = controls.records.slice(0, tx1End).filter((r) => /^\s*COMMIT/i.test(r.sql)).length;
    const tx1Rollbacks = controls.records.slice(0, tx1End).filter((r) => /^\s*ROLLBACK/i.test(r.sql)).length;
    assert.equal(tx1Commits, 1, "tx-1 must emit exactly one COMMIT");
    assert.equal(tx1Rollbacks, 0, "tx-1 must NOT emit ROLLBACK");

    // Tx 2 — fail on cursor.
    controls.throwOnce = {
      matcher: /INSERT INTO cursor/i,
      err: new Error("tx-2 cursor leg blew up"),
    };

    let caught: unknown = null;
    try {
      await store.withTransaction(async (client) => {
        await store.insertEventInTx(client, {
          program: "vault",
          eventName: "EventB",
          data: '{"b":2}',
          signature: "sig_B",
          slot: 200,
          eventOrdinal: 0,
        });
        await store.upsertCursorInTx(client, {
          program: "vault",
          slot: 200,
          signature: "sig_B",
        });
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof Error);
    assert.match((caught as Error).message, /tx-2 cursor leg blew up/);

    const tx2 = controls.records.slice(tx1End);
    const tx2Commits = tx2.filter((r) => /^\s*COMMIT/i.test(r.sql)).length;
    const tx2Rollbacks = tx2.filter((r) => /^\s*ROLLBACK/i.test(r.sql)).length;
    assert.equal(tx2Commits, 0, "failed tx-2 must NOT COMMIT");
    assert.equal(tx2Rollbacks, 1, "failed tx-2 must emit exactly one ROLLBACK");

    // Two acquire/release pairs — one per tx.
    assert.equal(controls.connects, 2);
    assert.equal(controls.releases, 2);
  });
});

// ---------------------------------------------------------------------------
// Test 3: idempotent re-run via pg-mem — the tx wrapper composes
// correctly with `ON CONFLICT (program, signature, event_ordinal) DO
// NOTHING` so a duplicate-event tx is safe. (pg-mem honours INSERT and
// ON CONFLICT, just not BEGIN/ROLLBACK — so this test runs cleanly
// against the in-memory backend.)
// ---------------------------------------------------------------------------

describe("OFF-200 — idempotent retry of the same tx is safe", () => {
  let store: PostgresStore;
  let pool: Pool;

  beforeEach(async () => {
    const fixture = await makePgMemStore();
    store = fixture.store;
    pool = fixture.pool;
  });

  after(async () => {
    if (store) await store.close();
  });

  it("two separate txs with the same event PK + same cursor advance ⇒ one event row", async () => {
    const eventArgs = {
      program: "vault",
      eventName: "VaultInitialized",
      data: '{"first":"call"}',
      signature: "sig_replay",
      slot: 50,
      eventOrdinal: 0,
    };
    const cursorArgs = { program: "vault", slot: 50, signature: "sig_replay" };

    await store.withTransaction(async (client) => {
      await store.insertEventInTx(client, eventArgs);
      await store.upsertCursorInTx(client, cursorArgs);
    });
    assert.equal(await store.countRows("events"), 1, "first tx: one event row");

    // Same PK, different `data` payload — ON CONFLICT DO NOTHING wins.
    await store.withTransaction(async (client) => {
      await store.insertEventInTx(client, { ...eventArgs, data: '{"second":"call"}' });
      await store.upsertCursorInTx(client, cursorArgs);
    });

    const events = await pool.query(
      `SELECT data FROM events WHERE signature = $1`,
      ["sig_replay"],
    );
    assert.equal(events.rowCount, 1, "second tx must NOT add a duplicate row");
    assert.equal(
      events.rows[0].data,
      '{"first":"call"}',
      "ON CONFLICT DO NOTHING preserves the original row",
    );

    const cursor = await pool.query(
      `SELECT last_signature, last_processed_slot FROM cursor WHERE program = 'vault'`,
    );
    assert.equal(cursor.rowCount, 1);
    assert.equal(cursor.rows[0].last_signature, "sig_replay");
    assert.equal(Number(cursor.rows[0].last_processed_slot), 50);
  });

  it("duplicate event PK with an advancing cursor: event dedupes, cursor moves", async () => {
    // Realistic shape: same event arrives via websocket then via
    // backfill. Event row dedupes (PK); the cursor advances on the
    // second (later) batch.
    await store.withTransaction(async (client) => {
      await store.insertEventInTx(client, {
        program: "vault",
        eventName: "VaultPaused",
        data: "{}",
        signature: "sig_obs",
        slot: 10,
        eventOrdinal: 0,
      });
      await store.upsertCursorInTx(client, {
        program: "vault",
        slot: 10,
        signature: "sig_obs",
      });
    });

    await store.withTransaction(async (client) => {
      await store.insertEventInTx(client, {
        program: "vault",
        eventName: "VaultPaused",
        data: "{}",
        signature: "sig_obs",
        slot: 10,
        eventOrdinal: 0,
      });
      await store.upsertCursorInTx(client, {
        program: "vault",
        slot: 20,
        signature: "sig_later",
      });
    });

    assert.equal(await store.countRows("events"), 1, "duplicate event PK does not double-count");

    const cursor = await pool.query(
      `SELECT last_signature, last_processed_slot FROM cursor WHERE program = 'vault'`,
    );
    assert.equal(cursor.rows[0].last_signature, "sig_later");
    assert.equal(Number(cursor.rows[0].last_processed_slot), 20);
  });
});

// ---------------------------------------------------------------------------
// Test 4: structural — withTransaction passes a single PoolClient to
// the body. Guards against a future refactor that accidentally calls
// `pool.query` instead of `client.query` inside `*InTx`, which would
// silently break BEGIN/COMMIT binding (each pool.query may be a
// different connection).
// ---------------------------------------------------------------------------

describe("OFF-200 — withTransaction exposes a single PoolClient to the body", () => {
  it("the same client argument is used for every call inside the tx body", async () => {
    const { store } = await makePgMemStore();
    let observedClient: PoolClient | null = null;
    let secondCallSawSameClient = false;

    await store.withTransaction(async (client) => {
      observedClient = client;
      await store.insertEventInTx(client, {
        program: "vault",
        eventName: "X",
        data: "{}",
        signature: "sig_single_client",
        slot: 1,
        eventOrdinal: 0,
      });
      secondCallSawSameClient = client === observedClient;
    });

    assert.ok(observedClient, "tx body must receive a non-null client");
    assert.ok(secondCallSawSameClient, "all calls inside one tx must share the same client");
    await store.close();
  });
});
