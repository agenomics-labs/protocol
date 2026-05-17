# Cycle-4 Security Audit — OFFCHAIN INDEXER

Scope: `src/indexer/` (decoder, ADR-087 @solana/kit migration, ADR-118 concurrency,
ADR-128 Postgres). Baseline branch `audit-baseline` @ `b8fe80b`. READ-ONLY.

Prior cycle-3 OFFCHAIN punchlist confirmed drained; this draft covers ADR-087/118/128
deltas plus the untrusted-log-parsing trust boundary.

---

## C4-OFF-01 — `BorshReader.string()` unbounded length prefix → silent offset drift / OOM (AUD-004 class)

- **Severity:** HIGH
- **File:** `src/indexer/index.ts:669-674` (also `BorshReader` u8/u16/u32/u64/i64/pubkey,
  `index.ts:614-667`)
- **Scenario:** `string()` reads a u32 length prefix from an *untrusted on-chain log*
  (`Program data:` line, `parseLogsForEvents`, `index.ts:1377`) and does
  `buf.subarray(offset, offset+len)` then `offset += len`. `subarray` is silently clamped
  to buffer end, so a corrupt/hostile/truncated payload with `len` larger than the
  remaining bytes does **not throw**: it yields a short string and then advances `offset`
  by the *declared* `len`, not bytes actually consumed. Every subsequent field in that
  decoder reads from a desynchronized offset — bit-shifted garbage written to `events.data`
  and propagated to the agents projection and the PG shadow. This is precisely the AUD-004
  `SuspensionCleared` failure mode, now structurally reachable for **any** event with a
  `String` field (`AgentRegistered.name/category`, `AgentDeregistered.name`,
  `index.ts:761,762,786,937`). Numeric readers (`readUInt8`, `readBigUInt64LE`, …) *do*
  throw `RangeError` on OOB and are caught at `index.ts:1406` (acceptable — classification
  preserved). `string()` is the one reader that fails *silently* instead of throwing.
  Secondary: a 4 GiB `len` triggers a multi-GiB `toString("utf8")` allocation attempt
  (DoS) before any clamp matters in adversarial RPC scenarios.
- **Fix:** In `string()` (and ideally a shared `take(n)` helper used by `pubkey`/`hexBytes`/
  `string`), assert `this.offset + len <= this.buf.length` and throw a `RangeError`
  (matching `hexBytes`' existing `index.ts:682-684` pattern) *before* the `subarray`/
  `toString`. Cap `len` against `buf.length - offset` so a hostile prefix cannot drive a
  giant allocation. The throw is already correctly handled by the
  `catch (decodeErr)` at `index.ts:1406`.
- **ADR-needed?:** No — bug-fix within ADR-082 field-coverage invariant. Add a regression
  test in `decoder.test.ts` (truncated-`String`-field fixture) to lock it.

## C4-OFF-02 — No trailing-byte / full-consumption assertion after decode (offset-drift detector absent)

- **Severity:** MEDIUM
- **File:** `src/indexer/index.ts:1402-1405` (`decoder(new BorshReader(decoded.subarray(8)))`)
- **Scenario:** `BorshReader` exposes `done` (`index.ts:610-612`) but no decoder call site
  checks it. A wire-layout drift (program adds/reorders an event field, e.g. the original
  AUD-004 `cleared_count` regression) where the indexer under-reads produces a *successful*
  decode of wrong data with no error — the very class of bug ADR-082 field-coverage exists
  to catch is invisible at runtime. Combined with C4-OFF-01, an over-read that happens to
  land on plausible bytes is also silently accepted.
- **Fix:** After `decoder(...)` returns, assert the reader fully consumed the buffer
  (`reader.done`) for known events; on mismatch, treat as a decode failure (fall to the
  `rawData` + `decodeError` path at `index.ts:1409`) and increment a distinct prom label
  (e.g. `error_type: "decode_underrun"`) so wire drift pages operators instead of corrupting
  the projection.
- **ADR-needed?:** Light ADR or extend ADR-082 — this is a defensive runtime mirror of the
  static `scripts/check-event-coverage.ts` gate; worth recording the invariant.

## C4-OFF-03 — `gracefulShutdown` closes the DB without awaiting in-flight write-mutex work (ADR-118 partial-write / replay)

- **Severity:** HIGH
- **File:** `src/indexer/index.ts:3474-3543` (esp. `db.close()` at `index.ts:3530`)
- **Scenario:** ADR-118's stated invariant is "the cursor only ever advances on
  fully-persisted work" with SIGTERM checked *between* batches (`index.ts:2503-2513`
  comment). But `gracefulShutdown` only sets `isShuttingDown=true` and calls `abortAll()`;
  it then proceeds straight to `pgStore.close()` and `db.close()` inside the async IIFE
  **without awaiting any outstanding `withProgramWriteLock` promise**. A live-stream
  `handleLogs` commit (`index.ts:2633`) or a backfill per-tx commit (`index.ts:2529`)
  already executing inside the mutex is *not* drained. `persistEventsForTx` is itself a
  sequence of separate auto-commit statements (event INSERTs → `updateAgentFromEvent`
  → cursor UPSERT, `index.ts:2310-2389`) with **no enclosing `db.transaction()`**. If
  `db.close()` lands (or the 30 s force-exit fires, `index.ts:3494-3500`) after the event
  rows commit but before the cursor UPSERT (`index.ts:2363-2370`) or mid
  `updateAgentFromEvent`, the next boot replays from a stale cursor: at best duplicate
  work (mitigated by `INSERT OR IGNORE`), at worst the agents projection / tombstones
  (`index.ts:1907,1922,1943`) and the SQLite-vs-PG cursors diverge. `synchronous=FULL`
  (`index.ts:245`) guarantees *each statement* is durable but does **not** make the
  multi-statement sequence atomic.
- **Fix:** (a) Wrap the event-loop + `updateAgentFromEvent` + cursor UPSERT of
  `persistEventsForTx` in a single `better-sqlite3` `db.transaction(...)` so a crash/close
  is all-or-nothing per tx. (b) In `gracefulShutdown`, before `db.close()`, await all
  registered write mutexes draining (e.g. acquire each `writeMutexes` entry once, or track
  a shared in-flight promise set) so no synchronous commit sequence is in progress when the
  handle closes.
- **ADR-needed?:** Yes — amend ADR-118: the per-tx atomicity guarantee and the
  shutdown-drains-mutex ordering are load-bearing and currently only asserted in prose.

## C4-OFF-04 — Postgres connection has no TLS enforcement (ADR-128 plaintext shadow stream)

- **Severity:** MEDIUM
- **File:** `src/indexer/postgres-store.ts:825-884` (`createPostgresStore`, `poolConfig`)
- **Scenario:** `INDEXER_PG_URL` is validated only for protocol (`postgres:`/`postgresql:`,
  `postgres-store.ts:833`) and passed verbatim as `connectionString` with no `ssl` field in
  `poolConfig` (`postgres-store.ts:862-881`). If an operator's URL omits `?sslmode=require`,
  the entire ADR-128 shadow stream — full event payloads, authority pubkeys, CDP/EVM wallet
  bindings (`CdpWalletUpdated`, `index.ts:829-835`) — crosses the network in cleartext and
  is downgrade-able by an on-path attacker. No least-privilege guidance either: the same
  role runs DDL (`applyMigration`, `postgres-store.ts:476-480`) and DML.
- **Fix:** Default `poolConfig.ssl` to `{ rejectUnauthorized: true }` (or fail-closed unless
  `INDEXER_PG_INSECURE=1` is explicitly set); document a least-privilege role split (DDL via
  a migration role, runtime DML via a constrained role). Validate `sslmode` in the URL
  pre-flight alongside the existing protocol check.
- **ADR-needed?:** Yes — ADR-128 addendum: transport security + DB role least-privilege are
  unspecified.

## C4-OFF-05 — `applyMigration` runs multi-statement SQL outside a transaction (ADR-128 migration safety)

- **Severity:** LOW
- **File:** `src/indexer/postgres-store.ts:476-480`
- **Scenario:** Each `migration.sql` is sent via a single `pool.query` (`postgres-store.ts:478`)
  with no `BEGIN/COMMIT` wrapper. A multi-statement migration that fails partway (network
  blip, statement_timeout `postgres-store.ts:877`) leaves the schema half-applied. Re-runs
  are protected only by hand-authored `IF NOT EXISTS` idempotency (`postgres-store.ts:472`)
  and there is no `schema_migrations` ledger yet (acknowledged as Phase 2). Lower severity
  because PG is Phase-1 shadow-only and SQLite stays authoritative, but a partially-applied
  schema can make `runShadow` errors permanent and silent (`postgres-store.ts:787-796`).
- **Fix:** Wrap each migration in `withTransaction` (the primitive already exists,
  `postgres-store.ts:526`) so a failed migration rolls back atomically; bring the
  `schema_migrations` ledger forward rather than deferring entirely to Phase 2.
- **ADR-needed?:** No — fits within ADR-128 Phase 2 scope; flag as a hardening item.

---

## Positive confirmations (no finding)

- `parseLogsForEvents` numeric-reader OOB throws are caught and downgraded to classified
  `rawData` with `decodeError` (`index.ts:1406-1418`) — fail-safe, no crash on hostile logs.
- `SuspensionCleared` AUD-004 regression is fixed and correctly ordered
  (`index.ts:789-804`).
- Finality uses `COMMITMENT = "finalized"` as a narrowed literal (`index.ts:209-220`)
  with the heartbeat deliberately on cheaper `"confirmed"` — reorg/orphan exposure on the
  indexed path is correctly closed; no `"confirmed"`-sourced writes.
- PG DML is fully parameterized (`$1..$n`); the only identifier interpolation
  (`countRows`, `postgres-store.ts:757-769`) is gated by the `INDEXER_PG_TABLE_SET`
  allow-list — no SQL injection surface found.
- `pg.Pool` env parsing is fail-closed via `parsePositiveIntEnv` (OFF-204/215) and an
  idle-client `error` handler is wired (`postgres-store.ts:903`) — no NaN-timeout hang.
- ADR-128 OFF-200 transactional dual-write (`withTransaction`, `postgres-store.ts:526-540`)
  correctly binds BEGIN/COMMIT/ROLLBACK to one pooled client.

---

## Summary

**Severity counts:** CRITICAL 0 · HIGH 2 · MEDIUM 2 · LOW 1 (total 5)

**Top 3:**

1. **C4-OFF-01 (HIGH)** — `BorshReader.string()` has no bounds check; a hostile/corrupt
   on-chain log length prefix causes silent offset drift across all subsequent fields
   (AUD-004 class, now structurally generic) plus a multi-GiB allocation DoS vector.
   `index.ts:669-674`.
2. **C4-OFF-03 (HIGH)** — ADR-118 `gracefulShutdown` calls `db.close()` without draining
   in-flight write mutexes, and `persistEventsForTx` is not a single SQLite transaction:
   a SIGTERM mid-commit splits event-INSERT from cursor-UPSERT → replay-on-restart /
   projection divergence. `index.ts:3530`, `2310-2389`.
3. **C4-OFF-04 (MEDIUM)** — ADR-128 PG pool sets no `ssl`; the shadow stream (event bodies,
   authority + EVM wallet bindings) can traverse the network in plaintext, plus no DB
   least-privilege split. `postgres-store.ts:862-881`.

Recommend ADR amendments for ADR-118 (per-tx atomicity + shutdown drain ordering) and
ADR-128 (transport security + role least-privilege).
