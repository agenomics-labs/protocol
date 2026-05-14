/**
 * ADR-118 — SIGTERM test harness.
 *
 * Standalone script spawned by `adr-118-sigterm.test.ts`. Mirrors the
 * shape of the production `main()` SIGTERM handler at the level needed
 * to verify the contract, without dragging in RPC, HTTP, or PG:
 *
 *   - Opens a SQLite DB via `initDb` (so PRAGMA FULL + WAL is in play).
 *   - Spawns a "live-stream" simulated by a `setInterval` that grabs the
 *     per-program write mutex and inserts events. We start ONE in-flight
 *     batch and hold the mutex artificially with a short delay so the
 *     SIGTERM arrives while the batch is mid-commit.
 *   - Installs the SIGTERM handler with the same shape main() uses:
 *       1. flips `isShuttingDown` (via __resetShutdownFlagForTest's
 *          inverse — we own the module flag for the lifetime of this
 *          subprocess), but cleanly: we just rely on `isShuttingDown`
 *          being settable through the public surface. The harness uses
 *          the `withProgramWriteLock` helper directly so the flag isn't
 *          needed for the assertion, but we still emit the same logs
 *          (`shutdown:start`, `:flush`, `:exit`) for the test to match.
 *       2. aborts a fake AbortController (stand-in for `abortAll()`).
 *       3. awaits the in-flight commit (the mutex serialises it).
 *       4. closes the DB and exits 0.
 *
 * CLI: `tsx adr-118-sigterm.harness.ts <mode> <dbPath> <budgetMs>`
 *   - mode "normal": clean path finishes well under budget.
 *   - mode "hang":   clean path awaits a never-resolved promise so the
 *                    force-exit timer is the only way out.
 */

import { initDb, withProgramWriteLock } from "../index";
import { logger } from "../logger";

async function main(): Promise<void> {
  const [, , mode = "normal", dbPath = ":memory:", budgetRaw = "30000"] = process.argv;
  const budgetMs = Number.parseInt(budgetRaw, 10);

  const db = initDb(dbPath);
  const controller = new AbortController();

  // "Live-stream" simulator. Holds the vault mutex briefly while
  // inserting one event row. Started immediately; we don't even need
  // an interval — a single inflight call is enough to assert "the
  // mutex blocks shutdown until the batch commits".
  const insert = db.prepare(
    `INSERT INTO events (program, event_name, data, signature, slot, event_ordinal)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const inflight = withProgramWriteLock("vault", async () => {
    // Hold the lock for a few ms so SIGTERM almost certainly arrives
    // while we're inside the critical section. The production
    // handler's contract is "isShuttingDown flips between batches"
    // and "abortAll() ends the iterator without scheduling reconnect";
    // both happen WHILE this commit is still draining.
    await new Promise((resolve) => setTimeout(resolve, 150));
    insert.run("vault", "TestEvent", JSON.stringify({}), "sig-test-1", 1, 0);
  });

  let shutdownInFlight = false;
  let isShuttingDown = false;
  const gracefulShutdown = (reason: "SIGINT" | "SIGTERM"): void => {
    if (shutdownInFlight) return;
    shutdownInFlight = true;
    isShuttingDown = true;
    logger.info(
      { reason, budget_ms: budgetMs, event: "shutdown:start" },
      "shutdown:start",
    );

    // NOTE: do NOT unref() this timer — in the "hang" test mode the
    // clean-exit path awaits a never-resolving promise, leaving zero
    // refs in the event loop; an unref'd force-exit would let Node
    // exit cleanly (code 0) before the budget fires. We rely on the
    // signal-handler path being the only thing scheduling this timer
    // so its presence is bounded by the shutdown window.
    const forceExitTimer = setTimeout(() => {
      logger.error(
        { reason, budget_ms: budgetMs, event: "shutdown:exit" },
        "shutdown:exit — graceful budget exceeded, force-exiting (1)",
      );
      // Best-effort sync close before we bail — keeps the WAL from
      // leaking past the parent test. better-sqlite3's close() is
      // sync, so this completes before exit().
      try {
        db.close();
      } catch {
        // ignore
      }
      process.exit(1);
    }, budgetMs);

    // Fake the production abortAll(): trigger our stand-in controller.
    try {
      controller.abort();
    } catch {
      // ignore
    }

    void (async () => {
      try {
        logger.info({ reason, event: "shutdown:flush" }, "shutdown:flush");
        // Wait for the in-flight commit to drain. The mutex
        // guarantees it lands fully before we close the DB.
        await inflight;

        if (mode === "hang") {
          // Force-exit path: pretend a downstream cleanup never
          // returns. The force-exit timer is the only way out.
          await new Promise<void>(() => {
            /* never resolves */
          });
        }

        db.close();
        clearTimeout(forceExitTimer);
        logger.info({ reason, event: "shutdown:exit" }, "shutdown:exit");
        process.exit(0);
      } catch (err) {
        logger.error(
          { err: String(err), reason, event: "shutdown:exit" },
          "shutdown:exit — clean path threw, force-exit will fire",
        );
      }
    })();
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  // Keep the process alive until SIGTERM arrives. The setInterval is
  // unref-ed so it never blocks exit on its own.
  const keepalive = setInterval(() => {
    /* heartbeat to keep loop alive */
    if (isShuttingDown) {
      clearInterval(keepalive);
    }
  }, 25);
}

main().catch((err) => {
  // Don't use the logger here — bypass pino so the test can still
  // collect the raw stderr if `main` itself blows up.
  process.stderr.write(`harness fatal: ${String(err)}\n`);
  process.exit(2);
});
