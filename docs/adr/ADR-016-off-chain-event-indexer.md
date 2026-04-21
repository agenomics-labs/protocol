# ADR-016: Off-chain Event Indexer

## Status
Accepted

## Date
2026-04-15

## Context
AEP emits Anchor events from all three on-chain programs (Agent Vault, Agent Registry, Settlement Protocol) rather than storing audit data in accounts (see Architecture doc, Section 6: "Why Events for Indexing"). However, there is no off-chain component to capture, store, and query these events. Without an indexer, consumers must parse raw RPC logs manually, making it impractical to build dashboards, analytics, or agent discovery UIs.

The protocol needs a lightweight, self-contained indexer that:
- Subscribes to program log events in real-time via WebSocket
- Parses Anchor event discriminators and known event names
- Persists events durably for historical queries
- Exposes a simple API for frontends and other services

## Decision
Implement a TypeScript-based event indexer (`src/indexer/index.ts`) that:

1. **Subscribes** to Solana RPC `onLogs` for all three program IDs (vault, registry, settlement)
2. **Parses** both Anchor `Program data:` log lines (base64-encoded events) and human-readable event patterns (EscrowCreated, TaskAccepted, MilestoneApproved, etc.)
3. **Stores** events in a local SQLite database (via better-sqlite3) with WAL mode for concurrent read/write performance
4. **Maintains** a derived `agents` table updated from AgentRegistered and ReputationUpdated events
5. **Exposes** a REST API via Express:
   - `GET /events` - All events with pagination and optional event_name filter
   - `GET /events/:program` - Events filtered by program (vault, registry, settlement)
   - `GET /agents` - Indexed agents with optional category and reputation filters
   - `GET /stats` - Aggregate event and agent statistics

SQLite was chosen over Postgres for zero-configuration deployment. The indexer is designed to be replaceable with Helius, Metaplex DAS, or a custom Postgres indexer in production.

## Alternatives Considered

### Alternative A: Use Helius Webhooks directly
Rejected for MVP because it adds an external dependency and cost. The self-hosted indexer works with local validators and devnet without third-party accounts.

### Alternative B: Store events in Postgres
Rejected for initial implementation due to deployment complexity. SQLite with WAL mode handles the expected event volume (hundreds per day) with no infrastructure. Migration to Postgres is straightforward if needed.

### Alternative C: Use Anchor's built-in event CPI log parsing via @coral-xyz/anchor EventParser
Partially adopted. The indexer supports IDL-based parsing when available but falls back to regex-based extraction from log lines, making it resilient to IDL version mismatches.

## Consequences

### Positive
- Zero-infrastructure deployment (single process, embedded database)
- Real-time event capture with confirmed commitment level
- REST API enables dashboard and analytics development
- Derived agents table provides fast agent discovery queries
- WAL mode enables concurrent reads during writes

### Negative
- SQLite limits horizontal scaling (single-writer constraint)
- Event data is only as complete as the RPC node's log retention
- No backfill mechanism for historical events before indexer start
- Regex-based event parsing is fragile if log formats change

## Files Changed
- `src/indexer/index.ts` - Event indexer implementation
- `src/indexer/package.json` - Dependencies (express, better-sqlite3, @solana/web3.js, @coral-xyz/anchor)
