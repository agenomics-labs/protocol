/**
 * ADR-139 — reputation-attestor HTTP issuer tests.
 *
 * Exercises the route surface, rate-limit, caching, and error-path
 * behaviour without booting the full indexer. Tests use a stub
 * `AgentProfileFetcher` and an in-memory `IssuerKeypair` so they're
 * hermetic.
 */

import { describe, it, before } from "node:test";
import * as assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import type {
  AgentProfileSnapshot,
} from "@agenomics/reputation-attestor";
import {
  createReputationAttestorApp,
  type AgentProfileFetcher,
} from "../reputation-attestor.js";

// ADR-091-style — @agenomics/reputation-attestor is ESM-only; the
// indexer test compile is CJS. Dynamic import at runtime preserves type
// safety without forcing a CJS↔ESM interop tax at module load.
type AttestorModule = typeof import("@agenomics/reputation-attestor");
let R: AttestorModule;
before(async () => {
  R = await import("@agenomics/reputation-attestor");
});

const AGENT_ID = "AgentPubkey1111111111111111111111111111111AA";
const AUTHORITY = "AuthorityPubkey1111111111111111111111111111A";

function fixtureSnapshot(overrides: Partial<AgentProfileSnapshot> = {}): AgentProfileSnapshot {
  return {
    agent_id: AGENT_ID,
    authority: AUTHORITY,
    manifest_hash: "e".repeat(64),
    reputation_score: 73,
    slash_count: 0,
    reputation_stake_lamports: 1_000_000_000n,
    registration_nonce: 4n,
    snapshot_slot: 184_729_103n,
    snapshot_timestamp: 1_731_543_123,
    ...overrides,
  };
}

class StubFetcher implements AgentProfileFetcher {
  current: { snapshot: AgentProfileSnapshot; isActive: boolean } | null;
  historical: Map<string, { snapshot: AgentProfileSnapshot; isActive: boolean } | null | undefined>;
  callCount = 0;
  shouldThrow = false;

  constructor() {
    this.current = { snapshot: fixtureSnapshot(), isActive: true };
    this.historical = new Map();
  }

  async fetchCurrent(_agentId: string) {
    this.callCount++;
    if (this.shouldThrow) throw new Error("rpc boom");
    return this.current;
  }

  async fetchAtSlot(_agentId: string, slot: bigint) {
    this.callCount++;
    const key = slot.toString();
    return this.historical.get(key);
  }
}

function startApp(opts: {
  fetcher: AgentProfileFetcher;
  now?: () => number;
  cacheBucketSeconds?: number;
  rateLimitMaxRequests?: number;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const issuer = R.issuerKeypairFromSecret(new Uint8Array(32).fill(0x77));
  const app = createReputationAttestorApp({
    issuer,
    fetcher: opts.fetcher,
    issuerUrl: "https://reputation.test.example",
    now: opts.now,
    cacheBucketSeconds: opts.cacheBucketSeconds,
    rateLimitMaxRequests: opts.rateLimitMaxRequests,
  });
  const server: Server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res) => {
            // See x402-relay/test/admin-drain-endpoint.test.ts for the
            // full rationale: undici's fetch() keeps keep-alive sockets
            // open, and server.close() waits on them indefinitely
            // otherwise.
            server.closeAllConnections();
            server.close(() => res());
          }),
      });
    });
  });
}

describe("ADR-139 reputation-attestor HTTP issuer", () => {
  it("GET /reputation/:agent_id returns a verifiable credential", async (t) => {
    const fetcher = new StubFetcher();
    const handle = await startApp({ fetcher });
    t.after(() => handle.close());

    const resp = await fetch(`${handle.url}/reputation/${AGENT_ID}`);
    assert.equal(resp.status, 200);
    const cred = await resp.json();
    const verified = R.verifyAttestation(cred);
    assert.equal(verified.ok, true);
    if (verified.ok) {
      assert.equal(verified.payload.reputation_score, 73);
      assert.equal(verified.payload.slash_count, 0);
      assert.equal(verified.payload.agent_id, AGENT_ID);
    }
  });

  it("rejects a non-base58 agent_id", async (t) => {
    const fetcher = new StubFetcher();
    const handle = await startApp({ fetcher });
    t.after(() => handle.close());

    const resp = await fetch(`${handle.url}/reputation/not-a-pubkey`);
    assert.equal(resp.status, 400);
  });

  it("returns 404 for an unknown agent", async (t) => {
    const fetcher = new StubFetcher();
    fetcher.current = null;
    const handle = await startApp({ fetcher });
    t.after(() => handle.close());

    const resp = await fetch(`${handle.url}/reputation/${AGENT_ID}`);
    assert.equal(resp.status, 404);
  });

  it("returns 409 for a non-active agent", async (t) => {
    const fetcher = new StubFetcher();
    fetcher.current = { snapshot: fixtureSnapshot(), isActive: false };
    const handle = await startApp({ fetcher });
    t.after(() => handle.close());

    const resp = await fetch(`${handle.url}/reputation/${AGENT_ID}`);
    assert.equal(resp.status, 409);
  });

  it("returns 502 when upstream throws", async (t) => {
    const fetcher = new StubFetcher();
    fetcher.shouldThrow = true;
    const handle = await startApp({ fetcher });
    t.after(() => handle.close());

    const resp = await fetch(`${handle.url}/reputation/${AGENT_ID}`);
    assert.equal(resp.status, 502);
  });

  it("caches within the bucket window — second hit does not fetch", async (t) => {
    const fetcher = new StubFetcher();
    let t0 = 1000;
    const handle = await startApp({
      fetcher,
      now: () => t0,
      cacheBucketSeconds: 5,
    });
    t.after(() => handle.close());

    const r1 = await fetch(`${handle.url}/reputation/${AGENT_ID}`);
    assert.equal(r1.status, 200);
    const r2 = await fetch(`${handle.url}/reputation/${AGENT_ID}`);
    assert.equal(r2.status, 200);
    assert.equal(fetcher.callCount, 1, "second request should hit cache");
    t0 += 10;
    const r3 = await fetch(`${handle.url}/reputation/${AGENT_ID}`);
    assert.equal(r3.status, 200);
    assert.equal(fetcher.callCount, 2, "after bucket rolls, cache misses");
  });

  it("rate-limits per IP", async (t) => {
    const fetcher = new StubFetcher();
    const handle = await startApp({
      fetcher,
      cacheBucketSeconds: 0,
      rateLimitMaxRequests: 2,
    });
    t.after(() => handle.close());

    const a = await fetch(`${handle.url}/reputation/${AGENT_ID}`);
    const b = await fetch(`${handle.url}/reputation/${AGENT_ID}`);
    const c = await fetch(`${handle.url}/reputation/${AGENT_ID}`);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 429);
  });

  it("GET /reputation/:agent_id/at/:slot returns 501 when no fetcher.fetchAtSlot impl exists", async (t) => {
    const fetcher: AgentProfileFetcher = {
      async fetchCurrent() {
        return { snapshot: fixtureSnapshot(), isActive: true };
      },
    };
    const handle = await startApp({ fetcher });
    t.after(() => handle.close());

    const resp = await fetch(`${handle.url}/reputation/${AGENT_ID}/at/100`);
    assert.equal(resp.status, 501);
    const body = await resp.json();
    assert.ok(typeof body.fallback === "string");
  });

  it("GET /reputation/:agent_id/at/:slot returns a signed historical credential when fetcher has the slot", async (t) => {
    const fetcher = new StubFetcher();
    const snap = fixtureSnapshot({ reputation_score: 42, snapshot_slot: 100n });
    fetcher.historical.set("100", { snapshot: snap, isActive: true });
    const handle = await startApp({ fetcher });
    t.after(() => handle.close());

    const resp = await fetch(`${handle.url}/reputation/${AGENT_ID}/at/100`);
    assert.equal(resp.status, 200);
    const cred = await resp.json();
    const v = R.verifyAttestation(cred);
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.payload.reputation_score, 42);
  });

  it("rejects /at/:slot with non-numeric slot", async (t) => {
    const fetcher = new StubFetcher();
    const handle = await startApp({ fetcher });
    t.after(() => handle.close());

    const resp = await fetch(`${handle.url}/reputation/${AGENT_ID}/at/abc`);
    assert.equal(resp.status, 400);
  });
});
