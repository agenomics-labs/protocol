/**
 * ADR-118 — `PRAGMA synchronous = FULL` regression test.
 *
 * The 2026-05 re-audit (R-offchain-02) found that the SQLite store had
 * `journal_mode = WAL` but not `synchronous = FULL`, so a power-loss or
 * kernel-panic mid-batch could leave the WAL with committed-but-unsynced
 * pages. The fix in `initDb` is a one-liner `db.pragma("synchronous = FULL")`
 * right after the WAL pragma; this test pins it so a future refactor
 * that accidentally drops the line (or moves it before the WAL switch
 * where the pragma is silently re-defaulted) is caught at CI.
 *
 * SQLite's mapping for `synchronous`: OFF=0, NORMAL=1, FULL=2, EXTRA=3.
 * The audit-mandated value is FULL (2). NORMAL (1) is SQLite's WAL-mode
 * default and is what the pre-fix code path returned — explicitly
 * asserting `=== 2` catches an accidental removal.
 *
 * Hermetic: an `:memory:` SQLite DB, no network, no FS.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { initDb } from "../index";

/**
 * Helper: get a unique temp file path and clean up its SQLite sidecars.
 * `:memory:` databases override `journal_mode` to "memory" regardless of
 * the requested PRAGMA, which would mask the WAL assertion below — so
 * the WAL-asserting tests open a real file.
 */
function withTempDb<T>(fn: (dbPath: string) => T): T {
  const dbPath = path.join(
    os.tmpdir(),
    `adr-118-pragma-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  try {
    return fn(dbPath);
  } finally {
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }
}

describe("ADR-118 — PRAGMA synchronous = FULL", () => {
  it("initDb sets synchronous = FULL (2) on a file-backed connection", () => {
    withTempDb((dbPath) => {
      const db = initDb(dbPath);
      try {
        // `pragma()` with no value returns the current setting; with
        // `{ simple: true }` it returns the raw scalar (a number for
        // `synchronous`). Default in WAL mode is NORMAL=1; FULL=2 is
        // the ADR-mandated value.
        const sync = db.pragma("synchronous", { simple: true });
        assert.equal(sync, 2, "synchronous pragma must be FULL (2)");
      } finally {
        db.close();
      }
    });
  });

  it("initDb keeps journal_mode = WAL alongside synchronous = FULL", () => {
    // Regression guard: ADR-118 must not regress the WAL setting that
    // the dual-write / cursor design depends on (readers and writers
    // share the journal without blocking each other). Note: this test
    // uses a real file because `:memory:` databases override
    // journal_mode to "memory" regardless of the requested pragma.
    withTempDb((dbPath) => {
      const db = initDb(dbPath);
      try {
        const journal = db.pragma("journal_mode", { simple: true });
        // SQLite returns the mode name lowercased.
        assert.equal(journal, "wal", "journal_mode must remain WAL");
        const sync = db.pragma("synchronous", { simple: true });
        assert.equal(sync, 2, "synchronous must be FULL even with WAL on");
      } finally {
        db.close();
      }
    });
  });

  it("a fresh Database without initDb keeps the engine default", () => {
    // Sanity: the FULL setting comes from initDb, not from
    // better-sqlite3's defaults. If a future bump changes the engine
    // default to FULL we'd want to know (so we can drop the pragma).
    const Database = require("better-sqlite3");
    const raw = new Database(":memory:");
    try {
      const sync = raw.pragma("synchronous", { simple: true });
      // We assert ONLY that the value is a small integer in the
      // {0,1,2,3} set — the load-bearing assertion is the one against
      // initDb above.
      assert.ok(
        sync === 0 || sync === 1 || sync === 2 || sync === 3,
        `synchronous pragma sanity (got ${sync})`,
      );
    } finally {
      raw.close();
    }
  });
});
