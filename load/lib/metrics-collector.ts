/**
 * Metrics collector for load scenarios.
 *
 * Captures, per ix-class:
 *   - wall-clock latency (ms) → p50 / p95 / p99
 *   - compute units (CU) consumed (parsed from tx-log meta.computeUnitsConsumed)
 *   - RPC failure counts, classified by error class
 *
 * Plus per-run aggregates:
 *   - run start / end timestamps
 *   - concurrency, scenario name, RPC URL
 *   - indexer ingest lag (slot delta) at run end
 *   - first / last slot observed
 *
 * The collector is intentionally allocation-light: latencies are stored in
 * unsorted Float64Arrays per ix-class, percentiles are computed at flush
 * time only. This lets a multi-hour campaign capture hundreds of thousands
 * of samples without GC pressure mid-run.
 *
 * Output: a single JSON file under `load/results/`. Schema is stable across
 * Phase 2/3 additions — new ix-classes append to `perIx`; new aggregate
 * fields are additive on `summary`. Operators consume this file; CI in
 * Phase 3 will diff it against threshold SLOs.
 */
import * as fs from "fs";
import * as path from "path";

export type IxClass =
  | "register_agent"
  | "initialize_vault"
  | "create_escrow"
  | "accept_task"
  | "submit_milestone"
  | "approve_milestone"
  // approve_milestone CPIs into Registry::update_provider_reputation, which
  // is the post-AUD-100 implementation of the propose_reputation_delta
  // policy. We surface the CPI cost separately via tx-log inspection; see
  // README §"Why no direct propose_reputation_delta latency?".
  | "approve_milestone__includes_reputation_cpi";

export interface IxSample {
  /** Wall-clock ms from before the .rpc() call to confirmation. */
  latencyMs: number;
  /** Compute units, NaN if the tx had no meta or the field was undefined. */
  computeUnits: number;
  /** Tx signature, retained for forensic on slow-tail samples only. */
  signature: string;
  /** Slot the tx landed in, for ordering / lag computations. */
  slot: number;
}

export type RpcErrorClass =
  | "timeout"
  | "slot_skipped"
  | "rate_limited"
  | "blockhash_not_found"
  | "node_unhealthy"
  | "transaction_failed"
  | "other";

export interface IndexerLagReading {
  /** Cluster head slot at the time of measurement. */
  chainHeadSlot: number;
  /** Indexer cursor's last_processed_slot per program label. */
  perProgram: Record<string, { cursorSlot: number; lagSlots: number }>;
  /** True if the cursor table was queryable at all. */
  available: boolean;
  /** Reason string when available=false (DB missing, schema mismatch, etc.). */
  unavailableReason?: string;
}

interface PerIxBucket {
  samples: IxSample[];
}

export class MetricsCollector {
  private readonly buckets = new Map<IxClass, PerIxBucket>();
  private readonly rpcErrors: Record<RpcErrorClass, number> = {
    timeout: 0,
    slot_skipped: 0,
    rate_limited: 0,
    blockhash_not_found: 0,
    node_unhealthy: 0,
    transaction_failed: 0,
    other: 0,
  };
  private readonly rpcErrorMessages: string[] = []; // first 50 for debugging
  private readonly startedAt = Date.now();
  private flowsAttempted = 0;
  private flowsSucceeded = 0;
  private firstSlot: number | null = null;
  private lastSlot: number | null = null;
  private indexerLag: IndexerLagReading | null = null;

  constructor(
    private readonly meta: {
      scenario: string;
      rpcUrl: string;
      concurrency: number;
      durationSec: number;
      flows: number;
    },
  ) {}

  recordIx(ixClass: IxClass, sample: IxSample): void {
    let b = this.buckets.get(ixClass);
    if (!b) {
      b = { samples: [] };
      this.buckets.set(ixClass, b);
    }
    b.samples.push(sample);
    if (this.firstSlot === null || sample.slot < this.firstSlot) {
      this.firstSlot = sample.slot;
    }
    if (this.lastSlot === null || sample.slot > this.lastSlot) {
      this.lastSlot = sample.slot;
    }
  }

  recordRpcError(message: string): void {
    const cls = classifyRpcError(message);
    this.rpcErrors[cls] += 1;
    if (this.rpcErrorMessages.length < 50) {
      this.rpcErrorMessages.push(`[${cls}] ${message.slice(0, 200)}`);
    }
  }

  recordFlowAttempt(success: boolean): void {
    this.flowsAttempted += 1;
    if (success) this.flowsSucceeded += 1;
  }

  setIndexerLag(reading: IndexerLagReading): void {
    this.indexerLag = reading;
  }

  /**
   * Flush the accumulated samples to disk as a single JSON file under
   * `load/results/`. Returns the absolute output path.
   *
   * Output schema is stable; consumers (operators today, CI gates in
   * Phase 3) can rely on the field shapes.
   */
  async flush(outputDir: string): Promise<string> {
    fs.mkdirSync(outputDir, { recursive: true });
    const ts = new Date(this.startedAt).toISOString().replace(/[:.]/g, "-");
    const outFile = path.join(
      outputDir,
      `${this.meta.scenario}_${ts}.json`,
    );

    const perIx: Record<string, PerIxStats> = {};
    for (const [cls, bucket] of this.buckets) {
      perIx[cls] = summarizeBucket(bucket);
    }

    const totalRpcErrors = Object.values(this.rpcErrors).reduce(
      (a, b) => a + b,
      0,
    );
    const totalIxAttempts =
      Array.from(this.buckets.values()).reduce(
        (acc, b) => acc + b.samples.length,
        0,
      ) + totalRpcErrors;

    const payload = {
      schemaVersion: "1.0",
      meta: {
        ...this.meta,
        startedAt: new Date(this.startedAt).toISOString(),
        endedAt: new Date().toISOString(),
        wallSec: (Date.now() - this.startedAt) / 1000,
      },
      summary: {
        flowsAttempted: this.flowsAttempted,
        flowsSucceeded: this.flowsSucceeded,
        flowsFailed: this.flowsAttempted - this.flowsSucceeded,
        successRate:
          this.flowsAttempted === 0
            ? null
            : this.flowsSucceeded / this.flowsAttempted,
        totalIxObserved: Array.from(this.buckets.values()).reduce(
          (acc, b) => acc + b.samples.length,
          0,
        ),
        totalIxAttempts,
        rpcErrorRate:
          totalIxAttempts === 0 ? null : totalRpcErrors / totalIxAttempts,
        firstSlot: this.firstSlot,
        lastSlot: this.lastSlot,
        slotsSpanned:
          this.firstSlot !== null && this.lastSlot !== null
            ? this.lastSlot - this.firstSlot
            : null,
      },
      perIx,
      rpcErrors: {
        countsByClass: { ...this.rpcErrors },
        sampleMessages: this.rpcErrorMessages,
      },
      indexerLag: this.indexerLag,
    };

    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + "\n");
    return outFile;
  }
}

interface PerIxStats {
  count: number;
  latencyMs: { p50: number; p95: number; p99: number; min: number; max: number; mean: number };
  computeUnits: { p50: number; p95: number; p99: number; mean: number; samples: number };
}

function summarizeBucket(bucket: PerIxBucket): PerIxStats {
  const lats = bucket.samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const cuRaw = bucket.samples
    .map((s) => s.computeUnits)
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);

  return {
    count: bucket.samples.length,
    latencyMs: {
      p50: percentile(lats, 0.5),
      p95: percentile(lats, 0.95),
      p99: percentile(lats, 0.99),
      min: lats[0] ?? 0,
      max: lats[lats.length - 1] ?? 0,
      mean: lats.length === 0 ? 0 : Math.round(lats.reduce((a, b) => a + b, 0) / lats.length),
    },
    computeUnits: {
      p50: percentile(cuRaw, 0.5),
      p95: percentile(cuRaw, 0.95),
      p99: percentile(cuRaw, 0.99),
      mean: cuRaw.length === 0 ? 0 : Math.round(cuRaw.reduce((a, b) => a + b, 0) / cuRaw.length),
      samples: cuRaw.length,
    },
  };
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return Math.round(sorted[idx] * 100) / 100;
}

function classifyRpcError(message: string): RpcErrorClass {
  const m = message.toLowerCase();
  if (m.includes("timeout") || m.includes("timed out")) return "timeout";
  if (m.includes("blockhash not found") || m.includes("blockhash")) {
    return "blockhash_not_found";
  }
  if (m.includes("node is unhealthy") || m.includes("node behind")) {
    return "node_unhealthy";
  }
  if (m.includes("429") || m.includes("rate limit") || m.includes("too many")) {
    return "rate_limited";
  }
  if (m.includes("slot was skipped") || m.includes("slot skipped")) {
    return "slot_skipped";
  }
  if (m.includes("transaction simulation failed") || m.includes("custom program error")) {
    return "transaction_failed";
  }
  return "other";
}
