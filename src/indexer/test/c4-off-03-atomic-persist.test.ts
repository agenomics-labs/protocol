/**
 * C4-OFF-03 (cycle-4) — `persistEventsForTx` per-tx atomicity +
 * `drainProgramWriteLocks` shutdown ordering.
 *
 * The audit found two compounding gaps in ADR-118's stated invariant
 * ("the cursor only ever advances on fully-persisted work"):
 *
 *   1. `persistEventsForTx` ran the event INSERTs, the agents-projection
 *      updates, and the cursor UPSERT as separate auto-commit statements.
 *      `synchronous=FULL` makes each statement durable but does NOT make
 *      the multi-statement sequence atomic — a crash/close between the
 *      event rows and the cursor UPSERT left the next boot replaying from
 *      a torn state. The fix wraps the whole per-tx sequence in a single
 *      `db.transaction()`.
 *
 *   2. `gracefulShutdown` proceeded to `db.close()` without awaiting any
 *      in-flight `withProgramWriteLock` work. `drainProgramWriteLocks`
 *      now blocks until every registered per-program mutex is idle.
 *
 * Pure-unit: :memory: SQLite, no RPC, no PG.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  initDb,
  persistEventsForTx,
  withProgramWriteLock,
  drainProgramWriteLocks,
  createInitialMetrics,
  type IndexerMetrics,
} from "../index";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("C4-OFF-03: persistEventsForTx is atomic per transaction", () => {
  it("event rows and the cursor UPSERT commit together (cursor never advances without the rows)", () => {
    const db = initDb(":memory:");
    try {
      const label = "settlement";
      const metrics: IndexerMetrics = createInitialMetrics();

      // A well-formed but undecodable payload is fine — persistence does
      // not depend on decode success; it inserts whatever ParsedEvent[]
      // it is given.
      const events = [{ name: "EscrowCompleted", data: { x: 1 } }];
      const sig = `sig-${"a".repeat(60)}`;
      const r = persistEventsForTx(db, label, sig, 4242, events, metrics);

      assert.equal(r.inserted, 1, "the single event was inserted");

      const eventRow = db
        .prepare(
          "SELECT slot, signature FROM events WHERE program = ? AND signature = ?",
        )
        .get(label, sig) as { slot: number; signature: string } | undefined;
      const cursorRow = db
        .prepare(
          "SELECT last_processed_slot, last_signature FROM cursor WHERE program = ?",
        )
        .get(label) as
        | { last_processed_slot: number; last_signature: string }
        | undefined;

      assert.ok(eventRow, "event row committed");
      assert.ok(cursorRow, "cursor row committed");
      // The invariant: the cursor points at exactly the slot/sig whose
      // event rows are present. They can only be observed together
      // because they are now in one db.transaction().
      assert.equal(cursorRow!.last_processed_slot, 4242);
      assert.equal(cursorRow!.last_signature, sig);
      assert.equal(eventRow!.slot, 4242);
    } finally {
      db.close();
    }
  });

  it("a throw inside the per-tx loop rolls back the WHOLE batch — no partial rows, cursor unmoved", () => {
    const db = initDb(":memory:");
    try {
      const label = "registry";
      const metrics: IndexerMetrics = createInitialMetrics();

      // First, advance the cursor with a clean tx so we have a known
      // "before" cursor state to prove it does NOT move on rollback.
      persistEventsForTx(
        db,
        label,
        `sig-${"b".repeat(60)}`,
        100,
        [{ name: "AgentRegistered", data: { ok: true } }],
        metrics,
      );
      const before = db
        .prepare("SELECT last_processed_slot FROM cursor WHERE program = ?")
        .get(label) as { last_processed_slot: number };
      assert.equal(before.last_processed_slot, 100);

      // Now feed a batch where the SECOND event's data cannot be
      // JSON.stringify'd (a BigInt throws in JSON.stringify). Pre-fix,
      // the first event would have been committed and the cursor left
      // torn; post-fix the whole transaction rolls back.
      const poison = [
        { name: "AgentRegistered", data: { good: 1 } },
        { name: "AgentRegistered", data: { bad: 10n as unknown } }, // BigInt → JSON.stringify throws
      ];
      const r = persistEventsForTx(
        db,
        label,
        `sig-${"c".repeat(60)}`,
        200,
        poison as { name: string; data: Record<string, unknown> }[],
        metrics,
      );

      assert.equal(r.inserted, 0, "rollback => nothing reported inserted");
      assert.equal(r.skipped, 0);

      // No row from the poisoned batch survived.
      const leaked = db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE signature = ?")
        .get(`sig-${"c".repeat(60)}`) as { n: number };
      assert.equal(leaked.n, 0, "no partial rows from the rolled-back batch");

      // Cursor did NOT advance to the poisoned slot.
      const after = db
        .prepare("SELECT last_processed_slot FROM cursor WHERE program = ?")
        .get(label) as { last_processed_slot: number };
      assert.equal(
        after.last_processed_slot,
        100,
        "cursor must stay at the last fully-persisted tx (100), not the rolled-back 200",
      );
    } finally {
      db.close();
    }
  });
});

describe("C4-OFF-03: drainProgramWriteLocks awaits in-flight write work", () => {
  it("does not resolve until an in-flight withProgramWriteLock body completes", async () => {
    const label = "vault-c4off03-drain";
    let workDone = false;

    // Start a long-ish critical section under the same per-label mutex
    // gracefulShutdown must drain before db.close().
    const inFlight = withProgramWriteLock(label, async () => {
      await sleep(40);
      workDone = true;
    });

    // Give the mutex a tick to actually acquire.
    await sleep(5);

    // Drain must BLOCK until the in-flight body finished.
    await drainProgramWriteLocks();
    assert.equal(
      workDone,
      true,
      "drainProgramWriteLocks resolved before in-flight write work completed — db.close() could land mid-commit",
    );

    await inFlight; // hygiene
  });

  it("resolves promptly when no write work is in flight", async () => {
    const t0 = Date.now();
    await drainProgramWriteLocks();
    assert.ok(
      Date.now() - t0 < 1000,
      "idle drain must not hang",
    );
  });
});
