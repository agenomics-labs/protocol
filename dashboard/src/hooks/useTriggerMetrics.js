import { useState, useEffect, useCallback } from "react";
import { METRICS_API_URL } from "../config.js";

/**
 * ADR-131 re-calibration trigger metrics. Polls the indexer's metrics-server
 * (default http://localhost:9100) for the two operator-facing signals:
 *   1. Sybil-pattern incidents over a 7-day window.
 *   2. Escrow median over a 30-day window, broken down by token mint.
 *
 * Mirrors the indexer-first / 30s-poll / graceful-failure shape of
 * useProtocolData.js. When the metrics endpoints are unavailable
 * (HTTP 503 because the pg pool is not wired, network error, etc.),
 * `available` flips to false and the StatsBar renders the same "..."
 * loading dash the existing cards use during their first fetch. This
 * keeps the dashboard pre-deploy build green even if the parallel
 * indexer agent has not yet wired the materialized views.
 */
export function useTriggerMetrics() {
  const [state, setState] = useState({
    sybilPatterns: null, // { count: number, since: string, authorities_seen: string[] }
    escrowMedian: null, // { medianByToken: { [mint]: { medianAmountBaseUnits, sampleCount, decimals } }, since: string }
    loading: true,
    available: false,
    error: null,
  });

  const fetchMetrics = useCallback(async () => {
    try {
      const [sybilRes, escrowRes] = await Promise.all([
        fetch(`${METRICS_API_URL}/api/metrics/sybil-patterns?window_days=7`),
        fetch(`${METRICS_API_URL}/api/metrics/escrow-median?window_days=30`),
      ]);
      if (!sybilRes.ok || !escrowRes.ok) {
        setState({
          sybilPatterns: null,
          escrowMedian: null,
          loading: false,
          available: false,
          error: `metrics endpoint returned ${sybilRes.status}/${escrowRes.status}`,
        });
        return;
      }
      const sybil = await sybilRes.json();
      const escrow = await escrowRes.json();
      setState({
        sybilPatterns: sybil,
        escrowMedian: escrow,
        loading: false,
        available: true,
        error: null,
      });
    } catch (err) {
      setState({
        sybilPatterns: null,
        escrowMedian: null,
        loading: false,
        available: false,
        error: err?.message || "fetch failed",
      });
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 30000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  return { ...state, refresh: fetchMetrics };
}
