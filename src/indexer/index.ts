/** AEP Off-chain Event Indexer - subscribes to program logs, stores in SQLite, exposes REST API */
import express, { Request, Response } from "express";
import Database from "better-sqlite3";
// ADR-118: per-program write-path mutex. SQLite + WAL allows concurrent
// readers but serialises writers; the better-sqlite3 binding is sync, so
// two interleaved write paths (backfill + live-stream) can't actually
// overlap inside the engine. The mutex serialises at a *higher* layer:
// the live `handleLogs` and the per-tx backfill commit each grab the
// same per-label mutex so a backfill mid-batch advance can't sneak a
// cursor write between the live-stream's INSERT+UPSERT pair. Per-label
// (not global) so the three programs progress independently.
import { Mutex } from "async-mutex";
import {
  address as toAddressBrand,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  getAddressDecoder,
  type Address,
  type Commitment,
  type Signature,
  type Slot,
} from "@solana/kit";

// ADR-087 Phase A target #2 — @solana/web3.js v1 → @solana/kit v2 migration.
//
// v1→v2 mapping summary (see docs/audits/SOLANA-V2-MIGRATION-PLAN-2026-05-04.md
// §3.1 and the indexer-specific mapping in the Phase A target #2 brief):
//
//   Connection             → SolanaRpc (HTTP) + SolanaRpcSubscriptions (WS)
//   PublicKey              → Address (base58 string brand)
//   pubkey.toBase58()      → pubkey                       (Address is a string)
//   getSignaturesForAddress(pk, opts, commitment)
//                          → rpc.getSignaturesForAddress(addr, { ..., commitment }).send()
//   getTransaction(sig, opts)
//                          → rpc.getTransaction(sig, { ..., encoding: "json" }).send()
//   getSlot({ commitment }) → rpc.getSlot({ commitment }).send()  (returns bigint)
//   onLogs(pk, cb, commit) returning subId
//                          → rpcSubs.logsNotifications({ mentions: [addr] }, { commitment })
//                                  .subscribe({ abortSignal }) returns AsyncIterable
//   removeOnLogsListener(subId)
//                          → abortController.abort()  (per-label AbortController)
//   Logs, Context           → notification.{value,context} from logsNotifications
//   ConfirmedSignatureInfo  → GetSignaturesForAddressApi response element (inlined)
//   Finality                → string literal "finalized" | "confirmed"
//
// Slot / UnixTimestamp are bigint in v2 — coerced with Number(...) at the
// SQLite storage boundary (INTEGER columns map to JS number, not BigInt).

type SolanaRpc = ReturnType<typeof createSolanaRpc>;
type SolanaRpcSubscriptions = ReturnType<typeof createSolanaRpcSubscriptions>;

// 32-byte-buffer → base58 Address. Replaces `new PublicKey(buf).toBase58()`
// inside the borsh reader's `pubkey()` field. The decoder is constructed
// once at module load — same allocation cost as the cached encoder in
// mcp-server/src/solana-v2.ts.
const ADDRESS_DECODER = getAddressDecoder();
function bytesToAddress(buf: Buffer | Uint8Array): string {
  // ADDRESS_DECODER returns the branded `Address` (a base58 string);
  // we widen it to string at the call site because the borsh reader's
  // contract is "return a base58 pubkey string", not "return an Address".
  return ADDRESS_DECODER.decode(buf as Uint8Array) as string;
}

// Mirror mcp-server/src/solana-v2.ts::resolveWsUrl — derive the WS URL from
// SOLANA_WS_URL (explicit override), otherwise rewrite SOLANA_RPC_URL's
// scheme (http→ws, https→wss). Exported so tests can verify the precedence.
export function resolveWsUrl(): string {
  const explicit = process.env.SOLANA_WS_URL;
  if (explicit && explicit.length > 0) return explicit;
  const http = process.env.SOLANA_RPC_URL;
  if (http && http.length > 0) {
    if (http.startsWith("https://")) return "wss://" + http.slice("https://".length);
    if (http.startsWith("http://")) return "ws://" + http.slice("http://".length);
    return http;
  }
  return "ws://127.0.0.1:8900";
}
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
const PROGRAM_IDS: Record<"vault" | "registry" | "settlement", Address> = {
  vault: toAddressBrand("28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw"),
  registry: toAddressBrand("psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv"),
  settlement: toAddressBrand("9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95"),
};

// Finding #23: "confirmed" can be rolled back by a fork. Use "finalized"
// so the indexer never persists an event from a transaction that might
// later be dropped. This adds ~10-20s latency versus "confirmed" but is
// the correct tradeoff for an authoritative event log.
// In @solana/kit v2 the narrower "Finality" union is gone; we pin the
// commitment as the literal `"finalized"` (still a valid `Commitment`).
// getSignaturesForAddress's config type EXCLUDES "processed" but accepts
// "finalized"; getTransaction accepts the full Commitment union — both
// fit. Narrowing the type to "finalized" here also guards against a
// future ` const COMMITMENT: Commitment = ... ` typo silently widening
// the indexer to "confirmed".
const COMMITMENT = "finalized" as const;
type IndexerCommitment = typeof COMMITMENT;
// Local breadcrumb: the heartbeat uses "confirmed" (cheaper, doesn't
// require finality wait — it's just a liveness probe), not COMMITMENT.

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
  // ADR-118: synchronous = FULL forces an fsync on every commit so a
  // power-loss / kernel-panic mid-batch cannot leave the WAL with a
  // committed-but-unsynced page. Cost is one fsync per commit, which is
  // affordable here because writes are batched at the
  // `persistEventsForTx` granularity (one tx = one commit), not per
  // event. Combined with the per-program write mutex (see below) this
  // closes R-offchain-02 from the 2026-05 re-audit.
  db.pragma("synchronous = FULL");

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

    -- ADR-138: execution-provenance attestations. Persists every
    -- ExecutionAttested event emitted by the agent-vault program so
    -- consumers can answer "which agent, under which delegation/policy,
    -- executing which tool, with which manifest, at what slot?".
    -- The PG mirror lives in migration 003-adr-138-execution-attestations.sql;
    -- this SQLite block stays in lockstep with that file. Schema notes:
    --   * tool_id / manifest_hash kept as TEXT hex strings (64 chars).
    --   * amount as TEXT (u64 lossless round-trip per coerceU64String).
    --   * delegation_grant / mint / recipient NULLable (Borsh Option).
    --   * Idempotency primitive: UNIQUE(tx_signature, instruction_index).
    --   * Hot-path indexes match the 003 migration: by agent, vault,
    --     and tool_id; each trailing on slot DESC for paginating reads.
    CREATE TABLE IF NOT EXISTS execution_attestations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_signature TEXT NOT NULL,
      instruction_index INTEGER NOT NULL DEFAULT 0,
      vault TEXT NOT NULL,
      agent_identity TEXT NOT NULL,
      authority TEXT NOT NULL,
      action_kind TEXT NOT NULL CHECK (action_kind IN (
        'Transfer','TokenTransfer','PolicyUpdate','AllowlistManage',
        'IdentityRotation','PauseToggle','GrantTransfer','GrantTokenTransfer'
      )),
      tool_id TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      delegation_grant TEXT,
      amount TEXT NOT NULL DEFAULT '0',
      mint TEXT,
      recipient TEXT,
      slot INTEGER NOT NULL,
      event_timestamp INTEGER NOT NULL,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
      decoded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_exec_attest_unique
      ON execution_attestations(tx_signature, instruction_index);
    CREATE INDEX IF NOT EXISTS idx_exec_attest_agent_slot
      ON execution_attestations(agent_identity, slot DESC);
    CREATE INDEX IF NOT EXISTS idx_exec_attest_vault_slot
      ON execution_attestations(vault, slot DESC);
    CREATE INDEX IF NOT EXISTS idx_exec_attest_tool_slot
      ON execution_attestations(tool_id, slot DESC);

    -- ADR-111: Per-grant current-state projection. Bumped on
    -- DelegationGrantCreated (insert), DelegationGrantRevoked (update),
    -- DelegationGrantUpdated (update), DelegationGrantExecuted
    -- (running tally updates). The SQLite mirror is kept in lockstep
    -- with migrations/004-adr-111-delegation-grants.sql; the parity
    -- test in test/aud-202-migration-embedded.test.ts pins the
    -- Postgres shape.
    CREATE TABLE IF NOT EXISTS delegation_grants (
      grant_address TEXT PRIMARY KEY,
      vault TEXT NOT NULL,
      grantor TEXT NOT NULL,
      grantee TEXT NOT NULL,
      nonce INTEGER NOT NULL CHECK(nonce >= 0 AND nonce <= 255),
      allowed_actions INTEGER NOT NULL,
      spend_cap_lamports TEXT NOT NULL,
      spent_lamports TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_seen_slot INTEGER NOT NULL,
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_delegation_grants_vault   ON delegation_grants(vault);
    CREATE INDEX IF NOT EXISTS idx_delegation_grants_grantee ON delegation_grants(grantee);

    -- ADR-111: Append-only audit log for every delegation-grant lifecycle
    -- event. One row per Created / Revoked / Updated / Executed.
    CREATE TABLE IF NOT EXISTS delegation_grant_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('Created', 'Revoked', 'Updated', 'Executed')),
      grant_address TEXT NOT NULL,
      vault TEXT NOT NULL,
      grantee TEXT,
      grantor TEXT,
      revoker TEXT,
      recipient TEXT,
      mint TEXT,
      action_kind INTEGER,
      allowed_actions INTEGER,
      spend_cap_lamports TEXT,
      amount TEXT,
      spent_after TEXT,
      expires_at INTEGER,
      nonce INTEGER,
      event_timestamp INTEGER NOT NULL,
      slot INTEGER NOT NULL,
      signature TEXT NOT NULL,
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dgrant_events_grant ON delegation_grant_events(grant_address);
    CREATE INDEX IF NOT EXISTS idx_dgrant_events_vault ON delegation_grant_events(vault);
    CREATE INDEX IF NOT EXISTS idx_dgrant_events_kind  ON delegation_grant_events(kind);
    CREATE INDEX IF NOT EXISTS idx_dgrant_events_slot  ON delegation_grant_events(slot);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dgrant_events_unique
      ON delegation_grant_events(grant_address, signature, slot, kind);
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
  // Q-S3-A: CdpWalletUpdated — emitted by update_cdp_wallet (Surface-3
  // CDP-wallet binding). Pre-fix, the event surfaced on-chain but the
  // indexer classified it as `event_<hex>` because no disc-map entry
  // existed; the coverage gate caught this only after the on-chain
  // event landed without a paired indexer decoder.
  "1c01a7c0b68356b6": "CdpWalletUpdated",

  // agent-vault
  b42bcf021247034b: "VaultInitialized",
  // ADR-138: ExecutionAttested. sha256("event:ExecutionAttested")[0..8].
  // Emitted by every value-moving or authority-changing instruction in
  // the agent-vault program. The decoder lives below in EVENT_DECODERS.
  "6715b47fb9c66172": "ExecutionAttested",
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
  // ADR-111: delegation-grant events. Disc-map values match
  // sha256("event:<Name>")[..8]; cross-verified by
  // scripts/check-event-coverage.ts on every CI run.
  "37ea91e0d721da14": "DelegationGrantCreated",
  "597b42ded5f14ef3": "DelegationGrantRevoked",
  de3e0cc9bca0dfc7: "DelegationGrantUpdated",
  b588434af4e727f9: "DelegationGrantExecuted",

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
  // C4-OB-02 (cycle-4, PR #176): EscrowClosed — emitted by the now
  // non-no-op `close_escrow` after the residual ATA sweep + close.
  "6d143933d97603ad": "EscrowClosed",
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

  // cctp-hook (Surface-3 CCTP V2 round-trip)
  // MilestoneAutoApproved — emitted from auto_approve_milestone after
  // the CPI into Settlement returns successfully. sha256("event:Milestone
  // AutoApproved")[0..8]. Coverage gate flagged this as missing once the
  // cctp-hook program landed without a paired indexer disc-map entry.
  "813e91dc8abf032e": "MilestoneAutoApproved",
};

// ADR-142 — cctp-hook program id. The indexer does NOT open a
// `logsNotifications` subscription for cctp-hook; `MilestoneAutoApproved`
// is emitted via CPI inside a settlement-mentioning transaction, so the
// event is observed on the `settlement` subscription but its *emitting*
// program is cctp-hook. The provenance gate must therefore know
// cctp-hook's address to attribute that one event correctly.
// Mirrors `programs/cctp-hook/src/lib.rs::declare_id!()`.
const CCTP_HOOK_PROGRAM_ID: Address = toAddressBrand(
  "3yifMBDVChLzcihZWh4or9zxgzbmQVghdNZzpuP814vb",
);

// ADR-142 — every decoded event is bound to the program that is
// *legitimately allowed to emit it*. CC-1: `logsNotifications({mentions:
// [programId]})` returns logs for EVERY program in any transaction merely
// mentioning the subscribed program, so a foreign program can emit a
// `Program data:` line whose 8-byte discriminator collides with a trusted
// event. Classification by discriminator alone is no longer a trusted
// authority for persistence — the emitting program (resolved from the
// `Program <id> invoke/success/failed` scope brackets in the log stream,
// see `parseLogsForEvents`) MUST equal the expected owner below before an
// event is persisted. Sourced from each program's `src/events.rs`.
const EVENT_PROGRAM: Record<string, Address> = (() => {
  const m: Record<string, Address> = {};
  const reg = PROGRAM_IDS.registry;
  const vault = PROGRAM_IDS.vault;
  const settle = PROGRAM_IDS.settlement;
  // agent-registry/src/events.rs
  for (const e of [
    "AgentRegistered",
    "AgentProfileUpdated",
    "AgentStatusUpdated",
    "ReputationUpdated",
    "ReputationStaked",
    "AgentSlashed",
    "ReputationUnstaked",
    "AgentDeregistered",
    "SuspensionCleared",
    "ManifestUpdated",
    "AgentMigrated",
    "CdpWalletUpdated",
    "ReputationDeltaProposed",
  ]) {
    m[e] = reg;
  }
  // agent-vault/src/events.rs
  for (const e of [
    "VaultInitialized",
    "AgentIdentityUpdated",
    "PolicyUpdated",
    "TransactionExecuted",
    "ProgramCallExecuted",
    "TokenTransferExecuted",
    "AllowlistUpdated",
    "VaultPaused",
    "VaultResumed",
    "ExecutionAttested",
    "DelegationGrantCreated",
    "DelegationGrantRevoked",
    "DelegationGrantUpdated",
    "DelegationGrantExecuted",
  ]) {
    m[e] = vault;
  }
  // settlement/src/events.rs
  for (const e of [
    "EscrowCreated",
    "TaskAccepted",
    "MilestoneSubmitted",
    "MilestoneApproved",
    "MilestoneRejected",
    "EscrowCompleted",
    "DisputeRaised",
    "DisputeResolved",
    "EscrowCancelled",
    "EscrowExpired",
    "EscrowClosed",
    "ProtocolConfigInitialized",
    "ProtocolConfigUpdated",
  ]) {
    m[e] = settle;
  }
  // cctp-hook/src/events.rs (CPI-emitted under a settlement-mentioning tx)
  m["MilestoneAutoApproved"] = CCTP_HOOK_PROGRAM_ID;
  return m;
})();

/**
 * ADR-142 — resolve the emitting program for each `Program data:` line by
 * walking the runtime invoke/return scope brackets Solana writes into
 * `logMessages`:
 *
 *   "Program <id> invoke [1]"     → push <id>
 *   "Program <id> success"        → pop (matching innermost <id>)
 *   "Program <id> failed: ..."    → pop (matching innermost <id>)
 *   "Program data: <base64>"      → attributed to stack top (innermost)
 *
 * Anchor's `emit!` writes the `Program data:` line while the emitting
 * program frame is still active, so the innermost (top-of-stack) program
 * is the true emitter. When the log stream carries NO bracket lines at
 * all (sparse RPC responses, and the many unit-test fixtures that pass
 * only `Program data:` lines) we cannot resolve a per-line program; the
 * caller falls back to the discriminator→owner binding gated by the
 * subscribed label (still closes CC-1 for the realistic attack: a foreign
 * program's collision discriminator maps to a trusted event whose owner
 * is NOT the subscribed program).
 */
function attributeLogsToPrograms(
  logs: string[],
): { emittingProgram: (string | null)[]; sawBrackets: boolean } {
  const invokeRe = /^Program (\S+) invoke \[\d+\]$/;
  const successRe = /^Program (\S+) success$/;
  const failedRe = /^Program (\S+) failed/;
  const stack: string[] = [];
  const emittingProgram: (string | null)[] = [];
  let sawBrackets = false;
  for (const log of logs) {
    const inv = log.match(invokeRe);
    if (inv) {
      sawBrackets = true;
      stack.push(inv[1]);
      emittingProgram.push(null);
      continue;
    }
    const suc = log.match(successRe);
    if (suc) {
      sawBrackets = true;
      // Pop the matching innermost frame (defensive: only if it matches
      // the top, so a malformed/forged "success" for a program that
      // isn't actually the innermost frame cannot prematurely unwind a
      // legitimate parent frame).
      if (stack.length > 0 && stack[stack.length - 1] === suc[1]) {
        stack.pop();
      }
      emittingProgram.push(null);
      continue;
    }
    const fail = log.match(failedRe);
    if (fail) {
      sawBrackets = true;
      if (stack.length > 0 && stack[stack.length - 1] === fail[1]) {
        stack.pop();
      }
      emittingProgram.push(null);
      continue;
    }
    emittingProgram.push(stack.length > 0 ? stack[stack.length - 1] : null);
  }
  return { emittingProgram, sawBrackets };
}

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
    // @solana/kit v2: AddressDecoder turns 32 raw bytes into a base58
    // string-branded `Address`. We return it as `string` to preserve
    // the BorshReader contract used by every downstream consumer
    // (event decoders, JSON projection, SQLite text columns).
    return bytesToAddress(slice);
  }

  string(): string {
    const len = this.u32();
    // C4-OFF-01: the u32 length prefix comes from an untrusted on-chain
    // `Program data:` log. `subarray` SILENTLY CLAMPS to the buffer end,
    // so a hostile/truncated payload whose declared `len` exceeds the
    // remaining bytes would (pre-fix) yield a short string and then
    // advance `offset` by the *declared* `len` — desynchronising every
    // subsequent field (the generic AUD-004 offset-drift class). Bounds-
    // check BEFORE the read and throw a RangeError (mirrors `hexBytes`'
    // existing guard); the throw is caught at the `parseLogsForEvents`
    // decode boundary and downgraded to a classified `rawData` row, so a
    // corrupt log can no longer poison the projection. The check is
    // written `len > remaining` (not `offset+len > buf.length`) so a
    // ~4 GiB declared `len` cannot overflow the addition or drive a
    // multi-GiB `toString("utf8")` allocation before the bound is tested.
    const remaining = this.buf.length - this.offset;
    if (len > remaining) {
      throw new RangeError(
        `string: declared length ${len} exceeds ${remaining} remaining bytes`,
      );
    }
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

// Borsh `Option<[u8; n]>` — wire-encoded as a u8 tag (0=None, 1=Some)
// followed by exactly `n` raw bytes when Some. Used by CdpWalletUpdated's
// old_wallet / new_wallet (EVM 20-byte addresses). Returns null for None
// and a hex string for Some so the JSON projection stays stable.
function optionHexBytes(r: BorshReader, n: number): string | null {
  const tag = r.u8();
  if (tag === 0) return null;
  if (tag === 1) return r.hexBytes(n);
  throw new Error(`optionHexBytes: invalid Borsh Option tag ${tag} (expected 0|1)`);
}

// ADR-138: Borsh `Option<Pubkey>` — wire-encoded as a u8 tag
// (0=None, 1=Some) followed by 32 raw bytes when Some. Returns null
// for None or a base58 `Address` string for Some so the JSON
// projection mirrors every other Pubkey field decoded in this module.
function optionPubkey(r: BorshReader): string | null {
  const tag = r.u8();
  if (tag === 0) return null;
  if (tag === 1) return r.pubkey();
  throw new Error(`optionPubkey: invalid Borsh Option tag ${tag} (expected 0|1)`);
}

// ADR-138: declaration order of `ActionKind` in
// programs/agent-vault/src/events.rs. Borsh encodes the enum as a
// positional 1-byte tag; reordering the Rust enum without updating this
// array silently mis-decodes every ExecutionAttested event. The pin
// test in `tests/indexer.test.ts` MUST fail loudly if either side
// drifts.
const ACTION_KIND_VARIANTS = [
  "Transfer",
  "TokenTransfer",
  "PolicyUpdate",
  "AllowlistManage",
  "IdentityRotation",
  "PauseToggle",
  "GrantTransfer",
  "GrantTokenTransfer",
] as const;

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

  // Q-S3-A: CdpWalletUpdated (agent-registry, Surface-3 CDP-wallet binding).
  // Wire layout from programs/agent-registry/src/events.rs:
  //   pub authority: Pubkey
  //   pub old_wallet: Option<[u8; 20]>   // 1-byte Borsh tag + 20 raw bytes when Some
  //   pub new_wallet: Option<[u8; 20]>   // same encoding; None on clear (session-end)
  //   pub timestamp: i64
  //
  // old_wallet is None for the first binding; new_wallet is None when the
  // binding is cleared. Block-body decoder so the two Option<> reads can be
  // sequenced explicitly without inlining the tag-dispatch into every line.
  CdpWalletUpdated: (r) => {
    const authority = r.pubkey();
    const old_wallet = optionHexBytes(r, 20);
    const new_wallet = optionHexBytes(r, 20);
    const timestamp = i64ToJson(r.i64());
    return { authority, old_wallet, new_wallet, timestamp };
  },

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

  // ADR-082 decoder gap closure: agent-vault events (commit 1 of 4).
  // All 8 events below had DISCRIMINATOR_MAP entries but no
  // EVENT_DECODERS entries, so they fell through to the
  // {discriminator, rawData} forensics fallback. Field layouts are
  // copied verbatim from programs/agent-vault/src/events.rs; field
  // names match the Rust struct field names so downstream consumers
  // can index by the same identifiers used on-chain.

  // VaultInitialized — emitted by initialize_vault.
  // Wire layout:
  //   pub vault: Pubkey
  //   pub agent_identity: Pubkey
  //   pub authority: Pubkey
  //   pub daily_limit: u64
  //   pub per_tx_limit: u64
  VaultInitialized: (r) => ({
    vault: r.pubkey(),
    agent_identity: r.pubkey(),
    authority: r.pubkey(),
    daily_limit: u64ToJson(r.u64()),
    per_tx_limit: u64ToJson(r.u64()),
  }),

  // PolicyUpdated — emitted on vault policy edits.
  // Wire layout:
  //   pub vault: Pubkey
  //   pub daily_limit: u64
  //   pub per_tx_limit: u64
  //   pub max_txs_per_hour: u32
  PolicyUpdated: (r) => ({
    vault: r.pubkey(),
    daily_limit: u64ToJson(r.u64()),
    per_tx_limit: u64ToJson(r.u64()),
    max_txs_per_hour: r.u32(),
  }),

  // TransactionExecuted — SOL transfer from vault.
  // Wire layout:
  //   pub vault: Pubkey
  //   pub recipient: Pubkey
  //   pub amount: u64
  //   pub timestamp: i64
  //   pub success: bool
  TransactionExecuted: (r) => ({
    vault: r.pubkey(),
    recipient: r.pubkey(),
    amount: u64ToJson(r.u64()),
    timestamp: i64ToJson(r.i64()),
    success: r.bool(),
  }),

  // ProgramCallExecuted — CPI to an allowlisted program.
  // Wire layout:
  //   pub vault: Pubkey
  //   pub program_id: Pubkey
  //   pub instruction_hash: [u8; 32]
  //   pub timestamp: i64
  //   pub success: bool
  ProgramCallExecuted: (r) => ({
    vault: r.pubkey(),
    program_id: r.pubkey(),
    instruction_hash: r.hexBytes(32),
    timestamp: i64ToJson(r.i64()),
    success: r.bool(),
  }),

  // TokenTransferExecuted — SPL token transfer from vault.
  // Wire layout (NOTE: no `success` field, unlike TransactionExecuted):
  //   pub vault: Pubkey
  //   pub mint: Pubkey
  //   pub recipient: Pubkey
  //   pub amount: u64
  //   pub timestamp: i64
  TokenTransferExecuted: (r) => ({
    vault: r.pubkey(),
    mint: r.pubkey(),
    recipient: r.pubkey(),
    amount: u64ToJson(r.u64()),
    timestamp: i64ToJson(r.i64()),
  }),

  // AllowlistUpdated — recipient/program allowlist mutation.
  // Wire layout:
  //   pub vault: Pubkey
  //   pub item: Pubkey
  //   pub action: String
  AllowlistUpdated: (r) => ({
    vault: r.pubkey(),
    item: r.pubkey(),
    action: r.string(),
  }),

  // VaultPaused — emergency-pause toggle on.
  // Wire layout:
  //   pub vault: Pubkey
  VaultPaused: (r) => ({
    vault: r.pubkey(),
  }),

  // VaultResumed — emergency-pause toggle off.
  // Wire layout:
  //   pub vault: Pubkey
  VaultResumed: (r) => ({
    vault: r.pubkey(),
  }),

  // ADR-138: ExecutionAttested — provenance record emitted at the end of
  // every value-moving or authority-changing vault instruction.
  // Wire layout from programs/agent-vault/src/events.rs:
  //   pub vault: Pubkey
  //   pub agent_identity: Pubkey
  //   pub authority: Pubkey
  //   pub action_kind: ActionKind          // 1-byte positional enum tag
  //   pub tool_id: [u8; 32]
  //   pub manifest_hash: [u8; 32]
  //   pub policy_version: u32
  //   pub delegation_grant: Option<Pubkey> // ADR-111 reserve; None here
  //   pub amount: u64
  //   pub mint: Option<Pubkey>
  //   pub recipient: Option<Pubkey>
  //   pub slot: u64
  //   pub timestamp: i64
  //
  // ACTION_KIND_VARIANTS must stay in declaration-order lockstep with
  // the Rust enum (same drift hazard as AGENT_STATUS_VARIANTS).
  ExecutionAttested: (r) => {
    const vault = r.pubkey();
    const agent_identity = r.pubkey();
    const authority = r.pubkey();
    const actionTag = r.u8();
    const action_kind =
      ACTION_KIND_VARIANTS[actionTag] ?? `Unknown(${actionTag})`;
    const tool_id = r.hexBytes(32);
    const manifest_hash = r.hexBytes(32);
    const policy_version = r.u32();
    const delegation_grant = optionPubkey(r);
    const amount = u64ToJson(r.u64());
    const mint = optionPubkey(r);
    const recipient = optionPubkey(r);
    const slot = u64ToJson(r.u64());
    const timestamp = i64ToJson(r.i64());
    return {
      vault,
      agent_identity,
      authority,
      action_kind,
      tool_id,
      manifest_hash,
      policy_version,
      delegation_grant,
      amount,
      mint,
      recipient,
      slot,
      timestamp,
    };
  },

  // ADR-111: delegation-grant events. Field layouts mirror
  // programs/agent-vault/src/events.rs verbatim; field names match the
  // Rust struct field names so downstream consumers can index by the
  // same identifiers used on-chain.

  // DelegationGrantCreated — emitted by create_delegation_grant.
  DelegationGrantCreated: (r) => ({
    vault: r.pubkey(),
    grant: r.pubkey(),
    grantor: r.pubkey(),
    grantee: r.pubkey(),
    allowed_actions: r.u8(),
    spend_cap_lamports: u64ToJson(r.u64()),
    expires_at: i64ToJson(r.i64()),
    nonce: r.u8(),
    timestamp: i64ToJson(r.i64()),
  }),

  // DelegationGrantRevoked — emitted by revoke_delegation_grant.
  DelegationGrantRevoked: (r) => ({
    vault: r.pubkey(),
    grant: r.pubkey(),
    revoker: r.pubkey(),
    timestamp: i64ToJson(r.i64()),
  }),

  // DelegationGrantUpdated — emitted by update_delegation_grant.
  DelegationGrantUpdated: (r) => ({
    vault: r.pubkey(),
    grant: r.pubkey(),
    new_allowed_actions: r.u8(),
    new_spend_cap_lamports: u64ToJson(r.u64()),
    new_expires_at: i64ToJson(r.i64()),
    timestamp: i64ToJson(r.i64()),
  }),

  // DelegationGrantExecuted — emitted on a successful
  // execute_grant_transfer / execute_grant_token_transfer.
  DelegationGrantExecuted: (r) => ({
    vault: r.pubkey(),
    grant: r.pubkey(),
    grantee: r.pubkey(),
    action_kind: r.u8(),
    mint: r.pubkey(),
    recipient: r.pubkey(),
    amount: u64ToJson(r.u64()),
    spent_after: u64ToJson(r.u64()),
    timestamp: i64ToJson(r.i64()),
  }),

  // ADR-082 decoder gap closure: agent-registry events (commit 2 of 4).
  // All 3 events below had DISCRIMINATOR_MAP entries but no
  // EVENT_DECODERS entries, so they fell through to the
  // {discriminator, rawData} forensics fallback. Field layouts are
  // copied verbatim from programs/agent-registry/src/events.rs; field
  // names match the Rust struct field names so downstream consumers
  // can index by the same identifiers used on-chain.

  // ReputationStaked — emitted when an agent stakes reputation.
  // Wire layout:
  //   pub authority: Pubkey
  //   pub amount: u64
  //   pub total_staked: u64
  //   pub timestamp: i64
  ReputationStaked: (r) => ({
    authority: r.pubkey(),
    amount: u64ToJson(r.u64()),
    total_staked: u64ToJson(r.u64()),
    timestamp: i64ToJson(r.i64()),
  }),

  // AgentSlashed — emitted when an agent's stake is slashed.
  // Wire layout:
  //   pub authority: Pubkey
  //   pub total_slashes: u32      // AUD-111: widened from u8 → u32 at the
  //                               // event surface (cast at emit-time is
  //                               // `as u32`, lossless). The on-disk
  //                               // profile still carries `slash_count: u8`
  //                               // — do NOT confuse the two; this decoder
  //                               // pins the EVENT wire format.
  //   pub suspended: bool
  //   pub timestamp: i64
  AgentSlashed: (r) => ({
    authority: r.pubkey(),
    total_slashes: r.u32(),
    suspended: r.bool(),
    timestamp: i64ToJson(r.i64()),
  }),

  // ReputationUnstaked — emitted when an agent withdraws staked reputation.
  // Wire layout:
  //   pub authority: Pubkey
  //   pub amount: u64
  //   pub remaining_staked: u64
  //   pub timestamp: i64
  ReputationUnstaked: (r) => ({
    authority: r.pubkey(),
    amount: u64ToJson(r.u64()),
    remaining_staked: u64ToJson(r.u64()),
    timestamp: i64ToJson(r.i64()),
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

  // ADR-082 decoder gap closure: settlement events (commit 3 of 3 — final).
  // All 7 events below had DISCRIMINATOR_MAP entries but no
  // EVENT_DECODERS entries, so they fell through to the
  // {discriminator, rawData} forensics fallback. Field layouts are
  // copied verbatim from programs/settlement/src/events.rs; field
  // names match the Rust struct field names so downstream consumers
  // can index by the same identifiers used on-chain. EscrowCreated,
  // DisputeRaised, and DisputeResolved (the other three settlement
  // events) were already wired above as part of the ADR-131 trigger
  // surface — this batch finishes the settlement decoder set.
  //
  // Closing this batch takes the gate decoder-less count from 7 -> 0
  // across all 33 declared #[event] structs; the indexer-event-
  // coverage test is flipped back to the OK contract in the same
  // commit so the tree never sits in a state where the gate passes
  // but the test asserts it should fail.

  // TaskAccepted — emitted when the provider accepts an escrow task.
  // Wire layout:
  //   pub escrow: Pubkey
  //   pub provider: Pubkey
  //   pub task_id: u64
  TaskAccepted: (r) => ({
    escrow: r.pubkey(),
    provider: r.pubkey(),
    task_id: u64ToJson(r.u64()),
  }),

  // MilestoneSubmitted — provider submits a milestone for review.
  // Wire layout (NOTE: 2nd actor field is `provider`, unlike the
  // approve/reject events whose 2nd actor is `client` — preserve
  // declaration order verbatim):
  //   pub escrow: Pubkey
  //   pub provider: Pubkey
  //   pub milestone_index: u32
  //   pub task_id: u64
  MilestoneSubmitted: (r) => ({
    escrow: r.pubkey(),
    provider: r.pubkey(),
    milestone_index: r.u32(),
    task_id: u64ToJson(r.u64()),
  }),

  // MilestoneApproved — client approves a submitted milestone and
  // releases the milestone-tranche payout.
  // Wire layout:
  //   pub escrow: Pubkey
  //   pub client: Pubkey
  //   pub milestone_index: u32
  //   pub amount: u64
  //   pub task_id: u64
  MilestoneApproved: (r) => ({
    escrow: r.pubkey(),
    client: r.pubkey(),
    milestone_index: r.u32(),
    amount: u64ToJson(r.u64()),
    task_id: u64ToJson(r.u64()),
  }),

  // MilestoneRejected — client rejects a submitted milestone.
  // Wire layout (no `amount` field — rejection releases nothing):
  //   pub escrow: Pubkey
  //   pub client: Pubkey
  //   pub milestone_index: u32
  //   pub task_id: u64
  MilestoneRejected: (r) => ({
    escrow: r.pubkey(),
    client: r.pubkey(),
    milestone_index: r.u32(),
    task_id: u64ToJson(r.u64()),
  }),

  // EscrowCompleted — final milestone approved, escrow fully settled.
  // Wire layout:
  //   pub escrow: Pubkey
  //   pub provider: Pubkey
  //   pub task_id: u64
  //   pub total_released: u64
  EscrowCompleted: (r) => ({
    escrow: r.pubkey(),
    provider: r.pubkey(),
    task_id: u64ToJson(r.u64()),
    total_released: u64ToJson(r.u64()),
  }),

  // EscrowCancelled — client cancels a not-yet-accepted escrow.
  // Wire layout:
  //   pub escrow: Pubkey
  //   pub client: Pubkey
  //   pub task_id: u64
  //   pub refunded_amount: u64
  EscrowCancelled: (r) => ({
    escrow: r.pubkey(),
    client: r.pubkey(),
    task_id: u64ToJson(r.u64()),
    refunded_amount: u64ToJson(r.u64()),
  }),

  // EscrowExpired — deadline passed without delivery; refund issued.
  // Wire layout (NOTE: no `client` field — the on-chain handler
  // reads it from the escrow account but the event surface omits
  // it; preserve declaration order verbatim):
  //   pub escrow: Pubkey
  //   pub task_id: u64
  //   pub refunded_amount: u64
  EscrowExpired: (r) => ({
    escrow: r.pubkey(),
    task_id: u64ToJson(r.u64()),
    refunded_amount: u64ToJson(r.u64()),
  }),

  // C4-OB-02 (cycle-4, PR #176): EscrowClosed — emitted by the now
  // non-no-op `close_escrow` once a terminal escrow is torn down. The
  // pre-fix handler was `Ok(())` (no event); the fix sweeps any residual
  // escrow-ATA balance to the client then `close_account`s the ATA before
  // Anchor closes the PDA. `residual_swept` is 0 on the normal
  // drained-by-settlement path; non-zero flags an unsolicited direct
  // transfer into the escrow ATA that the close path recovered. Wire
  // layout verbatim from programs/settlement/src/events.rs `EscrowClosed`
  // (Borsh is positional — order MUST match the struct):
  //   pub escrow: Pubkey
  //   pub client: Pubkey
  //   pub task_id: u64
  //   pub residual_swept: u64
  EscrowClosed: (r) => ({
    escrow: r.pubkey(),
    client: r.pubkey(),
    task_id: u64ToJson(r.u64()),
    residual_swept: u64ToJson(r.u64()),
  }),

  // Surface-3 / cctp-hook: MilestoneAutoApproved.
  // Wire layout from programs/cctp-hook/src/events.rs:
  //   pub escrow: Pubkey
  //   pub milestone_index: u8
  //   pub base_tx_hash: [u8; 32]
  //   pub amount_returned_micros: u64
  //   pub agent_authority: Pubkey
  //
  // Note milestone_index is u8 here (the cctp-hook only auto-approves the
  // final milestone of an escrow and the on-chain handler casts down from
  // u32), unlike the settlement program's MilestoneSubmitted/Approved/
  // Rejected which carry u32 milestone_index. base_tx_hash is the Base-
  // side burn tx hash, surfaced as a hex string for the cross-chain link.
  MilestoneAutoApproved: (r) => ({
    escrow: r.pubkey(),
    milestone_index: r.u8(),
    base_tx_hash: r.hexBytes(32),
    amount_returned_micros: u64ToJson(r.u64()),
    agent_authority: r.pubkey(),
  }),
};

// ADR-142 — `programLabel` is the subscribed program for this log stream
// (`vault` | `registry` | `settlement`, the `mentions:[programId]`
// filter). It is now LOAD-BEARING: an event is only persisted if its
// emitting program (resolved from invoke/return scope brackets) matches
// the program that legitimately owns that discriminator. Foreign-program
// discriminator collisions are rejected to a forensics-only
// `event_rejected_provenance` classification and never reach the
// authoritative store via `updateAgentFromEvent`.
function parseLogsForEvents(logs: string[], programLabel: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const eventRegex = /Program data: (.+)/;

  const { emittingProgram, sawBrackets } = attributeLogsToPrograms(logs);
  // The address of the program this subscription is bound to. When the
  // label is a synthetic test label not in PROGRAM_IDS, `subscribedAddr`
  // is undefined and the no-bracket fallback degrades to "accept if the
  // discriminator is known" (test fixtures), which still rejects unknown
  // discriminators and is never reached on a real RPC stream (which
  // always carries invoke/return brackets).
  const subscribedAddr: string | undefined = (
    PROGRAM_IDS as Record<string, Address>
  )[programLabel];

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
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
        // ADR-142 / CC-1: bind the decoded event to its emitting program.
        // `expectedOwner` is the program that legitimately emits this
        // event per its `src/events.rs`. If the log stream carried scope
        // brackets, `actualEmitter` is the innermost active program at
        // this `Program data:` line; otherwise we fall back to the
        // subscribed program (a foreign collision still fails because the
        // trusted event's owner is not the subscribed program).
        const expectedOwner = EVENT_PROGRAM[eventName];
        const actualEmitter = sawBrackets
          ? emittingProgram[i]
          : subscribedAddr;
        if (
          expectedOwner !== undefined &&
          actualEmitter != null &&
          actualEmitter !== expectedOwner
        ) {
          // Discriminator-collision / foreign-program forgery. Quarantine
          // to a distinct classification so it is visible to forensics
          // but never matched by `updateAgentFromEvent` (which keys off
          // the canonical event name). It is NOT persisted as the trusted
          // event.
          indexerErrors.inc({ error_type: "event_rejected_provenance" });
          programLogger(programLabel).warn(
            {
              adr: "ADR-142",
              event_name: eventName,
              discriminator,
              expected_program: expectedOwner,
              emitting_program: actualEmitter,
              event: "provenance:reject",
            },
            "rejected discriminator-collision event from foreign program",
          );
          events.push({
            name: `event_rejected_provenance`,
            data: {
              rejectedEventName: eventName,
              discriminator,
              expectedProgram: expectedOwner,
              emittingProgram: actualEmitter,
              rawData: decoded.subarray(8).toString("hex"),
            },
          });
          continue;
        }

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

  // ADR-138: ExecutionAttested — append to the execution_attestations
  // projection. The full provenance record is the load-bearing surface
  // for the MCP `query_execution_history` tool; we copy the decoded
  // fields verbatim so the JSON projection on `events.data` stays the
  // canonical source of truth (no derived columns drift).
  if (event.name === "ExecutionAttested") {
    const vault = typeof data.vault === "string" ? data.vault : undefined;
    const agentIdentity =
      typeof data.agent_identity === "string" ? data.agent_identity : undefined;
    const authority2 =
      typeof data.authority === "string" ? data.authority : undefined;
    const actionKind =
      typeof data.action_kind === "string" ? data.action_kind : undefined;
    const toolId = typeof data.tool_id === "string" ? data.tool_id : undefined;
    const manifestHash =
      typeof data.manifest_hash === "string" ? data.manifest_hash : undefined;
    const policyVersion =
      typeof data.policy_version === "number"
        ? data.policy_version
        : undefined;
    if (
      !vault ||
      !agentIdentity ||
      !authority2 ||
      !actionKind ||
      !toolId ||
      !manifestHash ||
      policyVersion === undefined
    ) {
      // Malformed row (decoder fell through) — drop to the forensics
      // fallback in the raw `events` table. We deliberately do not
      // INSERT a partial attestation row.
      return;
    }
    const delegationGrant =
      typeof data.delegation_grant === "string" ? data.delegation_grant : null;
    const mint = typeof data.mint === "string" ? data.mint : null;
    const recipient =
      typeof data.recipient === "string" ? data.recipient : null;
    const amount = coerceU64String(data.amount);
    const eventSlot =
      typeof data.slot === "number" || typeof data.slot === "bigint"
        ? Number(data.slot)
        : typeof data.slot === "string"
          ? Number(data.slot)
          : slot;
    const eventTs = coerceI64(data.timestamp);
    // SQLite is authoritative — write here under the per-program write
    // mutex held by the caller. `INSERT OR IGNORE` against the UNIQUE
    // index makes the row idempotent on (tx_signature,
    // instruction_index); the per-tx event ordinal carried in `events`
    // is the natural `instruction_index` value (one ExecutionAttested
    // per action ix).
    db.prepare(`
      INSERT OR IGNORE INTO execution_attestations
        (tx_signature, instruction_index, vault, agent_identity, authority,
         action_kind, tool_id, manifest_hash, policy_version,
         delegation_grant, amount, mint, recipient,
         slot, event_timestamp, ingested_at, decoded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              datetime('now'), datetime('now'))
    `).run(
      signature,
      // The event row's own per-tx ordinal lands in the `events` table;
      // ExecutionAttested is emitted at most once per action ix so the
      // ordinal doubles as instruction_index here. Negative ordinals
      // never happen — the inline loop in `persistEventsForTx` writes
      // monotonically from 0.
      // Best-effort: fall back to 0 if the signature carries no events
      // (impossible in practice, but defensive).
      readMaxEventOrdinalForSignature(db, signature),
      vault,
      agentIdentity,
      authority2,
      actionKind,
      toolId,
      manifestHash,
      policyVersion,
      delegationGrant,
      amount,
      mint,
      recipient,
      eventSlot,
      typeof eventTs === "bigint" ? eventTs.toString() : eventTs,
    );
    // ADR-128 Phase 1 dual-write — execution_attestations projection.
    void getPostgresStore().insertExecutionAttestation({
      txSignature: signature,
      instructionIndex: readMaxEventOrdinalForSignature(db, signature),
      vault,
      agentIdentity,
      authority: authority2,
      actionKind: actionKind as
        | "Transfer"
        | "TokenTransfer"
        | "PolicyUpdate"
        | "AllowlistManage"
        | "IdentityRotation"
        | "PauseToggle"
        | "GrantTransfer"
        | "GrantTokenTransfer",
      toolId,
      manifestHash,
      policyVersion,
      delegationGrant,
      amount,
      mint,
      recipient,
      slot: eventSlot,
      eventTimestamp: eventTs,
    });
    return;
  }

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

  // ADR-111: DelegationGrantCreated — insert a new row into
  // `delegation_grants` (current-state projection) and append a row to
  // `delegation_grant_events` (audit log). Subsequent revoke/update/
  // execute events bump the same row in `delegation_grants`.
  if (event.name === "DelegationGrantCreated") {
    const grantAddr = typeof data.grant === "string" ? data.grant : undefined;
    const vault = typeof data.vault === "string" ? data.vault : undefined;
    const grantor = typeof data.grantor === "string" ? data.grantor : undefined;
    const grantee = typeof data.grantee === "string" ? data.grantee : undefined;
    if (!grantAddr || !vault || !grantor || !grantee) return;
    const allowedActions =
      typeof data.allowed_actions === "number" ? data.allowed_actions : 0;
    const spendCap = coerceU64String(data.spend_cap_lamports);
    const expiresAt = coerceI64(data.expires_at);
    const nonce = typeof data.nonce === "number" ? data.nonce : 0;
    const eventTs = coerceI64(data.timestamp);
    db.prepare(`
      INSERT INTO delegation_grants
        (grant_address, vault, grantor, grantee, nonce, allowed_actions,
         spend_cap_lamports, spent_lamports, expires_at, revoked,
         created_at, last_seen_slot, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, 0, ?, ?, datetime('now'))
      ON CONFLICT(grant_address) DO UPDATE SET
        allowed_actions = excluded.allowed_actions,
        spend_cap_lamports = excluded.spend_cap_lamports,
        expires_at = excluded.expires_at,
        revoked = 0,
        last_seen_slot = excluded.last_seen_slot
    `).run(
      grantAddr,
      vault,
      grantor,
      grantee,
      nonce,
      allowedActions,
      spendCap,
      expiresAt,
      eventTs,
      slot
    );
    db.prepare(`
      INSERT OR IGNORE INTO delegation_grant_events
        (kind, grant_address, vault, grantee, grantor,
         allowed_actions, spend_cap_lamports, expires_at, nonce,
         event_timestamp, slot, signature, observed_at)
      VALUES ('Created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      grantAddr,
      vault,
      grantee,
      grantor,
      allowedActions,
      spendCap,
      expiresAt,
      nonce,
      eventTs,
      slot,
      signature
    );
    return;
  }

  if (event.name === "DelegationGrantRevoked") {
    const grantAddr = typeof data.grant === "string" ? data.grant : undefined;
    const vault = typeof data.vault === "string" ? data.vault : undefined;
    const revoker = typeof data.revoker === "string" ? data.revoker : undefined;
    if (!grantAddr || !vault || !revoker) return;
    const eventTs = coerceI64(data.timestamp);
    db.prepare(`
      UPDATE delegation_grants
      SET revoked = 1, last_seen_slot = ?
      WHERE grant_address = ?
    `).run(slot, grantAddr);
    db.prepare(`
      INSERT OR IGNORE INTO delegation_grant_events
        (kind, grant_address, vault, revoker, event_timestamp, slot, signature, observed_at)
      VALUES ('Revoked', ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(grantAddr, vault, revoker, eventTs, slot, signature);
    return;
  }

  if (event.name === "DelegationGrantUpdated") {
    const grantAddr = typeof data.grant === "string" ? data.grant : undefined;
    const vault = typeof data.vault === "string" ? data.vault : undefined;
    if (!grantAddr || !vault) return;
    const allowedActions =
      typeof data.new_allowed_actions === "number" ? data.new_allowed_actions : 0;
    const newCap = coerceU64String(data.new_spend_cap_lamports);
    const newExpiresAt = coerceI64(data.new_expires_at);
    const eventTs = coerceI64(data.timestamp);
    db.prepare(`
      UPDATE delegation_grants
      SET allowed_actions = ?,
          spend_cap_lamports = ?,
          expires_at = ?,
          last_seen_slot = ?
      WHERE grant_address = ?
    `).run(allowedActions, newCap, newExpiresAt, slot, grantAddr);
    db.prepare(`
      INSERT OR IGNORE INTO delegation_grant_events
        (kind, grant_address, vault, allowed_actions, spend_cap_lamports,
         expires_at, event_timestamp, slot, signature, observed_at)
      VALUES ('Updated', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      grantAddr,
      vault,
      allowedActions,
      newCap,
      newExpiresAt,
      eventTs,
      slot,
      signature
    );
    return;
  }

  if (event.name === "DelegationGrantExecuted") {
    const grantAddr = typeof data.grant === "string" ? data.grant : undefined;
    const vault = typeof data.vault === "string" ? data.vault : undefined;
    const grantee = typeof data.grantee === "string" ? data.grantee : undefined;
    if (!grantAddr || !vault || !grantee) return;
    const actionKind =
      typeof data.action_kind === "number" ? data.action_kind : 0;
    const mint = typeof data.mint === "string" ? data.mint : "";
    const recipient = typeof data.recipient === "string" ? data.recipient : "";
    const amount = coerceU64String(data.amount);
    const spentAfter = coerceU64String(data.spent_after);
    const eventTs = coerceI64(data.timestamp);
    // Bump the running spend tally on the projection row. For SOL grants
    // (action_kind = 1) we update spent_lamports directly. For SPL
    // grants (action_kind = 2) the per-mint tally lives in the on-chain
    // GrantTokenCap and is not surfaced as a top-level projection
    // column — operators query the events table for per-mint history.
    if (actionKind === 1) {
      db.prepare(`
        UPDATE delegation_grants
        SET spent_lamports = ?, last_seen_slot = ?
        WHERE grant_address = ?
      `).run(spentAfter, slot, grantAddr);
    } else {
      db.prepare(`
        UPDATE delegation_grants
        SET last_seen_slot = ?
        WHERE grant_address = ?
      `).run(slot, grantAddr);
    }
    db.prepare(`
      INSERT OR IGNORE INTO delegation_grant_events
        (kind, grant_address, vault, grantee, action_kind, mint, recipient,
         amount, spent_after, event_timestamp, slot, signature, observed_at)
      VALUES ('Executed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      grantAddr,
      vault,
      grantee,
      actionKind,
      mint,
      recipient,
      amount,
      spentAfter,
      eventTs,
      slot,
      signature
    );
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

/**
 * ADR-138: best-effort lookup of the per-tx event ordinal for an
 * `ExecutionAttested` row. We persist the ordinal on the parent
 * `events` row (the `event_ordinal` column); for the attestations table
 * we want the ordinal of the most recently-inserted event with this
 * signature, which is the ordinal of the ExecutionAttested itself
 * because `persistEventsForTx` walks the parsed events in order and
 * inserts ExecutionAttested AFTER its paired Transfer/Policy/etc event.
 *
 * Returning 0 on a miss is defensive only — every ExecutionAttested
 * lands as a row in `events` before this lookup runs.
 */
function readMaxEventOrdinalForSignature(
  db: Database.Database,
  signature: string,
): number {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(event_ordinal), 0) AS max_ord FROM events WHERE signature = ?",
    )
    .get(signature) as { max_ord: number } | undefined;
  return row?.max_ord ?? 0;
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
// ===========================================================================
// ADR-118 — per-program write mutex.
//
// One `Mutex` per program label (`vault`, `registry`, `settlement`). Every
// write path acquires the matching label's mutex before touching SQLite:
//
//   - `persistEventsForTx` (called by live-stream `handleLogs` and by the
//     per-tx loop in `backfillProgram`) — wraps the INSERT+UPSERT pair.
//   - Standalone `upsertCursor` callsites in `backfillProgram` (the no-
//     cursor seed and the no-logs cursor-advance) — wrapped at the call
//     site, not inside `upsertCursor` itself, because some seed callers
//     are still synchronous-shaped and the locking is the caller's
//     orchestration concern.
//
// Reads stay unlocked — WAL allows readers to proceed against a snapshot
// even while a writer holds the journal lock. The registry is module-
// scoped (not per-`subscribeToPrograms` instance) so a backfill kicked
// off in one call and a live-stream consumer in another are serialised
// against the same Mutex object.
// ===========================================================================
const writeMutexes: Map<string, Mutex> = new Map();

function getWriteMutex(label: string): Mutex {
  let m = writeMutexes.get(label);
  if (!m) {
    m = new Mutex();
    writeMutexes.set(label, m);
  }
  return m;
}

/**
 * ADR-118 — convenience wrapper for `mutex.runExclusive` keyed by label.
 * Use at every write callsite (live-stream `handleLogs`, backfill batch
 * commit, standalone `upsertCursor` seed). Test-only export so the mutex
 * registry can be instrumented for the concurrent-enters assertion.
 */
export function withProgramWriteLock<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
  return getWriteMutex(label).runExclusive(fn);
}

/**
 * C4-OFF-03 / ADR-118 — drain every registered per-program write mutex.
 *
 * `gracefulShutdown` previously proceeded straight to `db.close()` after
 * `abortAll()` without awaiting any in-flight `withProgramWriteLock`
 * promise. A live `handleLogs` commit or a backfill per-tx commit already
 * executing inside the mutex was not waited on, so `db.close()` (or the
 * 30s force-exit) could land mid-`persistEventsForTx`. Acquiring each
 * mutex here blocks until the current `runExclusive` body has fully run
 * to completion (better-sqlite3 is synchronous, so once we hold the lock
 * no SQLite write for that label is in progress); we release immediately.
 * After this resolves, no synchronous commit sequence is in flight and
 * the DB handle can be closed safely. Bounded by the caller's force-exit
 * timer so a wedged mutex cannot hang shutdown past the grace budget.
 */
export async function drainProgramWriteLocks(): Promise<void> {
  const releases = await Promise.all(
    [...writeMutexes.values()].map((m) => m.acquire()),
  );
  for (const release of releases) {
    release();
  }
}

// ADR-118 — module-scoped shutdown flag. Set by the SIGTERM/SIGINT
// handler so the backfill loop can finish the current batch transaction
// and stop scheduling fresh `getTransaction` requests. The live-stream
// loop's exit is driven separately via the per-label `AbortController`s
// (see `subscribeToPrograms`); this flag is the *cooperative* signal
// the polling backfill checks between its per-tx iterations.
let isShuttingDown = false;
/** Test-only: reset the flag after a sub-process / fixture test ends. */
export function __resetShutdownFlagForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetShutdownFlagForTest is only callable when NODE_ENV=test");
  }
  isShuttingDown = false;
}
/** Test-only: peek the flag from outside the module. */
export function __isShuttingDownForTest(): boolean {
  return isShuttingDown;
}

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

  const cursorStmt = db.prepare(`
    INSERT INTO cursor (program, last_processed_slot, last_signature, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(program) DO UPDATE SET
      last_processed_slot = excluded.last_processed_slot,
      last_signature = excluded.last_signature,
      updated_at = datetime('now')
  `);

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

  // C4-OFF-03 / ADR-118: wrap the per-event INSERTs, the in-tx agents-
  // projection updates (`updateAgentFromEvent`), AND the cursor UPSERT in
  // a SINGLE better-sqlite3 transaction. `synchronous=FULL` makes each
  // statement durable but does NOT make the multi-statement sequence
  // atomic — pre-fix, a SIGTERM / `db.close()` / 30s force-exit landing
  // between the event rows and the cursor UPSERT (or mid
  // `updateAgentFromEvent`) left the cursor stale or the agents
  // projection half-applied, so the next boot replayed from a torn
  // state. `db.transaction()` makes the whole per-tx commit all-or-
  // nothing; metric/PG side-effects are applied ONLY after it commits.
  let inserted = 0;
  let skipped = 0;
  const insertedEventNames: string[] = [];
  const txResult = db.transaction(() => {
    let txInserted = 0;
    let txSkipped = 0;
    let ordinal = 0;
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
          txInserted++;
          insertedEventNames.push(event.name);
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
          txSkipped++;
        }
      } catch (err) {
        // A throw here rolls back the WHOLE per-tx transaction (atomicity
        // is the point of C4-OFF-03). Re-throw so `db.transaction()`
        // aborts; the outer catch records the metric and the cursor does
        // not advance past a tx we failed to fully persist.
        throw new PerEventPersistError(
          (err as Error).message,
          event.name,
        );
      }
      ordinal++;
    }
    if (txInserted > 0 || txSkipped > 0) {
      // Cursor UPSERT is now INSIDE the same transaction as the event
      // rows + projection writes — it can never commit independently.
      cursorStmt.run(label, slot, signature);
    }
    return { txInserted, txSkipped };
  });

  try {
    const r = txResult();
    inserted = r.txInserted;
    skipped = r.txSkipped;
  } catch (err) {
    metrics.parseErrors++;
    // OFF-208: prom counter for SQLite-write failures. Labelled
    // `store_event` to match `metrics-server.test.ts` so the prom
    // contract stays stable across the audit close.
    indexerErrors.inc({ error_type: "store_event" });
    programLogger(label).error(
      { err: String(err), corr_id: signature },
      "failed to store event batch (transaction rolled back)",
    );
    // Nothing committed — no metric/PG side-effects, cursor unchanged.
    return { inserted: 0, skipped: 0 };
  }

  // --- Post-commit side-effects (only reached if the tx committed) ---
  for (const name of insertedEventNames) {
    metrics.eventsInserted++;
    // OFF-208: prom counter for events successfully persisted to SQLite
    // (the authoritative store). Labelled by `event_name`.
    eventsProcessed.inc({ event_type: name });
  }
  metrics.eventsDuplicateSkipped += skipped;

  if (inserted > 0 || skipped > 0) {
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

// C4-OFF-03 — typed error so a per-event persistence failure aborts the
// enclosing `db.transaction()` (rolling back the entire per-tx batch +
// cursor advance) rather than being swallowed mid-loop and leaving a
// torn projection.
class PerEventPersistError extends Error {
  constructor(message: string, readonly eventName: string) {
    super(message);
    this.name = "PerEventPersistError";
  }
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
  rpc: SolanaRpc,
  db: Database.Database,
  label: string,
  programId: Address,
  state: SubscriptionState,
  metrics: IndexerMetrics
): Promise<number> {
  const cursor = readCursor(db, label);

  if (!cursor || !cursor.signature) {
    try {
      // @solana/kit v2: commitment moves into the options object; the call
      // returns a builder and .send() executes the request.
      const head = await rpc
        .getSignaturesForAddress(programId, { limit: 1, commitment: COMMITMENT })
        .send();
      if (head.length > 0) {
        // Slot is `bigint` in v2; coerce to number for the SQLite INTEGER
        // column. AUD-039 unchanged — the slot fits in a JS number safely
        // (mainnet slot counter is ~3e8 today; Number.MAX_SAFE_INTEGER is
        // ~9e15, ~30 million years of headroom at 0.4 s/slot).
        const headSlot = Number(head[0].slot);
        const headSig = head[0].signature as string;
        // ADR-118: seed cursor under the per-label write mutex so a
        // live-stream `handleLogs` already running for this label can't
        // interleave with the cold-start seed.
        await withProgramWriteLock(label, () => upsertCursor(db, label, headSlot, headSig));
        state.lastProcessedSlot = headSlot;
        state.lastSignature = headSig;
        programLogger(label).info(
          { slot: headSlot, corr_id: headSig },
          "no cursor — seeded at head signature",
        );
      }
    } catch (err) {
      metrics.backfillErrors++;
      // OFF-208: prom counter for cursor-seed failures (first-run
      // boot when no persisted cursor exists). `error_type` namespaced
      // so backfill-page-fetch / backfill-tx / cursor-seed can each be
      // alert-ruled separately. PRESERVE EXACT LABEL "backfill_cursor_seed".
      indexerErrors.inc({ error_type: "backfill_cursor_seed" });
      state.lastError = `cursor seed failed: ${(err as Error).message}`;
      programLogger(label).error({ err: String(err) }, "cursor seed failed");
    }
    return 0;
  }

  const until = cursor.signature as Signature;
  // Inline the v2 row shape (kit's exported type is internal). The fields
  // we touch are { signature: Signature, slot: Slot } — anything else from
  // the API is ignored. `slot` stays as bigint here and is coerced at the
  // SQLite boundary just below.
  const collected: ReadonlyArray<{ signature: Signature; slot: Slot }>[] = [];
  let before: Signature | undefined;

  try {
    // eslint-disable-next-line no-constant-condition -- backfill paginates until the RPC returns an empty page; the loop body's early `break` is the exit condition.
    while (true) {
      const page = await rpc
        .getSignaturesForAddress(programId, {
          limit: BACKFILL_PAGE_SIZE,
          before,
          until,
          commitment: COMMITMENT,
        })
        .send();
      if (page.length === 0) break;
      collected.push(page);
      if (page.length < BACKFILL_PAGE_SIZE) break;
      before = page[page.length - 1].signature;
    }
  } catch (err) {
    metrics.backfillErrors++;
    // OFF-208: prom counter for `getSignaturesForAddress` paging
    // failures. Distinct label from the per-tx fetch below so an RPC
    // outage that wedges paging surfaces independently of a tx-level
    // RPC flap. PRESERVE EXACT LABEL "backfill_page_fetch".
    indexerErrors.inc({ error_type: "backfill_page_fetch" });
    state.lastError = `backfill page fetch failed: ${(err as Error).message}`;
    programLogger(label).error({ err: String(err) }, "backfill page fetch failed");
    return 0;
  }

  // Flatten + reverse to oldest-first so the cursor advances monotonically.
  // A crash mid-loop leaves the cursor at the last fully-processed signature.
  const flattened = collected.flat();
  if (flattened.length === 0) {
    return 0;
  }

  programLogger(label).info(
    { signature_count: flattened.length, since_cursor: until },
    "backfilling signatures since cursor",
  );

  let totalInserted = 0;
  for (const info of flattened.reverse()) {
    // ADR-118: SIGTERM cooperative-stop point. Check BETWEEN batches
    // (per ADR §Decision item 3); a batch already in-flight commits
    // cleanly under the write mutex below, then the loop bails out so
    // the cursor only ever advances on fully-persisted work.
    if (isShuttingDown) {
      programLogger(label).info(
        { events_inserted: totalInserted, remaining: flattened.length },
        "backfill bailing out — shutdown requested",
      );
      break;
    }
    const infoSlot = Number(info.slot);
    const infoSig = info.signature as string;
    try {
      const tx = await rpc
        .getTransaction(info.signature, {
          commitment: COMMITMENT,
          maxSupportedTransactionVersion: 0,
          encoding: "json",
        })
        .send();
      // ADR-142 / CC-2: same failed-tx gate as the live path. A
      // backfilled signature whose `meta.err` is set never committed
      // on-chain — its pre-abort logs must not enter the authoritative
      // store. Still advance the cursor (via the no-logs branch) so we
      // do not re-fetch the failed signature forever.
      if (tx?.meta?.err != null) {
        indexerErrors.inc({ error_type: "skipped_failed_tx" });
        programLogger(label).debug(
          {
            adr: "ADR-142",
            corr_id: infoSig,
            slot: infoSlot,
            event: "failed-tx:skip",
          },
          "skipping failed transaction (backfill)",
        );
        await withProgramWriteLock(label, () =>
          upsertCursor(db, label, infoSlot, infoSig),
        );
      } else if (tx?.meta?.logMessages) {
        const parsed = parseLogsForEvents(tx.meta.logMessages as string[], label);
        // ADR-118: per-program write mutex around the per-tx commit so
        // a concurrent live-stream `handleLogs` for this label cannot
        // sneak its own commit between our INSERT+UPSERT pair.
        const { inserted } = await withProgramWriteLock(label, () =>
          persistEventsForTx(db, label, infoSig, infoSlot, parsed, metrics)
        );
        totalInserted += inserted;
        metrics.eventsBackfilled += inserted;
      } else {
        // Tx has no logs or couldn't be fetched at finalized commitment —
        // still advance cursor so we don't re-fetch it forever.
        // ADR-118: same mutex as the persistEventsForTx path so backfill
        // never races a live-stream cursor write for this label.
        await withProgramWriteLock(label, () => upsertCursor(db, label, infoSlot, infoSig));
      }
      state.lastProcessedSlot = Math.max(state.lastProcessedSlot, infoSlot);
      state.lastSignature = infoSig;
    } catch (err) {
      metrics.backfillErrors++;
      // OFF-208: prom counter for per-tx `getTransaction` failures
      // during backfill. Distinct from `backfill_page_fetch` above so
      // operators can tell "RPC pagination broken" from "RPC tx-fetch
      // intermittently 5xx-ing". PRESERVE EXACT LABEL "backfill_tx_fetch".
      indexerErrors.inc({ error_type: "backfill_tx_fetch" });
      state.lastError = `backfill tx ${infoSig.substring(0, 8)}... failed: ${(err as Error).message}`;
      programLogger(label).error(
        { err: String(err), corr_id: infoSig },
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
  rpc: SolanaRpc,
  rpcSubscriptions: SolanaRpcSubscriptions,
  db: Database.Database,
  states?: Map<string, SubscriptionState>,
  metrics?: IndexerMetrics
): {
  states: Map<string, SubscriptionState>;
  metrics: IndexerMetrics;
  heartbeat: HeartbeatHandle;
  /**
   * ADR-118: abort every live `logsNotifications` subscription.
   * Iterates the per-label `AbortController` map and fires `.abort()`
   * on each — mirrors the AUD-204 release-before-resubscribe semantic
   * the heartbeat path uses. After this returns, the `for await`
   * loops inside `subscribeWithReconnect` see the abort and exit
   * without scheduling a reconnect (the `controller.signal.aborted`
   * guard). Used exclusively by the graceful-shutdown handler in
   * `main()`.
   */
  abortAll: () => void;
} {
  const activeStates = states ?? new Map<string, SubscriptionState>();
  const activeMetrics = metrics ?? createInitialMetrics();

  // In @solana/kit v2 there is no numeric `subId` returned by `subscribe()`
  // — subscriptions are cancelled by aborting the AbortController whose
  // signal was passed into `subscribe({ abortSignal })`. We track one
  // controller per program label; calling `controller.abort()` ends the
  // async iterator's `for await` loop and the underlying WS slot.
  const subscriptionControllers: Map<string, AbortController> = new Map();

  function getOrCreateState(label: string, programId: Address): SubscriptionState {
    let state = activeStates.get(label);
    if (!state) {
      state = {
        label,
        programId,
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

  async function handleLogs(
    label: string,
    slot: number,
    signature: string,
    logs: readonly string[],
  ): Promise<void> {
    const state = activeStates.get(label);
    if (state && slot > state.lastProcessedSlot) {
      state.lastProcessedSlot = slot;
      state.lastSignature = signature;
    }

    const parsed = parseLogsForEvents(logs as string[], label);
    if (parsed.length === 0) return;

    // ADR-118: serialise the per-tx write against any concurrent
    // backfill write for the SAME label. Other labels remain free to
    // progress in parallel (one Mutex per label).
    const { inserted, skipped } = await withProgramWriteLock(label, () =>
      persistEventsForTx(
        db,
        label,
        signature,
        slot,
        parsed,
        activeMetrics
      )
    );
    if (inserted > 0) {
      for (const event of parsed) {
        programLogger(label).info(
          {
            event_name: event.name,
            slot,
            corr_id: signature,
          },
          "event ingested",
        );
      }
    }
    if (skipped > 0) {
      programLogger(label).debug(
        { skipped, corr_id: signature },
        "duplicate events skipped",
      );
    }
  }

  // In @solana/kit v2 `subscribe()` is async — it awaits a WS slot from
  // the rpc-subscriptions transport, then returns a `Promise<AsyncIterable>`.
  // We launch the subscribe + consume loop as a detached promise so
  // `subscribeWithReconnect` itself stays synchronous-shaped from the
  // caller's perspective (matching the v1 `onLogs` return).
  function subscribeWithReconnect(label: string, programId: Address): void {
    const state = getOrCreateState(label, programId);
    programLogger(label).info(
      { program_id: programId },
      "subscribing to program",
    );

    // Per-subscription AbortController. Aborting this ends the
    // notification iterator; the server-side slot is released by the
    // kit transport on signal abort. Used by both AUD-204 (heartbeat-
    // driven reconnect releases BEFORE re-subscribing) and the
    // graceful-shutdown SIGINT/SIGTERM path.
    const controller = new AbortController();
    subscriptionControllers.set(label, controller);

    // Detached async — kick the subscribe + iterator loop, but don't
    // block `subscribeWithReconnect`'s synchronous-shaped return.
    void (async () => {
      let iterable: AsyncIterable<{
        context: { slot: bigint };
        value: { signature: string; logs: readonly string[]; err: unknown };
      }>;
      try {
        // Cast: kit's typed `logsNotifications` request returns
        // `SolanaRpcResponse<{ err, logs, signature }>` but the runtime
        // shape matches { context: { slot }, value: {...} }. We narrow
        // to that minimal shape for our handler.
        iterable = (await rpcSubscriptions
          .logsNotifications({ mentions: [programId] }, { commitment: COMMITMENT })
          .subscribe({ abortSignal: controller.signal })) as unknown as AsyncIterable<{
          context: { slot: bigint };
          value: { signature: string; logs: readonly string[]; err: unknown };
        }>;
        state.connected = true;
        state.lastError = null;
      } catch (err) {
        // Aborts surface here as an AbortError when the signal fired
        // before subscribe resolved — don't treat that as a real
        // subscribe failure (the caller is intentionally tearing down).
        if (controller.signal.aborted) return;
        state.connected = false;
        state.lastError = `subscribe failed: ${(err as Error).message}`;
        programLogger(label).error({ err: String(err) }, "subscription failed");
        subscriptionControllers.delete(label);
        scheduleReconnect(label, programId);
        return;
      }

      // Kick off backfill after subscribe so live events queue while
      // history is catching up; `INSERT OR IGNORE` handles any overlap.
      backfillProgram(rpc, db, label, programId, state, activeMetrics).catch((err) => {
        activeMetrics.backfillErrors++;
        // OFF-208: prom counter for unexpected backfill throws (the
        // top-level rejection that escapes the inner try/catch sites).
        // Different `error_type` so an alert that fires on this label
        // means "the backfill itself crashed", not "an RPC call inside
        // backfill failed and was already counted above". PRESERVE EXACT
        // LABEL "backfill_threw".
        indexerErrors.inc({ error_type: "backfill_threw" });
        state.lastError = `backfill threw: ${(err as Error).message}`;
        programLogger(label).error({ err: String(err) }, "backfill threw");
      });

      // Async-iterator consumption loop with its own error boundary so a
      // thrown error in the handler can never kill the indexer (mirror
      // the log-and-continue policy the v1 onLogs callback enjoyed by
      // virtue of being invoked one-at-a-time by Connection).
      try {
        for await (const notification of iterable) {
          try {
            const slot = Number(notification.context.slot);
            const signature = notification.value.signature;
            // ADR-142 / CC-2: a transaction that emitted log lines but
            // then aborted is NOT committed on-chain. Solana still
            // returns the pre-abort `Program data:` lines in the
            // notification, so persisting them would diverge the
            // off-chain authoritative log from chain state (and, chained
            // with CC-1, is a cheap state-forgery primitive). Drop the
            // entire notification when `value.err != null`. x402-relay's
            // `verifyPaymentOnChain` already applies the symmetric gate;
            // the indexer now matches it on the live path.
            if (notification.value.err != null) {
              indexerErrors.inc({ error_type: "skipped_failed_tx" });
              programLogger(label).debug(
                {
                  adr: "ADR-142",
                  corr_id: signature,
                  slot,
                  event: "failed-tx:skip",
                },
                "skipping failed transaction (live)",
              );
              continue;
            }
            // ADR-118: handleLogs is now async (mutex acquisition).
            // Await per notification so the write mutex is held end-to-
            // end before we move to the next message; this preserves
            // the per-tx commit ordering the v1 onLogs callback enjoyed.
            await handleLogs(label, slot, signature, notification.value.logs);
          } catch (cbErr) {
            programLogger(label).error(
              { err: String(cbErr) },
              "logsNotification handler threw — continuing",
            );
          }
        }
      } catch (iterErr) {
        // Normal-shutdown path: aborting the controller ends the
        // iterator via an AbortError-shaped rejection. Don't log that
        // as a real failure — it's how the v2 kit signals cancel.
        if (!controller.signal.aborted) {
          state.connected = false;
          state.lastError = `subscription iterator ended: ${(iterErr as Error).message}`;
          programLogger(label).warn(
            { err: String(iterErr) },
            "subscription iterator ended unexpectedly",
          );
          // The iterator's natural end (without an explicit abort) means
          // the WS slot closed beneath us. Schedule a reconnect so we
          // don't end up silently un-subscribed forever.
          if (subscriptionControllers.get(label) === controller) {
            subscriptionControllers.delete(label);
            scheduleReconnect(label, programId);
          }
        }
      }
    })();

    // AUD-039 / ADR-118: WebSocket disconnects are observed via the
    // process-wide heartbeat (see startHeartbeat below) rather than a
    // private socket-field peek. The heartbeat is started once on
    // first subscribe and remains running for the lifetime of the
    // process; per-program reconnect logic is unchanged from the
    // pre-migration implementation.
  }

  function scheduleReconnect(label: string, programId: Address): void {
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
  const heartbeatHandle = startConnectionHeartbeat(rpc, {
    intervalMs: HEARTBEAT_INTERVAL_MS,
    timeoutMs: HEARTBEAT_TIMEOUT_MS,
    failureThreshold: HEARTBEAT_FAILURE_THRESHOLD,
    onConnectionLost: (reason) => {
      // Reconnect every program whose subscription is currently live.
      // We iterate over a snapshot because scheduleReconnect mutates
      // `subscriptionControllers` indirectly through subscribeWithReconnect.
      const labels = Array.from(subscriptionControllers.keys());
      for (const label of labels) {
        const state = activeStates.get(label);
        if (!state) continue;
        const programId = state.programId as Address;
        programLogger(label).warn(
          { last_slot: state.lastProcessedSlot, reason },
          "heartbeat failed, scheduling reconnect",
        );
        state.connected = false;
        state.lastError = `heartbeat failed: ${reason}`;
        // AUD-204: release the prior logsNotifications subscription
        // BEFORE removing it from the map and starting a fresh
        // subscribe. Without this, every heartbeat-driven reconnect
        // on a flaky network would stack an extra iterator inside
        // the kit transport, eventually causing duplicate log delivery
        // (idempotency saves correctness via the UNIQUE index, but
        // inflates parseErrors/duplicateSkipped metrics and wastes
        // memory). `controller.abort()` is fire-and-forget — the
        // iterator loop above sees the signal abort and exits cleanly
        // without scheduling its own reconnect (the
        // `controller.signal.aborted` guard).
        const oldController = subscriptionControllers.get(label);
        if (oldController !== undefined) {
          oldController.abort();
        }
        subscriptionControllers.delete(label);
        scheduleReconnect(label, programId);
      }
    },
  });

  // ADR-118: expose a single-shot helper that aborts every live
  // subscription. The map is local to this closure (so per-instance
  // state stays encapsulated), but the SIGTERM handler in `main()`
  // needs to reach in and trigger the abort path. AUD-204 already
  // wires `abort()` to a clean release on the kit transport side —
  // we reuse exactly that semantic here.
  const abortAll = (): void => {
    for (const [label, controller] of subscriptionControllers) {
      try {
        controller.abort();
      } catch (err) {
        programLogger(label).warn(
          { err: String(err) },
          "abort during shutdown failed",
        );
      }
    }
    subscriptionControllers.clear();
  };

  return { states: activeStates, metrics: activeMetrics, heartbeat: heartbeatHandle, abortAll };
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
  rpc: Pick<SolanaRpc, "getSlot">,
  opts: HeartbeatOptions,
): HeartbeatHandle {
  let failures = 0;
  let stopped = false;

  const ping = async (): Promise<void> => {
    // Race getSlot against a timeout so a wedged WS doesn't stall the
    // heartbeat. @solana/kit v2 returns a request builder; calling
    // .send() returns a Promise<Slot>. AUD-039 invariant preserved:
    // this still uses ONLY a public RPC method — no private socket-
    // field access — so a kit minor bump that renames internals does
    // not silently break the heartbeat.
    const slotPromise = rpc.getSlot({ commitment: "confirmed" }).send();
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
          // @solana/kit v2: Address is already a base58 string, no .toBase58().
          programId,
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

  // ADR-138: execution-provenance query surface. Returns the most
  // recent `ExecutionAttested` rows for a given agent_identity OR vault,
  // filtered by `action_kind` and/or `tool_id`. Cursor pagination via
  // `since` (a slot lower bound). The default ordering is `slot DESC`
  // so the most recent action lands first; the trailing index on
  // (agent_identity|vault|tool_id, slot DESC) covers both the filter and
  // the sort without a separate sort step.
  //
  // Path-routed by the primary filter dimension so the endpoint
  // composes well with the URL-driven MCP tool wrapper:
  //   GET /execution/agent/:agent_identity
  //   GET /execution/vault/:vault
  // Either path accepts optional `?action_kind=`, `?tool_id=` (hex),
  // `?since=<slot>`, `?limit=<n>`.
  app.get(
    "/execution/:dim(agent|vault)/:key",
    (req: Request, res: Response) => {
      const dim = req.params.dim;
      const key = req.params.key;
      if (!key || key.length === 0) {
        res.status(400).json({ error: "missing key" });
        return;
      }
      const limit = Math.min(
        Math.max(parseInt(req.query.limit as string) || 50, 1),
        500,
      );
      const sinceRaw = req.query.since;
      const since =
        typeof sinceRaw === "string" && sinceRaw.length > 0
          ? Number.parseInt(sinceRaw, 10)
          : 0;
      const actionKind =
        typeof req.query.action_kind === "string" &&
        (req.query.action_kind as string).length > 0
          ? (req.query.action_kind as string)
          : null;
      const toolId =
        typeof req.query.tool_id === "string" &&
        (req.query.tool_id as string).length > 0
          ? (req.query.tool_id as string)
          : null;

      const params: unknown[] = [];
      const wheres: string[] = [];
      if (dim === "agent") {
        wheres.push("agent_identity = ?");
        params.push(key);
      } else {
        wheres.push("vault = ?");
        params.push(key);
      }
      if (Number.isFinite(since) && since > 0) {
        wheres.push("slot >= ?");
        params.push(since);
      }
      if (actionKind) {
        wheres.push("action_kind = ?");
        params.push(actionKind);
      }
      if (toolId) {
        wheres.push("tool_id = ?");
        params.push(toolId);
      }
      const sql = `
        SELECT tx_signature, instruction_index, vault, agent_identity, authority,
               action_kind, tool_id, manifest_hash, policy_version,
               delegation_grant, amount, mint, recipient, slot, event_timestamp,
               ingested_at, decoded_at
        FROM execution_attestations
        WHERE ${wheres.join(" AND ")}
        ORDER BY slot DESC, id DESC
        LIMIT ?
      `;
      params.push(limit);
      const rows = db.prepare(sql).all(...params);
      // Cursor for the caller's next page: the lowest slot we returned.
      // Callers paginate downward by supplying that slot as `since` on
      // the next request (a forward-walking cursor for older rows would
      // also work; downward-walking matches "show recent first").
      const lastRow = rows.length > 0 ? (rows[rows.length - 1] as { slot: number }) : null;
      res.json({
        dim,
        key,
        limit,
        count: rows.length,
        next_cursor: lastRow ? { before_slot: lastRow.slot } : null,
        attestations: rows,
      });
    },
  );

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

  // @solana/kit v2: HTTP and WS RPC are separate clients now.
  // - rpc           — HTTP for getSignaturesForAddress / getTransaction / getSlot
  // - rpcSubscriptions — WS for logsNotifications (replaces v1 connection.onLogs)
  // Commitment is per-call in v2 (see COMMITMENT usage at each call site).
  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(resolveWsUrl());
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

  const { states, metrics, heartbeat, abortAll } = subscribeToPrograms(rpc, rpcSubscriptions, db);
  const app = createApi(db, states, metrics);

  // ADR-139: optionally mount the portable reputation attestation issuer.
  // Activated when REPUTATION_ATTESTOR_KEYPAIR_PATH or _B64 is set; the
  // mount is a no-op otherwise so existing deployments are unaffected.
  // See `src/indexer/reputation-attestor.ts` for the route surface and
  // `docs/adr/ADR-139-portable-reputation-attestations.md` for the model.
  try {
    const { tryMountReputationAttestorFromEnv } = await import(
      "./reputation-attestor-wire.js"
    );
    tryMountReputationAttestorFromEnv(app, rpc as unknown as Parameters<typeof tryMountReputationAttestorFromEnv>[1], logger);
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), adr: "ADR-139" },
      "reputation-attestor mount failed; service continues without it",
    );
  }

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

  // CYCLE4-OFF-001 / ADR-118: SIGTERM is what container orchestrators
  // send (k8s, Docker, systemd) before SIGKILL. Without graceful
  // handling we'd lose the in-flight batch's commit on rollout, and PG
  // would only release the writer lock when the TCP session timed out
  // (delaying the next replica). The handler below:
  //
  //   1. logs `shutdown:start` (info, with reason + budget)
  //   2. flips `isShuttingDown=true` so the backfill loop bails between
  //      batches — the in-flight `persistEventsForTx` commit still
  //      completes under the per-program mutex, so the cursor only
  //      moves on fully-persisted work
  //   3. aborts every live `logsNotifications` subscription via the
  //      per-label `AbortController`s (AUD-204 release pattern)
  //   4. stops the heartbeat (unrefs its timer so process exit doesn't
  //      block on the next tick)
  //   5. logs `shutdown:flush`, then releases the writer lock and
  //      closes the PG pool
  //   6. closes the SQLite DB and exits 0 with `shutdown:exit`
  //
  // Force-exit fallback at `gracefulShutdownTimeoutMs` (default 30 s,
  // env override `INDEXER_GRACEFUL_SHUTDOWN_MS`) covers the case where
  // an in-flight RPC call or PG `release()` hangs past the budget.
  // K8s' default `terminationGracePeriodSeconds` is 30 s — match it so
  // the force-exit code (1) only ever lands inside a kill -9 window
  // anyway.
  const gracefulShutdownTimeoutMs = Number.parseInt(
    process.env.INDEXER_GRACEFUL_SHUTDOWN_MS ?? "30000",
    10,
  );
  let shutdownInFlight = false;
  const gracefulShutdown = (reason: "SIGINT" | "SIGTERM"): void => {
    // Idempotent: a double-signal (operator hits Ctrl+C twice, or k8s
    // re-sends SIGTERM during the grace window) must not start a second
    // shutdown pipeline — the first one's force-exit timer is still
    // armed, and re-entering `db.close()` on a closed handle throws.
    if (shutdownInFlight) {
      logger.warn({ reason }, "shutdown:duplicate-signal — already shutting down");
      return;
    }
    shutdownInFlight = true;
    isShuttingDown = true;
    logger.info(
      { reason, budget_ms: gracefulShutdownTimeoutMs, event: "shutdown:start" },
      "shutdown:start",
    );

    // Force-exit fallback. If any of the steps below hang (an RPC mid-
    // call, a PG socket that won't drain), we bail out with code 1 so
    // the orchestrator sees a non-zero exit and we don't outlive our
    // grace period.
    const forceExitTimer = setTimeout(() => {
      logger.error(
        { reason, budget_ms: gracefulShutdownTimeoutMs, event: "shutdown:exit" },
        "shutdown:exit — graceful budget exceeded, force-exiting (1)",
      );
      process.exit(1);
    }, gracefulShutdownTimeoutMs);
    // Unref so this timer alone never keeps the process alive past the
    // clean-exit path below.
    forceExitTimer.unref?.();

    // ADR-118: stop the heartbeat first so a pending tick doesn't
    // re-arm a reconnect against a subscription we're about to abort.
    heartbeat.stop();
    // ADR-118 / AUD-204: abort every live subscription. The kit
    // transport releases the WS slot on signal abort; the
    // `subscribeWithReconnect` consumer loop sees the abort and exits
    // without scheduling a reconnect.
    abortAll();

    // Run the rest of the cleanup async so a slow PG `release()` or
    // pool close doesn't block the signal handler frame.
    void (async () => {
      try {
        logger.info({ reason, event: "shutdown:flush" }, "shutdown:flush");
        // OFF-212: release the writer lock explicitly. PG session-close
        // releases it too, so this is a clean-exit optimisation, not a
        // correctness primitive.
        await writerLock.release().catch((err) => {
          logger.warn({ err: String(err), off: "OFF-212" }, "writer lock release failed");
        });
        // ADR-128 Phase 1: close the shadow pool. No-op on
        // DisabledPostgresStore.
        await pgStore.close().catch((err) => {
          logger.warn({ err: String(err) }, "postgres pool close failed");
        });
        // C4-OFF-03 / ADR-118: drain in-flight per-program write mutexes
        // BEFORE closing the SQLite handle. `abortAll()` above stops new
        // live notifications and `isShuttingDown` halts the backfill loop
        // between batches, but a `persistEventsForTx` commit already
        // inside `withProgramWriteLock` must run to completion (the whole
        // per-tx INSERT+projection+cursor transaction is atomic, but the
        // handle must not close mid-flight). Bounded by `forceExitTimer`.
        await drainProgramWriteLocks().catch((err) => {
          logger.warn(
            { err: String(err), off: "C4-OFF-03" },
            "write-lock drain failed",
          );
        });
        db.close();
        clearTimeout(forceExitTimer);
        logger.info({ reason, event: "shutdown:exit" }, "shutdown:exit");
        process.exit(0);
      } catch (err) {
        // Any throw on the clean-exit path falls through to the force-
        // exit timer; log so the operator can see why.
        logger.error(
          { err: String(err), reason, event: "shutdown:exit" },
          "shutdown:exit — clean path threw, force-exit will fire",
        );
      }
    })();
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
