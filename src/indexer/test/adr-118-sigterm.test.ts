/**
 * ADR-118 — SIGTERM graceful-shutdown regression test.
 *
 * The production handler in `main()` does too much real I/O to exercise
 * in-process (it opens an HTTP listener, opens a PG pool, opens a WS,
 * binds a Solana RPC). For a hermetic test we spawn a sub-process
 * running a self-contained harness that imports the same building
 * blocks (`isShuttingDown` flag, `withProgramWriteLock`, `initDb`) and
 * wires up a SIGTERM handler with the same shape: flip the flag, abort
 * a fake "live subscription", commit one final batch under the mutex,
 * close the DB, exit 0 — all inside the 30s budget.
 *
 * The test asserts:
 *
 *   1. The child exits with code 0 within the budget when SIGTERM is
 *      delivered.
 *   2. The child wrote a `shutdown:start` and `shutdown:exit` log line
 *      to stdout (the production handler logs these via pino at info).
 *   3. The "in-flight batch" the harness is holding finishes
 *      committing — i.e. the row inserted under the mutex is visible
 *      on the next process startup (the harness writes the SQLite db
 *      to a temp file and the test re-opens it to read).
 *   4. The child exits with code 1 when the graceful budget is too
 *      short for the in-flight work — exercising the force-exit timer.
 *
 * Why a sub-process: `process.on("SIGTERM", ...)` in the same process
 * as the test runner would either short-circuit `process.exit()` (and
 * kill the runner) or require monkey-patching it. A child gives a
 * clean signal surface AND lets us verify the exit code.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_INDEXER = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const HARNESS_TS = path.resolve(__dirname, "adr-118-sigterm.harness.ts");
// Direct tsx binary path: avoid `npx tsx` because npx spawns a Node
// wrapper that does NOT forward SIGTERM to the underlying child, which
// would defeat the whole point of this test (we'd kill the npm wrapper
// instead of the harness). Using node_modules/.bin/tsx is the canonical
// "I want a real Node process I can signal" pattern in workspace tests.
const TSX_BIN = path.resolve(REPO_ROOT, "node_modules/.bin/tsx");

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function runHarness(args: string[], signalAfterMs: number, killBudgetMs: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(
      TSX_BIN,
      ["--no-warnings", HARNESS_TS, ...args],
      {
        cwd: REPO_INDEXER,
        env: { ...process.env, NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    // Send SIGTERM after the harness has had time to set up its handler
    // and start its in-flight work loop.
    const sigTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited — fine.
      }
    }, signalAfterMs);

    // Hard kill if the child outlives the budget; the assertion below
    // distinguishes "exited cleanly" from "we had to SIGKILL it".
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, killBudgetMs);

    child.on("error", (err) => {
      clearTimeout(sigTimer);
      clearTimeout(killTimer);
      reject(err);
    });

    child.on("exit", (code, signal) => {
      clearTimeout(sigTimer);
      clearTimeout(killTimer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}

describe("ADR-118 — SIGTERM graceful shutdown", () => {
  it("clean shutdown: child exits 0 within budget, logs shutdown:start + shutdown:exit", async () => {
    const tmpDb = path.join(
      os.tmpdir(),
      `adr-118-sigterm-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );

    try {
      // Args: <mode> <dbPath> <budgetMs>
      // Mode "normal" — the harness's in-flight batch finishes in
      // well under 1 s; we send SIGTERM after 1.5 s (giving tsx +
      // ESM + better-sqlite3 boot time) and the budget is 10 s. The
      // clean-exit path must fire.
      const result = await runHarness(
        ["normal", tmpDb, "10000"],
        /* signalAfterMs */ 1500,
        /* killBudgetMs  */ 20_000,
      );

      assert.equal(
        result.code,
        0,
        `child should exit cleanly with code 0 (got code=${result.code} signal=${result.signal}, stderr=${result.stderr})`,
      );
      assert.equal(result.signal, null, "child must exit via clean exit, not SIGKILL");

      // Log assertions: pino emits JSON lines. We match on the shape
      // the production handler uses (`event: "shutdown:start"` etc.).
      assert.ok(
        result.stdout.includes("shutdown:start"),
        `stdout missing shutdown:start; got:\n${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes("shutdown:exit"),
        `stdout missing shutdown:exit; got:\n${result.stdout}`,
      );

      // The in-flight batch must have committed. The harness inserts
      // exactly one events row labelled "vault" under the mutex; assert
      // the row is visible.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const db = new Database(tmpDb, { readonly: true });
      try {
        const row = db
          .prepare("SELECT COUNT(*) AS n FROM events WHERE program = ?")
          .get("vault") as { n: number };
        assert.equal(
          row.n,
          1,
          "in-flight batch must commit under the mutex before exit",
        );
      } finally {
        db.close();
      }
    } finally {
      try {
        fs.unlinkSync(tmpDb);
      } catch {
        // ignore — tmp may have already vanished if WAL stayed open
      }
      // Best-effort: blow away the WAL sidecars. SQLite may leave
      // zero-byte -wal / -shm files after `db.close()` if no other
      // connection is open; that's an *empty* WAL, not an orphaned
      // committed-but-unsynced one. The load-bearing assertion for
      // "no orphan WAL" is therefore "the -wal file (if present) is
      // empty" rather than "the file doesn't exist".
      const walPath = `${tmpDb}-wal`;
      const shmPath = `${tmpDb}-shm`;
      if (fs.existsSync(walPath)) {
        const walSize = fs.statSync(walPath).size;
        // PRAGMA synchronous = FULL + clean close should leave an
        // empty (checkpointed-out) WAL. A non-zero size here would
        // mean uncheckpointed pages survived past the close, which
        // is the leak the ADR is closing.
        assert.equal(walSize, 0, `WAL must be empty after clean close (got ${walSize}B)`);
        fs.unlinkSync(walPath);
      }
      if (fs.existsSync(shmPath)) {
        fs.unlinkSync(shmPath);
      }
    }
  });

  it("force-exit: a too-short budget triggers code 1", async () => {
    const tmpDb = path.join(
      os.tmpdir(),
      `adr-118-sigterm-force-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );

    try {
      // Mode "hang" — harness leaves a non-resolving pending operation
      // (a never-resolved promise) on the clean-exit path so the only
      // way out is the force-exit timer. Budget is 1 s; the test kill
      // budget is 15 s so we have plenty of head-room.
      const result = await runHarness(
        ["hang", tmpDb, "1000"],
        /* signalAfterMs */ 1500,
        /* killBudgetMs  */ 15_000,
      );

      assert.equal(
        result.code,
        1,
        `forced-exit child must exit code=1 (got code=${result.code} signal=${result.signal}, stderr=${result.stderr})`,
      );
      assert.equal(result.signal, null, "force-exit goes through process.exit(1), not SIGKILL");

      // The force-exit branch logs `shutdown:exit` at error level —
      // it's still the same `event` key.
      assert.ok(
        result.stdout.includes("shutdown:start"),
        `stdout missing shutdown:start; got:\n${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes("shutdown:exit"),
        `stdout missing shutdown:exit; got:\n${result.stdout}`,
      );
    } finally {
      for (const p of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
        try {
          fs.unlinkSync(p);
        } catch {
          // ignore
        }
      }
    }
  });
});
