// ADR-059 §6 — Per-action preflight gate execution.
//
// Gates are declared in `Action.preflight[]` (type: `PreflightGate` from
// ADR-058 §2.1 / `src/types/capability.ts`). `executePreflight` runs the
// declared gates sequentially and returns the first failure.
//
// Contract (MCP-312, Batch E close)
// =================================
// Preflight is NOT a chain oracle. It is a fast pre-filter that runs five
// domain gates (`cluster_health`, `account_rent_exempt`,
// `daily_cap_not_exhausted`, `token_daily_cap_not_exhausted`,
// `dispute_window_open`) via direct `getAccountInfo` reads. The actual
// `simulateTransaction` lives in `compute-budget.ts` and is invoked by
// `handlers-v2/vault.ts` separately.
//
// The ONLY invariant the preflight contract guarantees is:
//
//   PREFLIGHT-FAIL ⇒ CHAIN-REJECT-FOR-THE-GATED-REASON
//
// The inverse — preflight-pass ⇒ chain-accept — is NOT guaranteed. Reasons:
//   - Cache TTLs (cluster_health 10s, vault-state 5s) admit racy chain-side
//     state changes between gate read and chain submit.
//   - The chain enforces invariants beyond the five gates (signature
//     authority, account ownership, rent at submit time, slippage on the
//     payee account, etc.) that preflight does not duplicate.
//   - Preflight runs against the latest confirmed slot; the tx submits
//     against `processed`/`finalized` per the caller's commitment.
//
// Operationally this means: preflight is a UX optimization that cuts an
// RPC round-trip when the gated reason would have failed anyway. It is
// NOT a substitute for sound on-chain enforcement, and it does not
// pre-clear all chain rejection paths.
//
// `mcp-server/test/preflight-contract.test.ts` pins the inverse-non-guarantee
// with a representative scenario and the failure-direction guarantee with
// each gate's failure case.
//
// All five gates from ADR-058 §2.1 are implemented:
//   - `cluster_health`               — getRecentPerformanceSamples + slot lag
//   - `account_rent_exempt`          — recipient account already rent-exempt
//   - `daily_cap_not_exhausted`      — vault.daily_limit - vault.spent_today
//                                      >= requested amount (SOL-denominated);
//                                      needs `vaultAddress` + `amountLamports`
//   - `token_daily_cap_not_exhausted`— per-mint analogue of the SOL gate; reads
//                                      Vault.token_spend_records[mint] and
//                                      checks both daily_limit and per_tx_limit;
//                                      needs `vaultAddress` + `tokenMint` +
//                                      `tokenAmountBaseUnits`
//   - `dispute_window_open`          — escrow.disputed_at.is_some() AND
//                                      now < escrow.deadline; needs
//                                      `escrowAddress` via PreflightInputContext
//
// The last two gates live in `state-gates.ts` (split out to keep each file
// under the 500-line project guideline); their public runners + the shared
// types are re-exported here so existing imports keep working.

import type { PreflightGate } from "../types/capability.js";
import type { ActionContext, Result } from "../types/action.js";
import { ok, err } from "../types/action.js";
import type {
  ClusterHealthRpc,
  RentExemptRpc,
  AccountDataRpc,
  PreflightDeps,
  PreflightInputContext,
} from "./preflight-types.js";
import {
  runDailyCapNotExhausted,
  runTokenDailyCapNotExhausted,
  runDisputeWindowOpen,
  __resetVaultStateCacheForTests,
  __resetVaultFullStateCacheForTests,
} from "./state-gates.js";

export type {
  ClusterHealthRpc,
  RentExemptRpc,
  AccountDataRpc,
  PreflightDeps,
  PreflightInputContext,
};
export {
  __resetVaultStateCacheForTests,
  __resetVaultFullStateCacheForTests,
};

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
      const result = err({
        code: "PREFLIGHT_FAILED",
        message: `cluster_health: slot progress out of range (${lag})`,
        details: { gate: "cluster_health", lag },
      });
      clusterHealthCache = { expiresAt: now + CLUSTER_HEALTH_CACHE_MS, result };
      return result;
    }

    if (samples.length === 0) {
      const result = err({
        code: "PREFLIGHT_FAILED",
        message: "cluster_health: no recent performance samples",
        details: { gate: "cluster_health" },
      });
      clusterHealthCache = { expiresAt: now + CLUSTER_HEALTH_CACHE_MS, result };
      return result;
    }

    const sample = samples[0];
    if (sample.numSlots === 0n) {
      const result = err({
        code: "PREFLIGHT_FAILED",
        message: "cluster_health: sample window reported 0 slots",
        details: { gate: "cluster_health" },
      });
      clusterHealthCache = { expiresAt: now + CLUSTER_HEALTH_CACHE_MS, result };
      return result;
    }

    const txPerSlot = Number(sample.numTransactions) / Number(sample.numSlots);
    if (txPerSlot < CLUSTER_HEALTH_MIN_TX_PER_SLOT) {
      const result = err({
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
      const lamports = (info.value as { lamports: bigint }).lamports;
      if (lamports < minBalance) {
        return err({
          code: "PREFLIGHT_FAILED",
          message: `account_rent_exempt: ${address} below minimum (${lamports} < ${minBalance})`,
          details: {
            gate: "account_rent_exempt",
            address,
            lamports: lamports.toString(),
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
// Orchestrator
// --------------------------------------------------------------------------

export async function executePreflight(
  gates: PreflightGate[] | undefined,
  ctx: ActionContext,
  deps: PreflightDeps = {},
  input?: PreflightInputContext,
): Promise<Result<void>> {
  if (!gates || gates.length === 0) return ok(undefined);

  for (const gate of gates) {
    const result = await runGate(gate, ctx, deps, input);
    if (!result.ok) return result;
  }
  return ok(undefined);
}

async function runGate(
  gate: PreflightGate,
  ctx: ActionContext,
  deps: PreflightDeps,
  input: PreflightInputContext | undefined,
): Promise<Result<void>> {
  switch (gate) {
    case "cluster_health":
      return runClusterHealth(deps);
    case "account_rent_exempt":
      return runAccountRentExempt(deps);
    case "daily_cap_not_exhausted":
      return runDailyCapNotExhausted(deps, ctx, input);
    case "token_daily_cap_not_exhausted":
      return runTokenDailyCapNotExhausted(deps, ctx, input);
    case "dispute_window_open":
      return runDisputeWindowOpen(deps, ctx, input);
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
