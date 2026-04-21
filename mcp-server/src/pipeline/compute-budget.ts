// ADR-059 §2 + §3 — Compute-budget auto-injection.
//
// `getComputeBudgetInstructions` simulates a transaction to read its
// `unitsConsumed`, applies the ADR-059 sizing formula
//     CU limit = max(consumed + 100_000, ceil(consumed * 1.2), 200_000)
// and fetches a priority fee via `getRecentPrioritizationFees` (mid
// percentile = 50th). It returns the two compute-budget instructions ready
// for the caller to prepend to their transaction message.
//
// Scope per PR3 spec (intentionally narrow):
//   - NO Helius branch. `getRecentPrioritizationFees` only.
//   - NO direct Kit transaction-message wiring — the caller supplies a
//     simulate-thunk and a writable-accounts list. Wiring to real messages
//     happens when handlers actually consume this (a later PR).
//
// Why the thunk? Kit's `simulateTransaction` has a complex typed surface
// (base64-encoded wire tx + config), and callers want flexibility to
// either (a) precompute a simulation result or (b) defer to this module.
// Taking a thunk keeps the boundary clean and testable without pinning
// us to any one Kit call shape.

import {
  getSetComputeUnitLimitInstruction,
  setTransactionMessageComputeUnitPrice,
} from "@solana-program/compute-budget";
import type { Address } from "@solana/kit";

// --------------------------------------------------------------------------
// CU limit — ADR-059 §2 formula
// --------------------------------------------------------------------------

export const CU_LIMIT_FLOOR = 200_000;
export const CU_LIMIT_HEADROOM = 100_000;
export const CU_LIMIT_MULTIPLIER = 1.2;

/**
 * Apply the ADR-059 §2 sizing formula:
 *     max(consumed + 100_000, ceil(consumed * 1.2), 200_000)
 *
 * A 200k floor prevents anomalous simulation (0 CU consumed) from producing
 * an under-provisioned tx.
 */
export function sizeCuLimit(unitsConsumed: number | bigint): number {
  const consumed = Number(unitsConsumed);
  if (!Number.isFinite(consumed) || consumed < 0) return CU_LIMIT_FLOOR;
  const candidate = Math.max(
    consumed + CU_LIMIT_HEADROOM,
    Math.ceil(consumed * CU_LIMIT_MULTIPLIER),
    CU_LIMIT_FLOOR,
  );
  // CU limit is a u32; cap at the SBPF-runtime ceiling to avoid overflow.
  // `MAX_COMPUTE_UNIT_LIMIT` in the compute-budget program is 1.4M.
  return Math.min(candidate, 1_400_000);
}

// --------------------------------------------------------------------------
// Priority fee — ADR-059 §3 percentile path
// --------------------------------------------------------------------------

export type FeeTier = "min" | "mid" | "max";

const TIER_PERCENTILE: Record<FeeTier, number> = {
  min: 0.01,
  mid: 0.5,
  max: 0.95,
};

export interface PrioritizationFeeSample {
  readonly prioritizationFee: bigint;
  readonly slot: bigint;
}

/**
 * Extract the Nth-percentile fee from a set of samples. Zero-fee samples
 * (the typical "uncontended" case) drag the low end of the distribution,
 * which is fine — agents on a cold cluster should not be paying 95p fees.
 *
 * Returns 0n on an empty sample set (caller policy: no samples → no fee).
 */
export function percentileFee(
  samples: readonly PrioritizationFeeSample[],
  percentile: number,
): bigint {
  if (samples.length === 0) return 0n;
  const clamped = Math.min(1, Math.max(0, percentile));
  const sorted = [...samples].sort((a, b) =>
    a.prioritizationFee < b.prioritizationFee ? -1 :
    a.prioritizationFee > b.prioritizationFee ? 1 : 0,
  );
  const idx = Math.min(sorted.length - 1, Math.floor(clamped * sorted.length));
  return sorted[idx].prioritizationFee;
}

// --------------------------------------------------------------------------
// RPC surface (narrow, for DI in tests)
// --------------------------------------------------------------------------

type Pending<T> = { send(): Promise<T> };

export interface ComputeBudgetRpc {
  getRecentPrioritizationFees(
    addresses?: readonly Address[],
  ): Pending<readonly PrioritizationFeeSample[]>;
}

/**
 * The simulate-thunk protocol: caller performs the `simulateTransaction`
 * call however they like (base64-wire, plus config etc.) and returns just
 * the CU-consumed count that this module needs.
 */
export type SimulateForCuThunk = () => Promise<{ unitsConsumed: number | bigint }>;

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export interface ComputeBudgetInstructions {
  /**
   * Result of `getSetComputeUnitLimitInstruction({ units })`. The caller
   * prepends this to their transaction message instructions[].
   */
  readonly setComputeUnitLimit: ReturnType<typeof getSetComputeUnitLimitInstruction>;
  /**
   * The priority fee in micro-lamports. To apply it to a Kit transaction
   * message, use `setTransactionMessageComputeUnitPrice(microLamports, msg)`
   * (re-exported from this module). We return the raw value rather than
   * an instruction because the `@solana-program/compute-budget` package's
   * price-setting API operates on the message directly, not via a free
   * instruction factory.
   */
  readonly priorityMicroLamports: bigint;
  /** Metadata for logging / observability. */
  readonly simulatedUnitsConsumed: number;
  readonly computedUnitLimit: number;
}

export interface GetComputeBudgetOptions {
  rpc: ComputeBudgetRpc;
  simulate: SimulateForCuThunk;
  /**
   * The set of accounts that are writable in the tx being built. Used by
   * `getRecentPrioritizationFees` to scope the fee sampling to contention
   * on this tx's write set.
   */
  writableAccounts: readonly Address[];
  /** Percentile tier, default `'mid'` (50th). */
  tier?: FeeTier;
}

/**
 * ADR-059 §2 + §3 — simulate-then-size + priority-fee estimate.
 *
 * Returns the compute-budget instructions ready for the caller to prepend
 * to their transaction. The caller is responsible for the actual prepend —
 * we do not mutate here because the `@solana-program/compute-budget`
 * update-or-append helpers (`updateOrAppendSetComputeUnitLimitInstruction`
 * etc.) expect the message as input, which is outside this module's scope.
 */
export async function getComputeBudgetInstructions(
  opts: GetComputeBudgetOptions,
): Promise<ComputeBudgetInstructions> {
  const sim = await opts.simulate();
  const unitsConsumed = sim.unitsConsumed ?? 0;
  const computedUnitLimit = sizeCuLimit(unitsConsumed);

  const tier = opts.tier ?? "mid";
  const samples = await opts.rpc
    .getRecentPrioritizationFees(opts.writableAccounts)
    .send();
  const priorityMicroLamports = percentileFee(samples, TIER_PERCENTILE[tier]);

  return {
    setComputeUnitLimit: getSetComputeUnitLimitInstruction({
      units: computedUnitLimit,
    }),
    priorityMicroLamports,
    simulatedUnitsConsumed: Number(unitsConsumed),
    computedUnitLimit,
  };
}

// Re-export so callers have a single entry point to apply the price to a
// transaction message (keeps ADR-059 wiring discoverable).
export { setTransactionMessageComputeUnitPrice };
