/**
 * Integration test for the indexer Prometheus metrics server (ADR-104).
 *
 * Verifies that:
 *   1. GET /metrics returns 200 with the correct Prometheus content-type
 *   2. The response body contains the indexer metric family names
 *   3. GET <anything else> returns 404
 *   4. The exported counters/gauge can be incremented without throwing
 *   5. Incremented values are reflected in the scrape output
 *
 * Runs under `node --import ts-node/esm --test` or similar tsx-based runner.
 * Uses `node:test` + `node:assert` so there is no extra test-framework dep.
 */

import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "http";
import {
  startMetricsServer,
  eventsProcessed,
  indexerErrors,
  lastSlotProcessed,
  indexerRegistry,
} from "./metrics-server";

function httpGet(url: string): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers["content-type"] ?? "",
          body,
        })
      );
    }).on("error", reject);
  });
}

const TEST_PORT = 19100;

describe("indexer metrics-server (ADR-104)", () => {
  let server: http.Server;

  before(async () => {
    indexerRegistry.resetMetrics();
    server = startMetricsServer(TEST_PORT);
    await new Promise<void>((r) => setTimeout(r, 50));
  });

  after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  );

  it("GET /metrics returns 200", async () => {
    const { status } = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
    assert.equal(status, 200);
  });

  it("GET /metrics returns Prometheus content-type", async () => {
    const { contentType } = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
    assert.ok(
      contentType.includes("text/plain") || contentType.includes("application/openmetrics-text"),
      `unexpected content-type: ${contentType}`
    );
  });

  it("GET /metrics body contains aep_indexer metric families", async () => {
    const { body } = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
    assert.ok(
      body.includes("aep_indexer_events_processed_total"),
      "missing aep_indexer_events_processed_total"
    );
    assert.ok(
      body.includes("aep_indexer_last_slot_processed"),
      "missing aep_indexer_last_slot_processed"
    );
    assert.ok(
      body.includes("aep_indexer_errors_total"),
      "missing aep_indexer_errors_total"
    );
  });

  it("GET /other returns 404", async () => {
    const { status } = await httpGet(`http://127.0.0.1:${TEST_PORT}/health`);
    assert.equal(status, 404);
  });

  it("eventsProcessed counter increments without error", () => {
    assert.doesNotThrow(() => {
      eventsProcessed.inc({ event_type: "AgentRegistered" });
      eventsProcessed.inc({ event_type: "AgentDeregistered" });
    });
  });

  it("indexerErrors counter increments without error", () => {
    assert.doesNotThrow(() => {
      indexerErrors.inc({ error_type: "store_event" });
    });
  });

  it("lastSlotProcessed gauge sets without error", () => {
    assert.doesNotThrow(() => {
      lastSlotProcessed.set(42_000_000);
    });
  });

  it("incremented values are reflected in /metrics output", async () => {
    indexerRegistry.resetMetrics();
    eventsProcessed.inc({ event_type: "VaultInitialized" });
    lastSlotProcessed.set(99);

    const { body } = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
    assert.ok(
      body.includes("VaultInitialized"),
      "label value VaultInitialized not found in output"
    );
  });
});

// ===========================================================================
// AUD-029 / AUD-403 — /metrics default-bind regression (indexer)
// ===========================================================================
//
// `startMetricsServer()` (src/indexer/metrics-server.ts) reads METRICS_HOST
// from process.env and falls back to "127.0.0.1" — same default-loopback
// posture as mcp-server's `startMcpMetricsServer`. AUD-403 (cycle-2 audit)
// flagged the cycle-1 closure (440ecac) as config-only with no automated
// bind assertion. These tests are that assertion for the indexer.

describe("AUD-029 / AUD-403: indexer /metrics binding default 127.0.0.1", () => {
  function awaitListening(s: http.Server): Promise<void> {
    return new Promise((resolve, reject) => {
      s.once("listening", () => resolve());
      s.once("error", reject);
    });
  }

  async function bindAndInspect(): Promise<{ address: string; family: string; port: number }> {
    // Port 0 lets the OS pick a free ephemeral port — avoids racing the
    // 19100 fixture above.
    const s = startMetricsServer(0);
    try {
      await awaitListening(s);
      const addr = s.address();
      assert.ok(addr && typeof addr === "object", "server.address() must be an AddressInfo");
      return addr as { address: string; family: string; port: number };
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  it("defaults to 127.0.0.1 when METRICS_HOST is unset", async () => {
    const saved = process.env.METRICS_HOST;
    delete process.env.METRICS_HOST;
    try {
      const addr = await bindAndInspect();
      assert.equal(
        addr.address,
        "127.0.0.1",
        "default bind must be loopback IPv4 (AUD-029 / AUD-403)",
      );
    } finally {
      if (saved !== undefined) process.env.METRICS_HOST = saved;
      else delete process.env.METRICS_HOST;
    }
  });

  it("honours METRICS_HOST=0.0.0.0 when an operator opts in to a wider bind", async () => {
    const saved = process.env.METRICS_HOST;
    process.env.METRICS_HOST = "0.0.0.0";
    try {
      const addr = await bindAndInspect();
      assert.equal(
        addr.address,
        "0.0.0.0",
        "explicit METRICS_HOST=0.0.0.0 must propagate to the listen() call",
      );
    } finally {
      if (saved !== undefined) process.env.METRICS_HOST = saved;
      else delete process.env.METRICS_HOST;
    }
  });
});
