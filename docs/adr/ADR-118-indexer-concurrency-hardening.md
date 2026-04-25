# ADR-118: Indexer concurrency hardening (WAL fullsync + write mutex + SIGTERM)

## Status
Proposed

## Date
2026-04-24

## Context

Re-audit surfaced three related concurrency gaps in `src/indexer/`:

- **R-offchain-02 (High).** Backfill worker and live WebSocket stream
  both write to SQLite concurrently. Journal mode is `WAL` (good) but
  `synchronous = FULL` is not set. A crash mid-backfill can leave the
  WAL unsynced; on restart the partially-committed backfill is
  replayed. Combined with live-stream writes that advanced cursors
  past the same slot, this can revive an agent the tombstone table
  logically deregistered.
- **R-offchain-07 (Medium).** No SIGTERM handler. K8s rollouts send
  SIGTERM; the indexer only handles SIGINT. In-flight backfill
  batches terminate mid-write; the cursor is advanced after each
  batch, so crash-mid-batch means the slot window is partially
  indexed but the cursor records "done." Restart resumes past the
  gap.
- (Related to R-offchain-02.) There is no per-program write mutex
  serialising the two streams. Even with `synchronous = FULL`, a
  late `AgentRegistered` replay from backfill arriving after a live
  `AgentDeregistered` can race with the tombstone insert unless the
  two streams take turns.

## Decision

Three coordinated changes in `src/indexer/`:

1. **`PRAGMA synchronous = FULL`** on the SQLite connection
   (`db.pragma("synchronous = FULL")`) immediately after WAL mode is
   set. Cost: write fsync on every commit (OK — the indexer does
   batched commits, not per-event).
2. **Write mutex**: introduce a single `async-mutex` instance guarding
   every write path (live-stream handler + backfill batch commit).
   Reads remain unlocked (WAL allows concurrent readers). The mutex
   is per-program so the three programs can progress independently.
3. **SIGTERM handler**: wire `process.on("SIGTERM", ...)` alongside
   the existing SIGINT handler. The handler sets an
   `isShuttingDown` flag the backfill loop checks between batches;
   the current batch transaction is committed or rolled back (never
   left dangling). The live-stream WebSocket is `.unsubscribe()`-ed.
   Then `db.close()` and `process.exit(0)`. Budget: 30s
   `gracefulShutdownTimeoutMs`, default K8s `terminationGracePeriodSeconds`.

Testing:
- Unit test: simulate mid-batch SIGTERM with a stubbed
  `db.transaction`; assert rollback on next start.
- Integration test: spin a real SQLite file, start backfill in one
  goroutine and live-stream writes in another, issue SIGTERM after
  ~50 writes, assert no ghost rows and cursor matches last committed
  batch.

Observability: log `shutdown:start`, `shutdown:flush`, `shutdown:exit`
at `info` level with correlation IDs per ADR-090.

## Consequences

- Crash-safe under both journal corruption and K8s rollouts.
- Minor write-latency increase from `synchronous = FULL` — negligible
  vs. commit batch size.
- Adds `async-mutex` dep to `src/indexer/package.json`. Already used
  elsewhere in the Node ecosystem; trivial.
- Tests for mid-shutdown behavior become part of the event-coverage
  CI gate (ADR-082).

## References

- `docs/ARCHITECTURE_REAUDIT_2026-05.md` R-offchain-02, R-offchain-07.
- `docs/adr/ADR-082-indexer-event-coverage-ci-gate.md`.
- `docs/adr/ADR-090-structured-logging.md`.
- `src/indexer/index.ts` (WAL + SIGINT as-is).
