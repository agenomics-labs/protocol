// ADR-059 §6 — Per-action preflight gate execution.
//
// Gates are declared in `Action.preflight[]` (type: `PreflightGate` from
// ADR-058 §2.1 / `src/types/capability.ts`). `executePreflight` runs the
// declared gates sequentially and returns the first failure. Two gates are
// implemented here (`cluster_health`, `account_rent_exempt`); the two
// workflow-bound gates (`daily_cap_not_exhausted`, `dispute_window_open`)
// are stubbed with a TODO — they require vault/escrow context that isn't
// plumbed through to this layer yet, so they'll land with the next PR that
// extends `ActionContext` with protocol-state accessors.

import type { PreflightGate } from "../types/capability.js";
import type { ActionContext, Result } from "../types/action.js";
import { ok, err } from "../types/action.js";
import type { Address } from "@solana/kit";

// --------------------------------------------------------------------------
// Minimal RPC surface used by the gates.
//
// We DO NOT take the full Kit `SolanaRpc` shape here — that would pin tests
// to the complete Kit type graph and make mocking painful. Instead each
// gate declares the narrow method-subset it needs, and `PreflightDeps`
// unions them so callers can inject a single RPC-like object.
// --------------------------------------------------------------------------

type Pending<T> = { send(): Promise<T> };

export interface ClusterHealthRpc {
  getRecentPerformanceSamples(
    limit?: number,
  ): Pending<readonly { numSlots: bigint; numTransactions: bigint }[]>;
  getSlot(): Pending<bigint>;
}

export interface RentExemptRpc {
  getMinimumBalanceForRentExemption(size: bigint): Pending<bigint>;
  getAccountInfo(
    address: Address,
    config?: unknown,
  ): Pending<{
    value: { lamports: bigint; data?: unknown; space?: bigint } | null;
  }>;
}

export interface PreflightDeps {
  rpc?: ClusterHealthRpc & RentExemptRpc;
  /**
   * The set of accounts (and their byte sizes) to check rent-exemption for
   * when the `account_rent_exempt` gate runs. Handlers typically know which
   * accounts they're about to touch; until the action shape carries that
   * metadata, callers supply it here. When unset the gate is a no-op pass.
   */
  rentExemptAccounts?: ReadonlyArray<{ address: Address; size: bigint }>;
  /**
   * Test hook — the gate caches its result for 10s; tests use this to
   * reset the cache between cases.
   */
  now?: () => number;
}

// --------------------------------------------------------------------------
// cluster_health
// --------------------------------------------------------------------------
//
// Green if the last sample window shows meaningful TPS and the slot lag
// between two consecutive `getSlot` reads is below a safety floor.
//
// Cache: 10s per ADR-059 §consequences ("Mitigated by caching
// `getRecentPerformanceSamples` for 10s").

const CLUSTER_HEALTH_CACHE_MS = 10_000;
const CLUSTER_HEALTH_MIN_TX_PER_SLOT = 1; // floor: if a window saw zero tx across all its slots, the cluster is almost certainly stalled
const CLUSTER_HEALTH_MAX_SLOT_LAG = 150; // ~60s @ 400ms/slot

interface ClusterHealthCacheEntry {
  expiresAt: number;
  result: Result<void>;
}

let clusterHealthCache: ClusterHealthCacheEntry | null = null;

export function __resetClusterHealthCacheForTests(): void {
  clusterHealthCache = null;
}

async function runClusterHealth(deps: PreflightDeps): Promise<Result<void>> {
  const now = (deps.now ?? Date.now)();
  if (clusterHealthCache && clusterHealthCache.expiresAt > now) {
    return clusterHealthCache.result;
  }

  if (!deps.rpc) {
    return err({
      code: "PREFLIGHT_FAILED",
      message: "cluster_health: no RPC configured",
      details: { gate: "cluster_health" },
    });
  }

  try {
    const slotBefore = await deps.rpc.getSlot().send();
    const samples = await deps.rpc.getRecentPerformanceSamples(1).send();
    const slotAfter = await deps.rpc.getSlot().send();

    const lag = Number(slotAfter - slotBefore);
    // The slot monotonically increases; only a negative value or a huge
    // forward jump would indicate something odd. `lag` is the *progress*
    // between the two reads, not a staleness metric — it's expected to be
    // small and positive. We only fail if it somehow goes negative (time
    // travel on the RPC side) or if it exceeds the safety floor.
    if (lag < 0 || lag > CLUSTER_HEALTH_MAX_SLOT_LAG) {
      const result = err<void>({
        code: "PREFLIGHT_FAILED",
        message: `cluster_health: slot progress out of range (${lag})`,
        details: { gate: "cluster_health", lag },
      });
      clusterHealthCache = { expiresAt: now + CLUSTER_HEALTH_CACHE_MS, result };
      return result;
    }

    if (samples.length === 0) {
      const result = err<void>({
        code: "PREFLIGHT_FAILED",
        message: "cluster_health: no recent performance samples",
        details: { gate: "cluster_health" },
      });
      clusterHealthCache = { expiresAt: now + CLUSTER_HEALTH_CACHE_MS, result };
      return result;
    }

    const sample = samples[0];
    if (sample.numSlots === 0n) {
      const result = err<void>({
        code: "PREFLIGHT_FAILED",
        message: "cluster_health: sample window reported 0 slots",
        details: { gate: "cluster_health" },
      });
      clusterHealthCache = { expiresAt: now + CLUSTER_HEALTH_CACHE_MS, result };
      return result;
    }

    const txPerSlot = Number(sample.numTransactions) / Number(sample.numSlots);
    if (txPerSlot < CLUSTER_HEALTH_MIN_TX_PER_SLOT) {
      const result = err<void>({
        code: "PREFLIGHT_FAILED",
        message: `cluster_health: tx/slot below floor (${txPerSlot.toFixed(2)})`,
        details: { gate: "cluster_health", txPerSlot },
      });
      clusterHealthCache = { expiresAt: now + CLUSTER_HEALTH_CACHE_MS, result };
      return result;
    }

    const result = ok<void>(undefined);
    clusterHealthCache = { expiresAt: now + CLUSTER_HEALTH_CACHE_MS, result };
    return result;
  } catch (e) {
    return err({
      code: "PREFLIGHT_FAILED",
      message: `cluster_health: RPC error — ${e instanceof Error ? e.message : String(e)}`,
      details: { gate: "cluster_health" },
    });
  }
}

// --------------------------------------------------------------------------
// account_rent_exempt
// --------------------------------------------------------------------------
//
// For each `{ address, size }` pair supplied via `deps.rentExemptAccounts`,
// fetch the account's current lamport balance and compare it against the
// minimum balance required for an account of `size` bytes. A missing
// account is treated as PASS — the account will be created by the tx and
// rent-exemption is the handler's responsibility on creation. This gate is
// specifically for "account already exists; is it still above the
// rent-exempt floor?"

async function runAccountRentExempt(
  deps: PreflightDeps,
): Promise<Result<void>> {
  const accounts = deps.rentExemptAccounts ?? [];
  if (accounts.length === 0) return ok(undefined); // nothing declared — pass

  if (!deps.rpc) {
    return err({
      code: "PREFLIGHT_FAILED",
      message: "account_rent_exempt: no RPC configured",
      details: { gate: "account_rent_exempt" },
    });
  }

  try {
    for (const { address, size } of accounts) {
      const minBalance = await deps.rpc
        .getMinimumBalanceForRentExemption(size)
        .send();
      const info = await deps.rpc
        .getAccountInfo(address, { encoding: "base64" })
        .send();

      if (info.value === null) continue; // will be created this tx — skip
      if (info.value.lamports < minBalance) {
        return err({
          code: "PREFLIGHT_FAILED",
          message: `account_rent_exempt: ${address} below minimum (${info.value.lamports} < ${minBalance})`,
          details: {
            gate: "account_rent_exempt",
            address,
            lamports: info.value.lamports.toString(),
            minBalance: minBalance.toString(),
          },
        });
      }
    }
    return ok(undefined);
  } catch (e) {
    return err({
      code: "PREFLIGHT_FAILED",
      message: `account_rent_exempt: RPC error — ${e instanceof Error ? e.message : String(e)}`,
      details: { gate: "account_rent_exempt" },
    });
  }
}

// --------------------------------------------------------------------------
// Stubs: daily_cap_not_exhausted, dispute_window_open
// --------------------------------------------------------------------------
//
// TODO(ADR-059 follow-up PR): these gates need vault-policy / escrow-
// dispute-window state that isn't plumbed through `ActionContext` yet.
// Both gates return PASS today so that actions which declare them don't
// break, and fail-closed behavior is added once the state accessors land.

async function runDailyCapNotExhausted(
  _deps: PreflightDeps,
  _ctx: ActionContext,
): Promise<Result<void>> {
  // TODO: resolve active vault from ctx + read policy.daily_cap + read
  // today's spent tally, fail closed on over-cap. Needs vault-state accessor.
  return ok(undefined);
}

async function runDisputeWindowOpen(
  _deps: PreflightDeps,
  _ctx: ActionContext,
): Promise<Result<void>> {
  // TODO: resolve escrow from input + compare `now` against
  // escrow.dispute_deadline_unix. Needs escrow-state accessor + action-input
  // visibility. Currently PASS so declared actions don't break.
  return ok(undefined);
}

// --------------------------------------------------------------------------
// Orchestrator
// --------------------------------------------------------------------------

export async function executePreflight(
  gates: PreflightGate[] | undefined,
  ctx: ActionContext,
  deps: PreflightDeps = {},
): Promise<Result<void>> {
  if (!gates || gates.length === 0) return ok(undefined);

  for (const gate of gates) {
    const result = await runGate(gate, ctx, deps);
    if (!result.ok) return result;
  }
  return ok(undefined);
}

async function runGate(
  gate: PreflightGate,
  ctx: ActionContext,
  deps: PreflightDeps,
): Promise<Result<void>> {
  switch (gate) {
    case "cluster_health":
      return runClusterHealth(deps);
    case "account_rent_exempt":
      return runAccountRentExempt(deps);
    case "daily_cap_not_exhausted":
      return runDailyCapNotExhausted(deps, ctx);
    case "dispute_window_open":
      return runDisputeWindowOpen(deps, ctx);
    default: {
      // Exhaustiveness — if PreflightGate gains a variant, TS will flag this
      const exhaustive: never = gate;
      return err({
        code: "PREFLIGHT_FAILED",
        message: `unknown preflight gate: ${String(exhaustive)}`,
        details: { gate },
      });
    }
  }
}
