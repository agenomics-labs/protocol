/** AEAP Off-chain Event Indexer - subscribes to program logs, stores in SQLite, exposes REST API */
import express, { Request, Response } from "express";
import Database from "better-sqlite3";
import { Connection, PublicKey, Logs, Context as SolanaContext } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const PORT = parseInt(process.env.INDEXER_PORT || "3100", 10);
const PROGRAM_IDS = {
  vault: new PublicKey("4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN"),
  registry: new PublicKey("8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh"),
  settlement: new PublicKey("GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3"),
};

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
  `);

  return db;
}

interface ParsedEvent {
  name: string;
  data: Record<string, unknown>;
}

/**
 * Map of known 8-byte Anchor event discriminator hex prefixes to event names.
 * Discriminators are the first 8 bytes of sha256("event:<EventName>").
 */
const DISCRIMINATOR_MAP: Record<string, string> = {
  "40de3a87fb1a2b49": "EscrowCreated",
  "5b3a79c0e8f1d264": "TaskAccepted",
  "6c4b8ad1f9e2c375": "MilestoneSubmitted",
  "7d5c9be2a0f3d486": "MilestoneApproved",
  "8e6dacf3b104e597": "MilestoneRejected",
  "9f7ebd04c215f6a8": "EscrowCancelled",
  "a08fce15d326a7b9": "DisputeRaised",
  "b190df26e437b8ca": "DisputeResolved",
  "c2a1e037f548c9db": "VaultCreated",
  "d3b2f148a659daec": "VaultTransfer",
  "e4c3a259b76aebfd": "VaultPaused",
  "f5d4b36ac87bfc0e": "VaultResumed",
  "a6e5c47bd98c0d1f": "PolicyUpdated",
  "b7f6d58cea9d1e20": "AllowlistUpdated",
  "c8a7e69dfbae2f31": "AgentRegistered",
  "d9b8f7ae0cbf3a42": "AgentProfileUpdated",
  "eac9a8bf1dc04b53": "ReputationUpdated",
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
      const discriminator = decoded.subarray(0, 8).toString("hex");
      const rawData = decoded.subarray(8).toString("hex");
      const eventName = DISCRIMINATOR_MAP[discriminator] || `event_${discriminator.substring(0, 8)}`;
      events.push({
        name: eventName,
        data: { discriminator, rawData },
      });
    } catch {
      // Skip unparseable base64 data
    }
  }

  return events;
}

function updateAgentFromEvent(db: Database.Database, event: ParsedEvent): void {
  const data = event.data as Record<string, string>;

  if (event.name === "AgentRegistered") {
    const stmt = db.prepare(`
      INSERT INTO agents (authority, name, category, last_updated)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(authority) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        last_updated = datetime('now')
    `);
    stmt.run(
      data.authority || "unknown",
      data.name || null,
      data.category || null
    );
  }

  if (event.name === "ReputationUpdated") {
    const stmt = db.prepare(`
      UPDATE agents SET
        reputation_score = ?,
        tasks_completed = tasks_completed + 1,
        last_updated = datetime('now')
      WHERE authority = ?
    `);
    stmt.run(
      parseInt(data.new_score || "0", 10),
      data.authority || "unknown"
    );
  }
}

const RECONNECT_DELAY_MS = 3000;

function subscribeToPrograms(connection: Connection, db: Database.Database): void {
  const insertStmt = db.prepare(`
    INSERT INTO events (program, event_name, data, signature, slot)
    VALUES (?, ?, ?, ?, ?)
  `);

  const subscriptionIds: Map<string, number> = new Map();
  let lastProcessedSlot = 0;

  function handleLogs(label: string, logs: Logs, ctx: SolanaContext): void {
    if (ctx.slot > lastProcessedSlot) {
      lastProcessedSlot = ctx.slot;
    }

    const events = parseLogsForEvents(logs.logs, label);

    for (const event of events) {
      try {
        insertStmt.run(
          label,
          event.name,
          JSON.stringify(event.data),
          logs.signature,
          ctx.slot
        );
        updateAgentFromEvent(db, event);
        console.log(
          `[${label}] ${event.name} @ slot ${ctx.slot} tx=${logs.signature.substring(0, 16)}...`
        );
      } catch (err) {
        console.error(`Failed to store event: ${err}`);
      }
    }
  }

  function subscribeWithReconnect(label: string, programId: PublicKey): void {
    console.log(`Subscribing to ${label}: ${programId.toBase58()}`);

    try {
      const subId = connection.onLogs(
        programId,
        (logs: Logs, ctx: SolanaContext) => {
          handleLogs(label, logs, ctx);
        },
        "confirmed"
      );
      subscriptionIds.set(label, subId);
    } catch (err) {
      console.error(`[${label}] Subscription failed: ${err}`);
      scheduleReconnect(label, programId);
      return;
    }

    // Monitor for WebSocket disconnects via connection error events
    const wsConnection = (connection as unknown as { _rpcWebSocket?: { on?: (event: string, handler: () => void) => void } })._rpcWebSocket;
    if (wsConnection && typeof wsConnection.on === "function") {
      wsConnection.on("close", () => {
        console.warn(`[${label}] WebSocket closed, scheduling reconnect (last slot: ${lastProcessedSlot})`);
        subscriptionIds.delete(label);
        scheduleReconnect(label, programId);
      });
    }
  }

  function scheduleReconnect(label: string, programId: PublicKey): void {
    console.log(`[${label}] Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
    setTimeout(() => {
      console.log(`[${label}] Attempting re-subscribe (last processed slot: ${lastProcessedSlot})`);
      subscribeWithReconnect(label, programId);
    }, RECONNECT_DELAY_MS);
  }

  for (const [label, programId] of Object.entries(PROGRAM_IDS)) {
    subscribeWithReconnect(label, programId);
  }
}

function createApi(db: Database.Database): express.Application {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", programs: Object.keys(PROGRAM_IDS) });
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

  return app;
}

async function main(): Promise<void> {
  console.log("AEAP Event Indexer starting...");
  console.log(`RPC: ${RPC_URL}`);

  const connection = new Connection(RPC_URL, "confirmed");
  const db = initDb(process.env.DB_PATH || "./aeap-events.db");

  subscribeToPrograms(connection, db);
  const app = createApi(db);
  app.listen(PORT, () => {
    console.log(`Indexer API listening on http://localhost:${PORT}`);
    console.log("Endpoints: GET /events, GET /events/:program, GET /agents, GET /stats");
  });

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

export { initDb, parseLogsForEvents, updateAgentFromEvent, createApi, PROGRAM_IDS };
