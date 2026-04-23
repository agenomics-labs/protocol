/**
 * Integration test for the indexer Prometheus metrics server (ADR-104).
 *
 * Verifies that:
 *   1. GET /metrics returns 200 with the correct Prometheus content-type
 *   2. The response body contains at least the indexer metric family names
 *   3. GET <anything else> returns 404
 *   4. The exported counters/gauge can be incremented without throwing
 */
import * as assert from "assert";
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

// Use a dedicated port range that is unlikely to clash with the service under test.
const TEST_PORT = 19100;

describe("indexer metrics-server (ADR-104)", () => {
  let server: http.Server;

  before(async () => {
    // Reset registry counters between test runs so values are deterministic.
    indexerRegistry.resetMetrics();
    server = startMetricsServer(TEST_PORT);
    // Give the server a tick to bind.
    await new Promise<void>((r) => setTimeout(r, 50));
  });

  after((done) => {
    server.close(done);
  });

  it("GET /metrics returns 200", async () => {
    const { status } = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
    assert.strictEqual(status, 200);
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
    assert.strictEqual(status, 404);
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
