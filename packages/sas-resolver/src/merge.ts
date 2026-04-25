// ADR-061 §4 merge semantics — "Registry + SAS" side-by-side helpers.
//
// These helpers implement the recommended UI convention from ADR-061
// §4 — Registry-native `reputation_score` and SAS `score` are shown
// side-by-side, never summed, because mixing them into one numeric
// hides provenance (the opposite of what the ADR is trying to
// preserve).
//
// This module does NOT enforce a particular rendering; it returns
// plain strings the caller can log, console.table, or slot into a
// UI component. The strings are deterministic so tests can assert
// exact output.

import type { AttestationReputation } from "./types.js";

/**
 * Minimal Registry-native view the merge helpers need. Mirrors the
 * subset of `AgentProfile` fields ADR-061 §5 lists as authoritative.
 * We do NOT import the full Registry type here — `@agenomics/sas-resolver`
 * is decoupled from program types by design (Registry TS bindings
 * regen on Anchor IDL bumps; this package shouldn't).
 *
 * AUD-007 (PR-Q): the on-chain `total_tasks_completed` field was retired
 * (PR-G had already deleted the only writer; the field had become
 * permanently zero). We keep the property here as **optional** so the
 * resolver can still render a task count when the caller has one from a
 * different source (typically the indexer — ADR-061 §5 explicitly carves
 * out per-task telemetry as the indexer's domain). The field is omitted
 * for callers who only have on-chain Registry signals.
 */
export interface RegistryReputationView {
  /** Registry-native `reputation_score`, 0..10000 bps. */
  reputation_score: number;
  /**
   * Optional task counter. AUD-007 (PR-Q): no longer sourced from the
   * on-chain Registry; comes from the indexer if at all.
   */
  total_tasks_completed?: number;
  /** Optional stake amount (lamports or basis points — caller chooses). */
  staked_amount?: number;
  /** Slash count (ADR-020). */
  slash_count?: number;
}

/**
 * "Fresh" = last_updated within 30 days.
 * "Aging" = 30 days < last_updated <= 90 days.
 * "Stale" = last_updated > 90 days.
 *
 * Per ADR-061 §6: the 90-day threshold is a resolver-side convention,
 * not a protocol rule. Consumers are free to weight stale attestations
 * lower but not discard them; the resolver merely surfaces the bucket.
 */
export type Freshness = "fresh" | "aging" | "stale";

const SECS_PER_DAY = 86_400;
const FRESH_THRESHOLD_DAYS = 30;
const STALE_THRESHOLD_DAYS = 90;

/**
 * Classify an attestation's staleness given its `last_updated` and the
 * current unix-seconds time.
 *
 * `now` defaults to real wall-clock if unspecified; tests should pass
 * an explicit value (same contract as `ResolverConfig.now`).
 */
export function scoreFreshness(
  lastUpdated: number,
  now: number = Math.floor(Date.now() / 1000),
): Freshness {
  const age_secs = Math.max(0, now - lastUpdated);
  const age_days = age_secs / SECS_PER_DAY;
  if (age_days <= FRESH_THRESHOLD_DAYS) return "fresh";
  if (age_days <= STALE_THRESHOLD_DAYS) return "aging";
  return "stale";
}

/**
 * Are Registry and SAS scores far enough apart to flag to the
 * consumer? ADR-061 §4 recommends 2000 bps (20 percentage points).
 *
 * Returns `false` when either side is unavailable — divergence is
 * only meaningful when both signals exist.
 */
export function detectDisagreement(
  registry: RegistryReputationView,
  sas: AttestationReputation | undefined,
): boolean {
  if (!sas) return false;
  const delta = Math.abs(registry.reputation_score - sas.score);
  return delta > 2000;
}

/**
 * Render a two-line "Registry + SAS" side-by-side summary following
 * ADR-061 §4's UX convention. The strings are deliberately plain so
 * callers can wrap them in whatever UI primitive they prefer.
 *
 * Examples:
 *   line1 = "Registry: 8200/10000 (124 tasks)"
 *   line2 = "SAS:      8600/10000 (fresh, 118 tasks, signer=…)"
 *
 * `line2` is the empty string when no SAS signal is present — caller
 * can render a single-line fallback "SAS: (no attestation)" or omit
 * the line entirely.
 */
export function renderSideBySide(
  registry: RegistryReputationView,
  sas: AttestationReputation | undefined,
  now: number = Math.floor(Date.now() / 1000),
): { line1: string; line2: string } {
  // AUD-007 (PR-Q): tasks count is now optional — render only when supplied.
  const tasksSuffix =
    typeof registry.total_tasks_completed === "number"
      ? ` (${registry.total_tasks_completed} tasks)`
      : "";
  const line1 = `Registry: ${registry.reputation_score}/10000${tasksSuffix}`;
  if (!sas) {
    return { line1, line2: "SAS:      (no attestation)" };
  }
  const freshness = scoreFreshness(sas.last_updated, now);
  const signerShort = shortPubkey(sas.signer);
  const line2 = `SAS:      ${sas.score}/10000 (${freshness}, ${sas.completed_tasks} tasks, signer=${signerShort})`;
  return { line1, line2 };
}

/**
 * `Abcd…wxyz` short form for base58 pubkeys — compact display without
 * dropping the full string (callers can log the full pubkey separately
 * when they need it; this is a UX concession to terminal width).
 */
function shortPubkey(pubkey: string): string {
  if (pubkey.length <= 8) return pubkey;
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}
