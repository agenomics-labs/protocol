/**
 * Integration test for the mcp-server Prometheus metrics endpoint (ADR-104).
 *
 * Verifies that:
 *   1. GET /metrics returns 200 with the correct content-type
 *   2. The response body contains aep_mcp metric families
 *   3. tracedToolCall records counter increments on success and error
 *   4. OTel opt-in: initTracing() is a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is absent
 *
 * Runs under `node --import tsx --test`.
 */

import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "http";
import {
  startMcpMetricsServer,
  tracedToolCall,
  initTracing,
  mcpRegistry,
} from "../src/observability.js";

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

const TEST_PORT = 19101;

describe("mcp-server observability (ADR-104)", () => {
  let server: http.Server;

  before(async () => {
    mcpRegistry.resetMetrics();
    server = startMcpMetricsServer(TEST_PORT);
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

  it("GET /metrics body contains aep_mcp metric families", async () => {
    const { body } = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
    assert.ok(body.includes("aep_mcp_tool_calls_total"), "missing aep_mcp_tool_calls_total");
    assert.ok(
      body.includes("aep_mcp_tool_duration_seconds"),
      "missing aep_mcp_tool_duration_seconds"
    );
  });

  it("GET /other returns 404", async () => {
    const { status } = await httpGet(`http://127.0.0.1:${TEST_PORT}/health`);
    assert.equal(status, 404);
  });

  it("tracedToolCall increments success counter", async () => {
    mcpRegistry.resetMetrics();
    await tracedToolCall("test_tool", async () => "ok");
    const { body } = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
    assert.ok(body.includes('tool_name="test_tool"'), "tool_name label missing");
    assert.ok(body.includes('status="success"'), "status=success label missing");
  });

  it("tracedToolCall increments error counter on throw", async () => {
    mcpRegistry.resetMetrics();
    try {
      await tracedToolCall("failing_tool", async () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    const { body } = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
    assert.ok(body.includes('tool_name="failing_tool"'), "tool_name label missing");
    assert.ok(body.includes('status="error"'), "status=error label missing");
  });

  it("initTracing is a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is absent", () => {
    const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    assert.doesNotThrow(() => initTracing());
    if (saved !== undefined) {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved;
    }
  });

  it("tracedToolCall returns the resolved value", async () => {
    const result = await tracedToolCall("echo_tool", async () => ({ ok: true }));
    assert.deepEqual(result, { ok: true });
  });
});
