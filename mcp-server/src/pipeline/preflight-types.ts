// Shared types for the preflight pipeline. Extracted into their own module
// so `preflight.ts` (orchestrator + network/RPC-sensitivity gates) and
// `state-gates.ts` (account-decode gates) can both import them without a
// circular dependency.

import type { Address } from "@solana/kit";

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

/**
 * Narrow RPC surface for the vault / escrow state reads used by the two
 * workflow-bound gates. A single `base64` `getAccountInfo` call is all we
 * need — callers pass the address + we decode the returned bytes ourselves.
 */
export interface AccountDataRpc {
  getAccountInfo(
    address: Address,
    config?: unknown,
  ): Pending<{
    value: { data: readonly [string, string] | null; lamports?: bigint } | null;
  }>;
}

export interface PreflightDeps {
  rpc?: ClusterHealthRpc & RentExemptRpc & Partial<AccountDataRpc>;
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

/**
 * Per-request preflight input, derived from the Action input by
 * `Action.preflightContext` (see `types/action.ts`). Each gate consumes
 * only the fields it needs; missing-but-required inputs fail the gate
 * with PREFLIGHT_FAILED so a mis-wired Action surfaces loudly rather
 * than silently bypassing the check.
 */
export interface PreflightInputContext {
  /** Required by `daily_cap_not_exhausted`. PDA of the agent's vault. */
  vaultAddress?: string;
  /** Required by `daily_cap_not_exhausted`. Amount requested, in lamports. */
  amountLamports?: bigint;
  /** Required by `dispute_window_open`. PDA of the escrow under consideration. */
  escrowAddress?: string;
}
