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

// ===========================================================================
// AUD-029 / AUD-403 — /metrics default-bind regression
// ===========================================================================
//
// `startMcpMetricsServer()` reads METRICS_HOST from process.env and falls
// back to "127.0.0.1" — keeping the scrape endpoint loopback-only by
// default so the tool-call cardinality / duration histograms are not an
// info-disclosure surface to LAN peers.
//
// AUD-403 (cycle-2 audit) flagged that the cycle-1 closure (440ecac) was
// config-only, with no automated assertion that `server.address()`
// actually reports the loopback bind. These tests are that assertion.
//
// Each case picks a fresh ephemeral port (port 0 → kernel assigns) so we
// don't collide with the suite above, sets/unsets METRICS_HOST, awaits
// `listening`, then reads `server.address()` and closes immediately.

describe("AUD-029 / AUD-403: /metrics binding default 127.0.0.1", () => {
  function awaitListening(s: http.Server): Promise<void> {
    return new Promise((resolve, reject) => {
      s.once("listening", () => resolve());
      s.once("error", reject);
    });
  }

  async function bindAndInspect(): Promise<{ address: string; family: string; port: number }> {
    // Port 0 lets the OS pick a free ephemeral port — avoids racing the
    // 19101 fixture above and lets every case run cleanly in parallel.
    const s = startMcpMetricsServer(0);
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

  it("defaults to 127.0.0.1 when METRICS_HOST is the empty string (??)", async () => {
    // Subtle: `??` (used in observability.ts) treats "" as a defined value
    // and would NOT fall back. Documenting that contract here so a refactor
    // to `||` doesn't silently widen the bind without anyone noticing.
    const saved = process.env.METRICS_HOST;
    process.env.METRICS_HOST = "";
    try {
      const addr = await bindAndInspect();
      // With METRICS_HOST="" Node interprets the empty bind as IPv6 unspec
      // (`::`) on dual-stack machines or 0.0.0.0 on IPv4-only — i.e. NOT
      // loopback. Capture today's behaviour explicitly so an operator who
      // sets METRICS_HOST="" cannot silently regress this gate.
      assert.notEqual(
        addr.address,
        "127.0.0.1",
        "METRICS_HOST=\"\" is a defined value; ?? fallback skipped — " +
          "reflect that contract so any future widening is intentional",
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
