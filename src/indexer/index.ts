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

const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const PORT = parseInt(process.env.INDEXER_PORT || "3100", 10);
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
  "611134c2e8133ec3": "ReputationUpdateScheduled",
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
    authority: r.pubkey(),
    new_reputation_score: u64ToJson(r.u64()),
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
  ReputationDeltaProposed: (r) => ({
    authority: r.pubkey(),
    delta: r.u16(),    // i16 in Rust wire-encodes as u16 (little-endian, two's complement)
    reason: r.u8(),
    old_score: r.u8(),
    new_score: r.u8(),
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
    stmt.run(
      authority,
      typeof data.name === "string" ? data.name : null,
      typeof data.category === "string" ? data.category : null
    );
    if (tombstone) {
      db.prepare("DELETE FROM agent_tombstones WHERE authority = ?").run(authority);
    }
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
    stmt.run(typeof data.name === "string" ? data.name : null, authority);
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

  for (const event of events) {
    try {
      const result = insertStmt.run(
        label,
        event.name,
        JSON.stringify(event.data),
        signature,
        slot,
        ordinal
      );
      if (result.changes > 0) {
        inserted++;
        metrics.eventsInserted++;
        updateAgentFromEvent(db, event, slot, signature);
      } else {
        skipped++;
        metrics.eventsDuplicateSkipped++;
      }
    } catch (err) {
      metrics.parseErrors++;
      programLogger(label).error({ err: String(err), corr_id: signature }, "failed to store event");
    }
    ordinal++;
  }

  if (inserted > 0 || skipped > 0) {
    upsertCursor(db, label, slot, signature);
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
): { states: Map<string, SubscriptionState>; metrics: IndexerMetrics } {
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
      state.lastError = `backfill threw: ${(err as Error).message}`;
      programLogger(label).error({ err: String(err) }, "backfill threw");
    });

    // Monitor for WebSocket disconnects via connection error events
    const wsConnection = (connection as unknown as { _rpcWebSocket?: { on?: (event: string, handler: () => void) => void } })._rpcWebSocket;
    if (wsConnection && typeof wsConnection.on === "function") {
      wsConnection.on("close", () => {
        programLogger(label).warn(
          { last_slot: state.lastProcessedSlot },
          "WebSocket closed, scheduling reconnect",
        );
        state.connected = false;
        subscriptionIds.delete(label);
        scheduleReconnect(label, programId);
      });
    }
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

  return { states: activeStates, metrics: activeMetrics };
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

  const { states, metrics } = subscribeToPrograms(connection, db);
  const app = createApi(db, states, metrics);
  app.listen(PORT, () => {
    logger.info(
      {
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

  process.on("SIGINT", () => {
    logger.info("shutting down (SIGINT)");
    db.close();
    process.exit(0);
  });
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
};
