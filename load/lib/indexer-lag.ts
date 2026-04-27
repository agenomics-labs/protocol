/**
 * Indexer event-ingest lag measurement.
 *
 * The protocol's indexer (`src/indexer/index.ts`) writes a per-program
 * cursor to a `cursor` table in a SQLite DB (default path `./aep-events.db`,
 * overridable via `DB_PATH`). Lag = chain head slot − cursor's
 * last_processed_slot, measured at the end of a load run.
 *
 * This module reads that table directly via better-sqlite3 (the same
 * driver the indexer uses). It does NOT spawn the indexer — Phase 1
 * assumes the operator runs the indexer separately if they want a lag
 * measurement; if the DB file is missing the reading is reported as
 * unavailable and the campaign continues.
 */
import * as fs from "fs";
import { Connection } from "@solana/web3.js";
import type { IndexerLagReading } from "./metrics-collector";

interface CursorRow {
  program: string;
  last_processed_slot: number;
  last_signature: string | null;
}

export async function measureIndexerLag(
  connection: Connection,
  dbPath: string,
): Promise<IndexerLagReading> {
  const chainHeadSlot = await connection.getSlot("confirmed");

  if (!fs.existsSync(dbPath)) {
    return {
      chainHeadSlot,
      perProgram: {},
      available: false,
      unavailableReason: `indexer DB not found at ${dbPath} (set DB_PATH or run the indexer)`,
    };
  }

  // Lazy-require so the harness still loads if better-sqlite3 isn't built
  // (operator hasn't run `npm install` from the indexer workspace). The
  // root workspace pulls it transitively, but a fresh checkout without
  // postinstall might not have the native binding compiled yet.
  let Database: typeof import("better-sqlite3");
  try {
    Database = require("better-sqlite3");
  } catch (err) {
    return {
      chainHeadSlot,
      perProgram: {},
      available: false,
      unavailableReason: `better-sqlite3 unavailable: ${(err as Error).message}`,
    };
  }

  let db: import("better-sqlite3").Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return {
      chainHeadSlot,
      perProgram: {},
      available: false,
      unavailableReason: `cannot open DB: ${(err as Error).message}`,
    };
  }

  try {
    // Schema check: the cursor table must exist. If it doesn't, the
    // indexer never ran — surface that explicitly so the operator
    // doesn't read the resulting "lag = head" as a real number.
    const tableExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cursor'",
      )
      .get();
    if (!tableExists) {
      return {
        chainHeadSlot,
        perProgram: {},
        available: false,
        unavailableReason: "DB exists but `cursor` table is missing (indexer never wrote schema)",
      };
    }

    const rows = db
      .prepare("SELECT program, last_processed_slot, last_signature FROM cursor")
      .all() as CursorRow[];

    const perProgram: IndexerLagReading["perProgram"] = {};
    for (const row of rows) {
      perProgram[row.program] = {
        cursorSlot: row.last_processed_slot,
        lagSlots: chainHeadSlot - row.last_processed_slot,
      };
    }

    return { chainHeadSlot, perProgram, available: true };
  } finally {
    db.close();
  }
}
