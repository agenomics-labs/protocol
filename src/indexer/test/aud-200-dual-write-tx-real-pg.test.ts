/**
 * OFF-217 — real-Postgres transactional verification for the OFF-200
 * dual-write fix.
 *
 * OFF-200 wrapped the indexer's per-event INSERT and the cursor UPSERT
 * in a single `withTransaction` call (`postgres-store.ts`). The
 * companion suite `aud-200-dual-write-tx.test.ts` proves the helper
 * EMITS BEGIN / COMMIT / ROLLBACK in the right order using a hand-
 * rolled mock Pool, because pg-mem 3.x does not honour transactional
 * isolation through its Pool adapter (a `client.query("ROLLBACK")`
 * does NOT undo INSERTs applied on the same client; we verified this
 * directly in the OFF-200 patch). The mock-Pool suite is necessary but
 * not sufficient: it does not prove a real PostgreSQL engine actually
 * rolls the rows back on failure.
 *
 * This suite closes that gap. It runs ONLY when `INDEXER_PG_TEST_URL`
 * is set and points at a writable Postgres instance the operator has
 * dedicated to integration testing (CI service container or local
 * `docker run --rm postgres:16`). When unset, the suite skips cleanly
 * and logs the skip reason — `npm test` stays green in environments
 * without a Postgres available, and the cycle-3 punchlist Cutover-Gate
 * §"INDEXER_PG_URL unblock" is satisfied via an opt-in operator/CI run.
 *
 * Env-var contract:
 *   - `INDEXER_PG_TEST_URL` UNSET → describe-blocks skip; one log line
 *     emitted at file load time so the operator sees why nothing ran.
 *   - `INDEXER_PG_TEST_URL` SET   → live suite runs against the URL.
 *     The URL MUST point at a database the test owns end-to-end:
 *     setup drops + recreates the schema, teardown closes the pool.
 *     **Do not point this at a database with real data.**
 *
 * The intentional difference vs. the pg-mem suite is that here we
 * assert ROW-LEVEL state after a rollback, not just SQL-stream shape:
 *
 *   1. Happy path  — both event row + cursor row persist after COMMIT.
 *   2. Mid-tx fail — event INSERT succeeds in-tx, then a deliberately
 *                    invalid statement aborts the tx; the event row
 *                    MUST NOT persist after rollback (this is the
 *                    invariant pg-mem can't verify).
 *   3. Conn-abort  — body throws before any writes; tx ends cleanly
 *                    with ROLLBACK, no rows leak, client returns to
 *                    the pool, and the next tx on a fresh client
 *                    behaves normally.
 *   4. Idempotency — a repeat tx with the same event PK is a no-op
 *                    against a real ON CONFLICT engine (parity with
 *                    SQLite's INSERT OR IGNORE).
 *
 * CI integration: a workflow job that boots a `postgres:16` service
 * container, sets `INDEXER_PG_TEST_URL` to the service URL, and runs
 * this suite alongside the existing `npm test --workspace
 * @agenomics/indexer` invocation is the operator-driven path. That
 * workflow change is OUT OF SCOPE for this commit (see commit body)
 * and tracked as a follow-up — the test file ships now so it can be
 * exercised manually against a local Postgres before the CI job lands.
 */

import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import type { Pool } from "pg";

import {
  createPostgresStoreFromPool,
  type PostgresStore,
} from "../postgres-store";
import { MIGRATIONS } from "../migrations.embedded";

// ---------------------------------------------------------------------------
// Env-gate. Use a TEST-specific name (`INDEXER_PG_TEST_URL`) rather than
// reusing `INDEXER_PG_URL` so a developer with the production env var
// set in their shell does NOT accidentally run destructive schema-reset
// migrations against the production-shaped DB. The name and contract are
// documented in this file's header above; the punchlist footnote for
// OFF-217 cross-references it for operators.
// ---------------------------------------------------------------------------

const PG_TEST_URL = process.env.INDEXER_PG_TEST_URL;
const SUITE_ENABLED = typeof PG_TEST_URL === "string" && PG_TEST_URL.trim().length > 0;

if (!SUITE_ENABLED) {
  // One-line skip notice so operators / CI logs make the gate visible.
  // node:test reporters surface `console.log` between suite blocks.
  console.log(
    "[OFF-217] Skipping real-PG suite — set INDEXER_PG_TEST_URL to enable " +
      "(e.g. postgres://user:pass@127.0.0.1:5432/aep_indexer_test).",
  );
}

// ---------------------------------------------------------------------------
// Shared fixture. Skipping `before` hooks isn't honoured by node:test the
// same way `describe.skip` is, so we lazy-init the pool/store inside
// `before` and guard each describe-block with `{ skip: !SUITE_ENABLED }`.
// ---------------------------------------------------------------------------

let pool: Pool | undefined;
let store: PostgresStore | undefined;

/**
 * Build a fresh schema before each describe-block runs. Drops + recreates
 * every table the embedded migration owns so a flake in one suite does
 * not contaminate the next. Uses `IF EXISTS` for the drops so a brand-new
 * DB also goes through cleanly.
 *
 * Kept here (not in a fixture helper module) because OFF-217 is a single
 * test file's worth of state and adding a third helper module would
 * outweigh the duplication.
 */
async function resetSchema(p: Pool): Promise<void> {
  // Drop in reverse-dependency order. There are no FKs in the Phase 1
  // schema so `CASCADE` is belt-and-braces.
  const tables = [
    "events",
    "agents",
    "cursor",
    "agent_tombstones",
    "vault_identity_history",
    "manifest_history",
    "protocol_config_history",
  ];
  for (const t of tables) {
    await p.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  // Re-apply the embedded migrations against the now-empty DB.
  for (const migration of MIGRATIONS) {
    await p.query(migration.sql);
  }
}

// ---------------------------------------------------------------------------
// Test 1 — Happy path: a committed tx persists both rows under real PG.
// ---------------------------------------------------------------------------

describe("OFF-217 — real PG: happy-path tx commits both event and cursor", { skip: !SUITE_ENABLED }, () => {
  before(async () => {
    // Lazy-load `pg` so a Node environment without `pg` installed (eg.
    // a stripped CI image) doesn't blow up at module-load just to skip.
    // The workspace already declares `pg` in dependencies, so this is
    // strictly defence-in-depth.
    const { Pool: PgPool } = require("pg");
    pool = new PgPool({ connectionString: PG_TEST_URL, max: 4 }) as Pool;
    store = createPostgresStoreFromPool(pool);
    await resetSchema(pool);
  });

  after(async () => {
    if (store) await store.close();
    pool = undefined;
    store = undefined;
  });

  it("commits the event row and cursor row in a single transaction", async () => {
    assert.ok(pool && store, "fixture must be initialised");

    await store.withTransaction(async (client) => {
      await store.insertEventInTx(client, {
        program: "vault",
        eventName: "VaultInitialized",
        data: '{"happy":"path"}',
        signature: "off217_sig_happy",
        slot: 1000,
        eventOrdinal: 0,
      });
      await store.upsertCursorInTx(client, {
        program: "vault",
        slot: 1000,
        signature: "off217_sig_happy",
      });
    });

    // Both rows must be visible from a fresh pool.query (ie. they
    // really committed, not just sat on the in-tx client).
    const events = await pool.query(
      `SELECT data FROM events WHERE signature = $1`,
      ["off217_sig_happy"],
    );
    assert.equal(events.rowCount, 1, "event row must persist after COMMIT");
    assert.equal(events.rows[0].data, '{"happy":"path"}');

    const cursor = await pool.query(
      `SELECT last_processed_slot, last_signature FROM cursor WHERE program = 'vault'`,
    );
    assert.equal(cursor.rowCount, 1, "cursor row must persist after COMMIT");
    assert.equal(Number(cursor.rows[0].last_processed_slot), 1000);
    assert.equal(cursor.rows[0].last_signature, "off217_sig_happy");
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Mid-tx fail: event INSERT lands, then a deliberately broken
// statement aborts the tx. The event row MUST NOT be visible after the
// rollback. This is the rollback assertion pg-mem cannot honour.
// ---------------------------------------------------------------------------

describe("OFF-217 — real PG: mid-tx error rolls back the prior INSERT", { skip: !SUITE_ENABLED }, () => {
  before(async () => {
    const { Pool: PgPool } = require("pg");
    pool = new PgPool({ connectionString: PG_TEST_URL, max: 4 }) as Pool;
    store = createPostgresStoreFromPool(pool);
    await resetSchema(pool);
  });

  after(async () => {
    if (store) await store.close();
    pool = undefined;
    store = undefined;
  });

  it("aborts the tx after the event INSERT and leaves the events table empty", async () => {
    assert.ok(pool && store, "fixture must be initialised");

    let caught: unknown = null;
    try {
      await store.withTransaction(async (client) => {
        // 1) Real INSERT lands inside the tx.
        await store.insertEventInTx(client, {
          program: "vault",
          eventName: "VaultPaused",
          data: '{"will":"rollback"}',
          signature: "off217_sig_rollback",
          slot: 2000,
          eventOrdinal: 0,
        });

        // 2) Deliberate engine-level error to force a real PG rollback.
        // We aim a query at a table that does not exist — Postgres
        // raises `relation ... does not exist` (SQLSTATE 42P01) which
        // aborts the active transaction. This proves we are exercising
        // PG's transactional state machine, not the client wrapper's.
        await client.query(
          "INSERT INTO _off217_table_that_does_not_exist (x) VALUES (1)",
        );
      });
    } catch (err) {
      caught = err;
    }

    // The original PG error must have propagated up to our caller so
    // `withTransaction` could rollback. The exact SQLSTATE / message
    // shape is pg-driver dependent so we just check we got an error.
    assert.ok(caught instanceof Error, "expected rollback to surface the engine error");

    // The load-bearing assertion: the event INSERT from inside the
    // aborted tx must NOT be visible from a new connection. This is
    // what pg-mem could not verify.
    const events = await pool.query(
      `SELECT data FROM events WHERE signature = $1`,
      ["off217_sig_rollback"],
    );
    assert.equal(
      events.rowCount,
      0,
      "event row from aborted tx must NOT persist after ROLLBACK",
    );

    // Cursor row was never written in this tx, but assert it for
    // completeness — the cursor table for `vault` should be empty
    // (or not contain a row pointing at slot 2000).
    const cursor = await pool.query(
      `SELECT last_processed_slot FROM cursor WHERE program = 'vault'`,
    );
    if (cursor.rowCount && cursor.rowCount > 0) {
      assert.notEqual(
        Number(cursor.rows[0].last_processed_slot),
        2000,
        "cursor must not advance to a slot from an aborted tx",
      );
    }

    // Sanity: a follow-up clean tx on a fresh client must succeed,
    // proving the pool isn't leaking a poisoned client and the schema
    // is still intact after the engine-level abort.
    await store.withTransaction(async (client) => {
      await store.insertEventInTx(client, {
        program: "vault",
        eventName: "VaultPaused",
        data: '{"recovery":"works"}',
        signature: "off217_sig_recovery",
        slot: 2001,
        eventOrdinal: 0,
      });
      await store.upsertCursorInTx(client, {
        program: "vault",
        slot: 2001,
        signature: "off217_sig_recovery",
      });
    });

    const recovered = await pool.query(
      `SELECT data FROM events WHERE signature = $1`,
      ["off217_sig_recovery"],
    );
    assert.equal(recovered.rowCount, 1, "post-rollback recovery tx must commit cleanly");
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Body throws before any DB write. Wrapper must still emit
// ROLLBACK on the live engine, surface the original error, release the
// client, and leave no row drift.
// ---------------------------------------------------------------------------

describe("OFF-217 — real PG: body that throws before any write rolls back cleanly", { skip: !SUITE_ENABLED }, () => {
  before(async () => {
    const { Pool: PgPool } = require("pg");
    pool = new PgPool({ connectionString: PG_TEST_URL, max: 4 }) as Pool;
    store = createPostgresStoreFromPool(pool);
    await resetSchema(pool);
  });

  after(async () => {
    if (store) await store.close();
    pool = undefined;
    store = undefined;
  });

  it("wrapper rolls back, original error propagates, pool stays healthy", async () => {
    assert.ok(pool && store, "fixture must be initialised");

    let caught: unknown = null;
    try {
      await store.withTransaction(async (_client) => {
        // Throw BEFORE issuing any writes. This is the "conn-abort
        // during prepare" shape — eg. a marshal error or pre-check
        // failure before the dual-write site reaches `insertEventInTx`.
        throw new Error("off217 pre-write abort");
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof Error);
    assert.match((caught as Error).message, /off217 pre-write abort/);

    // No rows must have been written.
    const events = await pool.query(`SELECT count(*)::int AS c FROM events`);
    assert.equal(events.rows[0].c, 0, "no events must have been written");

    const cursor = await pool.query(`SELECT count(*)::int AS c FROM cursor`);
    assert.equal(cursor.rows[0].c, 0, "no cursor row must have been written");

    // Pool must still be usable — if `withTransaction`'s `finally`
    // failed to release the client we'd starve the pool here. We use
    // a tight max=4 above so a leak shows up after a few iterations.
    for (let i = 0; i < 6; i++) {
      await store.withTransaction(async (client) => {
        await store.insertEventInTx(client, {
          program: "vault",
          eventName: "Loop",
          data: `{"i":${i}}`,
          signature: `off217_sig_loop_${i}`,
          slot: 3000 + i,
          eventOrdinal: 0,
        });
        await store.upsertCursorInTx(client, {
          program: "vault",
          slot: 3000 + i,
          signature: `off217_sig_loop_${i}`,
        });
      });
    }

    const loop = await pool.query(`SELECT count(*)::int AS c FROM events WHERE event_name = 'Loop'`);
    assert.equal(loop.rows[0].c, 6, "all 6 follow-up txs must have committed");
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Idempotency under real PG. Same event PK twice ⇒ ON CONFLICT
// DO NOTHING wins, exactly one row. This already passes against pg-mem,
// but real PG re-verifies the index name + conflict target match the
// migration. A regression where the migration's UNIQUE index name drifts
// out of sync with the SQL constant would surface here as a real
// constraint-violation error rather than the silent-no-op the call site
// expects.
// ---------------------------------------------------------------------------

describe("OFF-217 — real PG: idempotent re-run of the same tx is safe", { skip: !SUITE_ENABLED }, () => {
  before(async () => {
    const { Pool: PgPool } = require("pg");
    pool = new PgPool({ connectionString: PG_TEST_URL, max: 4 }) as Pool;
    store = createPostgresStoreFromPool(pool);
    await resetSchema(pool);
  });

  after(async () => {
    if (store) await store.close();
    pool = undefined;
    store = undefined;
  });

  it("two committed txs with the same event PK leave exactly one event row", async () => {
    assert.ok(pool && store, "fixture must be initialised");

    const eventArgs = {
      program: "vault",
      eventName: "VaultInitialized",
      data: '{"first":"call"}',
      signature: "off217_sig_idem",
      slot: 4000,
      eventOrdinal: 0,
    };
    const cursorArgs = {
      program: "vault",
      slot: 4000,
      signature: "off217_sig_idem",
    };

    await store.withTransaction(async (client) => {
      await store.insertEventInTx(client, eventArgs);
      await store.upsertCursorInTx(client, cursorArgs);
    });

    // Same PK, different `data` payload — ON CONFLICT DO NOTHING wins.
    await store.withTransaction(async (client) => {
      await store.insertEventInTx(client, { ...eventArgs, data: '{"second":"call"}' });
      await store.upsertCursorInTx(client, cursorArgs);
    });

    const events = await pool.query(
      `SELECT data FROM events WHERE signature = $1`,
      ["off217_sig_idem"],
    );
    assert.equal(events.rowCount, 1, "second tx must NOT add a duplicate row");
    assert.equal(
      events.rows[0].data,
      '{"first":"call"}',
      "ON CONFLICT DO NOTHING preserves the original row",
    );
  });
});
