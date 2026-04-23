/**
 * Prometheus metrics server for the AEP indexer (ADR-104).
 *
 * Starts a minimal HTTP server on METRICS_PORT (default 9100) that serves
 * the prom-client default registry at GET /metrics. The server is entirely
 * separate from the indexer's primary Express API so scrape traffic never
 * blocks application requests.
 *
 * Counters / gauges are exported so the event-processing loop can
 * increment them inline without importing prom-client directly.
 */
import http from "http";
import { Counter, Gauge, Registry } from "prom-client";

export const indexerRegistry = new Registry();

export const eventsProcessed = new Counter({
  name: "aep_indexer_events_processed_total",
  help: "Total events decoded from Solana logs",
  labelNames: ["event_type"] as const,
  registers: [indexerRegistry],
});

export const lastSlotProcessed = new Gauge({
  name: "aep_indexer_last_slot_processed",
  help: "Most recent Solana slot processed by the indexer",
  registers: [indexerRegistry],
});

export const indexerErrors = new Counter({
  name: "aep_indexer_errors_total",
  help: "Errors encountered during event processing",
  labelNames: ["error_type"] as const,
  registers: [indexerRegistry],
});

/**
 * Start the Prometheus scrape endpoint. Safe to call once at process startup.
 * Returns the underlying http.Server so callers can close it in tests.
 */
export function startMetricsServer(port: number = 9100): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("Content-Type", indexerRegistry.contentType);
      res.end(await indexerRegistry.metrics());
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    console.log(`[metrics] Prometheus scrape endpoint on http://0.0.0.0:${port}/metrics`);
  });

  return server;
}
