/**
 * Observability for the AEP MCP server (ADR-104).
 *
 * Prometheus metrics
 * ------------------
 * Two prom-client metrics wrap the tool-dispatch layer:
 *   aep_mcp_tool_calls_total{tool_name, status}   — counter
 *   aep_mcp_tool_duration_seconds{tool_name}       — histogram
 *
 * A scrape endpoint is started on METRICS_PORT (default 9101) by calling
 * `startMcpMetricsServer()` once at process startup.
 *
 * OpenTelemetry tracing
 * ---------------------
 * The OTLP exporter is opt-in: the NodeTracerProvider is only initialised
 * when the OTEL_EXPORTER_OTLP_ENDPOINT environment variable is set.
 * When absent the tracer resolves to the no-op SDK tracer and adds zero
 * overhead. Call `initTracing()` once at startup before the first tool
 * dispatch.
 *
 * The exported `tracedDispatch` helper wraps an async action in a single
 * OTel span and records the tool name + outcome as attributes.
 */

import * as http from "http";
import { Counter, Histogram, Registry } from "prom-client";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// Prometheus registry + metrics
// ---------------------------------------------------------------------------

export const mcpRegistry = new Registry();

export const mcpToolCalls = new Counter({
  name: "aep_mcp_tool_calls_total",
  help: "MCP tool invocations",
  labelNames: ["tool_name", "status"] as const,
  registers: [mcpRegistry],
});

export const mcpToolDuration = new Histogram({
  name: "aep_mcp_tool_duration_seconds",
  help: "MCP tool call duration",
  labelNames: ["tool_name"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [mcpRegistry],
});

/**
 * Start the Prometheus scrape endpoint. Returns the http.Server so callers
 * can close it in tests.
 *
 * AUD-029: bind to `METRICS_HOST` (default `127.0.0.1`) instead of the
 * Node default of `0.0.0.0`. The /metrics endpoint exposes tool-call rates
 * and durations — operationally useful for a local Prometheus scraper but
 * an information-disclosure surface if reachable from any peer on the LAN.
 * Operators that need a non-loopback bind (e.g. a sidecar topology) opt in
 * explicitly via `METRICS_HOST=0.0.0.0`.
 */
export function startMcpMetricsServer(port: number = 9101): http.Server {
  const host = process.env.METRICS_HOST ?? "127.0.0.1";
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("Content-Type", mcpRegistry.contentType);
      res.end(await mcpRegistry.metrics());
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, host, () => {
    // Bootstrap-phase log: pino is configured elsewhere; this fires at
    // startup before structured logging is wired into this module.
    // eslint-disable-next-line no-console
    console.error(
      `[metrics] Prometheus scrape endpoint on http://${host}:${port}/metrics`,
    );
  });

  return server;
}

// ---------------------------------------------------------------------------
// OpenTelemetry tracing
// ---------------------------------------------------------------------------

let _tracer: Tracer | null = null;

/**
 * Initialise the OpenTelemetry tracer provider when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set. Must be called before any traced
 * operation. If the env variable is absent this is a no-op and `getTracer`
 * returns the SDK no-op tracer.
 */
export function initTracing(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    return; // OTel opt-in — no-op tracer used automatically
  }

  // Dynamic require so the heavy SDK bundles are only loaded when OTel is
  // actually configured. This keeps the startup cost near-zero in stdio mode.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SimpleSpanProcessor } = require("@opentelemetry/sdk-trace-node");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Resource } = require("@opentelemetry/resources");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SEMRESATTRS_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");

  const provider = new NodeTracerProvider({
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: "aep-mcp-server",
    }),
  });

  const exporter = new OTLPTraceExporter({ url: endpoint });
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();

  // Bootstrap-phase log: pino is configured elsewhere; this fires at
  // startup before structured logging is wired into this module.
  // eslint-disable-next-line no-console
  console.error(`[otel] OTLP trace exporter configured → ${endpoint}`);
}

/**
 * Return the OTel tracer. After `initTracing()` this is either the real
 * NodeTracerProvider's tracer (when OTEL_EXPORTER_OTLP_ENDPOINT is set) or
 * the no-op tracer (when it is not).
 */
export function getTracer(): Tracer {
  if (!_tracer) {
    _tracer = trace.getTracer("aep-mcp-server", "1.0.0");
  }
  return _tracer;
}

// ---------------------------------------------------------------------------
// Traced + metered dispatch helper
// ---------------------------------------------------------------------------

/**
 * Wrap an async tool handler with:
 *   1. An OTel span for the call (name = "mcp.tool/<toolName>")
 *   2. Prometheus counter + histogram recording
 *
 * The returned promise resolves/rejects identically to `fn`.
 */
export async function tracedToolCall<T>(
  toolName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  const end = mcpToolDuration.startTimer({ tool_name: toolName });

  return tracer.startActiveSpan(`mcp.tool/${toolName}`, async (span) => {
    span.setAttribute("mcp.tool_name", toolName);
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      mcpToolCalls.inc({ tool_name: toolName, status: "success" });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      mcpToolCalls.inc({ tool_name: toolName, status: "error" });
      throw err;
    } finally {
      end();
      span.end();
    }
  });
}
