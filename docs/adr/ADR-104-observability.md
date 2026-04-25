# ADR-104: Prometheus Metrics + OpenTelemetry Tracing for Off-chain Services

**Status:** Accepted
**Date:** 2026-04-23

## Context

The AEP off-chain services (indexer and mcp-server) have no standardised observability
infrastructure. There are no scrapeable metrics endpoints, and no distributed traces to
correlate a slow MCP tool call with on-chain RPC latency or SQLite pressure. The only
runtime signal is `console.log`/`console.error` output.

Architecture audit item 27 identified this as a gap: "Prometheus `/metrics` on indexer +
relay; OpenTelemetry tracing across MCP→CPI→indexer".

## Decision

1. **Prometheus metrics** are added to both the indexer and the mcp-server via `prom-client`.
   Each service exposes a `/metrics` endpoint on a dedicated HTTP server (separate from its
   primary API/MCP port) so scrape traffic does not mix with application traffic.

   - Indexer: `METRICS_PORT` env, default `9100`
   - mcp-server: `METRICS_PORT` env, default `9101`

2. **Indexer metrics** instrument the event processing pipeline:
   - `aep_indexer_events_processed_total{event_type}` — counter per event name
   - `aep_indexer_last_slot_processed` — gauge updated on every processed slot
   - `aep_indexer_errors_total{error_type}` — counter per error class

3. **MCP-server metrics** instrument the tool dispatch layer:
   - `aep_mcp_tool_calls_total{tool_name, status}` — counter labelled success/error
   - `aep_mcp_tool_duration_seconds{tool_name}` — histogram with default buckets

4. **OpenTelemetry tracing** is added to the mcp-server at the tool-call boundary.
   A span is created for each `CallToolRequest` and the tool name is recorded as an
   attribute. The OTLP exporter is **opt-in**: the tracer provider is only initialised
   when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. When the variable is absent the tracer
   resolves to a no-op and adds zero overhead.

## Consequences

- Operators can scrape both services with a standard Prometheus installation and build
  Grafana dashboards without log parsing.
- The OTel integration is non-breaking: existing deployments that omit
  `OTEL_EXPORTER_OTLP_ENDPOINT` see no change in behaviour.
- Two additional npm dependencies are required for the indexer (`prom-client`) and five
  for the mcp-server (`prom-client`, `@opentelemetry/api`, `@opentelemetry/sdk-trace-node`,
  `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources`).

## References

- Architecture audit item 27
- ADR-016: off-chain event indexer
- ADR-083: MCP transport auth
