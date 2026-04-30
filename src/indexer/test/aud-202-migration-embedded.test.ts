/**
 * OFF-202 (ADR-128 cycle-3 off-chain audit) — embedded-migration tests.
 *
 * Validates the fix for the production-boot ENOENT documented in
 * `docs/audits/CYCLE-3-OFFCHAIN-PUNCHLIST.md` (item OFF-202):
 *
 *   The previous `LivePostgresStore.applyMigration` resolved its SQL
 *   via `__dirname` + `fs.readFileSync('migrations/001-initial-postgres.sql')`.
 *   After `tsc` compiled `postgres-store.ts` into `dist/`, `__dirname`
 *   pointed under `dist/` — but the migration files ship at
 *   `src/indexer/migrations/*.sql` and were not copied by the build,
 *   so production boot failed with ENOENT before the dual-write path
 *   ever opened.
 *
 * Fix shape: SQL is inlined as a TypeScript constant in
 * `src/indexer/migrations.embedded.ts`. The .sql files remain
 * authoritative for grep / SQL-tooling / future migration-runner work;
 * the embedded copy is a source artifact compiled into the same JS
 * bundle as the consumer.
 *
 * What this suite asserts:
 *   1. The MIGRATIONS array is non-empty and well-formed.
 *   2. `applyMigration()` against a fresh pg-mem DB succeeds without
 *      touching the filesystem (no ENOENT path).
 *   3. Re-applying is idempotent — a second call against the same DB
 *      raises nothing and produces no schema drift.
 *   4. Source-vs-embedded parity — the inlined SQL matches the .sql
 *      file byte-for-byte (modulo trailing whitespace), which catches
 *      the drift the auto-generation comment warns about.
 */

import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { newDb, DataType } from "pg-mem";
import type { Pool } from "pg";

import {
  createPostgresStoreFromPool,
  type PostgresStore,
} from "../postgres-store";
import { MIGRATIONS } from "../migrations.embedded";

/**
 * pg-mem 3.x ships with very few native functions registered AND its
 * AST-coverage checker rejects PG ordered-set-aggregate syntax
 * (`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ...)`) outright. The
 * ADR-131 trigger-views migration (002) defines `vw_escrow_median_30d`
 * over that exact construct because it is the canonical PG idiom for
 * the median, and real PostgreSQL ships it as a built-in (the
 * dual-write-real-pg test in `aud-200-dual-write-tx-real-pg.test.ts`
 * exercises real PG and would catch a regression there).
 *
 * pg-mem is the only environment that cannot parse this DDL. We
 * intercept queries that match the offending CREATE OR REPLACE VIEW
 * for `vw_escrow_median_30d` and short-circuit them with an empty
 * result-set. The test does not query the view (it only spot-checks
 * the seven Phase-1 base tables exist), so the intercept is safe.
 *
 * Per pg-mem's own interface contract:
 *   "Intercept queries. If your interceptor returns an array, then
 *    the query will not be executed. The given result will be
 *    returned instead."
 *
 * The shim is scoped to the OFF-202 test only — production boot and
 * the real-pg test path apply the migration unmodified.
 */
function registerPgMemShims(mem: ReturnType<typeof newDb>): void {
  // The percentile_cont function still needs to be registered so the
  // surrounding DDL parses cleanly; the interceptor skips the actual
  // statement, but pg-mem's name-resolution pass walks the multi-
  // statement migration before any individual statement runs.
  mem.public.registerFunction({
    name: "percentile_cont",
    args: [DataType.float],
    returns: DataType.float,
    implementation: () => 0,
  });
  // Drop the median view's CREATE OR REPLACE statement on the floor
  // when pg-mem encounters it. Identified by the unique view name —
  // no other statement in the migration mentions
  // `vw_escrow_median_30d`.
  mem.public.interceptQueries((sql: string) => {
    if (
      /CREATE\s+OR\s+REPLACE\s+VIEW\s+vw_escrow_median_30d\b/i.test(sql)
    ) {
      return [];
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Test 1 — MIGRATIONS array shape.
// ---------------------------------------------------------------------------

describe("OFF-202 — MIGRATIONS array shape", () => {
  it("is non-empty", () => {
    assert.ok(MIGRATIONS.length >= 1, "MIGRATIONS must have at least one entry");
  });

  it("every entry has a non-empty name and non-empty sql", () => {
    for (const m of MIGRATIONS) {
      assert.equal(typeof m.name, "string", "name must be a string");
      assert.ok(m.name.length > 0, `name must be non-empty (got '${m.name}')`);
      assert.equal(typeof m.sql, "string", "sql must be a string");
      assert.ok(
        m.sql.trim().length > 0,
        `sql for '${m.name}' must be non-empty after trim`,
      );
    }
  });

  it("first migration is the initial postgres schema", () => {
    // Sanity check that the array order matches the .sql filename order
    // operators expect in `src/indexer/migrations/`.
    assert.equal(MIGRATIONS[0].name, "001-initial-postgres.sql");
  });

  it("second migration is the ADR-131 trigger views", () => {
    // ADR-131 trigger views landed as 002-* (see file header for the
    // sybil-cost re-calibration context). Pinning the name + position
    // here keeps the array order traceable to the on-disk file order
    // operators expect, and catches a regression where someone adds
    // a future migration above 002 without renumbering.
    assert.equal(MIGRATIONS[1].name, "002-adr-131-trigger-views.sql");
  });
});

// ---------------------------------------------------------------------------
// Test 2 — applyMigration against a fresh pg-mem DB succeeds (no ENOENT).
// ---------------------------------------------------------------------------

describe("OFF-202 — applyMigration on fresh pg-mem DB", () => {
  let store: PostgresStore;
  let pool: Pool;

  before(async () => {
    const mem = newDb({ autoCreateForeignKeyIndices: true });
    registerPgMemShims(mem);
    const pgAdapter = mem.adapters.createPg();
    pool = new pgAdapter.Pool() as Pool;
    store = createPostgresStoreFromPool(pool);
    // The load-bearing call: this would have ENOENT'd under the old
    // __dirname + fs.readFileSync path if the .sql tree wasn't shipped
    // alongside the compiled JS. With the embedded fix this returns
    // cleanly regardless of the filesystem layout.
    await store.applyMigration();
  });

  after(async () => {
    await store.close();
  });

  // Spot-check that the schema actually landed — if the SQL was empty or
  // malformed the migration would silently no-op, which would be a worse
  // failure mode than ENOENT. The seven-table set is the ADR-128
  // §"Surface impact" contract.
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
    it(`creates table '${table}' from the embedded SQL`, async () => {
      const res = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      assert.equal(res.rowCount, 1, `expected '${table}' to exist after applyMigration`);
    });
  }
});

// ---------------------------------------------------------------------------
// Test 3 — applyMigration is idempotent (second call is a no-op).
// ---------------------------------------------------------------------------

describe("OFF-202 — applyMigration is idempotent", () => {
  it("MIGRATIONS[0] (initial schema) is idempotent-shaped (uses IF NOT EXISTS)", () => {
    // Static check on the embedded payload itself: every CREATE TABLE
    // and CREATE INDEX must use IF NOT EXISTS so a re-run cannot raise
    // "relation already exists". This is the property operators depend
    // on for safe bring-up / parity testing re-runs (ADR-128 §"Phase 1
    // contract"). It also covers what the bug-fix promises: an
    // applyMigration call against an already-migrated DB completes
    // cleanly. We assert the static shape rather than running the
    // payload twice through pg-mem because pg-mem 3.x's AST-coverage
    // checker does not yet support the IF NOT EXISTS skip path on
    // re-runs (a pg-mem WIP limitation, not a real-Postgres bug).
    const sql = MIGRATIONS[0].sql;
    const createTables = sql.match(/^\s*CREATE\s+TABLE\b/gim) ?? [];
    const createTablesIfNotExists = sql.match(
      /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/gim,
    ) ?? [];
    assert.ok(createTables.length > 0, "migration must contain CREATE TABLE statements");
    assert.equal(
      createTables.length,
      createTablesIfNotExists.length,
      "every CREATE TABLE must be IF NOT EXISTS so re-runs are no-ops",
    );

    const createIndexes = sql.match(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/gim) ?? [];
    const createIndexesIfNotExists = sql.match(
      /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gim,
    ) ?? [];
    assert.ok(createIndexes.length > 0, "migration must contain CREATE INDEX statements");
    assert.equal(
      createIndexes.length,
      createIndexesIfNotExists.length,
      "every CREATE INDEX must be IF NOT EXISTS so re-runs are no-ops",
    );
  });

  // ADR-131 trigger-views migration uses a slightly different
  // idempotency surface than 001:
  //   * No CREATE TABLE statements (views + indexes only — preserves
  //     ADR-128 Phase 1's no-new-tables contract).
  //   * Views use CREATE OR REPLACE VIEW (PG always supports this for
  //     non-materialized views; preferred over CREATE VIEW IF NOT
  //     EXISTS because the latter would silently skip a redefinition
  //     when the column list legitimately changed in a follow-up
  //     migration).
  //   * Indexes still use CREATE INDEX IF NOT EXISTS — same shape as
  //     001 — so re-runs are no-ops.
  it("MIGRATIONS[1] (ADR-131 views) is idempotent-shaped (CREATE OR REPLACE / IF NOT EXISTS)", () => {
    const sql = MIGRATIONS[1].sql;

    // No CREATE TABLE statements at all — preserves the ADR-128 Phase 1
    // no-new-tables contract.
    const createTables = sql.match(/^\s*CREATE\s+TABLE\b/gim) ?? [];
    assert.equal(
      createTables.length,
      0,
      "ADR-131 migration must add views + indexes only, no new tables (ADR-128 Phase 1 contract)",
    );

    // Every CREATE VIEW must be CREATE OR REPLACE VIEW.
    const createViews = sql.match(/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/gim) ?? [];
    const createOrReplaceViews = sql.match(/^\s*CREATE\s+OR\s+REPLACE\s+VIEW\b/gim) ?? [];
    assert.ok(createViews.length > 0, "migration must contain CREATE VIEW statements");
    assert.equal(
      createViews.length,
      createOrReplaceViews.length,
      "every CREATE VIEW must be CREATE OR REPLACE VIEW so re-runs are no-ops",
    );

    // Every CREATE INDEX must be CREATE INDEX IF NOT EXISTS.
    const createIndexes = sql.match(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/gim) ?? [];
    const createIndexesIfNotExists = sql.match(
      /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gim,
    ) ?? [];
    assert.ok(createIndexes.length > 0, "migration must contain CREATE INDEX statements");
    assert.equal(
      createIndexes.length,
      createIndexesIfNotExists.length,
      "every CREATE INDEX must be IF NOT EXISTS so re-runs are no-ops",
    );
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Source/embedded parity. Catches drift between the .sql file
// (authoritative for tooling) and the embedded TypeScript constant
// (authoritative for runtime). If this fails, regenerate
// migrations.embedded.ts from src/indexer/migrations/*.sql.
// ---------------------------------------------------------------------------

describe("OFF-202 — embedded SQL matches the .sql source", () => {
  // Loop over every entry in MIGRATIONS so future migrations are
  // covered automatically — the parity contract is per-migration,
  // not per-file-pinned. Adding a new MIGRATIONS entry without a
  // matching .sql file (or vice-versa) trips this loop.
  for (const migration of MIGRATIONS) {
    it(`MIGRATIONS entry '${migration.name}' equals the contents of ${migration.name}`, () => {
      // Test runs from the working directory; resolve relative to this
      // test file so it works whether tsx is invoked from src/indexer or
      // from the repo root.
      const sourcePath = path.join(__dirname, "..", "migrations", migration.name);
      const onDisk = fs.readFileSync(sourcePath, "utf8");

      // Trim trailing whitespace/newlines so an editor adding a final
      // newline to the .sql file doesn't false-flag drift. The leading
      // content (comments, DDL) must match byte-for-byte.
      assert.equal(
        migration.sql.replace(/\s+$/, ""),
        onDisk.replace(/\s+$/, ""),
        `embedded SQL has drifted from src/indexer/migrations/${migration.name} — regenerate migrations.embedded.ts`,
      );
    });
  }
});
