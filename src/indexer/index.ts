/** AEP Off-chain Event Indexer - subscribes to program logs, stores in SQLite, exposes REST API */
import express, { Request, Response } from "express";
import Database from "better-sqlite3";
import {
  Connection,
  PublicKey,
  Logs,
  Context as SolanaContext,
  ConfirmedSignatureInfo,
  Finality,
} from "@solana/web3.js";
import { logger, programLogger } from "./logger.js";
import {
  acquireIndexerWriterLock,
  createPostgresStore,
  DisabledPostgresStore,
  type IndexerWriterLockHandle,
  type PostgresStore,
} from "./postgres-store.js";
// OFF-208 (cycle-3 off-chain audit): wire the prom-client counters
// declared in `metrics-server.ts` to the actual event-processing /
// dual-write / backfill error sites. Pre-fix the counters were defined
// (and the /metrics endpoint published them) but `inc()` was never
// called from production code, so every scrape returned the
// initial-zero series and operators had no real signal of indexer
// throughput or error rate. The increments below are intentionally
// inline (no helper wrapper) because the call sites already carry the
// correct `event_type` / `error_type` label values; a wrapper would
// just re-marshal the same data through one more frame.
import {
  eventsProcessed,
  indexerErrors,
  lastSlotProcessed,
  startMetricsServer,
} from "./metrics-server.js";

// ===========================================================================
// ADR-128 Phase 1 — Postgres dual-write singleton.
//
// Phase 1 contract (re-stated at every dual-write call site below):
//
//   * SQLite (`better-sqlite3`) is authoritative for BOTH writes AND
//     reads. Postgres is shadow-write-only; reads (the events query,
//     the cursor read, the S-offchain-04 tombstone consultation) all
//     stay against SQLite.
//   * Every SQLite write below is followed by a fire-and-forget call
//     into `pgStore`. The store's `LivePostgresStore.runShadow` wrapper
//     catches and logs WARN; failures NEVER propagate. This is the
//     load-bearing invariant — Postgres outages must not poison the
//     indexer.
//   * When `INDEXER_PG_URL` is unset, `pgStore` is a
//     `DisabledPostgresStore` no-op. No `pg` client is constructed, no
//     network is touched, and behaviour is byte-for-byte identical to
//     the pre-ADR-128 SQLite-only path. Operators MUST opt in.
//
// What Phase 2 (separate future PR) will change:
//
//   1. Reads flip to Postgres (events, agents, cursors, tombstones,
//      history projections — all five `app.get(...)` handlers and the
//      tombstone consultation in `updateAgentFromEvent`).
//   2. The dual-write loses its SQLite half — Postgres writes become
//      authoritative, and the SQLite write path is removed.
//   3. The cursor table cutover is the bridge: because Phase 1 keeps
//      the Postgres cursor in lockstep on every advance, Phase 2's
//      flip is a config change + a read-path swap, not a redesign or
//      a backfill.
// ===========================================================================
let _pgStore: PostgresStore | null = null;

/**
 * Lazy accessor for the Phase 1 shadow store. Constructed at first call
 * and cached for the process lifetime. Tests override via
 * `setPostgresStoreForTest` so a `pg-mem`-backed store can be injected
 * without touching real env vars.
 */
function getPostgresStore(): PostgresStore {
  if (_pgStore === null) {
    _pgStore = createPostgresStore();
  }
  return _pgStore;
}

/**
 * Test-only injection point. Replaces the cached singleton so a fixture
 * can hand in a `pg-mem`-backed `LivePostgresStore` (or a swap to a
 * `DisabledPostgresStore` for parity tests). Pass `null` to reset the
 * cache so the next `getPostgresStore()` call re-reads env.
 *
 * OFF-213 (cycle-3 off-chain audit): pre-fix this hook was an
 * unconditional public export. Any importer of `@agenomics/indexer`
 * could swap the production singleton at runtime — the function name
 * advertised the test-only intent but nothing enforced it. The audit
 * called this out as a soft escape hatch into the dual-write path:
 * a misuse from non-test code (a debug script, a future operator tool,
 * an accidentally-shipped fixture) could silently disable the Postgres
 * shadow store or replace it with a fake.
 *
 * Fix (option (a) per the punchlist guidance): hard-gate on
 * `process.env.NODE_ENV === "test"`. Production / development calls
 * throw immediately so the misuse surfaces at the call site, not as a
 * silent dual-write skip three layers down. The check uses an explicit
 * `"test"` match (not a `!== "production"` or a falsy guard) so a
 * staging deploy with `NODE_ENV` unset is treated as production —
 * fail-closed mirroring ADR-128's opt-in posture. The indexer's
 * `package.json` `test` script sets `NODE_ENV=test` ahead of `tsx
 * --test` so existing fixtures (`aud-128-postgres-store.test.ts`,
 * `aud-200-dual-write-tx.test.ts`) keep working unchanged.
 *
 * Minimum surface change: the export stays in place so existing test
 * imports continue to resolve; the runtime guard is the only addition.
 */
export function setPostgresStoreForTest(store: PostgresStore | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "setPostgresStoreForTest: refusing call outside NODE_ENV=test " +
        "(OFF-213 — this hook MUST NOT run in production / dev). " +
        "If you are inside a test runner, ensure NODE_ENV=test is set " +
        "before importing @agenomics/indexer.",
    );
  }
  _pgStore = store;
}

const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const PORT = parseInt(process.env.INDEXER_PORT || "3100", 10);
// AUD-203 (regression-class of AUD-029, mirrors mcp-server PR-F /
// observability.ts:55-73): the indexer's Express server hosts `/metrics`
// alongside `/events`, `/agents`, `/stats`, `/health`. Letting Node bind
// to its `0.0.0.0` default exposes the metrics surface — and the read-
// only event/agent endpoints — on every interface. Default to loopback,
// allow `INDEXER_METRICS_HOST=0.0.0.0` (or any other interface) to opt
// into a non-loopback bind explicitly. `METRICS_HOST` is honoured as a
// secondary fallback so deployments that already export the shared
// convention from `metrics-server.ts` keep working without renaming env.
const INDEXER_HOST =
  process.env.INDEXER_METRICS_HOST ?? process.env.METRICS_HOST ?? "127.0.0.1";
const PROGRAM_IDS = {
  vault: new PublicKey("4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN"),
  registry: new PublicKey("8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh"),
  settlement: new PublicKey("GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3"),
};

// Finding #23: "confirmed" can be rolled back by a fork. Use "finalized"
// so the indexer never persists an event from a transaction that might
// later be dropped. This adds ~10-20s latency versus "confirmed" but is
// the correct tradeoff for an authoritative event log.
// Typed as `Finality` (not `Commitment`) because the narrower union is
// what `getSignaturesForAddress` and `getTransaction` accept. "finalized"
// is a valid Finality, and `new Connection(..., "finalized")` accepts it
// as a Commitment too.
const COMMITMENT: Finality = "finalized";

// Backfill paging constants — `getSignaturesForAddress` returns at most
// 1000 entries per call. We page head → cursor, then process oldest-first
// so the cursor advances monotonically and a mid-backfill crash resumes
// cleanly.
const BACKFILL_PAGE_SIZE = 1000;
// Small delay between `getTransaction` calls to avoid overwhelming the
// validator when catching up from a long downtime. 25ms = ~40 tx/s worst
// case, well under public RPC limits.
const BACKFILL_TX_DELAY_MS = 25;

function initDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program TEXT NOT NULL,
      event_name TEXT NOT NULL,
      data TEXT NOT NULL,
      signature TEXT NOT NULL,
      slot INTEGER NOT NULL,
      event_ordinal INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_events_program ON events(program);
    CREATE INDEX IF NOT EXISTS idx_events_name ON events(event_name);
    CREATE INDEX IF NOT EXISTS idx_events_slot ON events(slot);

    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      authority TEXT NOT NULL UNIQUE,
      name TEXT,
      category TEXT,
      reputation_score INTEGER DEFAULT 0,
      tasks_completed INTEGER DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_agents_category ON agents(category);
    CREATE INDEX IF NOT EXISTS idx_agents_reputation ON agents(reputation_score);

    -- Finding #23: per-program checkpoint. Without this, restarting the
    -- indexer silently drops every event emitted during downtime because
    -- websocket subscriptions only deliver live logs.
    CREATE TABLE IF NOT EXISTS cursor (
      program TEXT PRIMARY KEY,
      last_processed_slot INTEGER NOT NULL DEFAULT 0,
      last_signature TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- S-offchain-04 (2026-04 re-audit): tombstone table for deregistered
    -- agents. The backfill worker processes historic signatures oldest
    -- first and advances the cursor monotonically, but it runs
    -- concurrently with the live websocket subscription. A restart that
    -- begins backfilling a slot range whose live-stream counterpart
    -- already observed AgentDeregistered would re-INSERT a resurrected
    -- agent row.
    --
    -- The tombstone records the slot at which each authority was last
    -- deregistered. AgentRegistered consults this table before writing
    -- and skips the write whenever the event slot is <= the recorded
    -- deregistration slot. A legitimate re-registration (later slot)
    -- passes through and clears the tombstone.
    CREATE TABLE IF NOT EXISTS agent_tombstones (
      authority TEXT PRIMARY KEY,
      deregistered_at_slot INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ADR-082: append-only history of vault.agent_identity rotations.
    -- Sourced from AgentIdentityUpdated (agent-vault, ADR-069). Any
    -- consumer that caches vault.agent_identity -> permitted-signer
    -- mappings must invalidate when a new row lands here; the
    -- (vault, slot, signature) tuple is the natural key.
    CREATE TABLE IF NOT EXISTS vault_identity_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault TEXT NOT NULL,
      old_identity TEXT NOT NULL,
      new_identity TEXT NOT NULL,
      slot INTEGER NOT NULL,
      signature TEXT NOT NULL,
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vault_identity_vault ON vault_identity_history(vault);
    CREATE INDEX IF NOT EXISTS idx_vault_identity_slot ON vault_identity_history(slot);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_identity_unique
      ON vault_identity_history(vault, signature, slot);

    -- ADR-082: append-only history of capability-manifest rotations
    -- (ADR-060). Each row preserves the on-chain manifest pointer plus
    -- the SHA-256 hash and version, so off-chain caches and IPFS pinners
    -- can refresh deterministically. manifest_cid is stored as the
    -- hex-encoded 64-byte payload (zero-padded CIDv1 string).
    CREATE TABLE IF NOT EXISTS manifest_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      authority TEXT NOT NULL,
      manifest_cid TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      manifest_version INTEGER NOT NULL,
      event_timestamp INTEGER NOT NULL,
      slot INTEGER NOT NULL,
      signature TEXT NOT NULL,
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_manifest_authority ON manifest_history(authority);
    CREATE INDEX IF NOT EXISTS idx_manifest_slot ON manifest_history(slot);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_manifest_unique
      ON manifest_history(authority, signature, slot);

    -- ADR-082: append-only history of ProtocolConfig governance changes.
    -- Stores both ProtocolConfigInitialized (one-shot) and
    -- ProtocolConfigUpdated (recurring). The 'kind' column distinguishes
    -- them so dashboards can render the right banner. All five tunable
    -- fields are recorded on every row so an operator can diff
    -- successive entries to see what changed.
    CREATE TABLE IF NOT EXISTS protocol_config_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('Initialized', 'Updated')),
      authority TEXT NOT NULL,
      min_escrow_amount TEXT NOT NULL,
      dispute_timeout_seconds INTEGER NOT NULL,
      reputation_delta_task_completed INTEGER NOT NULL,
      reputation_delta_dispute_loss INTEGER NOT NULL,
      reputation_delta_expiry_undelivered INTEGER NOT NULL,
      slot INTEGER NOT NULL,
      signature TEXT NOT NULL,
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_protocol_config_slot ON protocol_config_history(slot);
    CREATE INDEX IF NOT EXISTS idx_protocol_config_kind ON protocol_config_history(kind);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_protocol_config_unique
      ON protocol_config_history(signature, slot, kind);
  `);

  // Migration: older databases were created without `event_ordinal`.
  // SQLite lacks portable `ADD COLUMN IF NOT EXISTS`, so introspect and
  // add the column only when missing. Default 0 is safe because every
  // pre-existing row predates the ordinal concept.
  const cols = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "event_ordinal")) {
    db.exec("ALTER TABLE events ADD COLUMN event_ordinal INTEGER NOT NULL DEFAULT 0");
  }

  // Finding #23: idempotency. A websocket reconnect can replay recent
  // logs, and backfill can overlap with a live subscription. The UNIQUE
  // index + `INSERT OR IGNORE` makes event insertion idempotent on the
  // natural key (program, tx signature, per-tx ordinal).
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique ON events(program, signature, event_ordinal)"
  );

  return db;
}

interface ParsedEvent {
  name: string;
  data: Record<string, unknown>;
}

/**
 * Real Anchor event discriminators, computed as sha256("event:<EventName>")[..8].
 *
 * Pre-fix (finding #6), this map held 15 fabricated hex values that never matched
 * any real on-chain event. Every log fell through to the `event_<hex>` fallback
 * and the classifier was effectively off. The values below were produced by:
 *
 *     sha256("event:AgentRegistered").subarray(0, 8)
 *
 * matching Anchor 0.30+ `#[event]` macro output. If an event is renamed in the
 * Rust source, regenerate and update this table.
 */
const DISCRIMINATOR_MAP: Record<string, string> = {
  // agent-registry
  bf4ed936e864bd55: "AgentRegistered",
  "255624473bed06f7": "AgentProfileUpdated",
  c4d1b14343dfe10a: "AgentStatusUpdated",
  "1a24bb96eb5a6a59": "ReputationUpdated",
  "0c46497d1e7d060a": "ReputationStaked",
  "7897274de30de5b9": "AgentSlashed",
  "92ad47a0816f2aa2": "ReputationUnstaked",
  "8445f61387411c86": "AgentDeregistered",
  "59294014abdd32d7": "SuspensionCleared",
  // ADR-082 / audit-2026-04-23 item 6: ManifestUpdated (agent-registry,
  // ADR-060). Was silently classified as `event_<hex>` fallback before.
  "6941986a36affdb3": "ManifestUpdated",
  // ADR-094: propose_reputation_delta emits this event. Registry is now the
  // single source of reputation truth; agents table should update from this.
  "483cc896eed8c2fc": "ReputationDeltaProposed",
  // ADR-096: AgentMigrated — emitted by migrate_agent_profile when the
  // schema version is successfully bumped. sha256("event:AgentMigrated")[0..8].
  "3afb734612e65fa4": "AgentMigrated",

  // agent-vault
  b42bcf021247034b: "VaultInitialized",
  // ADR-082 / audit-2026-04-23 item 6: AgentIdentityUpdated (ADR-069 /
  // SEC-2 from 2026-04-22 deep audit). The signal that downstream
  // permitted-signer caches must invalidate. Was missing pre-fix; the
  // very event the SEC-2 fix added was not detectable downstream.
  aa69af3aa3095577: "AgentIdentityUpdated",
  e17070435fecf5a1: "PolicyUpdated",
  d3e3a80e206fbdd2: "TransactionExecuted",
  d2d9456a8479016c: "ProgramCallExecuted",
  "46fb7d915b2ec652": "TokenTransferExecuted",
  "58ef5d414a8c53d5": "AllowlistUpdated",
  c69d16974464a223: "VaultPaused",
  d0adee40213fe297: "VaultResumed",

  // settlement
  "467f69665c6107ad": "EscrowCreated",
  "7da42467c174421b": "TaskAccepted",
  f2134b630c1c1321: "MilestoneSubmitted",
  "286d9f90a9e623e5": "MilestoneApproved",
  c2f2509338e4c3f5: "MilestoneRejected",
  e51a00ca8ca76abb: "EscrowCompleted",
  f6a76d258e2d26b0: "DisputeRaised",
  "7940f9998b80ecbb": "DisputeResolved",
  "62f1c37ad500a2a1": "EscrowCancelled",
  bd16aafa4bda3a70: "EscrowExpired",
  // AUD-032 (2026-04-25 audit): ReputationUpdateScheduled
  // (discriminator 611134c2e8133ec3) was removed from the Settlement
  // program. The Registry's `ReputationUpdated` (1a24bb96eb5a6a59) is
  // the canonical reputation event; Settlement no longer mirrors it.
  // The discriminator entry is removed in lockstep so any historical
  // log carrying the old payload falls through to the `event_<hex>`
  // forensics fallback rather than being misclassified.
  // ADR-082 / audit-2026-04-23 item 6: ProtocolConfig governance
  // events. Both were silently invisible to dashboards before.
  f3451bee6fa957e7: "ProtocolConfigInitialized",
  "146320ed6f56c3c7": "ProtocolConfigUpdated",
};

/**
 * Minimal borsh reader for Anchor event payloads.
 *
 * Anchor serializes `#[event]` structs with borsh:
 *   - Pubkey        → 32 raw bytes
 *   - u8/u32/u64    → little-endian
 *   - i64           → little-endian, two's complement
 *   - bool          → 1 byte (0/1)
 *   - String        → u32 length prefix (LE) + UTF-8 bytes
 *   - enum<A,B,...> → 1-byte variant tag, then variant payload
 *
 * We only decode the events that drive downstream state. Other events stay
 * classified (name is right) but keep the raw payload for later inspection.
 */
class BorshReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  get done(): boolean {
    return this.offset >= this.buf.length;
  }

  u8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  // AUD-200: signed 16-bit, little-endian, two's-complement. Required by
  // ReputationDeltaProposed.delta (i16 in programs/agent-registry/src/
  // events.rs). Reading via `u16()` silently aliased negative values onto
  // the [32768, 65535] range — e.g. on-chain `-5` surfaced as `65531` to
  // dashboards consuming the indexed payload.
  i16(): number {
    const v = this.buf.readInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  i64(): bigint {
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  pubkey(): string {
    const slice = this.buf.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return new PublicKey(Buffer.from(slice)).toBase58();
  }

  string(): string {
    const len = this.u32();
    const s = this.buf.subarray(this.offset, this.offset + len).toString("utf8");
    this.offset += len;
    return s;
  }

  // Borsh fixed-size array of u8 — encoded as exactly `n` raw bytes with
  // no length prefix. Used by ADR-060 manifest_cid ([u8; 64]) and
  // manifest_hash ([u8; 32]). Returned as a hex string so JSON
  // serialization is lossless and stable across consumers.
  hexBytes(n: number): string {
    const slice = this.buf.subarray(this.offset, this.offset + n);
    if (slice.length !== n) {
      throw new Error(`hexBytes: wanted ${n} bytes, only ${slice.length} remaining`);
    }
    this.offset += n;
    return Buffer.from(slice).toString("hex");
  }
}

// u64 can exceed Number.MAX_SAFE_INTEGER; the SQLite column is INTEGER (i64)
// so we preserve precision by returning the bigint string when it's out of
// safe range. Consumers who need arithmetic cast explicitly.
function u64ToJson(v: bigint): number | string {
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
}
function i64ToJson(v: bigint): number | string {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(v)
    : v.toString();
}

type EventDecoder = (r: BorshReader) => Record<string, unknown>;

// S-offchain-05 (2026-04 re-audit): this array MUST match the declaration
// order of `pub enum AgentStatus` in programs/agent-registry/src/state.rs.
// A borsh enum is wire-encoded as its positional tag, so reordering the
// Rust enum without updating this array silently mis-decodes every
// `AgentStatusUpdated` event. The "AgentStatus enum drift guard" test in
// tests/indexer.test.ts reads the Rust source and fails CI if the two
// drift; fix the array here and re-run the test if that fires.
const AGENT_STATUS_VARIANTS = ["Active", "Paused", "Retired", "Suspended"] as const;

/**
 * Decoders for events that update the `agents` projection. Anything not in
 * this map keeps its classified name but stores `{discriminator, rawData}`
 * so the event log remains useful for forensics without us taking on the
 * decode surface for every field.
 */
const EVENT_DECODERS: Record<string, EventDecoder> = {
  AgentRegistered: (r) => ({
    authority: r.pubkey(),
    name: r.string(),
    category: r.string(),
    vault_address: r.pubkey(),
    timestamp: i64ToJson(r.i64()),
  }),
  AgentProfileUpdated: (r) => ({
    authority: r.pubkey(),
    name: r.string(),
    timestamp: i64ToJson(r.i64()),
  }),
  AgentStatusUpdated: (r) => {
    const authority = r.pubkey();
    const tag = r.u8();
    const new_status = AGENT_STATUS_VARIANTS[tag] ?? `Unknown(${tag})`;
    return { authority, new_status, timestamp: i64ToJson(r.i64()) };
  },
  ReputationUpdated: (r) => ({
    authority: r.pubkey(),
    new_reputation_score: u64ToJson(r.u64()),
    reputation_delta: i64ToJson(r.i64()),
    task_completed: r.bool(),
    timestamp: i64ToJson(r.i64()),
  }),
  AgentDeregistered: (r) => ({
    authority: r.pubkey(),
    name: r.string(),
    timestamp: i64ToJson(r.i64()),
  }),
  SuspensionCleared: (r) => ({
    // Wire layout from programs/agent-registry/src/events.rs:
    //   pub authority: Pubkey
    //   pub new_reputation_score: u64
    //   pub cleared_count: u8        // <-- AUD-004 (was missing pre-ADR-082-field-coverage)
    //   pub timestamp: i64
    //
    // Pre-fix the decoder skipped cleared_count, so every SuspensionCleared
    // event since AUD-004 landed had `timestamp` read 1 byte too early (bit-
    // shifted garbage), and `cleared_count` was silently dropped. Surfaced
    // by the field-coverage extension to scripts/check-event-coverage.ts.
    authority: r.pubkey(),
    new_reputation_score: u64ToJson(r.u64()),
    cleared_count: r.u8(),
    timestamp: i64ToJson(r.i64()),
  }),

  // ADR-096: AgentMigrated (agent-registry).
  // Wire layout from programs/agent-registry/src/events.rs:
  //   pub authority: Pubkey
  //   pub old_version: u8
  //   pub new_version: u8
  //   pub timestamp: i64
  AgentMigrated: (r) => ({
    authority: r.pubkey(),
    old_version: r.u8(),
    new_version: r.u8(),
    timestamp: i64ToJson(r.i64()),
  }),

  // ADR-082 / item 6: AgentIdentityUpdated (agent-vault, ADR-069).
  // Wire layout from programs/agent-vault/src/events.rs:
  //   pub vault: Pubkey
  //   pub old_identity: Pubkey
  //   pub new_identity: Pubkey
  AgentIdentityUpdated: (r) => ({
    vault: r.pubkey(),
    old_identity: r.pubkey(),
    new_identity: r.pubkey(),
  }),

  // ADR-082 / item 6: ManifestUpdated (agent-registry, ADR-060).
  // Wire layout from programs/agent-registry/src/events.rs:
  //   pub authority: Pubkey
  //   pub manifest_cid: [u8; 64]      // zero-padded CIDv1 string bytes
  //   pub manifest_hash: [u8; 32]     // sha256 of canonical manifest
  //   pub manifest_version: u16
  //   pub timestamp: i64
  ManifestUpdated: (r) => ({
    authority: r.pubkey(),
    manifest_cid: r.hexBytes(64),
    manifest_hash: r.hexBytes(32),
    manifest_version: r.u16(),
    timestamp: i64ToJson(r.i64()),
  }),

  // ADR-094: ReputationDeltaProposed (agent-registry).
  // Wire layout from programs/agent-registry/src/events.rs:
  //   pub authority: Pubkey
  //   pub delta: i16
  //   pub reason: u8
  //   pub old_score: u8
  //   pub new_score: u8
  //   pub timestamp: i64
  //
  // AUD-200: `delta` MUST be read as signed two's-complement; the previous
  // `r.u16()` mapped on-chain `-5` to `65531` for every downstream
  // consumer (dashboards, analytics, audit logs).
  ReputationDeltaProposed: (r) => ({
    authority: r.pubkey(),
    delta: r.i16(),
    reason: r.u8(),
    old_score: r.u8(),
    new_score: r.u8(),
    timestamp: i64ToJson(r.i64()),
  }),

  // ADR-082 / item 6: ProtocolConfigInitialized (settlement).
  // Wire layout from programs/settlement/src/events.rs:
  //   pub authority: Pubkey
  //   pub min_escrow_amount: u64
  //   pub dispute_timeout_seconds: i64
  //   pub reputation_delta_task_completed: i64
  //   pub reputation_delta_dispute_loss: i64
  //   pub reputation_delta_expiry_undelivered: i64
  ProtocolConfigInitialized: (r) => ({
    authority: r.pubkey(),
    min_escrow_amount: u64ToJson(r.u64()),
    dispute_timeout_seconds: i64ToJson(r.i64()),
    reputation_delta_task_completed: i64ToJson(r.i64()),
    reputation_delta_dispute_loss: i64ToJson(r.i64()),
    reputation_delta_expiry_undelivered: i64ToJson(r.i64()),
  }),

  // ADR-082 / item 6: ProtocolConfigUpdated (settlement). Identical
  // wire layout to ProtocolConfigInitialized — both events carry the
  // full snapshot so an indexer can compute the delta from the prior
  // protocol_config_history row without round-tripping to chain.
  ProtocolConfigUpdated: (r) => ({
    authority: r.pubkey(),
    min_escrow_amount: u64ToJson(r.u64()),
    dispute_timeout_seconds: i64ToJson(r.i64()),
    reputation_delta_task_completed: i64ToJson(r.i64()),
    reputation_delta_dispute_loss: i64ToJson(r.i64()),
    reputation_delta_expiry_undelivered: i64ToJson(r.i64()),
  }),

  // ADR-131: EscrowCreated (settlement).
  // Wire layout from programs/settlement/src/events.rs:
  //   pub escrow: Pubkey
  //   pub client: Pubkey
  //   pub provider: Pubkey
  //   pub task_id: u64
  //   pub total_amount: u64
  //   pub deadline: i64
  //   pub milestone_count: u32
  //   pub token_mint: Pubkey         // <-- ADR-131 (added 2026-04)
  //
  // Pre-ADR-131 this event fell through to the `event_<hex>` raw
  // classification (no decoder in EVENT_DECODERS), so downstream
  // dashboards saw {discriminator, rawData} only. ADR-131 §"Re-
  // calibration trigger" item 2 requires bucketing escrow medians
  // by `token_mint` to be meaningful (SOL vs USDC unit values
  // differ by orders of magnitude); decoding the event here is
  // what makes `vw_escrow_created` and `vw_escrow_median_30d`
  // (migration 002-adr-131-trigger-views.sql) return non-empty.
  //
  // u64 amounts go through u64ToJson — the same lossless
  // bigint-string fallback the rest of the file uses for values
  // that may exceed Number.MAX_SAFE_INTEGER.
  EscrowCreated: (r) => ({
    escrow: r.pubkey(),
    client: r.pubkey(),
    provider: r.pubkey(),
    task_id: u64ToJson(r.u64()),
    total_amount: u64ToJson(r.u64()),
    deadline: i64ToJson(r.i64()),
    milestone_count: r.u32(),
    token_mint: r.pubkey(),
  }),

  // ADR-131 trigger-1 surface: DisputeResolved (settlement).
  // Wire layout from programs/settlement/src/events.rs:
  //   pub escrow: Pubkey
  //   pub resolver: Pubkey
  //   pub client_refund: u64
  //   pub provider_refund: u64
  //   pub task_id: u64
  //
  // The fresh-authority dispute-cluster trigger view
  // (`vw_fresh_authority_disputes_7d` in migration 002) joins
  // DisputeResolved to EscrowCreated via task_id and derives the
  // winning side from the refund split. Without this decoder the
  // view returns zero rows and the dashboard's "Sybil Patterns (7d)"
  // card stays at 0 even when the protocol observes real clustering.
  DisputeResolved: (r) => ({
    escrow: r.pubkey(),
    resolver: r.pubkey(),
    client_refund: u64ToJson(r.u64()),
    provider_refund: u64ToJson(r.u64()),
    task_id: u64ToJson(r.u64()),
  }),

  // Counterpart to DisputeResolved: surfacing DisputeRaised in the
  // events stream is also a dependency of any future per-dispute
  // analytics. Included alongside DisputeResolved in this same wiring
  // pass to keep the dispute-lifecycle decoder set complete.
  // Wire layout from programs/settlement/src/events.rs:
  //   pub escrow: Pubkey
  //   pub requester: Pubkey
  //   pub task_id: u64
  DisputeRaised: (r) => ({
    escrow: r.pubkey(),
    requester: r.pubkey(),
    task_id: u64ToJson(r.u64()),
  }),
};

function parseLogsForEvents(logs: string[], _programLabel: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const eventRegex = /Program data: (.+)/;

  for (const log of logs) {
    if (!log.includes("Program data:")) {
      continue;
    }

    const match = log.match(eventRegex);
    if (!match) {
      continue;
    }

    try {
      const decoded = Buffer.from(match[1], "base64");
      if (decoded.length < 8) {
        continue;
      }
      const discriminator = decoded.subarray(0, 8).toString("hex");
      const eventName = DISCRIMINATOR_MAP[discriminator];

      if (eventName) {
        const decoder = EVENT_DECODERS[eventName];
        if (decoder) {
          try {
            const data = decoder(new BorshReader(decoded.subarray(8)));
            events.push({ name: eventName, data });
            continue;
          } catch (decodeErr) {
            // Field-level decode failure: keep the classification but preserve
            // the raw bytes so a later investigator can see what went wrong.
            events.push({
              name: eventName,
              data: {
                discriminator,
                rawData: decoded.subarray(8).toString("hex"),
                decodeError: (decodeErr as Error).message,
              },
            });
            continue;
          }
        }
        events.push({
          name: eventName,
          data: { discriminator, rawData: decoded.subarray(8).toString("hex") },
        });
        continue;
      }

      // Unknown discriminator — fall back to raw classification.
      events.push({
        name: `event_${discriminator.substring(0, 8)}`,
        data: { discriminator, rawData: decoded.subarray(8).toString("hex") },
      });
    } catch {
      // Skip unparseable base64 data
    }
  }

  return events;
}

function updateAgentFromEvent(
  db: Database.Database,
  event: ParsedEvent,
  slot = 0,
  signature = ""
): void {
  const data = event.data as Record<string, unknown>;
  const authority = typeof data.authority === "string" ? data.authority : undefined;

  // ADR-082: AgentIdentityUpdated does NOT carry an `authority` field —
  // it carries `vault`, `old_identity`, `new_identity`. Persist directly
  // into the vault_identity_history projection. Downstream consumers
  // that cache `vault.agent_identity → permitted-signer` MUST listen on
  // this table (or on the underlying event row) and invalidate.
  if (event.name === "AgentIdentityUpdated") {
    const vault = typeof data.vault === "string" ? data.vault : undefined;
    const oldIdentity = typeof data.old_identity === "string" ? data.old_identity : undefined;
    const newIdentity = typeof data.new_identity === "string" ? data.new_identity : undefined;
    if (!vault || !oldIdentity || !newIdentity) return;
    db.prepare(`
      INSERT OR IGNORE INTO vault_identity_history
        (vault, old_identity, new_identity, slot, signature, observed_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(vault, oldIdentity, newIdentity, slot, signature);
    // ADR-128 Phase 1 dual-write — vault_identity_history projection.
    void getPostgresStore().insertVaultIdentityHistory({
      vault,
      oldIdentity,
      newIdentity,
      slot,
      signature,
    });
    return;
  }

  // ADR-082: ManifestUpdated (ADR-060). Append-only history of
  // capability-manifest pointer rotations. Caches keyed on
  // (authority, manifest_hash) should refresh.
  if (event.name === "ManifestUpdated") {
    if (!authority) return;
    const manifestCid = typeof data.manifest_cid === "string" ? data.manifest_cid : "";
    const manifestHash = typeof data.manifest_hash === "string" ? data.manifest_hash : "";
    const manifestVersion = typeof data.manifest_version === "number" ? data.manifest_version : 0;
    const eventTs = coerceI64(data.timestamp);
    db.prepare(`
      INSERT OR IGNORE INTO manifest_history
        (authority, manifest_cid, manifest_hash, manifest_version,
         event_timestamp, slot, signature, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(authority, manifestCid, manifestHash, manifestVersion, eventTs, slot, signature);
    // ADR-128 Phase 1 dual-write — manifest_history projection.
    void getPostgresStore().insertManifestHistory({
      authority,
      manifestCid,
      manifestHash,
      manifestVersion,
      eventTimestamp: eventTs,
      slot,
      signature,
    });
    return;
  }

  // ADR-082: ProtocolConfigInitialized / ProtocolConfigUpdated
  // (settlement). Both share the same wire layout; the `kind` column on
  // protocol_config_history distinguishes them so dashboards can render
  // the right banner. The full snapshot is recorded on every row so
  // operators can diff successive entries to compute the delta.
  if (event.name === "ProtocolConfigInitialized" || event.name === "ProtocolConfigUpdated") {
    if (!authority) return;
    const kind = event.name === "ProtocolConfigInitialized" ? "Initialized" : "Updated";
    const minEscrow = coerceU64String(data.min_escrow_amount);
    const disputeTimeout = coerceI64(data.dispute_timeout_seconds);
    const repTask = coerceI64(data.reputation_delta_task_completed);
    const repDispute = coerceI64(data.reputation_delta_dispute_loss);
    const repExpiry = coerceI64(data.reputation_delta_expiry_undelivered);
    db.prepare(`
      INSERT OR IGNORE INTO protocol_config_history
        (kind, authority, min_escrow_amount, dispute_timeout_seconds,
         reputation_delta_task_completed, reputation_delta_dispute_loss,
         reputation_delta_expiry_undelivered, slot, signature, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      kind,
      authority,
      minEscrow,
      disputeTimeout,
      repTask,
      repDispute,
      repExpiry,
      slot,
      signature
    );
    // ADR-128 Phase 1 dual-write — protocol_config_history projection.
    void getPostgresStore().insertProtocolConfigHistory({
      kind,
      authority,
      minEscrowAmount: minEscrow,
      disputeTimeoutSeconds: disputeTimeout,
      reputationDeltaTaskCompleted: repTask,
      reputationDeltaDisputeLoss: repDispute,
      reputationDeltaExpiryUndelivered: repExpiry,
      slot,
      signature,
    });
    return;
  }

  if (event.name === "AgentRegistered") {
    if (!authority) return;
    // S-offchain-04: if a later deregistration has already been observed
    // for this authority, any `AgentRegistered` at an older slot is a
    // stale resurrection from backfill and must be ignored. A legitimate
    // re-registration carries a slot strictly greater than the tombstone;
    // it passes through and clears the tombstone below.
    const tombstone = db
      .prepare("SELECT deregistered_at_slot FROM agent_tombstones WHERE authority = ?")
      .get(authority) as { deregistered_at_slot: number } | undefined;
    if (tombstone && slot > 0 && slot <= tombstone.deregistered_at_slot) {
      return;
    }
    const stmt = db.prepare(`
      INSERT INTO agents (authority, name, category, last_updated)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(authority) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        last_updated = datetime('now')
    `);
    const agentName = typeof data.name === "string" ? data.name : null;
    const agentCategory = typeof data.category === "string" ? data.category : null;
    stmt.run(authority, agentName, agentCategory);
    if (tombstone) {
      db.prepare("DELETE FROM agent_tombstones WHERE authority = ?").run(authority);
    }
    // ADR-128 Phase 1 dual-write — agents projection (AgentRegistered).
    // Tombstone-clear in PG is intentionally deferred to Phase 2: the
    // tombstone consultation in this same function still reads SQLite,
    // so a stale PG tombstone cannot mis-route Phase 1 logic. Phase 2
    // will add a paired DELETE here when reads flip.
    void getPostgresStore().upsertAgent(authority, agentName, agentCategory);
    return;
  }

  if (event.name === "AgentProfileUpdated") {
    if (!authority) return;
    const stmt = db.prepare(`
      UPDATE agents SET
        name = COALESCE(?, name),
        last_updated = datetime('now')
      WHERE authority = ?
    `);
    const newName = typeof data.name === "string" ? data.name : null;
    stmt.run(newName, authority);
    // ADR-128 Phase 1 dual-write — agents projection (profile update).
    void getPostgresStore().updateAgentName(authority, newName);
    return;
  }

  if (event.name === "ReputationUpdated") {
    if (!authority) return;
    const score = coerceScore(data.new_reputation_score);
    const taskCompleted = data.task_completed === true ? 1 : 0;
    const stmt = db.prepare(`
      UPDATE agents SET
        reputation_score = ?,
        tasks_completed = tasks_completed + ?,
        last_updated = datetime('now')
      WHERE authority = ?
    `);
    stmt.run(score, taskCompleted, authority);
    // ADR-128 Phase 1 dual-write — agents projection (reputation).
    void getPostgresStore().updateAgentReputation(authority, score, taskCompleted);
    return;
  }

  // ADR-094: ReputationDeltaProposed — the new authoritative reputation path.
  // new_score is already clamped to [0, 100] by the registry instruction.
  if (event.name === "ReputationDeltaProposed") {
    if (!authority) return;
    const newScore = coerceScore(data.new_score);
    db.prepare(`
      UPDATE agents SET
        reputation_score = ?,
        last_updated = datetime('now')
      WHERE authority = ?
    `).run(newScore, authority);
    // ADR-128 Phase 1 dual-write — agents projection (ADR-094 path).
    void getPostgresStore().setAgentReputation(authority, newScore);
    return;
  }

  if (event.name === "SuspensionCleared") {
    if (!authority) return;
    const score = coerceScore(data.new_reputation_score);
    const stmt = db.prepare(`
      UPDATE agents SET
        reputation_score = ?,
        last_updated = datetime('now')
      WHERE authority = ?
    `);
    stmt.run(score, authority);
    // ADR-128 Phase 1 dual-write — agents projection (suspension cleared).
    void getPostgresStore().setAgentReputation(authority, score);
    return;
  }

  if (event.name === "AgentDeregistered") {
    if (!authority) return;
    db.prepare(`DELETE FROM agents WHERE authority = ?`).run(authority);
    // S-offchain-04: record the deregistration slot so a concurrent or
    // subsequent backfill cannot re-INSERT this authority. Upsert in case
    // multiple Deregister events arrive (shouldn't happen on-chain, but
    // the DB constraint is cheap). `MAX` ensures a later-arriving
    // tombstone always wins; an older backfill tombstone can't overwrite
    // a newer one.
    db.prepare(`
      INSERT INTO agent_tombstones (authority, deregistered_at_slot, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(authority) DO UPDATE SET
        deregistered_at_slot = MAX(deregistered_at_slot, excluded.deregistered_at_slot),
        updated_at = datetime('now')
    `).run(authority, slot);
    // ADR-128 Phase 1 dual-write — agents DELETE + tombstone UPSERT.
    // Phase 1's tombstone consultation (in the AgentRegistered branch
    // above) reads SQLite, so the PG tombstone is shadow-only. Phase 2
    // will flip the consultation target.
    void getPostgresStore().deleteAgent(authority);
    void getPostgresStore().upsertAgentTombstone({
      authority,
      deregisteredAtSlot: slot,
    });
    return;
  }
}

function coerceScore(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === "bigint") {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : Number.MAX_SAFE_INTEGER;
  }
  return 0;
}

// ADR-082: i64 fields (timestamps, signed reputation deltas) decode to
// either `number` (in safe range) or `string` (out of safe range, to
// preserve precision — see i64ToJson). Both shapes must round-trip into
// SQLite's INTEGER column without loss.
function coerceI64(v: unknown): number | bigint {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    try {
      return BigInt(v);
    } catch {
      return 0;
    }
  }
  if (typeof v === "bigint") return v;
  return 0;
}

// ADR-082: u64 amounts are stored as TEXT so the full unsigned 64-bit
// range round-trips losslessly. Consumers that need arithmetic cast on
// read.
function coerceU64String(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v).toString();
  if (typeof v === "bigint") return v.toString();
  return "0";
}

const RECONNECT_DELAY_MS = 3000;

// AUD-039 / ADR-118: WebSocket health is detected via a heartbeat ping
// rather than peeking at `(connection as any)._rpcWebSocket`. The previous
// approach reached into a private @solana/web3.js field and would silently
// stop firing on a minor-version bump that renames or removes it.
//
// We periodically issue a cheap RPC call (`getSlot` at "confirmed") with a
// timeout. After HEARTBEAT_FAILURE_THRESHOLD consecutive failures we treat
// the connection as dead and trigger the same per-program reconnect path
// that was previously kicked off by the WebSocket "close" event.
//
// Defaults are conservative: 10s interval, 5s timeout, 3 consecutive
// failures before declaring loss (~30s before reconnect, matching the
// rough latency of TCP keepalive + browser-style WS close detection on
// the prior implementation).
const HEARTBEAT_INTERVAL_MS = parseInt(
  process.env.INDEXER_HEARTBEAT_INTERVAL_MS || "10000",
  10,
);
const HEARTBEAT_TIMEOUT_MS = parseInt(
  process.env.INDEXER_HEARTBEAT_TIMEOUT_MS || "5000",
  10,
);
const HEARTBEAT_FAILURE_THRESHOLD = parseInt(
  process.env.INDEXER_HEARTBEAT_FAILURE_THRESHOLD || "3",
  10,
);

/**
 * Per-program live view of subscription health. Exposed through `/health`
 * and `/metrics` so operators can see which feeds are behind, disconnected,
 * or flapping without tailing logs.
 */
export interface SubscriptionState {
  label: string;
  programId: string;
  connected: boolean;
  lastProcessedSlot: number;
  lastSignature: string | null;
  reconnectAttempts: number;
  lastError: string | null;
}

/**
 * Counters covering the full indexer lifecycle. Finding #24: before this,
 * the only runtime signal was `console.log` lines; there was no way to ask
 * "how many events did we store", "how many duplicates did we skip", or
 * "how many parse errors have there been". These are exported through
 * `/metrics` for scraping.
 */
export interface IndexerMetrics {
  eventsInserted: number;
  eventsDuplicateSkipped: number;
  eventsBackfilled: number;
  subscriptionReconnects: number;
  parseErrors: number;
  backfillErrors: number;
  startedAt: string;
}

function createInitialMetrics(): IndexerMetrics {
  return {
    eventsInserted: 0,
    eventsDuplicateSkipped: 0,
    eventsBackfilled: 0,
    subscriptionReconnects: 0,
    parseErrors: 0,
    backfillErrors: 0,
    startedAt: new Date().toISOString(),
  };
}

function readCursor(
  db: Database.Database,
  label: string
): { slot: number; signature: string | null } | null {
  const row = db
    .prepare("SELECT last_processed_slot, last_signature FROM cursor WHERE program = ?")
    .get(label) as { last_processed_slot: number; last_signature: string | null } | undefined;
  if (!row) return null;
  return { slot: row.last_processed_slot, signature: row.last_signature };
}

function upsertCursor(
  db: Database.Database,
  label: string,
  slot: number,
  signature: string
): void {
  db.prepare(`
    INSERT INTO cursor (program, last_processed_slot, last_signature, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(program) DO UPDATE SET
      last_processed_slot = excluded.last_processed_slot,
      last_signature = excluded.last_signature,
      updated_at = datetime('now')
  `).run(label, slot, signature);
  // OFF-200 / ADR-128 Phase 1 dual-write — wrap the cursor advance in
  // a PG transaction even when there is no event payload alongside (eg.
  // the cursor seed in `backfillProgram` when no prior cursor exists).
  // The standalone-cursor case still benefits from the tx wrapper because
  // it keeps the call shape uniform with `persistEventsToPgInTx` below
  // and because future Phase-2 wiring (chained projection updates) can
  // hang off the same `withTransaction` boundary without a re-plumb.
  // Failure logged WARN, not propagated — SQLite remains authoritative.
  persistCursorAdvanceToPgInTx(label, slot, signature);
}

/**
 * OFF-200 — fire-and-forget at the call boundary, but the inner work is
 * a single PG transaction wrapping zero-or-more event INSERTs and the
 * cursor UPSERT. The invariant established here:
 *
 *   The PG cursor cannot advance unless every event INSERT for this
 *   batch also committed in the same transaction. If any step fails,
 *   ROLLBACK undoes both the INSERTs and the cursor advance, leaving
 *   PG cleanly behind the last successful batch.
 *
 * SQLite remains authoritative — a PG outage logs WARN at the outer
 * `.catch` and never blocks the SQLite write path. The shape mirrors
 * the original fire-and-forget semantic so callers (running on the
 * websocket / backfill hot path) do not pay for PG round-trips.
 */
function persistEventsToPgInTx(
  label: string,
  cursorSlot: number,
  cursorSignature: string,
  events: ReadonlyArray<{
    eventName: string;
    data: string;
    signature: string;
    slot: number;
    eventOrdinal: number;
  }>,
): void {
  const pgStore = getPostgresStore();
  if (!pgStore.enabled) return;
  pgStore
    .withTransaction(async (client) => {
      for (const ev of events) {
        await pgStore.insertEventInTx(client, {
          program: label,
          eventName: ev.eventName,
          data: ev.data,
          signature: ev.signature,
          slot: ev.slot,
          eventOrdinal: ev.eventOrdinal,
        });
      }
      await pgStore.upsertCursorInTx(client, {
        program: label,
        slot: cursorSlot,
        signature: cursorSignature,
      });
    })
    .catch((err) => {
      logger.warn(
        { err: String(err), op: "persistEventsToPgInTx", label, cursorSlot, adr: "ADR-128", off: "OFF-200" },
        "pg dual-write tx failed; SQLite is authoritative",
      );
    });
}

/**
 * OFF-200 — cursor-only variant of `persistEventsToPgInTx`. Used by the
 * standalone `upsertCursor` call site (notably the seed in
 * `backfillProgram` when no prior cursor exists). Still wraps the single
 * statement in a transaction so the path is uniform; the cost is
 * negligible and a future projection write at the same boundary can be
 * added inside the same tx without re-plumbing the call site.
 */
function persistCursorAdvanceToPgInTx(
  label: string,
  slot: number,
  signature: string,
): void {
  const pgStore = getPostgresStore();
  if (!pgStore.enabled) return;
  pgStore
    .withTransaction(async (client) => {
      await pgStore.upsertCursorInTx(client, { program: label, slot, signature });
    })
    .catch((err) => {
      logger.warn(
        { err: String(err), op: "persistCursorAdvanceToPgInTx", label, slot, adr: "ADR-128", off: "OFF-200" },
        "pg cursor-only dual-write tx failed; SQLite is authoritative",
      );
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persist the parsed events for a single transaction and advance the
 * cursor. Uses `INSERT OR IGNORE` against the UNIQUE(program, signature,
 * event_ordinal) index so a duplicate log (websocket replay, backfill
 * overlap) is silently skipped rather than raising.
 */
function persistEventsForTx(
  db: Database.Database,
  label: string,
  signature: string,
  slot: number,
  events: ParsedEvent[],
  metrics: IndexerMetrics
): { inserted: number; skipped: number } {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO events (program, event_name, data, signature, slot, event_ordinal)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  let skipped = 0;
  let ordinal = 0;
  // OFF-200 — collect the rows that the SQLite path actually inserted
  // so they can be replayed into PG inside a single transaction with
  // the cursor advance. Per the original ADR-128 semantic, only rows
  // that landed in SQLite (changes > 0) are propagated to the PG
  // shadow — a SQLite-skip stays a PG-skip too.
  const pgEventBatch: Array<{
    eventName: string;
    data: string;
    signature: string;
    slot: number;
    eventOrdinal: number;
  }> = [];

  for (const event of events) {
    try {
      const dataJson = JSON.stringify(event.data);
      const result = insertStmt.run(
        label,
        event.name,
        dataJson,
        signature,
        slot,
        ordinal
      );
      if (result.changes > 0) {
        inserted++;
        metrics.eventsInserted++;
        // OFF-208: prom counter for events successfully persisted to
        // SQLite (the authoritative store). Labelled by `event_name`
        // so a Grafana panel can surface per-event-type rates without
        // re-parsing the body of the metric. We DO NOT count duplicate-
        // skips here — `metrics.eventsDuplicateSkipped` is the
        // in-process counter for those, and a future ADR can wire a
        // separate prom counter if operators ask for it.
        eventsProcessed.inc({ event_type: event.name });
        updateAgentFromEvent(db, event, slot, signature);
        // OFF-200 / ADR-128 Phase 1 — defer the PG INSERT; the batch is
        // flushed inside a single PG transaction with the cursor
        // advance below, so the cursor cannot move past an event that
        // PG never received.
        pgEventBatch.push({
          eventName: event.name,
          data: dataJson,
          signature,
          slot,
          eventOrdinal: ordinal,
        });
      } else {
        skipped++;
        metrics.eventsDuplicateSkipped++;
      }
    } catch (err) {
      metrics.parseErrors++;
      // OFF-208: prom counter for SQLite-write failures inside the
      // per-event loop (a JSON.stringify throw, a disk-full, a UNIQUE
      // constraint we somehow missed). Labelled `store_event` to match
      // the value used in `metrics-server.test.ts` so the prom
      // contract stays stable across the audit close.
      indexerErrors.inc({ error_type: "store_event" });
      programLogger(label).error({ err: String(err), corr_id: signature }, "failed to store event");
    }
    ordinal++;
  }

  if (inserted > 0 || skipped > 0) {
    // SQLite is authoritative — advance its cursor synchronously.
    db.prepare(`
      INSERT INTO cursor (program, last_processed_slot, last_signature, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(program) DO UPDATE SET
        last_processed_slot = excluded.last_processed_slot,
        last_signature = excluded.last_signature,
        updated_at = datetime('now')
    `).run(label, slot, signature);
    // OFF-208: prom gauge for the most recent slot the indexer has
    // committed to SQLite. Set after the cursor advance so the gauge
    // never reports a slot we haven't actually persisted. A monotonic-
    // forward set is safe under `prom-client`'s gauge semantics — the
    // last-write-wins nature of `set()` matches the cursor's monotonic
    // advance, and a backfill that processes an OLDER slot than the
    // current cursor is invariant under the SQLite UPSERT (the cursor
    // won't move backwards, and this gauge tracks the cursor not the
    // input event). For the rare interleaving where backfill +
    // realtime touch the gauge in close succession, a brief dip is
    // acceptable: the next realtime tick re-asserts the head slot.
    lastSlotProcessed.set(slot);
    // OFF-200 — single PG transaction wrapping every PG event INSERT
    // for this batch and the cursor UPSERT. Fire-and-forget at the
    // outer boundary preserves the SQLite-authoritative invariant; the
    // tx ensures PG cannot end up in the broken intermediate state
    // where the cursor advanced but the event row never landed.
    persistEventsToPgInTx(label, slot, signature, pgEventBatch);
  }

  return { inserted, skipped };
}

/**
 * Finding #23: backfill missed events after downtime. Pages
 * `getSignaturesForAddress` from the chain head back to the persisted
 * cursor, then walks oldest-first so the cursor advances monotonically.
 * If the indexer crashes mid-backfill, the next run resumes from the
 * last committed cursor.
 *
 * First-run behaviour: if no cursor exists yet, record the current head
 * and skip history — operators who need historic replay can use a
 * one-shot reindex tool instead of paying the cost on every cold start.
 */
async function backfillProgram(
  connection: Connection,
  db: Database.Database,
  label: string,
  programId: PublicKey,
  state: SubscriptionState,
  metrics: IndexerMetrics
): Promise<number> {
  const cursor = readCursor(db, label);

  if (!cursor || !cursor.signature) {
    try {
      const head = await connection.getSignaturesForAddress(
        programId,
        { limit: 1 },
        COMMITMENT
      );
      if (head.length > 0) {
        upsertCursor(db, label, head[0].slot, head[0].signature);
        state.lastProcessedSlot = head[0].slot;
        state.lastSignature = head[0].signature;
        programLogger(label).info(
          { slot: head[0].slot, corr_id: head[0].signature },
          "no cursor — seeded at head signature",
        );
      }
    } catch (err) {
      metrics.backfillErrors++;
      // OFF-208: prom counter for cursor-seed failures (first-run
      // boot when no persisted cursor exists). `error_type` namespaced
      // so backfill-page-fetch / backfill-tx / cursor-seed can each be
      // alert-ruled separately.
      indexerErrors.inc({ error_type: "backfill_cursor_seed" });
      state.lastError = `cursor seed failed: ${(err as Error).message}`;
      programLogger(label).error({ err: String(err) }, "cursor seed failed");
    }
    return 0;
  }

  const until = cursor.signature;
  const collected: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;

  try {
    while (true) {
      const page = await connection.getSignaturesForAddress(
        programId,
        { limit: BACKFILL_PAGE_SIZE, before, until },
        COMMITMENT
      );
      if (page.length === 0) break;
      collected.push(...page);
      if (page.length < BACKFILL_PAGE_SIZE) break;
      before = page[page.length - 1].signature;
    }
  } catch (err) {
    metrics.backfillErrors++;
    // OFF-208: prom counter for `getSignaturesForAddress` paging
    // failures. Distinct label from the per-tx fetch below so an RPC
    // outage that wedges paging surfaces independently of a tx-level
    // RPC flap.
    indexerErrors.inc({ error_type: "backfill_page_fetch" });
    state.lastError = `backfill page fetch failed: ${(err as Error).message}`;
    programLogger(label).error({ err: String(err) }, "backfill page fetch failed");
    return 0;
  }

  if (collected.length === 0) {
    return 0;
  }

  programLogger(label).info(
    { signature_count: collected.length, since_cursor: until },
    "backfilling signatures since cursor",
  );

  let totalInserted = 0;
  // Reverse to oldest-first so the cursor advances monotonically. A crash
  // mid-loop leaves the cursor at the last fully-processed signature.
  for (const info of collected.reverse()) {
    try {
      const tx = await connection.getTransaction(info.signature, {
        commitment: COMMITMENT,
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta?.logMessages) {
        const parsed = parseLogsForEvents(tx.meta.logMessages, label);
        const { inserted } = persistEventsForTx(db, label, info.signature, info.slot, parsed, metrics);
        totalInserted += inserted;
        metrics.eventsBackfilled += inserted;
      } else {
        // Tx has no logs or couldn't be fetched at finalized commitment —
        // still advance cursor so we don't re-fetch it forever.
        upsertCursor(db, label, info.slot, info.signature);
      }
      state.lastProcessedSlot = Math.max(state.lastProcessedSlot, info.slot);
      state.lastSignature = info.signature;
    } catch (err) {
      metrics.backfillErrors++;
      // OFF-208: prom counter for per-tx `getTransaction` failures
      // during backfill. Distinct from `backfill_page_fetch` above so
      // operators can tell "RPC pagination broken" from "RPC tx-fetch
      // intermittently 5xx-ing".
      indexerErrors.inc({ error_type: "backfill_tx_fetch" });
      state.lastError = `backfill tx ${info.signature.substring(0, 8)}... failed: ${(err as Error).message}`;
      programLogger(label).error(
        { err: String(err), corr_id: info.signature },
        "backfill tx failed",
      );
    }
    await sleep(BACKFILL_TX_DELAY_MS);
  }

  programLogger(label).info(
    { events_inserted: totalInserted },
    "backfill complete",
  );
  return totalInserted;
}

function subscribeToPrograms(
  connection: Connection,
  db: Database.Database,
  states?: Map<string, SubscriptionState>,
  metrics?: IndexerMetrics
): {
  states: Map<string, SubscriptionState>;
  metrics: IndexerMetrics;
  heartbeat: HeartbeatHandle;
} {
  const activeStates = states ?? new Map<string, SubscriptionState>();
  const activeMetrics = metrics ?? createInitialMetrics();

  const subscriptionIds: Map<string, number> = new Map();

  function getOrCreateState(label: string, programId: PublicKey): SubscriptionState {
    let state = activeStates.get(label);
    if (!state) {
      state = {
        label,
        programId: programId.toBase58(),
        connected: false,
        lastProcessedSlot: 0,
        lastSignature: null,
        reconnectAttempts: 0,
        lastError: null,
      };
      activeStates.set(label, state);
    }
    return state;
  }

  function handleLogs(label: string, logs: Logs, ctx: SolanaContext): void {
    const state = activeStates.get(label);
    if (state && ctx.slot > state.lastProcessedSlot) {
      state.lastProcessedSlot = ctx.slot;
      state.lastSignature = logs.signature;
    }

    const parsed = parseLogsForEvents(logs.logs, label);
    if (parsed.length === 0) return;

    const { inserted, skipped } = persistEventsForTx(
      db,
      label,
      logs.signature,
      ctx.slot,
      parsed,
      activeMetrics
    );
    if (inserted > 0) {
      for (const event of parsed) {
        programLogger(label).info(
          {
            event_name: event.name,
            slot: ctx.slot,
            corr_id: logs.signature,
          },
          "event ingested",
        );
      }
    }
    if (skipped > 0) {
      programLogger(label).debug(
        { skipped, corr_id: logs.signature },
        "duplicate events skipped",
      );
    }
  }

  function subscribeWithReconnect(label: string, programId: PublicKey): void {
    const state = getOrCreateState(label, programId);
    programLogger(label).info(
      { program_id: programId.toBase58() },
      "subscribing to program",
    );

    try {
      const subId = connection.onLogs(
        programId,
        (logs: Logs, ctx: SolanaContext) => {
          handleLogs(label, logs, ctx);
        },
        COMMITMENT
      );
      subscriptionIds.set(label, subId);
      state.connected = true;
      state.lastError = null;
    } catch (err) {
      state.connected = false;
      state.lastError = `subscribe failed: ${(err as Error).message}`;
      programLogger(label).error({ err: String(err) }, "subscription failed");
      scheduleReconnect(label, programId);
      return;
    }

    // Kick off backfill after subscribe so live events queue while
    // history is catching up; `INSERT OR IGNORE` handles any overlap.
    backfillProgram(connection, db, label, programId, state, activeMetrics).catch((err) => {
      activeMetrics.backfillErrors++;
      // OFF-208: prom counter for unexpected backfill throws (the
      // top-level rejection that escapes the inner try/catch sites).
      // Different `error_type` so an alert that fires on this label
      // means "the backfill itself crashed", not "an RPC call inside
      // backfill failed and was already counted above".
      indexerErrors.inc({ error_type: "backfill_threw" });
      state.lastError = `backfill threw: ${(err as Error).message}`;
      programLogger(label).error({ err: String(err) }, "backfill threw");
    });

    // AUD-039 / ADR-118: WebSocket disconnects are observed via the
    // process-wide heartbeat (see startHeartbeat below) rather than a
    // private `_rpcWebSocket.on("close", ...)` peek that would break on
    // any @solana/web3.js minor bump. The heartbeat is started once on
    // first subscribe and remains running for the lifetime of the
    // process; per-program reconnect logic is unchanged from the
    // previous implementation.
  }

  function scheduleReconnect(label: string, programId: PublicKey): void {
    const state = getOrCreateState(label, programId);
    state.reconnectAttempts++;
    activeMetrics.subscriptionReconnects++;
    programLogger(label).info(
      { delay_ms: RECONNECT_DELAY_MS },
      "scheduling reconnect",
    );
    setTimeout(() => {
      programLogger(label).info(
        { last_slot: state.lastProcessedSlot },
        "attempting re-subscribe",
      );
      subscribeWithReconnect(label, programId);
    }, RECONNECT_DELAY_MS);
  }

  for (const [label, programId] of Object.entries(PROGRAM_IDS)) {
    getOrCreateState(label, programId);
    // Rehydrate lastProcessedSlot from persisted cursor so restart state
    // is visible to /health immediately, not just after first new event.
    const cursor = readCursor(db, label);
    if (cursor) {
      const state = activeStates.get(label)!;
      state.lastProcessedSlot = cursor.slot;
      state.lastSignature = cursor.signature;
    }
    subscribeWithReconnect(label, programId);
  }

  // AUD-039: process-wide heartbeat replaces the previous private-API
  // peek at `connection._rpcWebSocket`. On HEARTBEAT_FAILURE_THRESHOLD
  // consecutive failures, every currently-subscribed program is marked
  // disconnected and re-routed through scheduleReconnect — exact same
  // outcome as the old "close" event handler, just driven by a public
  // RPC call instead of a private socket field.
  const heartbeatHandle = startConnectionHeartbeat(connection, {
    intervalMs: HEARTBEAT_INTERVAL_MS,
    timeoutMs: HEARTBEAT_TIMEOUT_MS,
    failureThreshold: HEARTBEAT_FAILURE_THRESHOLD,
    onConnectionLost: (reason) => {
      // Reconnect every program whose subscription is currently live.
      // We iterate over a snapshot because scheduleReconnect mutates
      // `subscriptionIds` indirectly through subscribeWithReconnect.
      const labels = Array.from(subscriptionIds.keys());
      for (const label of labels) {
        const state = activeStates.get(label);
        if (!state) continue;
        const programId = new PublicKey(state.programId);
        programLogger(label).warn(
          { last_slot: state.lastProcessedSlot, reason },
          "heartbeat failed, scheduling reconnect",
        );
        state.connected = false;
        state.lastError = `heartbeat failed: ${reason}`;
        // AUD-204: release the prior onLogs subscription with the RPC
        // server BEFORE dropping it from `subscriptionIds` and starting
        // a fresh subscribe. Without this, every heartbeat-driven
        // reconnect on a flaky network stacks an extra listener inside
        // @solana/web3.js's `Connection`, eventually causing duplicate
        // log delivery (idempotency saves correctness via the UNIQUE
        // index, but inflates parseErrors/duplicateSkipped metrics and
        // wastes memory). `removeOnLogsListener` is fire-and-forget at
        // this layer — if the server has already closed the slot we
        // just log and continue.
        const oldSubId = subscriptionIds.get(label);
        if (oldSubId !== undefined) {
          // Don't await: `onConnectionLost` is not async and we don't
          // want a slow RPC to delay the reconnect schedule.
          void connection.removeOnLogsListener(oldSubId).catch((err) => {
            programLogger(label).warn(
              { err: String(err), sub_id: oldSubId },
              "removeOnLogsListener failed (subscription likely already gone)",
            );
          });
        }
        subscriptionIds.delete(label);
        scheduleReconnect(label, programId);
      }
    },
  });

  return { states: activeStates, metrics: activeMetrics, heartbeat: heartbeatHandle };
}

/**
 * AUD-039 / ADR-118: connection-health heartbeat.
 *
 * Polls `connection.getSlot({ commitment: "confirmed" })` on a fixed
 * interval. Each call is wrapped in a timeout so a hung WebSocket can't
 * block detection. After `failureThreshold` consecutive failures, the
 * `onConnectionLost` callback is invoked once (then the failure counter
 * resets so the next failure burst can trigger another reconnect).
 *
 * The shape is small and synchronous-looking on purpose: the timer fires
 * `tick` without awaiting, and `tick` swallows its own errors so an
 * unhandled rejection from getSlot can't kill the indexer.
 */
export interface HeartbeatOptions {
  intervalMs: number;
  timeoutMs: number;
  failureThreshold: number;
  onConnectionLost: (reason: string) => void;
}

export interface HeartbeatHandle {
  stop: () => void;
  /** Test hook: returns the current consecutive-failure count. */
  consecutiveFailures: () => number;
}

export function startConnectionHeartbeat(
  connection: Pick<Connection, "getSlot">,
  opts: HeartbeatOptions,
): HeartbeatHandle {
  let failures = 0;
  let stopped = false;

  const ping = async (): Promise<void> => {
    // Race getSlot against a timeout so a wedged WS doesn't stall the
    // heartbeat. AbortController would be cleaner but @solana/web3.js
    // <2.0 has no abort signal plumbing through Connection methods.
    const slotPromise = connection.getSlot({ commitment: "confirmed" });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`heartbeat timeout after ${opts.timeoutMs}ms`)),
        opts.timeoutMs,
      ).unref?.();
    });
    await Promise.race([slotPromise, timeoutPromise]);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await ping();
      failures = 0;
    } catch (err) {
      failures++;
      if (failures >= opts.failureThreshold) {
        const reason = (err as Error).message ?? String(err);
        // OFF-210 (cycle-3 off-chain audit): reset the failure counter
        // ONLY after the callback returns successfully. Pre-fix the
        // reset happened BEFORE the call, so a callback that itself
        // threw on the same tick (e.g. a `removeOnLogsListener` reject
        // on a flaky network, or a synchronous re-subscribe error) had
        // its own failure invisibly swallowed AND the heartbeat
        // counter was already at zero — meaning the next outage tick
        // had to climb the threshold from scratch instead of firing
        // immediately. The fix is to keep the counter at the
        // threshold value during the callback, then clear it only on
        // a clean return so a successful re-subscribe re-arms the
        // heartbeat without double-counting the outage on the very
        // next tick. If the callback throws we leave `failures` at
        // its current value: the next failed ping will increment it
        // further (still >= threshold), the next-tick branch will
        // re-fire the callback, and we recover automatically when the
        // callback path becomes healthy. The error path remains
        // logged at ERROR so an operator sees both the outage and the
        // callback failure.
        try {
          opts.onConnectionLost(reason);
          failures = 0;
        } catch (cbErr) {
          logger.error(
            { err: String(cbErr) },
            "heartbeat onConnectionLost callback threw",
          );
          // Intentionally do NOT reset `failures` here — see comment
          // above. The next tick re-evaluates the threshold, and a
          // persistently-failing callback will re-fire (with logging)
          // until it stops throwing.
        }
      }
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, opts.intervalMs);
  // Never block process exit on the heartbeat — SIGINT/SIGTERM handlers
  // (and tests) own shutdown.
  handle.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
    consecutiveFailures: () => failures,
  };
}

function createApi(
  db: Database.Database,
  states?: Map<string, SubscriptionState>,
  metrics?: IndexerMetrics
): express.Application {
  const app = express();
  app.use(express.json());

  // Finding #24: richer health signal. The old /health returned a static
  // "ok" regardless of whether any subscription was actually connected.
  // Now it reports per-program connection state, cursor position, and
  // degrades the top-level status when any subscription is down.
  app.get("/health", (_req: Request, res: Response) => {
    const subscriptions: Array<{
      program: string;
      programId: string;
      connected: boolean;
      lastProcessedSlot: number;
      lastSignature: string | null;
      reconnectAttempts: number;
      lastError: string | null;
    }> = [];

    // If we were given a live state map, surface it; otherwise fall back
    // to the cursor table so a read-only process (e.g. tests) still gets
    // meaningful output.
    if (states) {
      for (const state of states.values()) {
        subscriptions.push({
          program: state.label,
          programId: state.programId,
          connected: state.connected,
          lastProcessedSlot: state.lastProcessedSlot,
          lastSignature: state.lastSignature,
          reconnectAttempts: state.reconnectAttempts,
          lastError: state.lastError,
        });
      }
    } else {
      for (const [label, programId] of Object.entries(PROGRAM_IDS)) {
        const cursor = readCursor(db, label);
        subscriptions.push({
          program: label,
          programId: programId.toBase58(),
          connected: false,
          lastProcessedSlot: cursor?.slot ?? 0,
          lastSignature: cursor?.signature ?? null,
          reconnectAttempts: 0,
          lastError: null,
        });
      }
    }

    const anyDisconnected = states
      ? subscriptions.some((s) => !s.connected)
      : false;
    const status = states && anyDisconnected ? "degraded" : "ok";

    res.json({
      status,
      programs: Object.keys(PROGRAM_IDS),
      subscriptions,
    });
  });

  app.get("/events", (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    const offset = parseInt(req.query.offset as string) || 0;
    const eventName = req.query.event_name as string | undefined;

    let query = "SELECT * FROM events";
    const params: unknown[] = [];

    if (eventName) {
      query += " WHERE event_name = ?";
      params.push(eventName);
    }

    query += " ORDER BY id DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params);
    const countRow = db.prepare("SELECT COUNT(*) as total FROM events").get() as { total: number };

    res.json({ total: countRow.total, limit, offset, events: rows });
  });

  app.get("/events/:program", (req: Request, res: Response) => {
    const program = req.params.program;
    if (!["vault", "registry", "settlement"].includes(program)) {
      res.status(400).json({ error: "Invalid program. Use: vault, registry, settlement" });
      return;
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    const offset = parseInt(req.query.offset as string) || 0;

    const rows = db
      .prepare(
        "SELECT * FROM events WHERE program = ? ORDER BY id DESC LIMIT ? OFFSET ?"
      )
      .all(program, limit, offset);

    const countRow = db
      .prepare("SELECT COUNT(*) as total FROM events WHERE program = ?")
      .get(program) as { total: number };

    res.json({ program, total: countRow.total, limit, offset, events: rows });
  });

  app.get("/agents", (req: Request, res: Response) => {
    const category = req.query.category as string | undefined;
    const minReputation = parseInt(req.query.min_reputation as string) || 0;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    let query = "SELECT * FROM agents WHERE reputation_score >= ?";
    const params: unknown[] = [minReputation];

    if (category) {
      query += " AND category = ?";
      params.push(category);
    }

    query += " ORDER BY reputation_score DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(query).all(...params);
    res.json({ agents: rows });
  });

  app.get("/stats", (_req: Request, res: Response) => {
    const eventCount = db
      .prepare("SELECT COUNT(*) as total FROM events")
      .get() as { total: number };
    const agentCount = db
      .prepare("SELECT COUNT(*) as total FROM agents")
      .get() as { total: number };
    const byProgram = db.prepare("SELECT program, COUNT(*) as count FROM events GROUP BY program").all();
    const byEvent = db.prepare("SELECT event_name, COUNT(*) as count FROM events GROUP BY event_name ORDER BY count DESC LIMIT 20").all();

    res.json({ totalEvents: eventCount.total, totalAgents: agentCount.total, byProgram, topEvents: byEvent });
  });

  // Finding #24: structured metrics. Returns process-lifetime counters
  // (inserts, duplicate skips, backfilled events, reconnects, parse/
  // backfill errors), per-program cursor positions, and per-event-name
  // tallies. Scrape-friendly JSON rather than Prometheus text — the
  // relay-deployer wires this to whatever monitor they run.
  app.get("/metrics", (_req: Request, res: Response) => {
    const lifetime = metrics ?? {
      eventsInserted: 0,
      eventsDuplicateSkipped: 0,
      eventsBackfilled: 0,
      subscriptionReconnects: 0,
      parseErrors: 0,
      backfillErrors: 0,
      startedAt: new Date().toISOString(),
    };

    const cursorRows = db
      .prepare("SELECT program, last_processed_slot, last_signature, updated_at FROM cursor")
      .all() as Array<{
        program: string;
        last_processed_slot: number;
        last_signature: string | null;
        updated_at: string;
      }>;

    const byProgram = db
      .prepare("SELECT program, COUNT(*) as count FROM events GROUP BY program")
      .all() as Array<{ program: string; count: number }>;

    const byEventName = db
      .prepare(
        "SELECT program, event_name, COUNT(*) as count FROM events GROUP BY program, event_name ORDER BY count DESC"
      )
      .all() as Array<{ program: string; event_name: string; count: number }>;

    const subscriptions = states
      ? Array.from(states.values()).map((s) => ({
          program: s.label,
          connected: s.connected,
          lastProcessedSlot: s.lastProcessedSlot,
          reconnectAttempts: s.reconnectAttempts,
        }))
      : [];

    res.json({
      startedAt: lifetime.startedAt,
      uptimeSeconds: Math.floor(
        (Date.now() - new Date(lifetime.startedAt).getTime()) / 1000
      ),
      counters: {
        eventsInserted: lifetime.eventsInserted,
        eventsDuplicateSkipped: lifetime.eventsDuplicateSkipped,
        eventsBackfilled: lifetime.eventsBackfilled,
        subscriptionReconnects: lifetime.subscriptionReconnects,
        parseErrors: lifetime.parseErrors,
        backfillErrors: lifetime.backfillErrors,
      },
      cursors: cursorRows,
      subscriptions,
      eventsByProgram: byProgram,
      eventsByName: byEventName,
    });
  });

  return app;
}

async function main(): Promise<void> {
  logger.info(
    { rpc_url: RPC_URL, commitment: COMMITMENT },
    "AEP event indexer starting",
  );

  const connection = new Connection(RPC_URL, COMMITMENT);
  const db = initDb(process.env.DB_PATH || "./aep-events.db");

  // ADR-128 Phase 1: when INDEXER_PG_URL is set, apply the shadow
  // migration eagerly so dual-write call sites have a schema to write
  // into. Failures here surface in the boot log; the indexer continues
  // because SQLite is authoritative. When the URL is unset, the no-op
  // store's `applyMigration` returns immediately.
  const pgStore = getPostgresStore();
  if (pgStore.enabled) {
    try {
      await pgStore.applyMigration();
      logger.info(
        { adr: "ADR-128", phase: 1 },
        "postgres shadow store enabled — migration applied",
      );
    } catch (err) {
      logger.warn(
        { err: String(err), adr: "ADR-128", phase: 1 },
        "postgres migration failed (sqlite remains authoritative)",
      );
    }
  }

  // OFF-212 (cycle-3 off-chain audit): single-writer guarantee.
  //
  // Pre-fix two indexer processes targeting the same `INDEXER_PG_URL`
  // would both write — idempotency saved correctness on the events
  // table but the cursor and projection rows could race. Fix is a PG
  // session-scoped advisory lock taken at boot:
  //
  //   - When PG is unconfigured (`pgStore.enabled === false`) the
  //     SQLite WAL itself rejects a concurrent writer with
  //     SQLITE_BUSY, so we skip the lock attempt and let WAL do its
  //     job. The lock helper logs an INFO line either way so an
  //     operator can audit which mode is active.
  //
  //   - When PG is configured AND the lock is already held by another
  //     process, we fail-fast at boot with a clear log. The
  //     `INDEXER_ALLOW_NO_WRITER_LOCK=1` opt-out exists so a one-off
  //     debug run (read-only inspection, schema parity check) can
  //     proceed without owning the lock; the default posture is
  //     fail-closed, mirroring ADR-128's opt-in-with-strict-validation
  //     stance.
  //
  // The lock is released by `release()` in the SIGINT handler below,
  // and additionally by Postgres itself on connection close — so an
  // OOM-kill / SIGKILL / host reboot never strands the lock.
  const writerLock: IndexerWriterLockHandle = await acquireIndexerWriterLock(
    pgStore,
  );
  if (pgStore.enabled && !writerLock.acquired) {
    if (process.env.INDEXER_ALLOW_NO_WRITER_LOCK === "1") {
      logger.warn(
        { off: "OFF-212", env: "INDEXER_ALLOW_NO_WRITER_LOCK=1" },
        "indexer writer lock NOT held but starting anyway (operator override)",
      );
    } else {
      logger.fatal(
        { off: "OFF-212" },
        "indexer writer lock NOT acquired — refusing to start (set INDEXER_ALLOW_NO_WRITER_LOCK=1 to override)",
      );
      // Best-effort cleanup before exit so the pool sockets get torn
      // down cleanly rather than leaked into the OS's TIME_WAIT bucket.
      await pgStore.close().catch(() => {});
      db.close();
      process.exit(1);
    }
  }

  const { states, metrics, heartbeat } = subscribeToPrograms(connection, db);
  const app = createApi(db, states, metrics);
  // AUD-203: bind to INDEXER_HOST (loopback by default) so the /metrics
  // endpoint (and its sibling read-only routes) are not advertised on
  // every interface. Mirrors mcp-server/observability.ts post-PR-F.
  app.listen(PORT, INDEXER_HOST, () => {
    logger.info(
      {
        host: INDEXER_HOST,
        port: PORT,
        endpoints: [
          "GET /health",
          "GET /events",
          "GET /events/:program",
          "GET /agents",
          "GET /stats",
          "GET /metrics",
        ],
      },
      "indexer API listening",
    );
  });

  // ADR-131: start the metrics-server companion on a separate port (default
  // 9100, override via METRICS_PORT). Hosts the Prometheus `/metrics` scrape
  // surface AND the two re-calibration trigger JSON endpoints
  // (`/api/metrics/sybil-patterns`, `/api/metrics/escrow-median`) backed by
  // the views in migration 002. The pg.Pool is sourced from the live
  // postgres-store so this server reuses the dual-write pool rather than
  // opening a second connection set; when PG is unconfigured, the trigger
  // endpoints return 503 and the dashboard renders a "metric unavailable"
  // state — the prom scrape surface stays up either way.
  const metricsPort = Number.parseInt(process.env.METRICS_PORT ?? "9100", 10);
  if (Number.isFinite(metricsPort) && metricsPort > 0) {
    startMetricsServer(metricsPort, pgStore.pool);
    logger.info(
      {
        adr: "ADR-131",
        port: metricsPort,
        pgPoolWired: Boolean(pgStore.pool),
        endpoints: [
          "GET /metrics",
          "GET /api/metrics/sybil-patterns",
          "GET /api/metrics/escrow-median",
        ],
      },
      "metrics-server listening",
    );
  }

  // CYCLE4-OFF-001: SIGTERM is what container orchestrators send (k8s,
  // Docker, systemd) before SIGKILL. Without a handler, the process
  // exits at default-kill before `writerLock.release()` runs — PG
  // releases the lock on session teardown anyway (correctness preserved)
  // but rolling-deploy startup is delayed by the next instance waiting
  // for the lock-holder's TCP session to time out. Mirror the SIGINT
  // path for SIGTERM via a shared graceful-shutdown helper.
  const gracefulShutdown = (reason: "SIGINT" | "SIGTERM"): void => {
    logger.info({ reason }, "shutting down");
    heartbeat.stop();
    // OFF-212: release the writer lock explicitly on graceful
    // shutdown. The PG session-close path also releases it, so this
    // is an optimisation for a clean exit, not a correctness
    // primitive — `release()` is idempotent and safe to call even
    // when the lock was never acquired.
    void writerLock.release().catch((err) => {
      logger.warn({ err: String(err), off: "OFF-212" }, "writer lock release failed");
    });
    // ADR-128 Phase 1: close the shadow pool. `close()` is a no-op on
    // DisabledPostgresStore, so this is safe regardless of opt-in.
    void pgStore.close().catch((err) => {
      logger.warn({ err: String(err) }, "postgres pool close failed");
    });
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

// When imported by the test runner, `main()` must not auto-run; guard on
// direct execution only.
if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err: String(err) }, "fatal error");
    process.exit(1);
  });
}

export {
  initDb,
  parseLogsForEvents,
  updateAgentFromEvent,
  createApi,
  subscribeToPrograms,
  readCursor,
  upsertCursor,
  persistEventsForTx,
  backfillProgram,
  createInitialMetrics,
  PROGRAM_IDS,
  DISCRIMINATOR_MAP,
  COMMITMENT,
  INDEXER_HOST,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  HEARTBEAT_FAILURE_THRESHOLD,
};
