/**
 * AEAP Event Indexer - Unit Tests
 *
 * Tests the pure functions: parseLogsForEvents, initDb, updateAgentFromEvent, createApi.
 * Uses an in-memory SQLite database for isolation.
 *
 * Covers architecture critique findings #6 (real Anchor discriminators) and
 * #7 (updateAgentFromEvent reads fields the parser actually produces).
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { PublicKey, Keypair } from "@solana/web3.js";
import Database from "better-sqlite3";
import {
  initDb,
  parseLogsForEvents,
  updateAgentFromEvent,
  createApi,
} from "../src/indexer/index";

// Real Anchor discriminators = sha256("event:<Name>")[..8]. These were
// computed from the Rust #[event] structs; see the discriminator map in
// src/indexer/index.ts for the full table.
const DISC_AGENT_REGISTERED = "bf4ed936e864bd55";
const DISC_ESCROW_CREATED = "467f69665c6107ad";
const DISC_REPUTATION_UPDATED = "1a24bb96eb5a6a59";

// --- Helpers for encoding borsh-wire-compatible event payloads. ---
function encString(s: string): Buffer {
  const utf8 = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(utf8.length, 0);
  return Buffer.concat([len, utf8]);
}
function encU64(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}
function encI64(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return b;
}
function encBool(v: boolean): Buffer {
  return Buffer.from([v ? 1 : 0]);
}
function encPubkey(pk: PublicKey): Buffer {
  return Buffer.from(pk.toBytes());
}

function encodeAgentRegistered(args: {
  authority: PublicKey;
  name: string;
  category: string;
  vaultAddress: PublicKey;
  timestamp: number | bigint;
}): Buffer {
  return Buffer.concat([
    encPubkey(args.authority),
    encString(args.name),
    encString(args.category),
    encPubkey(args.vaultAddress),
    encI64(args.timestamp),
  ]);
}

function encodeReputationUpdated(args: {
  authority: PublicKey;
  newScore: bigint | number;
  delta: bigint | number;
  taskCompleted: boolean;
  timestamp: number | bigint;
}): Buffer {
  return Buffer.concat([
    encPubkey(args.authority),
    encU64(args.newScore),
    encI64(args.delta),
    encBool(args.taskCompleted),
    encI64(args.timestamp),
  ]);
}

function makeLog(discriminatorHex: string, payload: Buffer): string {
  const disc = Buffer.from(discriminatorHex, "hex");
  return `Program data: ${Buffer.concat([disc, payload]).toString("base64")}`;
}

describe("Indexer - parseLogsForEvents", () => {
  it("should return an empty array for empty logs", () => {
    const events = parseLogsForEvents([], "vault");
    expect(events).to.be.an("array").that.is.empty;
  });

  it("should return an empty array for logs with no 'Program data:' lines", () => {
    const logs = [
      "Program log: Instruction: Initialize",
      "Program log: Transfer complete",
    ];
    const events = parseLogsForEvents(logs, "vault");
    expect(events).to.be.an("array").that.is.empty;
  });

  it("should map a known discriminator to its event name (AgentRegistered)", () => {
    const authority = Keypair.generate().publicKey;
    const vault = Keypair.generate().publicKey;
    const payload = encodeAgentRegistered({
      authority,
      name: "TestAgent",
      category: "security",
      vaultAddress: vault,
      timestamp: 1_700_000_000,
    });
    const events = parseLogsForEvents(
      [makeLog(DISC_AGENT_REGISTERED, payload)],
      "registry"
    );

    expect(events).to.have.length(1);
    expect(events[0].name).to.equal("AgentRegistered");
    expect(events[0].data.authority).to.equal(authority.toBase58());
    expect(events[0].data.name).to.equal("TestAgent");
    expect(events[0].data.category).to.equal("security");
    expect(events[0].data.vault_address).to.equal(vault.toBase58());
    expect(events[0].data.timestamp).to.equal(1_700_000_000);
  });

  it("should map EscrowCreated discriminator correctly", () => {
    // EscrowCreated is classified but we don't decode its fields; the name
    // is what matters for the event log.
    const fullPayload = Buffer.from(DISC_ESCROW_CREATED + "00", "hex");
    const b64 = fullPayload.toString("base64");
    const events = parseLogsForEvents([`Program data: ${b64}`], "settlement");

    expect(events).to.have.length(1);
    expect(events[0].name).to.equal("EscrowCreated");
  });

  it("should decode ReputationUpdated fields", () => {
    const authority = Keypair.generate().publicKey;
    const payload = encodeReputationUpdated({
      authority,
      newScore: 1234,
      delta: -25,
      taskCompleted: false,
      timestamp: 1_700_000_001,
    });
    const events = parseLogsForEvents(
      [makeLog(DISC_REPUTATION_UPDATED, payload)],
      "registry"
    );

    expect(events).to.have.length(1);
    expect(events[0].name).to.equal("ReputationUpdated");
    expect(events[0].data.authority).to.equal(authority.toBase58());
    expect(events[0].data.new_reputation_score).to.equal(1234);
    expect(events[0].data.reputation_delta).to.equal(-25);
    expect(events[0].data.task_completed).to.equal(false);
  });

  it("should use fallback name for unknown discriminators", () => {
    const unknownDiscriminator = "aaaaaaaaaaaaaaaa";
    const fullPayload = Buffer.from(unknownDiscriminator + "ff", "hex");
    const b64 = fullPayload.toString("base64");
    const events = parseLogsForEvents([`Program data: ${b64}`], "vault");

    expect(events).to.have.length(1);
    expect(events[0].name).to.equal("event_aaaaaaaa");
    expect(events[0].data).to.have.property("discriminator", unknownDiscriminator);
    expect(events[0].data).to.have.property("rawData", "ff");
  });

  it("should skip payloads shorter than the discriminator", () => {
    // A sub-8-byte payload cannot carry a discriminator; must not throw
    // and must not emit an event.
    const shortPayload = Buffer.from("deadbeef", "hex");
    const logs = [`Program data: ${shortPayload.toString("base64")}`];
    const events = parseLogsForEvents(logs, "vault");
    expect(events).to.be.an("array").that.is.empty;
  });

  it("should skip unparseable base64 data gracefully", () => {
    const logs = ["Program data: !!"];
    const events = parseLogsForEvents(logs, "vault");
    expect(events).to.be.an("array");
  });

  it("should handle multiple Program data lines", () => {
    const payload1 = Buffer.alloc(16, 0x01);
    const payload2 = Buffer.alloc(16, 0x02);
    const logs = [
      `Program data: ${payload1.toString("base64")}`,
      "Program log: some other line",
      `Program data: ${payload2.toString("base64")}`,
    ];
    const events = parseLogsForEvents(logs, "vault");

    expect(events).to.have.length(2);
  });

  it("should preserve classification but flag decode errors on truncated payloads", () => {
    // AgentRegistered discriminator but payload too short to contain the
    // first Pubkey (32 bytes). Parser must not crash; it should return the
    // classified name with a `decodeError` marker.
    const shortPayload = Buffer.alloc(5, 0xab);
    const events = parseLogsForEvents(
      [makeLog(DISC_AGENT_REGISTERED, shortPayload)],
      "registry"
    );

    expect(events).to.have.length(1);
    expect(events[0].name).to.equal("AgentRegistered");
    expect(events[0].data).to.have.property("decodeError");
  });
});

describe("Indexer - initDb", () => {
  it("should create an in-memory database with events and agents tables", () => {
    const db = initDb(":memory:");

    const eventsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .get() as { name: string } | undefined;
    expect(eventsTable).to.not.be.undefined;
    expect(eventsTable!.name).to.equal("events");

    const agentsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'")
      .get() as { name: string } | undefined;
    expect(agentsTable).to.not.be.undefined;
    expect(agentsTable!.name).to.equal("agents");

    db.close();
  });

  it("should create indexes on events table", () => {
    const db = initDb(":memory:");

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'")
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).to.include("idx_events_program");
    expect(indexNames).to.include("idx_events_name");
    expect(indexNames).to.include("idx_events_slot");

    db.close();
  });

  it("should create indexes on agents table", () => {
    const db = initDb(":memory:");

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agents'")
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).to.include("idx_agents_category");
    expect(indexNames).to.include("idx_agents_reputation");

    db.close();
  });

  it("should be idempotent (IF NOT EXISTS prevents errors on repeat)", () => {
    const db = initDb(":memory:");
    expect(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          program TEXT NOT NULL,
          event_name TEXT NOT NULL,
          data TEXT NOT NULL,
          signature TEXT NOT NULL,
          slot INTEGER NOT NULL,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS agents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          authority TEXT NOT NULL UNIQUE,
          name TEXT,
          category TEXT,
          reputation_score INTEGER DEFAULT 0,
          tasks_completed INTEGER DEFAULT 0,
          last_updated TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    }).to.not.throw();

    db.close();
  });
});

describe("Indexer - updateAgentFromEvent", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("should insert a new agent on AgentRegistered event", () => {
    const event = {
      name: "AgentRegistered",
      data: {
        authority: "AgentPubkey123",
        name: "TestAgent",
        category: "data-analysis",
      },
    };

    updateAgentFromEvent(db, event);

    const agent = db
      .prepare("SELECT * FROM agents WHERE authority = ?")
      .get("AgentPubkey123") as Record<string, unknown>;

    expect(agent).to.not.be.undefined;
    expect(agent.name).to.equal("TestAgent");
    expect(agent.category).to.equal("data-analysis");
    expect(agent.reputation_score).to.equal(0);
    expect(agent.tasks_completed).to.equal(0);
  });

  it("should upsert on duplicate authority for AgentRegistered", () => {
    const event1 = {
      name: "AgentRegistered",
      data: { authority: "DuplicateKey", name: "First", category: "cat1" },
    };
    const event2 = {
      name: "AgentRegistered",
      data: { authority: "DuplicateKey", name: "Updated", category: "cat2" },
    };

    updateAgentFromEvent(db, event1);
    updateAgentFromEvent(db, event2);

    const agents = db
      .prepare("SELECT * FROM agents WHERE authority = ?")
      .all("DuplicateKey") as Record<string, unknown>[];

    expect(agents).to.have.length(1);
    expect(agents[0].name).to.equal("Updated");
    expect(agents[0].category).to.equal("cat2");
  });

  it("should update reputation on ReputationUpdated event (new_reputation_score field)", () => {
    updateAgentFromEvent(db, {
      name: "AgentRegistered",
      data: { authority: "RepAgent", name: "RepBot", category: "security" },
    });

    updateAgentFromEvent(db, {
      name: "ReputationUpdated",
      data: {
        authority: "RepAgent",
        new_reputation_score: 85,
        reputation_delta: 50,
        task_completed: true,
      },
    });

    const agent = db
      .prepare("SELECT * FROM agents WHERE authority = ?")
      .get("RepAgent") as Record<string, unknown>;

    expect(agent.reputation_score).to.equal(85);
    expect(agent.tasks_completed).to.equal(1);
  });

  it("should only increment tasks_completed when task_completed=true", () => {
    updateAgentFromEvent(db, {
      name: "AgentRegistered",
      data: { authority: "Worker1", name: "Worker", category: "general" },
    });

    // Slash event: task_completed=false → tasks_completed must not bump.
    updateAgentFromEvent(db, {
      name: "ReputationUpdated",
      data: {
        authority: "Worker1",
        new_reputation_score: 5,
        reputation_delta: -10,
        task_completed: false,
      },
    });
    updateAgentFromEvent(db, {
      name: "ReputationUpdated",
      data: {
        authority: "Worker1",
        new_reputation_score: 55,
        reputation_delta: 50,
        task_completed: true,
      },
    });

    const agent = db
      .prepare("SELECT * FROM agents WHERE authority = ?")
      .get("Worker1") as Record<string, unknown>;

    expect(agent.reputation_score).to.equal(55);
    expect(agent.tasks_completed).to.equal(1);
  });

  it("should update name on AgentProfileUpdated", () => {
    updateAgentFromEvent(db, {
      name: "AgentRegistered",
      data: { authority: "Profiler", name: "Old", category: "general" },
    });
    updateAgentFromEvent(db, {
      name: "AgentProfileUpdated",
      data: { authority: "Profiler", name: "New" },
    });

    const agent = db
      .prepare("SELECT * FROM agents WHERE authority = ?")
      .get("Profiler") as Record<string, unknown>;

    expect(agent.name).to.equal("New");
  });

  it("should halve score via SuspensionCleared without touching tasks_completed", () => {
    updateAgentFromEvent(db, {
      name: "AgentRegistered",
      data: { authority: "Appealer", name: "A", category: "g" },
    });
    updateAgentFromEvent(db, {
      name: "ReputationUpdated",
      data: {
        authority: "Appealer",
        new_reputation_score: 100,
        reputation_delta: 100,
        task_completed: true,
      },
    });
    updateAgentFromEvent(db, {
      name: "SuspensionCleared",
      data: { authority: "Appealer", new_reputation_score: 50 },
    });

    const agent = db
      .prepare("SELECT * FROM agents WHERE authority = ?")
      .get("Appealer") as Record<string, unknown>;

    expect(agent.reputation_score).to.equal(50);
    expect(agent.tasks_completed).to.equal(1);
  });

  it("should delete the agent row on AgentDeregistered", () => {
    updateAgentFromEvent(db, {
      name: "AgentRegistered",
      data: { authority: "LeavingAgent", name: "Bye", category: "g" },
    });
    updateAgentFromEvent(db, {
      name: "AgentDeregistered",
      data: { authority: "LeavingAgent", name: "Bye" },
    });

    const agent = db
      .prepare("SELECT * FROM agents WHERE authority = ?")
      .get("LeavingAgent");

    expect(agent).to.be.undefined;
  });

  // S-offchain-04 (2026-04 re-audit): backfill race guard.
  it("should NOT resurrect a deregistered agent when backfill delivers an older AgentRegistered", () => {
    // Timeline: live stream delivered register@100 and deregister@105.
    // Backfill later re-plays the older register@100 — must NOT resurrect.
    updateAgentFromEvent(
      db,
      { name: "AgentRegistered", data: { authority: "ZombieAgent", name: "z", category: "g" } },
      100
    );
    updateAgentFromEvent(
      db,
      { name: "AgentDeregistered", data: { authority: "ZombieAgent" } },
      105
    );
    updateAgentFromEvent(
      db,
      { name: "AgentRegistered", data: { authority: "ZombieAgent", name: "z", category: "g" } },
      100 // stale backfill replay
    );

    const agent = db
      .prepare("SELECT * FROM agents WHERE authority = ?")
      .get("ZombieAgent");
    expect(agent, "stale backfill must not resurrect deregistered agent").to.be.undefined;

    const tombstone = db
      .prepare("SELECT deregistered_at_slot FROM agent_tombstones WHERE authority = ?")
      .get("ZombieAgent") as { deregistered_at_slot: number };
    expect(tombstone.deregistered_at_slot).to.equal(105);
  });

  it("should allow legitimate re-registration at a later slot (clears tombstone)", () => {
    updateAgentFromEvent(
      db,
      { name: "AgentRegistered", data: { authority: "Rejoiner", name: "r", category: "g" } },
      200
    );
    updateAgentFromEvent(
      db,
      { name: "AgentDeregistered", data: { authority: "Rejoiner" } },
      210
    );
    // Legitimate re-registration: slot strictly greater than tombstone.
    updateAgentFromEvent(
      db,
      { name: "AgentRegistered", data: { authority: "Rejoiner", name: "r2", category: "g2" } },
      220
    );

    const agent = db
      .prepare("SELECT * FROM agents WHERE authority = ?")
      .get("Rejoiner") as Record<string, unknown>;
    expect(agent, "re-registration at later slot must succeed").to.not.be.undefined;
    expect(agent.name).to.equal("r2");

    const tombstone = db
      .prepare("SELECT deregistered_at_slot FROM agent_tombstones WHERE authority = ?")
      .get("Rejoiner");
    expect(tombstone, "tombstone cleared on legitimate re-registration").to.be.undefined;
  });

  it("should handle AgentRegistered with missing optional fields", () => {
    const event = {
      name: "AgentRegistered",
      data: { authority: "MinimalAgent" },
    };

    updateAgentFromEvent(db, event);

    const agent = db
      .prepare("SELECT * FROM agents WHERE authority = ?")
      .get("MinimalAgent") as Record<string, unknown>;

    expect(agent).to.not.be.undefined;
    expect(agent.name).to.be.null;
    expect(agent.category).to.be.null;
  });

  it("should ignore unrelated event names", () => {
    updateAgentFromEvent(db, {
      name: "VaultInitialized",
      data: { vault: "abc" },
    });

    const count = db
      .prepare("SELECT COUNT(*) as total FROM agents")
      .get() as { total: number };

    expect(count.total).to.equal(0);
  });

  it("should handle u64 reputation_score given as string (preserves big-int precision)", () => {
    updateAgentFromEvent(db, {
      name: "AgentRegistered",
      data: { authority: "BigAgent", name: "B", category: "g" },
    });
    updateAgentFromEvent(db, {
      name: "ReputationUpdated",
      data: {
        authority: "BigAgent",
        new_reputation_score: "42",
        reputation_delta: 0,
        task_completed: true,
      },
    });

    const agent = db
      .prepare("SELECT * FROM agents WHERE authority = ?")
      .get("BigAgent") as Record<string, unknown>;

    expect(agent.reputation_score).to.equal(42);
  });
});

describe("Indexer - createApi", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("should return an express application", () => {
    const app = createApi(db);
    expect(app).to.not.be.undefined;
    expect(app).to.have.property("get").that.is.a("function");
    expect(app).to.have.property("use").that.is.a("function");
  });

  it("should have registered GET routes for health, events, agents, and stats", () => {
    const app = createApi(db);

    // Express 5.x exposes the internal router as `app.router`; 4.x via
    // `app._router`. Prefer the private accessor if present (tolerates
    // either version so the test isn't pinned to a single major).
    type RouterStack = {
      stack: Array<{
        route?: { path: string; methods: Record<string, boolean> };
      }>;
    };
    const appAny = app as unknown as { router?: RouterStack; _router?: RouterStack };
    const router = appAny._router ?? appAny.router;
    expect(router).to.not.be.undefined;

    const routes = router!.stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route!.path,
        methods: Object.keys(layer.route!.methods),
      }));

    const paths = routes.map((r) => r.path);
    expect(paths).to.include("/health");
    expect(paths).to.include("/events");
    expect(paths).to.include("/events/:program");
    expect(paths).to.include("/agents");
    expect(paths).to.include("/stats");
  });
});

/**
 * S-offchain-05 (2026-04 re-audit): drift guard for `AgentStatus`.
 *
 * `AgentStatusUpdated` carries the enum variant as a borsh u8 tag, which
 * only conveys the ordinal position of the variant in the Rust source.
 * If the on-chain `pub enum AgentStatus { ... }` is ever reordered (or a
 * new variant inserted mid-list), every previously-emitted event
 * silently mis-decodes into the wrong label and downstream projections
 * drift.
 *
 * The indexer keeps a hard-coded positional array (`AGENT_STATUS_VARIANTS`)
 * in `src/indexer/index.ts`. This test reads the authoritative Rust
 * source, extracts the variant ordering, and asserts the indexer's array
 * matches. Any PR that reorders the enum without updating the indexer
 * fails here — the drift never reaches production.
 */
describe("Indexer - AgentStatus enum drift guard", () => {
  it("AGENT_STATUS_VARIANTS in the indexer must match the Rust enum order", () => {
    const statePath = path.resolve(
      __dirname,
      "../programs/agent-registry/src/state.rs"
    );
    const indexerPath = path.resolve(__dirname, "../src/indexer/index.ts");

    const stateSrc = fs.readFileSync(statePath, "utf8");
    const indexerSrc = fs.readFileSync(indexerPath, "utf8");

    // Extract the `pub enum AgentStatus { ... }` body.
    const enumMatch = stateSrc.match(/pub enum AgentStatus\s*{([\s\S]*?)}/);
    expect(enumMatch, "AgentStatus enum not found in registry state.rs").to.not.be.null;
    const rustVariants = enumMatch![1]
      .split(/,|\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("//"))
      .map((s) => s.split(/\s/)[0].replace(/[^A-Za-z0-9_]/g, ""))
      .filter((s) => /^[A-Z]/.test(s));

    // Extract `AGENT_STATUS_VARIANTS = [...]` from the indexer.
    const tsMatch = indexerSrc.match(
      /AGENT_STATUS_VARIANTS\s*=\s*\[([^\]]*)\]\s*as const/
    );
    expect(tsMatch, "AGENT_STATUS_VARIANTS not found in indexer").to.not.be.null;
    const tsVariants = tsMatch![1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s.length > 0);

    expect(tsVariants).to.deep.equal(
      rustVariants,
      `AgentStatus drift: Rust=[${rustVariants.join(", ")}] vs indexer=[${tsVariants.join(
        ", "
      )}]. Update AGENT_STATUS_VARIANTS in src/indexer/index.ts.`
    );
  });
});
