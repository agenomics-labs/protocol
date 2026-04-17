/**
 * AEAP Event Indexer - Unit Tests
 *
 * Tests the pure functions: parseLogsForEvents, initDb, updateAgentFromEvent, createApi.
 * Uses an in-memory SQLite database for isolation.
 */

import { expect } from "chai";
import Database from "better-sqlite3";
import { initDb, parseLogsForEvents, updateAgentFromEvent, createApi } from "../src/indexer/index";

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

  it("should parse a 'Program data:' line into a base64-decoded event", () => {
    // Create valid base64 data: 8-byte discriminator + some payload
    const payload = Buffer.from("0011223344556677aabbccdd", "hex");
    const b64 = payload.toString("base64");
    const logs = [`Program data: ${b64}`];
    const events = parseLogsForEvents(logs, "vault");

    expect(events).to.have.length(1);
    // Discriminator is first 8 bytes = "0011223344556677"
    expect(events[0].data).to.have.property("discriminator", "0011223344556677");
    expect(events[0].data).to.have.property("rawData", "aabbccdd");
    // This discriminator is not in the known map, so name should be fallback
    expect(events[0].name).to.match(/^event_/);
  });

  it("should map a known discriminator to its event name", () => {
    // The discriminator for AgentRegistered is "c8a7e69dfbae2f31"
    const discriminatorHex = "c8a7e69dfbae2f31";
    const rawPayload = "deadbeef";
    const fullPayload = Buffer.from(discriminatorHex + rawPayload, "hex");
    const b64 = fullPayload.toString("base64");
    const logs = [`Program data: ${b64}`];
    const events = parseLogsForEvents(logs, "registry");

    expect(events).to.have.length(1);
    expect(events[0].name).to.equal("AgentRegistered");
  });

  it("should map EscrowCreated discriminator correctly", () => {
    const discriminatorHex = "40de3a87fb1a2b49";
    const fullPayload = Buffer.from(discriminatorHex + "00", "hex");
    const b64 = fullPayload.toString("base64");
    const logs = [`Program data: ${b64}`];
    const events = parseLogsForEvents(logs, "settlement");

    expect(events).to.have.length(1);
    expect(events[0].name).to.equal("EscrowCreated");
  });

  it("should use fallback name for unknown discriminators", () => {
    const unknownDiscriminator = "aaaaaaaaaaaaaaaa";
    const fullPayload = Buffer.from(unknownDiscriminator + "ff", "hex");
    const b64 = fullPayload.toString("base64");
    const logs = [`Program data: ${b64}`];
    const events = parseLogsForEvents(logs, "vault");

    expect(events).to.have.length(1);
    expect(events[0].name).to.equal("event_aaaaaaaa");
  });

  it("should skip unparseable base64 data gracefully", () => {
    const logs = ["Program data: !!"];
    const events = parseLogsForEvents(logs, "vault");
    // Should not throw; Buffer.from with invalid base64 may produce
    // an empty or short buffer, but the function should handle it
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

  it("should update reputation on ReputationUpdated event", () => {
    updateAgentFromEvent(db, {
      name: "AgentRegistered",
      data: { authority: "RepAgent", name: "RepBot", category: "security" },
    });

    updateAgentFromEvent(db, {
      name: "ReputationUpdated",
      data: { authority: "RepAgent", new_score: "85" },
    });

    const agent = db
      .prepare("SELECT * FROM agents WHERE authority = ?")
      .get("RepAgent") as Record<string, unknown>;

    expect(agent.reputation_score).to.equal(85);
    expect(agent.tasks_completed).to.equal(1);
  });

  it("should increment tasks_completed on each ReputationUpdated", () => {
    updateAgentFromEvent(db, {
      name: "AgentRegistered",
      data: { authority: "Worker1", name: "Worker", category: "general" },
    });

    updateAgentFromEvent(db, {
      name: "ReputationUpdated",
      data: { authority: "Worker1", new_score: "10" },
    });
    updateAgentFromEvent(db, {
      name: "ReputationUpdated",
      data: { authority: "Worker1", new_score: "20" },
    });
    updateAgentFromEvent(db, {
      name: "ReputationUpdated",
      data: { authority: "Worker1", new_score: "30" },
    });

    const agent = db
      .prepare("SELECT * FROM agents WHERE authority = ?")
      .get("Worker1") as Record<string, unknown>;

    expect(agent.reputation_score).to.equal(30);
    expect(agent.tasks_completed).to.equal(3);
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
      name: "VaultCreated",
      data: { vault: "abc" },
    });

    const count = db
      .prepare("SELECT COUNT(*) as total FROM agents")
      .get() as { total: number };

    expect(count.total).to.equal(0);
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

    // Express stores routes in the internal router stack
    const router = (app as unknown as {
      _router: {
        stack: Array<{
          route?: { path: string; methods: Record<string, boolean> };
        }>;
      };
    })._router;
    expect(router).to.not.be.undefined;

    const routes = router.stack
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
