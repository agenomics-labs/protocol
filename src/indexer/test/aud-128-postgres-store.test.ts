/**
 * ADR-128 Phase 1 — postgres-store + dual-write tests.
 *
 * Validates the Phase 1 contract:
 *
 *   1. Schema parity — every table + column from the SQLite source
 *      (`src/indexer/index.ts::initDb`) exists in the Postgres
 *      migration with a column type that round-trips the same data.
 *   2. Idempotency primitive — `INSERT ... ON CONFLICT (program,
 *      signature, event_ordinal) DO NOTHING` is a no-op on the second
 *      insert of the same key (mirror of SQLite `INSERT OR IGNORE`).
 *   3. Cursor upsert — write a row, read it back, value matches; a
 *      second upsert with a higher slot wins.
 *   4. Disabled path — `DisabledPostgresStore` accepts every write
 *      silently with no side effects, no `pg` client, no allocations.
 *   5. Malformed-URL fail-closed — `createPostgresStore` throws at
 *      module-load when `INDEXER_PG_URL` is set but malformed.
 *   6. Dual-write parity — drive a real event through
 *      `persistEventsForTx` with `setPostgresStoreForTest` injecting a
 *      pg-mem-backed live store, then assert both SQLite and Postgres
 *      have the row.
 *
 * Uses `pg-mem` for an in-memory Postgres so the test is hermetic and
 * runs everywhere CI runs Node — no testcontainers, no docker
 * dependency (per ADR-128 Phase 1 cycle-3 budget constraint).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { newDb, type IMemoryDb } from "pg-mem";
import type { Pool } from "pg";
import Database from "better-sqlite3";

import {
  createPostgresStore,
  createPostgresStoreFromPool,
  DisabledPostgresStore,
  type PostgresStore,
} from "../postgres-store";

import {
  initDb,
  persistEventsForTx,
  createInitialMetrics,
  setPostgresStoreForTest,
  readCursor,
} from "../index";

// ---------------------------------------------------------------------------
// pg-mem fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh in-memory Postgres + adapter Pool. pg-mem ships its own
 * `pg.Pool`-shaped adapter; we hand it to `createPostgresStoreFromPool`
 * which is the test-only constructor (production goes through
 * `createPostgresStore` + `INDEXER_PG_URL`).
 *
 * pg-mem requires a tiny shim for `now()` because it does not implement
 * timezone-aware `now()` natively in all builds — but the migration
 * file uses bare `now()` which pg-mem 3.x supports out of the box.
 *
 * The migration file path is resolved relative to the postgres-store.ts
 * source location, which is `src/indexer`, so we set `__dirname`-style
 * resolution by reading the SQL directly here and applying it.
 */
async function makePgMemStore(): Promise<{ store: PostgresStore; mem: IMemoryDb; pool: Pool }> {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  // pg-mem's `createPg` returns a constructable `{Pool, Client}`. We use
  // `Pool` so the production `LivePostgresStore` exercises the same
  // `pool.query(...)` codepath it would in production.
  const pgAdapter = mem.adapters.createPg();
  const pool = new pgAdapter.Pool() as Pool;

  // Apply migration directly. We bypass `LivePostgresStore.applyMigration`
  // because it uses `__dirname`/`require("fs")` — straightforward, but
  // doing the read inline here keeps the test diagnostic if the SQL ever
  // fails to parse against pg-mem (the failure surfaces at the SQL site,
  // not buried inside the store).
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
// Test 1: Schema parity — every SQLite table from `initDb` exists in
// Postgres with the SAME column-name set. The SQLite side is the
// authoritative source per ADR-128 Phase 1 §"Surface impact"; the PG
// migration is a shadow that must round-trip the same shape.
//
// OFF-207 (cycle-3 off-chain audit): the previous version of this block
// hard-coded the expected column list inline in the test, so a developer
// who edited the migration SQL would (mechanically) edit the test in
// lockstep and the gate passed silently. The fix: derive BOTH sides
// independently — SQLite via `PRAGMA table_info(<table>)` against a
// freshly `initDb`'d database, Postgres via `information_schema.columns`
// after `applyMigration`. The test compares the two sets directly. A
// SQL-only edit on either side is now caught at test time.
// ---------------------------------------------------------------------------

/**
 * SQLite column set per `initDb`. Reads `PRAGMA table_info(<table>)`
 * which returns one row per column with `name`, `type`, `notnull`,
 * `dflt_value`, `pk`. We only need the column-name set for the parity
 * check — type mappings (INTEGER -> BIGINT, TEXT -> TEXT/TIMESTAMPTZ)
 * are documented in `001-initial-postgres.sql` and would require a
 * type-map oracle the test cannot derive.
 */
function sqliteColumns(db: Database.Database, table: string): string[] {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

/**
 * Postgres column set per `information_schema.columns`. Returns sorted
 * to match `sqliteColumns` so `assert.deepEqual` is order-stable.
 */
async function postgresColumns(pool: Pool, table: string): Promise<string[]> {
  const res = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY column_name`,
    [table],
  );
  return res.rows.map((r) => r.column_name).sort();
}

describe("ADR-128 Phase 1 — schema parity (SQLite ↔ Postgres)", () => {
  let store: PostgresStore;
  let pool: Pool;
  let sqliteDb: Database.Database;

  before(async () => {
    const fixture = await makePgMemStore();
    store = fixture.store;
    pool = fixture.pool;
    // Authoritative SQLite source: spin up the real `initDb` so the test
    // reads whatever DDL `src/indexer/index.ts` actually executes today.
    // No hand-maintained mirror.
    sqliteDb = initDb(":memory:");
  });

  after(async () => {
    await store.close();
    sqliteDb.close();
  });

  // The seven tables specified in ADR-128 §"Surface impact" — must all
  // exist in BOTH stores after their respective migrations. This list
  // is the cross-store contract; if either side adds a table without
  // adding it to the other, the loop below fails on the missing side.
  const expectedTables = [
    "events",
    "agents",
    "cursor",
    "agent_tombstones",
    "vault_identity_history",
    "manifest_history",
    "protocol_config_history",
  ];

  for (const table of expectedTables) {
    it(`'${table}' exists in BOTH SQLite and Postgres`, async () => {
      const sqliteRow = sqliteDb
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        )
        .get(table) as { name: string } | undefined;
      assert.ok(sqliteRow, `expected SQLite table '${table}' to exist`);

      const pgRes = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      assert.equal(
        pgRes.rowCount,
        1,
        `expected Postgres table '${table}' to exist`,
      );
    });

    it(`'${table}' has matching column-name set across both stores`, async () => {
      // OFF-207: the load-bearing parity check. Neither side is a
      // hardcoded expected-list — both are introspected from the
      // authoritative source. A column rename / add / drop on either
      // side without a matching change on the other surfaces here.
      const sqlite = sqliteColumns(sqliteDb, table);
      const pg = await postgresColumns(pool, table);
      assert.deepEqual(
        pg,
        sqlite,
        `column-name parity drift on '${table}': sqlite=${JSON.stringify(sqlite)} pg=${JSON.stringify(pg)}`,
      );
    });
  }

  it("idempotency UNIQUE index on (program, signature, event_ordinal) is enforced", async () => {
    // Confirms the load-bearing primitive ADR-128 §"Decision" (5)
    // depends on. Tested behaviourally: without the UNIQUE index,
    // `ON CONFLICT (program, signature, event_ordinal) DO NOTHING`
    // raises PG error 42P10 ("there is no unique or exclusion
    // constraint matching the ON CONFLICT specification"). If this
    // INSERT runs cleanly twice and yields exactly one row, the index
    // is present AND wired correctly. (Catalog inspection via
    // pg_indexes / pg_constraint is the more direct check but pg-mem
    // does not expose those system catalogs; the behavioural test is
    // strictly stronger because it exercises the conflict resolution
    // path the dual-write code actually depends on.)
    await pool.query(
      `INSERT INTO events (program, event_name, data, signature, slot, event_ordinal)
       VALUES ('vault', 'X', '{}', 'unique-probe', 1, 0)
       ON CONFLICT (program, signature, event_ordinal) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO events (program, event_name, data, signature, slot, event_ordinal)
       VALUES ('vault', 'X', '{}', 'unique-probe', 1, 0)
       ON CONFLICT (program, signature, event_ordinal) DO NOTHING`,
    );
    const res = await pool.query(
      `SELECT COUNT(*)::bigint AS c FROM events WHERE signature = 'unique-probe'`,
    );
    assert.equal(Number(res.rows[0].c), 1, "ON CONFLICT path did not dedupe");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Idempotency primitive — second insert of the same
// (program, signature, event_ordinal) is a no-op.
// ---------------------------------------------------------------------------

describe("ADR-128 Phase 1 — idempotency primitive", () => {
  let store: PostgresStore;

  before(async () => {
    const fixture = await makePgMemStore();
    store = fixture.store;
  });

  after(async () => {
    await store.close();
  });

  it("inserts a fresh event row exactly once on first call", async () => {
    await store.insertEvent({
      program: "vault",
      eventName: "VaultInitialized",
      data: '{"hello":"world"}',
      signature: "sig_abc",
      slot: 100,
      eventOrdinal: 0,
    });
    assert.equal(await store.countRows("events"), 1);
  });

  it("the same (program, signature, event_ordinal) tuple inserted twice is a no-op", async () => {
    // Mirror `INSERT OR IGNORE` semantics: second call must NOT raise
    // and MUST NOT add a row. This is the ADR-127 / ADR-128 load-
    // bearing claim about resume correctness.
    await store.insertEvent({
      program: "vault",
      eventName: "VaultInitialized",
      // Even with different `data`, the unique key wins — the row is
      // skipped, not overwritten.
      data: '{"different":"payload"}',
      signature: "sig_abc",
      slot: 100,
      eventOrdinal: 0,
    });
    const count = await store.countRows("events");
    assert.equal(count, 1, "duplicate insert added a row (idempotency broken)");
  });

  it("a different event_ordinal under the same signature inserts a new row", async () => {
    // Same tx (signature) can carry multiple events; ordinal
    // disambiguates them. This is exactly what `persistEventsForTx`
    // emits — ordinal++ per event in a tx.
    await store.insertEvent({
      program: "vault",
      eventName: "PolicyUpdated",
      data: '{"second":"event"}',
      signature: "sig_abc",
      slot: 100,
      eventOrdinal: 1,
    });
    const count = await store.countRows("events");
    assert.equal(count, 2);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Cursor upsert — write, read back, second upsert wins.
// ---------------------------------------------------------------------------

describe("ADR-128 Phase 1 — cursor upsert", () => {
  let store: PostgresStore;
  let pool: Pool;

  before(async () => {
    const fixture = await makePgMemStore();
    store = fixture.store;
    pool = fixture.pool;
  });

  after(async () => {
    await store.close();
  });

  it("inserts a fresh cursor row", async () => {
    await store.upsertCursor({ program: "registry", slot: 50, signature: "sig_seed" });
    const res = await pool.query(`SELECT last_processed_slot, last_signature FROM cursor WHERE program = $1`, ["registry"]);
    assert.equal(res.rowCount, 1);
    assert.equal(Number(res.rows[0].last_processed_slot), 50);
    assert.equal(res.rows[0].last_signature, "sig_seed");
  });

  it("upserts overwrite the cursor row in place (PK = program)", async () => {
    await store.upsertCursor({ program: "registry", slot: 200, signature: "sig_advance" });
    const res = await pool.query(`SELECT last_processed_slot, last_signature FROM cursor WHERE program = $1`, ["registry"]);
    assert.equal(res.rowCount, 1, "cursor must remain a single row per program");
    assert.equal(Number(res.rows[0].last_processed_slot), 200);
    assert.equal(res.rows[0].last_signature, "sig_advance");
  });
});

// ---------------------------------------------------------------------------
// Test 4: Disabled (no-op) store accepts every write silently.
// ---------------------------------------------------------------------------

describe("ADR-128 Phase 1 — DisabledPostgresStore is a silent no-op", () => {
  const store = new DisabledPostgresStore();

  it("reports enabled = false", () => {
    assert.equal(store.enabled, false);
  });

  it("accepts insertEvent without throwing", async () => {
    await store.insertEvent({
      program: "vault",
      eventName: "X",
      data: "{}",
      signature: "s",
      slot: 1,
      eventOrdinal: 0,
    });
  });

  it("accepts upsertCursor without throwing", async () => {
    await store.upsertCursor({ program: "vault", slot: 1, signature: "s" });
  });

  it("accepts every other write method without throwing", async () => {
    await store.upsertAgentTombstone({ authority: "a", deregisteredAtSlot: 1 });
    await store.insertVaultIdentityHistory({
      vault: "v",
      oldIdentity: "o",
      newIdentity: "n",
      slot: 1,
      signature: "s",
    });
    await store.insertManifestHistory({
      authority: "a",
      manifestCid: "c",
      manifestHash: "h",
      manifestVersion: 1,
      eventTimestamp: 0,
      slot: 1,
      signature: "s",
    });
    await store.insertProtocolConfigHistory({
      kind: "Updated",
      authority: "a",
      minEscrowAmount: "0",
      disputeTimeoutSeconds: 0,
      reputationDeltaTaskCompleted: 0,
      reputationDeltaDisputeLoss: 0,
      reputationDeltaExpiryUndelivered: 0,
      slot: 1,
      signature: "s",
    });
    await store.upsertAgent("a", "n", "c");
    await store.updateAgentName("a", "n");
    await store.updateAgentReputation("a", 50, 1);
    await store.setAgentReputation("a", 60);
    await store.deleteAgent("a");
    await store.close();
  });

  it("countRows returns 0 (no underlying store)", async () => {
    assert.equal(await store.countRows("events"), 0);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Fail-closed validation — malformed INDEXER_PG_URL throws.
// ---------------------------------------------------------------------------

describe("ADR-128 Phase 1 — INDEXER_PG_URL fail-closed validation", () => {
  it("returns DisabledPostgresStore when INDEXER_PG_URL is unset", () => {
    const store = createPostgresStore({});
    assert.ok(store instanceof DisabledPostgresStore, "unset URL must yield disabled store");
  });

  it("returns DisabledPostgresStore when INDEXER_PG_URL is empty string", () => {
    const store = createPostgresStore({ INDEXER_PG_URL: "" });
    assert.ok(store instanceof DisabledPostgresStore);
  });

  it("returns DisabledPostgresStore when INDEXER_PG_URL is whitespace only", () => {
    const store = createPostgresStore({ INDEXER_PG_URL: "   " });
    assert.ok(store instanceof DisabledPostgresStore);
  });

  it("throws when INDEXER_PG_URL is not a URL at all", () => {
    assert.throws(
      () => createPostgresStore({ INDEXER_PG_URL: "this-is-not-a-url" }),
      /INDEXER_PG_URL is set but malformed/,
    );
  });

  it("throws when INDEXER_PG_URL has a non-postgres scheme", () => {
    assert.throws(
      () => createPostgresStore({ INDEXER_PG_URL: "http://example.com/db" }),
      /protocol must be postgres:\/\/ or postgresql:\/\//,
    );
  });

  it("accepts postgres:// scheme", () => {
    // We can't easily assert the live constructor without standing up a
    // real PG, but the URL should at least pass validation and produce
    // a non-disabled store. The pool itself defers connection until
    // first query, so construction is cheap and side-effect-free.
    const store = createPostgresStore({
      INDEXER_PG_URL: "postgres://user:pass@127.0.0.1:5432/aep_events",
    });
    assert.equal(store instanceof DisabledPostgresStore, false);
    // Tear it down so the lazy pool doesn't hold sockets/timers.
    void store.close();
  });

  it("accepts postgresql:// scheme", () => {
    const store = createPostgresStore({
      INDEXER_PG_URL: "postgresql://user:pass@127.0.0.1:5432/aep_events",
    });
    assert.equal(store instanceof DisabledPostgresStore, false);
    void store.close();
  });
});

// ---------------------------------------------------------------------------
// Test 6: Integration — dual-write through persistEventsForTx puts the
// row in BOTH SQLite and Postgres.
// ---------------------------------------------------------------------------

describe("ADR-128 Phase 1 — dual-write integration via persistEventsForTx", () => {
  let pgStore: PostgresStore;
  let pgPool: Pool;
  let sqliteDb: Database.Database;

  beforeEach(async () => {
    const fixture = await makePgMemStore();
    pgStore = fixture.store;
    pgPool = fixture.pool;
    setPostgresStoreForTest(pgStore);

    sqliteDb = initDb(":memory:");
  });

  after(() => {
    setPostgresStoreForTest(null);
  });

  it("persistEventsForTx writes the same row to both SQLite and Postgres", async () => {
    const metrics = createInitialMetrics();
    const events = [
      { name: "VaultInitialized", data: { vault: "abc", slot: 99 } },
    ];

    const result = persistEventsForTx(
      sqliteDb,
      "vault",
      "sig_dual_001",
      99,
      events,
      metrics,
    );

    // SQLite half — synchronous, authoritative.
    assert.equal(result.inserted, 1, "SQLite write site must report 1 inserted");
    const sqliteCount = sqliteDb
      .prepare("SELECT COUNT(*) as c FROM events WHERE signature = ?")
      .get("sig_dual_001") as { c: number };
    assert.equal(sqliteCount.c, 1, "SQLite must hold the event");

    // Postgres half — fire-and-forget; give the event loop a tick to
    // drain the void-ed promises before asserting.
    await flushMicrotasks();
    const pgCount = await pgStore.countRows("events");
    assert.equal(pgCount, 1, "Postgres shadow must hold the same event");

    // Cursor parity — the same call upserts both cursors.
    const sqliteCursor = readCursor(sqliteDb, "vault");
    assert.equal(sqliteCursor?.slot, 99);
    assert.equal(sqliteCursor?.signature, "sig_dual_001");
    const pgCursor = await pgPool.query(
      `SELECT last_processed_slot, last_signature FROM cursor WHERE program = $1`,
      ["vault"],
    );
    assert.equal(pgCursor.rowCount, 1, "PG cursor must be in lockstep");
    assert.equal(Number(pgCursor.rows[0].last_processed_slot), 99);
    assert.equal(pgCursor.rows[0].last_signature, "sig_dual_001");
  });

  it("a duplicate signature/ordinal is skipped in BOTH stores (idempotency parity)", async () => {
    const metrics = createInitialMetrics();
    const events = [
      { name: "VaultInitialized", data: { vault: "abc" } },
    ];

    persistEventsForTx(sqliteDb, "vault", "sig_dup", 50, events, metrics);
    persistEventsForTx(sqliteDb, "vault", "sig_dup", 50, events, metrics);
    await flushMicrotasks();

    const sqliteCount = sqliteDb
      .prepare("SELECT COUNT(*) as c FROM events WHERE signature = ?")
      .get("sig_dup") as { c: number };
    assert.equal(sqliteCount.c, 1, "SQLite must dedupe");

    const pgCount = await pgStore.countRows("events");
    assert.equal(pgCount, 1, "Postgres must dedupe in lockstep");
  });

  it("with the disabled store, only SQLite writes — Postgres is never touched", async () => {
    setPostgresStoreForTest(new DisabledPostgresStore());
    const metrics = createInitialMetrics();
    const events = [{ name: "VaultPaused", data: {} }];

    const result = persistEventsForTx(sqliteDb, "vault", "sig_solo", 1, events, metrics);
    await flushMicrotasks();

    assert.equal(result.inserted, 1);
    const sqliteCount = sqliteDb
      .prepare("SELECT COUNT(*) as c FROM events")
      .get() as { c: number };
    assert.equal(sqliteCount.c, 1);
    // pgStore here is the OLD pgStore (from beforeEach) — verify it
    // received nothing because the test override switched to disabled.
    const pgCount = await pgStore.countRows("events");
    assert.equal(pgCount, 0, "PG must be untouched when store is disabled");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Yield to the event loop so void-ed promises from dual-write fire-and-
 * forget calls have a chance to settle. Two ticks is enough — the first
 * resolves the `pool.query` microtask, the second resolves
 * `runShadow`'s outer await.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}
