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
 *
 * ADR-131 dashboard surface (added 2026-04-30): the same HTTP server also
 * exposes two read-only JSON endpoints that back the operator dashboard's
 * re-calibration trigger cards. Both endpoints query Postgres-side
 * materialized views (created by `migrations/002-adr-131-trigger-views.sql`,
 * authored by a parallel agent — see view-name constants below) via the
 * optional `pgPool` parameter on `startMetricsServer`. When the pool is
 * not supplied (e.g. CLI or tests for the legacy Prometheus surface), the
 * trigger endpoints return HTTP 503 with a structured error so the
 * dashboard's loading/error states render instead of stale data. Reads
 * are intentionally co-located on this server (not the Express app on
 * port 3100) for two reasons:
 *   1. The Express app is owned by a parallel migration in this same
 *      pre-deploy cycle; co-location keeps the diff scoped to this file.
 *   2. ADR-128 Phase 1 keeps the Express app on SQLite reads. The trigger
 *      views live in Postgres, which this server can query directly via
 *      the supplied pool without crossing the SQLite boundary.
 */
import http from "http";
import type { Pool } from "pg";
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

// ---------------------------------------------------------------------------
// ADR-131 — re-calibration trigger view names.
//
// IMPORTANT: these constants MUST match the view names in
// `src/indexer/migrations/002-adr-131-trigger-views.sql` (authored by a
// parallel agent). If the SQL migration lands with different view names,
// update both this file AND the migration in lockstep — these names are
// the only coordination point between the dashboard surface and the
// indexer-side schema.
//
// Schema contract assumed by the SQL queries below:
//
//   v_fresh_authority_disputes_7d
//     Columns expected by /api/metrics/sybil-patterns:
//       - window_started_at  TIMESTAMPTZ  (start of the 7-day window)
//       - fresh_authorities  TEXT[]       (authorities that won disputes
//                                          while <90d old)
//       - incident_count     INTEGER      (rows where len(fresh_authorities)
//                                          >= 3 — i.e. an actual incident)
//     The endpoint sums `incident_count` over the trailing
//     `?window_days=7` (default) and returns the aggregate count plus
//     a deduplicated authority list for operator drill-down.
//
//   v_escrow_median_30d
//     Columns expected by /api/metrics/escrow-median:
//       - token_mint                TEXT     (PublicKey base58, or
//                                              'native' for SOL — must
//                                              match the EscrowCreated
//                                              event's `token_mint` field
//                                              landing in a parallel agent)
//       - median_amount_base_units  NUMERIC  (median in raw base units,
//                                              i.e. lamports for SOL,
//                                              micro-USDC for USDC)
//       - sample_count              INTEGER  (count of escrows in window)
//       - decimals                  SMALLINT (decimal scale of the mint —
//                                              9 for SOL, 6 for USDC)
//       - window_started_at         TIMESTAMPTZ
//     The endpoint groups by `token_mint` so SOL and USDC are reported
//     independently, per ADR-131 §"Re-calibration trigger" #2.
// ---------------------------------------------------------------------------
export const ADR_131_SYBIL_PATTERNS_VIEW = "vw_fresh_authority_disputes_7d";
export const ADR_131_ESCROW_MEDIAN_VIEW = "vw_escrow_median_30d";

// Known SPL mint decimals. The `vw_escrow_median_30d` view emits raw
// base-units (the on-chain `total_amount` u64 is mint-decimal-naive),
// so the API layer attaches the decimal scale per known mainnet mint.
// Unknown mints fall through to 6 (USDC-like) — that's the dominant
// settlement currency on this protocol; over-formatting an unknown
// mint as 6-decimals is a softer failure than under-formatting (a
// 9-decimal mint shown as 6-decimals reads as 1000× the actual SOL
// value, which is the safe direction — a human reviewer will notice).
const KNOWN_MINT_DECIMALS: Record<string, number> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC mainnet
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6, // USDT mainnet
  So11111111111111111111111111111111111111112: 9,  // Wrapped SOL
};

function decimalsForMint(mint: string): number {
  return KNOWN_MINT_DECIMALS[mint] ?? 6;
}

interface SybilPatternRow {
  window_started_at: Date;
  fresh_authorities: string[] | null;
  incident_count: number | string;
}

interface EscrowMedianRow {
  token_mint: string;
  median_amount_base_units: string | number;
  sample_count: number | string;
  window_started_at: Date;
}

/**
 * Parse `?window_days=N` with NaN / non-positive fallback to `defaultDays`.
 * Capped at `maxDays` so a malicious or typo'd query parameter cannot
 * coerce the view into an unbounded scan.
 */
function parseWindowDays(raw: string | string[] | undefined, defaultDays: number, maxDays: number): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === "") return defaultDays;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultDays;
  return Math.min(parsed, maxDays);
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function handleSybilPatterns(
  pool: Pool | undefined,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  if (!pool) {
    writeJson(res, 503, { error: "Postgres pool not configured for ADR-131 trigger endpoints" });
    return;
  }
  const windowDays = parseWindowDays(url.searchParams.get("window_days") ?? undefined, 7, 90);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  try {
    const result = await pool.query<SybilPatternRow>(
      `SELECT window_started_at, fresh_authorities, incident_count
         FROM ${ADR_131_SYBIL_PATTERNS_VIEW}
        WHERE window_started_at >= $1
        ORDER BY window_started_at DESC`,
      [since],
    );
    let count = 0;
    const authoritiesSet = new Set<string>();
    for (const row of result.rows) {
      const incident = typeof row.incident_count === "string"
        ? Number.parseInt(row.incident_count, 10)
        : row.incident_count;
      if (Number.isFinite(incident)) count += incident;
      if (Array.isArray(row.fresh_authorities)) {
        for (const authority of row.fresh_authorities) {
          if (typeof authority === "string" && authority.length > 0) {
            authoritiesSet.add(authority);
          }
        }
      }
    }
    writeJson(res, 200, {
      count,
      since: since.toISOString(),
      authorities_seen: Array.from(authoritiesSet),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeJson(res, 500, { error: "sybil-patterns query failed", detail: message });
  }
}

async function handleEscrowMedian(
  pool: Pool | undefined,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  if (!pool) {
    writeJson(res, 503, { error: "Postgres pool not configured for ADR-131 trigger endpoints" });
    return;
  }
  const windowDays = parseWindowDays(url.searchParams.get("window_days") ?? undefined, 30, 365);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  try {
    const result = await pool.query<EscrowMedianRow>(
      `SELECT token_mint, median_amount_base_units, sample_count, window_started_at
         FROM ${ADR_131_ESCROW_MEDIAN_VIEW}`,
      [],
    );
    const medianByToken: Record<
      string,
      { medianAmountBaseUnits: string; sampleCount: number; decimals: number }
    > = {};
    for (const row of result.rows) {
      if (!row.token_mint) continue;
      const sampleCount = typeof row.sample_count === "string"
        ? Number.parseInt(row.sample_count, 10)
        : row.sample_count;
      medianByToken[row.token_mint] = {
        medianAmountBaseUnits: String(row.median_amount_base_units),
        sampleCount: Number.isFinite(sampleCount) ? sampleCount : 0,
        decimals: decimalsForMint(row.token_mint),
      };
    }
    writeJson(res, 200, {
      medianByToken,
      since: since.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeJson(res, 500, { error: "escrow-median query failed", detail: message });
  }
}

/**
 * Start the Prometheus scrape endpoint. Safe to call once at process startup.
 * Returns the underlying http.Server so callers can close it in tests.
 *
 * AUD-029: bind to `METRICS_HOST` (default `127.0.0.1`) instead of the
 * Node default of `0.0.0.0`. Mirrors the same change in
 * `mcp-server/src/observability.ts`.
 *
 * ADR-131 (2026-04-30): when an optional `pgPool` is supplied, the same
 * server also serves two JSON trigger endpoints used by the operator
 * dashboard:
 *   GET /api/metrics/sybil-patterns?window_days=7
 *   GET /api/metrics/escrow-median?window_days=30
 * When `pgPool` is undefined, those routes return HTTP 503 so callers
 * can render a graceful "metric unavailable" state. The legacy
 * `/metrics` Prometheus surface is unchanged.
 */
export function startMetricsServer(port: number = 9100, pgPool?: Pool): http.Server {
  const host = process.env.METRICS_HOST ?? "127.0.0.1";
  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url ?? "/";
    // URL parsing requires a base when the request URL is path-only.
    const url = new URL(rawUrl, `http://${host}:${port}`);

    if (url.pathname === "/metrics") {
      res.setHeader("Content-Type", indexerRegistry.contentType);
      res.end(await indexerRegistry.metrics());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/metrics/sybil-patterns") {
      await handleSybilPatterns(pgPool, url, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/metrics/escrow-median") {
      await handleEscrowMedian(pgPool, url, res);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, host, () => {
    // eslint-disable-next-line no-console -- startup-only banner on stdout; matches the indexer's other init logs and is below the structured-logger boundary.
    console.log(`[metrics] Prometheus scrape endpoint on http://${host}:${port}/metrics`);
  });

  return server;
}
