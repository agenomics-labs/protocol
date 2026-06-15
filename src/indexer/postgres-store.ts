/**
 * ADR-128 Phase 1 — Postgres shadow store (dual-write target).
 *
 * Mirrors the SQLite write-path API surface defined inline in
 * `src/indexer/index.ts` so that Phase 2 (a separate future PR) can flip
 * reads from SQLite to Postgres without changing call sites. Phase 1
 * contract (do NOT loosen without an ADR amendment):
 *
 *   * SQLite remains authoritative. Postgres writes are best-effort
 *     shadow. Failures are logged at WARN and DO NOT propagate — they
 *     must never break the SQLite write path.
 *   * No reads from Postgres in Phase 1. The S-offchain-04 tombstone
 *     consultation, the cursor read, the events query — all stay against
 *     SQLite. Postgres parity is verified offline (manual or future
 *     parity-checker job).
 *   * When `INDEXER_PG_URL` is unset, a `DisabledPostgresStore` no-op is
 *     returned by `createPostgresStore()`. No `pg` client is constructed,
 *     no network is touched, and behavior matches today's SQLite-only
 *     path byte-for-byte.
 *   * When `INDEXER_PG_URL` is set but malformed, `createPostgresStore`
 *     throws at module-load time. Fail-closed mirrors ADR-126 / ADR-129's
 *     opt-in-with-strict-validation precedent.
 *
 * Idempotency primitive (ADR-128 §"Decision" 5): every event INSERT uses
 *   INSERT ... ON CONFLICT (program, signature, event_ordinal) DO NOTHING
 * which is the exact PostgreSQL equivalent of the SQLite
 * `INSERT OR IGNORE` against `idx_events_unique`. The history projection
 * tables (vault_identity_history, manifest_history,
 * protocol_config_history) use their own UNIQUE indexes for the same
 * `INSERT OR IGNORE` semantics — the SQL spelled below mirrors each
 * SQLite call site.
 */

import type { Pool, PoolClient, PoolConfig, QueryResultRow } from "pg";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pgModule: typeof import("pg") = require("pg");
import { logger } from "./logger.js";
import { MIGRATIONS } from "./migrations.embedded.js";

// ---------------------------------------------------------------------------
// OFF-204 (cycle-3 off-chain audit) — pg.Pool timeout defaults +
// process-survivable error handler.
//
// Pre-fix the `pg.Pool` was constructed with only `connectionString` +
// `max`. Two failure modes followed from that omission:
//
//   1. A Postgres brown-out (network partition, primary failover,
//      connection-cap exhaustion) made the next `pool.connect()` /
//      `pool.query()` hang indefinitely. The dual-write `runShadow`
//      wrapper logs and swallows on rejection — but it never received a
//      rejection, because there was no timeout. The shadow write call
//      sites in `index.ts` (which fire-and-forget) leaked promises;
//      worse, the transactional dual-write at OFF-200 stalled the
//      authoritative SQLite path while it awaited the PG transaction.
//
//   2. An idle pool client whose socket dies (TCP reset, server
//      restart) emits `error` on `pool.on('error', ...)`. With no
//      handler registered, Node's EventEmitter rule kicks in and the
//      indexer process crashes via unhandled error.
//
// Mirrors the OFF-206 fix for ioredis (`commandTimeout`, `connectTimeout`,
// `maxRetriesPerRequest`) on the PG side: each timeout has an env-
// overridable knob with a NaN / non-positive fallback to the default,
// and the pool-level `error` event is logged at WARN without rethrow.
// SQLite remains authoritative; PG outages must surface as logged
// errors, never as a hung process or a crash.
// ---------------------------------------------------------------------------

/**
 * Connection-acquire timeout. How long `pool.connect()` (or the
 * implicit acquire on `pool.query`) will wait for a free / new client
 * before rejecting. 5s is short enough that a brown-out surfaces as
 * an error within a single dual-write tick; long enough that a busy
 * pool under normal load doesn't false-alarm. ADR-128 Phase 1 leaves
 * pool sizing to the operator (`INDEXER_PG_POOL_MAX`, default 10),
 * so 5s also covers the worst-case "all 10 clients busy on a slow
 * query" without forcing operators to retune.
 */
export const INDEXER_PG_CONNECTION_TIMEOUT_DEFAULT_MS = 5_000;

/**
 * Idle-client TTL. Clients that sit idle in the pool for longer than
 * this are closed. 30s matches `pg`'s upstream default and lets a
 * cold pool recover quickly after a Postgres restart (stale sockets
 * get pruned without waiting for next-query failure).
 */
export const INDEXER_PG_IDLE_TIMEOUT_DEFAULT_MS = 30_000;

/**
 * Per-query timeout (driver-side). `query_timeout` aborts the client-
 * side wait; `statement_timeout` (set as a session GUC by `pg`) aborts
 * the server-side execution. Both are set so a query that hangs at
 * the network layer AND a query that hangs at the server layer both
 * surface within the bound. 15s is comfortably above the largest
 * single statement Phase 1 dual-write issues (a single-row INSERT
 * against an indexed table) and well below the OFF-206 ioredis
 * `commandTimeout` (2s) on the relay side — we expect PG writes to be
 * a small constant slower than Redis ops; 15s leaves plenty of
 * headroom for cold-cache plans and replica catch-up.
 */
export const INDEXER_PG_QUERY_TIMEOUT_DEFAULT_MS = 15_000;
export const INDEXER_PG_STATEMENT_TIMEOUT_DEFAULT_MS = 15_000;

/**
 * Parse a positive-integer env var with NaN / non-positive fallback to
 * `defaultValue`. Generalised from the OFF-204 `parsePositiveMsEnv`
 * helper (which only covered millisecond knobs) to also gate the
 * OFF-215 fix on `INDEXER_PG_POOL_MAX`. Mirrors the OFF-206 contract:
 * a typo'd env var must NOT silently fall back to "no limit" — that is
 * exactly the pre-fix failure mode for both timeouts (`pg.Pool` would
 * hang forever on `query_timeout=NaN`) and pool sizing (`pg.Pool` would
 * silently use its own internal default of 10 on `max=NaN`, which
 * happens to match here but is a footgun for any future tuning that
 * uses a non-default).
 *
 * The same parser is reused by OFF-204 (timeouts in milliseconds) and
 * OFF-215 (pool size as a count) so both call sites get identical
 * NaN / negative / zero / whitespace / fractional fallback semantics.
 */
export function parsePositiveIntEnv(
  raw: string | undefined,
  defaultValue: number,
): number {
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.floor(n);
}

/**
 * Backwards-compatible alias kept so the OFF-204 test fixture
 * (`off-204-pg-pool-hardening.test.ts`) and any out-of-tree callers
 * importing the old symbol keep compiling unchanged. The semantic is
 * identical — milliseconds are just positive integers — and the new
 * `parsePositiveIntEnv` name better describes the OFF-215 reuse.
 */
export const parsePositiveMsEnv = parsePositiveIntEnv;

/**
 * Default value for `INDEXER_PG_POOL_MAX`. Matches `pg.Pool`'s own
 * internal default and the value documented in ADR-128 §"New env vars",
 * but pinning it here makes the OFF-215 fallback observable at the
 * call site rather than silently delegated to the driver.
 */
export const INDEXER_PG_POOL_MAX_DEFAULT = 10;

// ---------------------------------------------------------------------------
// C4-OFF-04 (cycle-4 security re-audit) — transport security for the
// ADR-128 shadow stream.
//
// Pre-fix `poolConfig` set no `ssl` field, so `pg.Pool` connected with
// whatever the connection string implied — and a URL that omits
// `?sslmode=require` connects in PLAINTEXT. Event bodies (instruction
// data, pubkeys, the dual-write shadow stream) crossed the wire in the
// clear and were downgrade-able by an on-path attacker; an injected
// `sslmode=disable` in the URL was silently honoured.
//
// Fix: fail-closed. Outside an explicit dev/insecure escape hatch the
// pool REQUIRES TLS with certificate verification
// (`{ rejectUnauthorized: true }`), and a URL whose `sslmode` asks for
// plaintext (`disable`/`allow`/`prefer`) is rejected at boot rather
// than silently honoured. Localhost loopback is exempt (a local socket
// is not on-path); `INDEXER_PG_INSECURE=1` is the documented, loud
// opt-out for non-prod environments that genuinely have no TLS.
//
// Least-privilege role split is operator config, not code: the indexer
// runtime path only ever issues DML (INSERT/SELECT/UPDATE) — DDL is
// confined to the explicit `applyMigration()` boot step. Operators
// SHOULD provision two roles: a migration role with DDL for the one-
// shot migration and a constrained runtime role with DML-only grants
// for `INDEXER_PG_URL`. See ADR-128 addendum.
const PLAINTEXT_SSLMODES = new Set(["disable", "allow", "prefer"]);

/**
 * Loopback hosts where a plaintext PG socket is not on-path and TLS
 * enforcement would only obstruct local development.
 */
const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

/**
 * C4-OFF-04 — derive the `pg.Pool` `ssl` option fail-closed.
 *
 * Exported for unit testing: the live `pg.Pool` defers connection
 * until first query, so the only observable contract at construction
 * time is the resolved `PoolConfig`.
 *
 * @throws if a non-loopback URL requests a plaintext `sslmode` and the
 *   `INDEXER_PG_INSECURE=1` escape hatch is NOT set.
 */
export function resolvePoolSsl(
  parsedUrl: URL,
  env: NodeJS.ProcessEnv,
): PoolConfig["ssl"] {
  const insecure = env.INDEXER_PG_INSECURE === "1";
  const host = parsedUrl.hostname.toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(host);
  const sslmode = (parsedUrl.searchParams.get("sslmode") || "").toLowerCase();

  // Explicit, loud opt-out — or a loopback socket that isn't on-path.
  if (insecure || isLoopback) {
    return undefined;
  }

  // Fail-closed: a remote URL that asks for plaintext is an operator
  // config error, not a runtime fault. Surface it at boot.
  if (sslmode !== "" && PLAINTEXT_SSLMODES.has(sslmode)) {
    throw new Error(
      `INDEXER_PG_URL requests sslmode=${sslmode} for a non-loopback host ` +
        `(${host}); plaintext Postgres is refused fail-closed. Use a TLS ` +
        `connection (sslmode=require/verify-full) or set INDEXER_PG_INSECURE=1 ` +
        `to explicitly opt out in a non-production environment.`,
    );
  }

  // Default: require TLS with full certificate verification.
  return { rejectUnauthorized: true };
}

// ---------------------------------------------------------------------------
// OFF-214 (cycle-3 off-chain audit) — single source of truth for the
// Phase 1 table set.
//
// Pre-fix the table allow-list inside `countRows` was a duplicate of
// the `CREATE TABLE` set declared in `migrations.embedded.ts` (and
// `migrations/001-initial-postgres.sql`). A future migration that
// adds a table would have had to update `countRows` in lockstep —
// easy to forget, and the failure mode is "the new table is silently
// uncountable from the parity-check path", which is exactly the kind
// of drift the punchlist gate was supposed to prevent.
//
// Fix: export the canonical table set from one place. `countRows`
// references it via `INDEXER_PG_TABLE_SET` (a `Set` for O(1)
// membership rejection of injection attempts in the `table` argument);
// a future migration that adds a table updates ONE constant and the
// allow-list follows automatically. The aud-202 byte-for-byte parity
// test on `migrations.embedded.ts` ensures the migration SQL itself
// can't drift from the .sql source, and the OFF-214 regression test
// asserts every name in `INDEXER_PG_TABLES` actually appears as a
// `CREATE TABLE` in the embedded migration SQL — closing the cross-
// file drift dimension.
//
// Order matches the migration's `CREATE TABLE` order so a future
// `applyMigration`-style runner that wants to truncate / drop in
// reverse-dependency order can iterate the array directly.
// ---------------------------------------------------------------------------

export const INDEXER_PG_TABLES: readonly string[] = [
  "events",
  "agents",
  "cursor",
  "agent_tombstones",
  "vault_identity_history",
  "manifest_history",
  "protocol_config_history",
  // ADR-138 — execution provenance attestations. See migration 003.
  "execution_attestations",
] as const;

const INDEXER_PG_TABLE_SET: ReadonlySet<string> = new Set(INDEXER_PG_TABLES);

// ---------------------------------------------------------------------------
// Shared SQL — kept as module-level constants so the transactional
// (`*InTx`) and pool-level methods cannot drift from each other. Both
// must reference the same idempotency UNIQUE index columns because the
// dual-write `ON CONFLICT` invariant depends on it (ADR-128 §"Decision"
// item 5; see also OFF-200 transactional wrapper).
// ---------------------------------------------------------------------------

const INSERT_EVENT_SQL = `INSERT INTO events (program, event_name, data, signature, slot, event_ordinal)
 VALUES ($1, $2, $3, $4, $5, $6)
 ON CONFLICT (program, signature, event_ordinal) DO NOTHING`;

const UPSERT_CURSOR_SQL = `INSERT INTO cursor (program, last_processed_slot, last_signature, updated_at)
 VALUES ($1, $2, $3, now())
 ON CONFLICT (program) DO UPDATE SET
   last_processed_slot = excluded.last_processed_slot,
   last_signature      = excluded.last_signature,
   updated_at          = now()`;

// ---------------------------------------------------------------------------
// Public types — mirror the shapes already passed around in index.ts so a
// dual-write call site does not need to re-marshal.
// ---------------------------------------------------------------------------

/**
 * Single event row to dual-write into the Postgres `events` table. Field
 * names and types track the SQLite INSERT in `persistEventsForTx`
 * verbatim. `eventOrdinal` is the per-tx ordinal (0-based) used for the
 * idempotency UNIQUE index.
 */
export interface EventRecord {
  program: string;
  eventName: string;
  /** Already JSON-stringified payload (matches SQLite write-site). */
  data: string;
  signature: string;
  slot: number;
  eventOrdinal: number;
}

export interface CursorRecord {
  program: string;
  slot: number;
  signature: string;
}

export interface AgentTombstoneRecord {
  authority: string;
  deregisteredAtSlot: number;
}

export interface VaultIdentityHistoryRecord {
  vault: string;
  oldIdentity: string;
  newIdentity: string;
  slot: number;
  signature: string;
}

export interface ManifestHistoryRecord {
  authority: string;
  manifestCid: string;
  manifestHash: string;
  manifestVersion: number;
  /** i64 event timestamp; bigint when out of safe range. */
  eventTimestamp: number | bigint;
  slot: number;
  signature: string;
}

export interface ProtocolConfigHistoryRecord {
  kind: "Initialized" | "Updated";
  authority: string;
  /** u64-as-decimal-string per `coerceU64String` semantics. */
  minEscrowAmount: string;
  disputeTimeoutSeconds: number | bigint;
  reputationDeltaTaskCompleted: number | bigint;
  reputationDeltaDisputeLoss: number | bigint;
  reputationDeltaExpiryUndelivered: number | bigint;
  slot: number;
  signature: string;
}

/**
 * ADR-138 — `ExecutionAttested` event projection. One row per
 * value-moving or authority-changing vault instruction. Mirrors the
 * SQLite schema in `index.ts::initDb` and the migration in
 * `003-adr-138-execution-attestations.sql`.
 *
 * Field shapes:
 *   * `toolId` / `manifestHash` — 64-char hex strings (32-byte payload
 *     hex-encoded). The zero-hash sentinel is a string of 64 ASCII '0'
 *     bytes, NOT an empty string.
 *   * `amount`                  — u64-as-decimal-string per
 *     `coerceU64String` semantics. '0' for non-value actions.
 *   * `delegationGrant` / `mint` / `recipient` — base58 strings or null.
 *   * `slot` / `eventTimestamp` — bigints permitted for out-of-safe-
 *     range round-trip.
 *   * `instructionIndex`        — per-tx event ordinal (0-based). Used
 *     with `txSignature` for idempotency.
 */
export interface ExecutionAttestationRecord {
  txSignature: string;
  instructionIndex: number;
  vault: string;
  agentIdentity: string;
  authority: string;
  actionKind:
    | "Transfer"
    | "TokenTransfer"
    | "PolicyUpdate"
    | "AllowlistManage"
    | "IdentityRotation"
    | "PauseToggle"
    | "GrantTransfer"
    | "GrantTokenTransfer";
  toolId: string;
  manifestHash: string;
  policyVersion: number;
  delegationGrant: string | null;
  amount: string;
  mint: string | null;
  recipient: string | null;
  slot: number;
  eventTimestamp: number | bigint;
}

/**
 * Phase 1 write-path API surface. Every method mirrors a SQLite write
 * site in `src/indexer/index.ts`. All methods are async; SQLite remains
 * the sync authoritative store. All methods MUST swallow their own
 * errors and surface them as logged WARNs — the dual-write site in
 * `index.ts` calls these without `await` rejection-handling so a
 * Postgres outage cannot poison the SQLite path.
 */
export interface PostgresStore {
  /** True iff the underlying client is live (used by `/health`). */
  readonly enabled: boolean;
  /**
   * The underlying pg.Pool when the store is live; `undefined` otherwise.
   *
   * ADR-131 (added 2026-04-30): the metrics-server's trigger endpoints
   * (`/api/metrics/sybil-patterns`, `/api/metrics/escrow-median`) read
   * from Postgres-side views shipped in migration 002. Exposing the
   * pool here avoids constructing a second pool just for the metrics
   * surface, and keeps the connection-management contract (max
   * connections, error handling, single-writer advisory lock) in one
   * place. Keep this an OPTIONAL accessor — the disabled store does
   * not own a pool and the metrics endpoints gracefully render a
   * "metric unavailable" state when the pool is undefined.
   */
  readonly pool?: Pool;
  /** Apply the schema migration. Idempotent (CREATE ... IF NOT EXISTS). */
  applyMigration(): Promise<void>;
  insertEvent(rec: EventRecord): Promise<void>;
  upsertCursor(rec: CursorRecord): Promise<void>;
  upsertAgentTombstone(rec: AgentTombstoneRecord): Promise<void>;
  insertVaultIdentityHistory(rec: VaultIdentityHistoryRecord): Promise<void>;
  insertManifestHistory(rec: ManifestHistoryRecord): Promise<void>;
  insertProtocolConfigHistory(rec: ProtocolConfigHistoryRecord): Promise<void>;
  /** ADR-138 — append an execution-provenance attestation row. */
  insertExecutionAttestation(rec: ExecutionAttestationRecord): Promise<void>;
  /** Best-effort agent projection mirror. See dual-write notes in index.ts. */
  upsertAgent(authority: string, name: string | null, category: string | null): Promise<void>;
  updateAgentName(authority: string, name: string | null): Promise<void>;
  updateAgentReputation(authority: string, score: number, taskCompletedDelta: number): Promise<void>;
  setAgentReputation(authority: string, score: number): Promise<void>;
  deleteAgent(authority: string): Promise<void>;
  /** Test/operator hook: read row counts for the parity check. */
  countRows(table: string): Promise<number>;
  /** Graceful shutdown. */
  close(): Promise<void>;

  // -------------------------------------------------------------------------
  // OFF-200 transactional dual-write surface (ADR-128 follow-up)
  //
  // Phase 1 originally fired each PG write as an independent
  // `pool.query(...)` so the cursor-advance and the corresponding event
  // INSERT could land in any order — including the failure mode where
  // the cursor advances past an event PG never received. To close that
  // gap, the dual-write call sites in `index.ts` now wrap their
  // cursor+event pair in a single PG transaction via `withTransaction`,
  // and the `*InTx` variants run on the supplied client so BEGIN/COMMIT
  // bind to the same connection. The non-`InTx` methods remain unchanged
  // for the call sites (history projections, agent projections) that
  // only need a single write — they keep their `runShadow` swallow-and-
  // log behaviour.
  // -------------------------------------------------------------------------
  /**
   * Run `fn` inside a single PG client transaction (BEGIN/COMMIT/
   * ROLLBACK). On any throw inside `fn` the transaction is rolled back
   * and the error is rethrown to the caller. The caller in `index.ts`
   * wraps this in a `.catch(...)` so a PG outage logs WARN and the
   * SQLite-authoritative path is unaffected — but inside the tx, the
   * event INSERT and cursor UPSERT either both commit or both roll back.
   *
   * Disabled stores resolve `fn` with no client and never raise — the
   * call site's `if (pgStore.enabled)` guard skips the call in that
   * branch, so the disabled implementation is defensive only.
   */
  withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Same SQL as `insertEvent`, but executed on the supplied client. */
  insertEventInTx(client: PoolClient, rec: EventRecord): Promise<void>;
  /** Same SQL as `upsertCursor`, but executed on the supplied client. */
  upsertCursorInTx(client: PoolClient, rec: CursorRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// Disabled (no-op) implementation — selected when `INDEXER_PG_URL` unset.
// Mirrors the kill-switch precedent from ADR-129 §"New env vars"
// (AEP_EVO_ENABLED=false → bridge never spawned, calls return
// {skipped: true}). Same shape: zero side effects, zero allocations
// beyond the singleton itself, no network.
// ---------------------------------------------------------------------------

export class DisabledPostgresStore implements PostgresStore {
  readonly enabled = false;
  async applyMigration(): Promise<void> {}
  async insertEvent(_rec: EventRecord): Promise<void> {}
  async upsertCursor(_rec: CursorRecord): Promise<void> {}
  async upsertAgentTombstone(_rec: AgentTombstoneRecord): Promise<void> {}
  async insertVaultIdentityHistory(_rec: VaultIdentityHistoryRecord): Promise<void> {}
  async insertManifestHistory(_rec: ManifestHistoryRecord): Promise<void> {}
  async insertProtocolConfigHistory(_rec: ProtocolConfigHistoryRecord): Promise<void> {}
  async insertExecutionAttestation(_rec: ExecutionAttestationRecord): Promise<void> {}
  async upsertAgent(_authority: string, _name: string | null, _category: string | null): Promise<void> {}
  async updateAgentName(_authority: string, _name: string | null): Promise<void> {}
  async updateAgentReputation(_authority: string, _score: number, _taskCompletedDelta: number): Promise<void> {}
  async setAgentReputation(_authority: string, _score: number): Promise<void> {}
  async deleteAgent(_authority: string): Promise<void> {}
  async countRows(_table: string): Promise<number> {
    return 0;
  }
  async close(): Promise<void> {}
  // OFF-200: defensive no-ops. Call sites in `index.ts` guard with
  // `if (pgStore.enabled)` so the disabled path never reaches these — the
  // implementations exist only to satisfy the interface and to keep the
  // disabled store a strict zero-side-effect double of the live one.
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return fn(undefined as unknown as PoolClient);
  }
  async insertEventInTx(_client: PoolClient, _rec: EventRecord): Promise<void> {}
  async upsertCursorInTx(_client: PoolClient, _rec: CursorRecord): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Live implementation backed by `pg.Pool`.
// ---------------------------------------------------------------------------

/**
 * pg.Pool-backed shadow store. All write methods catch and log; the
 * caller in `index.ts` therefore never has to defend against Postgres
 * exceptions. `PoolClient` lifecycle is `pg.Pool`'s standard
 * acquire/release per-query — operators tune `INDEXER_PG_POOL_MAX`
 * (default 10 per ADR-128 §"Surface impact / New env vars") to size
 * the pool.
 */
export class LivePostgresStore implements PostgresStore {
  readonly enabled = true;
  // ADR-131: was `private`; now public-readonly so the metrics-server can
  // query the trigger views without owning a separate pool. See
  // PostgresStore.pool jsdoc above.
  readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Apply the embedded migration SQL. Idempotent — operators may call
   * this repeatedly during bring-up without harm. Test code can also
   * call this before each fixture without dropping the DB.
   *
   * OFF-202 (ADR-128 cycle-3 off-chain audit): the migration SQL is
   * inlined via `migrations.embedded.ts` rather than read from disk.
   * The previous `__dirname` + `fs.readFileSync` approach ENOENT'd at
   * production boot because `tsc` resolved `__dirname` under `dist/`
   * but the .sql files ship at `src/indexer/migrations/*.sql` and were
   * not copied into the build output. Embedding the SQL string in
   * TypeScript turns it into a build artifact of the source itself —
   * no runtime filesystem dependency, no copy step, no drift surface.
   *
   * Each migration is applied in `MIGRATIONS` order. The SQL itself is
   * authored idempotent (CREATE TABLE/INDEX IF NOT EXISTS) so re-runs
   * are safe; a Phase 2 PR may add a `schema_migrations` tracking row
   * and skip-if-applied without changing this method's contract.
   */
  async applyMigration(): Promise<void> {
    for (const migration of MIGRATIONS) {
      await this.pool.query(migration.sql);
    }
  }

  /**
   * Idempotency primitive — exact PG mirror of the SQLite
   * `INSERT OR IGNORE INTO events ...` at `index.ts:933`. The
   * `idx_events_unique` UNIQUE index on (program, signature,
   * event_ordinal) is created by the migration; this `ON CONFLICT`
   * clause references those columns directly.
   */
  async insertEvent(rec: EventRecord): Promise<void> {
    await this.runShadow("insertEvent", async () => {
      await this.pool.query(INSERT_EVENT_SQL, [
        rec.program,
        rec.eventName,
        rec.data,
        rec.signature,
        rec.slot,
        rec.eventOrdinal,
      ]);
    });
  }

  /**
   * Cursor upsert — mirrors `upsertCursor` at `index.ts:899`. The
   * `program` PK already provides the conflict target; semantics are
   * identical to SQLite.
   */
  async upsertCursor(rec: CursorRecord): Promise<void> {
    await this.runShadow("upsertCursor", async () => {
      await this.pool.query(UPSERT_CURSOR_SQL, [rec.program, rec.slot, rec.signature]);
    });
  }

  /**
   * OFF-200 — run `fn` inside a single pg client transaction. The
   * client is acquired from the pool (NOT taken via `pool.query`) so
   * BEGIN/COMMIT/ROLLBACK bind to the same connection. On any throw
   * inside `fn` the transaction is rolled back and the original error
   * is rethrown so the caller's `.catch` can decide policy. The
   * client is always released back to the pool, even on rollback.
   *
   * This is the load-bearing primitive for the transactional dual-
   * write: the call site in `index.ts` issues the event INSERT and the
   * cursor UPSERT inside one `withTransaction(...)`, which guarantees
   * the PG cursor cannot advance past an event that PG never received.
   */
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      // Best-effort rollback; if rollback itself raises (eg. broken
      // socket) we still want to surface the original error to the
      // caller, so the rollback failure is logged but not chained.
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        logger.warn(
          { err: String(rollbackErr), op: "withTransaction.rollback", adr: "ADR-128", phase: 1 },
          "postgres ROLLBACK failed after tx body threw",
        );
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Same SQL as `insertEvent`, but executed on the caller-supplied
   * client so it participates in the active transaction. NOT wrapped
   * in `runShadow` — errors here MUST propagate so `withTransaction`
   * can roll back. The caller's outer `.catch` (in `index.ts`)
   * preserves the fail-closed-shadow semantic at the tx boundary.
   */
  async insertEventInTx(client: PoolClient, rec: EventRecord): Promise<void> {
    await client.query(INSERT_EVENT_SQL, [
      rec.program,
      rec.eventName,
      rec.data,
      rec.signature,
      rec.slot,
      rec.eventOrdinal,
    ]);
  }

  /**
   * Same SQL as `upsertCursor`, but executed on the caller-supplied
   * client so it participates in the active transaction. See
   * `insertEventInTx` for the rationale on error propagation.
   */
  async upsertCursorInTx(client: PoolClient, rec: CursorRecord): Promise<void> {
    await client.query(UPSERT_CURSOR_SQL, [rec.program, rec.slot, rec.signature]);
  }

  /**
   * Tombstone upsert — mirrors the AgentDeregistered handler at
   * `index.ts:765`. `MAX(...)` ensures a later-arriving tombstone always
   * wins; an older backfill tombstone cannot overwrite a newer one.
   */
  async upsertAgentTombstone(rec: AgentTombstoneRecord): Promise<void> {
    await this.runShadow("upsertAgentTombstone", async () => {
      await this.pool.query(
        `INSERT INTO agent_tombstones (authority, deregistered_at_slot, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (authority) DO UPDATE SET
           deregistered_at_slot = GREATEST(agent_tombstones.deregistered_at_slot,
                                            excluded.deregistered_at_slot),
           updated_at           = now()`,
        [rec.authority, rec.deregisteredAtSlot],
      );
    });
  }

  async insertVaultIdentityHistory(rec: VaultIdentityHistoryRecord): Promise<void> {
    await this.runShadow("insertVaultIdentityHistory", async () => {
      await this.pool.query(
        `INSERT INTO vault_identity_history
           (vault, old_identity, new_identity, slot, signature, observed_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (vault, signature, slot) DO NOTHING`,
        [rec.vault, rec.oldIdentity, rec.newIdentity, rec.slot, rec.signature],
      );
    });
  }

  async insertManifestHistory(rec: ManifestHistoryRecord): Promise<void> {
    await this.runShadow("insertManifestHistory", async () => {
      await this.pool.query(
        `INSERT INTO manifest_history
           (authority, manifest_cid, manifest_hash, manifest_version,
            event_timestamp, slot, signature, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (authority, signature, slot) DO NOTHING`,
        [
          rec.authority,
          rec.manifestCid,
          rec.manifestHash,
          rec.manifestVersion,
          coerceBigIntParam(rec.eventTimestamp),
          rec.slot,
          rec.signature,
        ],
      );
    });
  }

  async insertProtocolConfigHistory(rec: ProtocolConfigHistoryRecord): Promise<void> {
    await this.runShadow("insertProtocolConfigHistory", async () => {
      await this.pool.query(
        `INSERT INTO protocol_config_history
           (kind, authority, min_escrow_amount, dispute_timeout_seconds,
            reputation_delta_task_completed, reputation_delta_dispute_loss,
            reputation_delta_expiry_undelivered, slot, signature, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (signature, slot, kind) DO NOTHING`,
        [
          rec.kind,
          rec.authority,
          rec.minEscrowAmount,
          coerceBigIntParam(rec.disputeTimeoutSeconds),
          coerceBigIntParam(rec.reputationDeltaTaskCompleted),
          coerceBigIntParam(rec.reputationDeltaDisputeLoss),
          coerceBigIntParam(rec.reputationDeltaExpiryUndelivered),
          rec.slot,
          rec.signature,
        ],
      );
    });
  }

  /**
   * ADR-138 — `ExecutionAttested` projection. Idempotent on
   * `(tx_signature, instruction_index)`; a backfill replay or websocket
   * reconnect that re-delivers the same event is a no-op.
   */
  async insertExecutionAttestation(rec: ExecutionAttestationRecord): Promise<void> {
    await this.runShadow("insertExecutionAttestation", async () => {
      await this.pool.query(
        `INSERT INTO execution_attestations
           (tx_signature, instruction_index, vault, agent_identity, authority,
            action_kind, tool_id, manifest_hash, policy_version,
            delegation_grant, amount, mint, recipient,
            slot, event_timestamp, ingested_at, decoded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, now(), now())
         ON CONFLICT (tx_signature, instruction_index) DO NOTHING`,
        [
          rec.txSignature,
          rec.instructionIndex,
          rec.vault,
          rec.agentIdentity,
          rec.authority,
          rec.actionKind,
          rec.toolId,
          rec.manifestHash,
          rec.policyVersion,
          rec.delegationGrant,
          rec.amount,
          rec.mint,
          rec.recipient,
          rec.slot,
          coerceBigIntParam(rec.eventTimestamp),
        ],
      );
    });
  }

  /**
   * Mirrors the AgentRegistered branch at `index.ts:683`. SQLite
   * `INSERT ... ON CONFLICT(authority) DO UPDATE SET ...` is already
   * PG-native syntax.
   */
  async upsertAgent(
    authority: string,
    name: string | null,
    category: string | null,
  ): Promise<void> {
    await this.runShadow("upsertAgent", async () => {
      await this.pool.query(
        `INSERT INTO agents (authority, name, category, last_updated)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (authority) DO UPDATE SET
           name         = excluded.name,
           category     = excluded.category,
           last_updated = now()`,
        [authority, name, category],
      );
    });
  }

  async updateAgentName(authority: string, name: string | null): Promise<void> {
    await this.runShadow("updateAgentName", async () => {
      await this.pool.query(
        `UPDATE agents SET name = COALESCE($1, name), last_updated = now()
         WHERE authority = $2`,
        [name, authority],
      );
    });
  }

  async updateAgentReputation(
    authority: string,
    score: number,
    taskCompletedDelta: number,
  ): Promise<void> {
    await this.runShadow("updateAgentReputation", async () => {
      await this.pool.query(
        `UPDATE agents SET
           reputation_score = $1,
           tasks_completed  = tasks_completed + $2,
           last_updated     = now()
         WHERE authority = $3`,
        [score, taskCompletedDelta, authority],
      );
    });
  }

  async setAgentReputation(authority: string, score: number): Promise<void> {
    await this.runShadow("setAgentReputation", async () => {
      await this.pool.query(
        `UPDATE agents SET reputation_score = $1, last_updated = now()
         WHERE authority = $2`,
        [score, authority],
      );
    });
  }

  async deleteAgent(authority: string): Promise<void> {
    await this.runShadow("deleteAgent", async () => {
      await this.pool.query(`DELETE FROM agents WHERE authority = $1`, [authority]);
    });
  }

  async countRows(table: string): Promise<number> {
    // OFF-214: the allow-list is now derived from the single
    // `INDEXER_PG_TABLES` source-of-truth declared above, not a
    // hand-maintained literal. `table` interpolates into SQL identifier
    // position which `pg` cannot parameterize, so the membership check
    // is still the only line of defence against injection — but it can
    // no longer drift from the migration's `CREATE TABLE` set.
    if (!INDEXER_PG_TABLE_SET.has(table)) {
      throw new Error(`countRows: refusing unknown table '${table}'`);
    }
    const res = await this.pool.query<QueryResultRow>(
      `SELECT COUNT(*)::bigint AS count FROM ${table}`,
    );
    const raw = res.rows[0]?.count;
    // pg returns BIGINT as string by default — convert here so callers
    // get a plain number (counts are bounded by table size; safe range).
    return typeof raw === "string" ? Number(raw) : Number(raw ?? 0);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Wrap a shadow write so any error is logged at WARN and swallowed.
   * Phase 1 invariant: Postgres never breaks SQLite. The dual-write call
   * site in `index.ts` is deliberately fire-and-forget; this wrapper is
   * the second line of defence (the first being the call site's own
   * `.catch` if it chooses to await).
   */
  private async runShadow(op: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      logger.warn(
        { err: String(err), op, adr: "ADR-128", phase: 1 },
        "postgres shadow write failed (sqlite remains authoritative)",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Factory + env-var validation.
// ---------------------------------------------------------------------------

/**
 * Construct the Phase 1 shadow store. Env-var contract:
 *
 *   - `INDEXER_PG_URL` UNSET  → returns `DisabledPostgresStore`. No `pg`
 *     client is constructed; behaviour matches today's SQLite-only
 *     path. This is the operator-opt-in default.
 *
 *   - `INDEXER_PG_URL` SET, well-formed → returns `LivePostgresStore`
 *     backed by `pg.Pool` with `max = INDEXER_PG_POOL_MAX || 10`. The
 *     migration is NOT auto-applied; callers (test fixtures, the
 *     indexer's `main()` boot path) invoke `applyMigration()`
 *     explicitly so the boot sequence is observable in logs.
 *
 *   - `INDEXER_PG_URL` SET, malformed → THROWS at module-load. Fail-
 *     closed: a typo'd connection string must surface as an obvious
 *     boot failure, not a silent dual-write skip.
 *
 * The URL is parsed with the WHATWG URL parser. `pg.Pool({connectionString})`
 * does its own parsing too; we pre-validate so the throw happens before
 * the Pool is constructed (Pool defers connection-string parsing until
 * the first query, which would mask the error inside `runShadow`).
 */
export function createPostgresStore(env: NodeJS.ProcessEnv = process.env): PostgresStore {
  const url = env.INDEXER_PG_URL;
  if (!url || url.trim() === "") {
    return new DisabledPostgresStore();
  }
  // Fail-closed validation (URL parse).
  let parsedUrl: URL;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error(
        `INDEXER_PG_URL protocol must be postgres:// or postgresql:// (got ${parsed.protocol})`,
      );
    }
    parsedUrl = parsed;
  } catch (err) {
    // Re-throw with clearer attribution; a malformed URL at boot is an
    // operator config error, not a runtime fault.
    throw new Error(
      `INDEXER_PG_URL is set but malformed: ${(err as Error).message}`,
      { cause: err },
    );
  }
  // OFF-215: pre-fix `parseInt(env.INDEXER_PG_POOL_MAX || "10", 10)`
  // returned NaN for any non-numeric env value (`"abc"`, `"10x"`,
  // a stray newline). `pg.Pool({ max: NaN })` then silently fell back
  // to its driver-internal default of 10, hiding operator config errors.
  // Reusing `parsePositiveIntEnv` (the OFF-204 helper, generalised
  // here from milliseconds to plain positive ints) means a typo'd pool
  // size lands deterministically on `INDEXER_PG_POOL_MAX_DEFAULT`
  // instead — same observable behaviour as the driver default but with
  // a fallback that is documented and testable from this module.
  const poolMax = parsePositiveIntEnv(
    env.INDEXER_PG_POOL_MAX,
    INDEXER_PG_POOL_MAX_DEFAULT,
  );
  // OFF-204: every timeout below is env-overridable with NaN / non-
  // positive fallback to the documented default. The pool also wires
  // a process-survivable `error` handler so an idle-client socket
  // failure logs and is contained instead of crashing the indexer.
  // C4-OFF-04: fail-closed TLS. Throws here (outside the malformed-URL
  // catch above, so the message is not masked) if a remote URL asks
  // for plaintext without the explicit INDEXER_PG_INSECURE=1 opt-out.
  const ssl = resolvePoolSsl(parsedUrl, env);
  const poolConfig: PoolConfig = {
    connectionString: url,
    max: poolMax,
    ...(ssl !== undefined ? { ssl } : {}),
    connectionTimeoutMillis: parsePositiveIntEnv(
      env.INDEXER_PG_CONNECTION_TIMEOUT_MS,
      INDEXER_PG_CONNECTION_TIMEOUT_DEFAULT_MS,
    ),
    idleTimeoutMillis: parsePositiveIntEnv(
      env.INDEXER_PG_IDLE_TIMEOUT_MS,
      INDEXER_PG_IDLE_TIMEOUT_DEFAULT_MS,
    ),
    query_timeout: parsePositiveIntEnv(
      env.INDEXER_PG_QUERY_TIMEOUT_MS,
      INDEXER_PG_QUERY_TIMEOUT_DEFAULT_MS,
    ),
    statement_timeout: parsePositiveIntEnv(
      env.INDEXER_PG_STATEMENT_TIMEOUT_MS,
      INDEXER_PG_STATEMENT_TIMEOUT_DEFAULT_MS,
    ),
  };
  const pool = new pgModule.Pool(poolConfig);
  attachPoolErrorHandler(pool);
  return new LivePostgresStore(pool);
}

/**
 * OFF-204 — register a process-survivable `error` handler on the pool.
 * `pg.Pool` re-emits errors from idle clients (e.g. a server-side
 * disconnect, an OS TCP reset) on the pool itself; without a listener,
 * Node's EventEmitter rule turns the next emission into an uncaught
 * exception that crashes the indexer. The handler logs at WARN
 * (matching the dual-write `runShadow` policy: "PG never breaks
 * SQLite") and lets the pool reclaim the dead client itself — `pg`'s
 * internal acquire path will already mark the client invalid before
 * emitting the event, so the next caller transparently gets a fresh
 * connection.
 *
 * Exported for `createPostgresStoreFromPool` so test fixtures get the
 * same containment as the production path. Idempotent — re-registering
 * is safe but the test fixture wires it once at construction.
 */
export function attachPoolErrorHandler(pool: Pool): void {
  // Defensive: in-process mock pools used by the OFF-200 unit tests
  // implement only the surface they exercise (`connect`, `query`, `end`)
  // and intentionally omit the EventEmitter API. A missing `.on` here
  // means the pool has no idle-client error stream to subscribe to —
  // which is the correct semantic for an in-memory mock — so we skip
  // wiring rather than throw. Production `pg.Pool` always extends
  // EventEmitter so the production path always wires the listener.
  const emitter = pool as unknown as {
    on?: (event: string, listener: (err: Error) => void) => unknown;
  };
  if (typeof emitter.on !== "function") {
    return;
  }
  emitter.on("error", (err: Error) => {
    logger.warn(
      { err: String(err), op: "pool.error", adr: "ADR-128", phase: 1 },
      "postgres pool emitted error from idle client (sqlite remains authoritative)",
    );
  });
}

/**
 * Test-only constructor — accepts a pre-built `pg.Pool` (typically the
 * `pg-mem`-provided in-memory adapter) so the test suite can exercise
 * the live code path without a real Postgres. The production code path
 * (`createPostgresStore`) does NOT call this; it is exported strictly
 * for fixture wiring.
 *
 * OFF-204: the same `error`-handler that `createPostgresStore` registers
 * is wired here too, so a fixture's pool cannot crash the test process
 * via an unhandled idle-client error. (pg-mem's pool does not emit
 * `error` in normal operation, but the wiring is symmetric so the
 * production and test code paths behave identically under fault.)
 */
export function createPostgresStoreFromPool(pool: Pool): PostgresStore {
  attachPoolErrorHandler(pool);
  return new LivePostgresStore(pool);
}

// ---------------------------------------------------------------------------
// OFF-212 (cycle-3 off-chain audit) — single-writer guarantee via PG
// session-scoped advisory lock.
//
// Pre-fix the indexer assumed a single writer per `INDEXER_PG_URL` but
// nothing enforced it. Two concurrently-running indexer processes
// (operator misconfiguration: a stale systemd unit not torn down, a
// pod that lost its Kubernetes lease but kept running, a developer
// running `npm start` against a prod URL by mistake) would both
// compete on the same SQLite cursor advance + the same PG dual-write
// rows. Idempotency on the events `(program, signature, event_ordinal)`
// UNIQUE index saves correctness, but the cursor and the projection
// rows can race in pathological ways — and an operator has no signal
// that two processes are stepping on each other.
//
// Fix: at boot, the indexer takes a Postgres session-scoped advisory
// lock via `pg_try_advisory_lock(<key>)`. Only one process can hold
// the lock at a time; subsequent boots fail-fast with a clear log.
// The lock is session-scoped (NOT transaction-scoped) so it lasts as
// long as the holding client holds the connection — which is the
// indexer's process lifetime. When the indexer process exits (graceful
// SIGINT, SIGTERM, OOM-kill, segfault, host reboot) the connection
// closes and Postgres releases the lock automatically. No external
// cleanup required, no stale-lock recovery, no TTL tuning.
//
// Why advisory and not row-level: a row in a `singletons` table would
// require a heartbeat job to expire stale claims, which adds the same
// complexity that ADR-128 §"Decision" 5 deliberately rejected.
// Advisory locks are designed for exactly this lease pattern and the
// expiry semantic is "the holder's TCP connection died" — which is
// the real signal of "the holder is no longer running".
//
// Why a fixed key not derived from the DB URL: every indexer process
// targets the same logical write surface inside a single PG database.
// A single fixed key (`INDEXER_WRITER_LOCK_KEY`) is the correct
// granularity — two indexers against the same DB MUST collide.
// Operators who run a per-environment indexer use per-environment DBs;
// the lock is scoped per-DB by Postgres itself.
//
// Fallback: when `INDEXER_PG_URL` is unset (the no-PG / SQLite-only
// posture), there is no shared backend to coordinate on, and the
// SQLite WAL itself rejects a second writer attempt with `SQLITE_BUSY`
// already. So the OFF-212 guard only runs when PG is configured —
// when it isn't, two indexers writing to two different SQLite files
// is a configuration error of a different shape that's out of scope
// here. (The audit's punchlist suggested `proper-lockfile` as a
// SQLite-mode fallback; that dependency is NOT a workspace dep today
// and adding it for a corner case the SQLite WAL already covers
// would be a net regression.)
// ---------------------------------------------------------------------------

/**
 * Stable 64-bit key for the indexer's writer lock. The value is
 * arbitrary but MUST NOT change across releases — a key change would
 * make a new indexer start that doesn't conflict with an old indexer
 * still running, defeating the lock. Picked as a high-bit-set i64 to
 * avoid colliding with any application-level advisory key an operator
 * might use for their own coordination (mcp-server's deploy lock,
 * etc.). Hex form: `0xAEF1_DEC0_DEC0_001` -> the bit pattern below.
 *
 * Postgres `pg_try_advisory_lock(bigint)` accepts an i64 directly;
 * the JS `bigint` is passed through `pg`'s param marshalling.
 */
export const INDEXER_WRITER_LOCK_KEY: bigint = 0x4145_5046_1212_0212n;

/**
 * Outcome of `acquireIndexerWriterLock`. The release callback is a
 * no-op for `acquired=false` so call sites can unconditionally invoke
 * it on shutdown without a branch.
 */
export interface IndexerWriterLockHandle {
  /**
   * `true` when this process is the lock holder. `false` means another
   * indexer process already held the lock (fail-fast at boot). Calls
   * to `release()` on a non-holding handle are silent no-ops.
   */
  readonly acquired: boolean;
  /**
   * Release the lock and return the borrowed client to the pool.
   * Idempotent — a second `release()` call is a silent no-op so the
   * SIGINT handler can call it without checking whether the boot path
   * also called it.
   *
   * On crash / OOM-kill / `process.exit()` the connection closes
   * automatically and PG releases the lock without a call to this
   * method. `release()` is therefore an optimisation for a graceful
   * shutdown, not a correctness primitive.
   */
  release(): Promise<void>;
}

/**
 * Acquire the indexer's PG advisory writer lock. Returns immediately
 * with `acquired=false` when:
 *
 *   - the store is `DisabledPostgresStore` (no PG configured — the
 *     SQLite WAL is the only writer arbitrator and is process-local);
 *   - the connect / advisory-lock query throws (logged at WARN; the
 *     handle's `acquired=false` branch is the caller's signal to either
 *     fail-fast or proceed in degraded mode per its own policy).
 *
 * The acquired client is held for the lifetime of the lock. It is
 * NOT returned to the pool after the `pg_try_advisory_lock` query —
 * doing so would release the lock immediately because session-scoped
 * advisory locks bind to the session that took them. The client is
 * released only via `handle.release()` (graceful path) or via the
 * pool's `pool.end()` on indexer shutdown (which the existing SIGINT
 * handler in `index.ts` already calls via `pgStore.close()`).
 */
export async function acquireIndexerWriterLock(
  store: PostgresStore,
): Promise<IndexerWriterLockHandle> {
  if (!store.enabled) {
    // No PG configured — single-writer enforcement deferred to the
    // SQLite WAL (which rejects concurrent writers via SQLITE_BUSY).
    // Surface as `acquired: false` with a no-op release so call sites
    // can treat this branch identically to "PG configured but lock
    // taken" if they want strict cluster-singleton semantics.
    logger.info(
      { off: "OFF-212" },
      "indexer writer lock: PG disabled — relying on SQLite WAL for single-writer",
    );
    return { acquired: false, release: async () => {} };
  }
  // We need a borrowed client whose session holds the lock for the
  // process lifetime. `LivePostgresStore.withTransaction` takes a
  // client but BEGIN/COMMIT scope it; we want the client unbound from
  // any tx. Cast through the interface to reach the pool.
  const live = store as unknown as { pool?: Pool };
  if (!live.pool || typeof live.pool.connect !== "function") {
    logger.warn(
      { off: "OFF-212" },
      "indexer writer lock: store has no pool surface — skipping (test fixture?)",
    );
    return { acquired: false, release: async () => {} };
  }
  let client: PoolClient;
  try {
    client = await live.pool.connect();
  } catch (err) {
    logger.warn(
      { err: String(err), off: "OFF-212" },
      "indexer writer lock: pool.connect failed — skipping",
    );
    return { acquired: false, release: async () => {} };
  }
  try {
    const res = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS pg_try_advisory_lock",
      [INDEXER_WRITER_LOCK_KEY.toString()],
    );
    const got = res.rows[0]?.pg_try_advisory_lock === true;
    if (!got) {
      // Another process holds the lock — release the client back to
      // the pool (we hold no lock to keep the session alive for) and
      // surface a clear signal to the caller.
      client.release();
      logger.error(
        { off: "OFF-212", lock_key: INDEXER_WRITER_LOCK_KEY.toString() },
        "indexer writer lock NOT acquired — another indexer process holds it; refusing to start",
      );
      return { acquired: false, release: async () => {} };
    }
    logger.info(
      { off: "OFF-212", lock_key: INDEXER_WRITER_LOCK_KEY.toString() },
      "indexer writer lock acquired",
    );
    let released = false;
    return {
      acquired: true,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [
            INDEXER_WRITER_LOCK_KEY.toString(),
          ]);
        } catch (err) {
          logger.warn(
            { err: String(err), off: "OFF-212" },
            "indexer writer lock: pg_advisory_unlock raised; pool teardown will release",
          );
        } finally {
          client.release();
        }
      },
    };
  } catch (err) {
    // Query failed (transient PG unreachable, statement timeout, etc.)
    // — release the client and surface as not-acquired. The caller
    // policy decides whether to fail-fast or proceed.
    client.release();
    logger.warn(
      { err: String(err), off: "OFF-212" },
      "indexer writer lock: pg_try_advisory_lock failed — skipping",
    );
    return { acquired: false, release: async () => {} };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `pg` accepts either `number` or `string` for BIGINT params. When the
 * source value is a JS `bigint` (out-of-safe-range i64), stringify so
 * the driver passes it through losslessly. Numbers in safe range pass
 * through untouched.
 */
function coerceBigIntParam(v: number | bigint): number | string {
  if (typeof v === "bigint") return v.toString();
  return v;
}
