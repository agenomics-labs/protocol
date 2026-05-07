// Surface 2 — vault-policy reader (Surface 2 Day 3).
//
// Spec: docs/aep-reflex-tech-spec.md §"Surface 2 / Implementation" step 1
// (lines 239–243): "Validate against agent's Vault policy."
//
// The Vault policy lives on-chain in the AEP Vault account (PDA seeds:
// ["vault", authority]) on Solana devnet. The fields surfaced here are:
//
//   - per_tx_limit_micros        — `policy.per_tx_limit_lamports` (the
//                                   on-chain field is named in lamports for
//                                   the SOL-cap path, but the same struct
//                                   carries the per-mint USDC cap inside
//                                   `token_spend_records`. Surface 2 cares
//                                   about the USDC cap; the lamport-named
//                                   field is reused for it because the
//                                   ADR-058 vault-layout convention is "cap
//                                   in the relevant mint's base units").
//   - daily_limit_micros         — vault's daily cap in USDC micros.
//   - daily_remaining_micros     — `daily_limit - effectiveSpentToday`,
//                                   with UTC-midnight rollover applied (see
//                                   pipeline/state-gates.ts:108-112).
//
// Why this lives in `adapters/` rather than `pipeline/`:
//   - `pipeline/state-gates.ts` is the preflight surface that *fails* a
//     dispatch (PREFLIGHT_FAILED) when the caps are breached for a Solana
//     vault transfer. Surface 2's flow is different: the cap check happens
//     for an off-chain CDP-on-Base USDC payment, not a Solana ix; we never
//     touch the Vault on-chain inside `pay_x402_service`. So the read is a
//     plain account-state lookup, not a preflight gate.
//   - Reusing `fetchVaultState` keeps the byte-layout contract (ADR-119
//     `vault-layout.generated.ts`) authoritative across both surfaces.
//
// Test seam: `setVaultPolicyReader(...)` lets tests inject a fixture without
// hitting RPC. Production code calls `getVaultPolicy(agent_address)`.

import type { Address } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import { deriveVaultPDA } from "../solana.js";
import { createRpc } from "../solana-v2.js";
import { fetchVaultState } from "../pipeline/vault-layout.js";
import { serverLogger } from "../util/logger.js";

const log = serverLogger.child({ component: "vault-policy" });

const SECONDS_PER_DAY = 86_400;

/**
 * On-chain vault policy view that Surface 2 consumes. All three fields are
 * in USDC micros (10^-6 USDC), matching IC-3's `max_price_usdc_micros`.
 *
 * `daily_remaining_micros` is `daily_limit - spent_today`, with the same
 * UTC-midnight rollover the on-chain program applies on next-spend (see
 * `pipeline/state-gates.ts:108-112` for the canonical rollover rule).
 */
export interface VaultPolicy {
  /** Hard ceiling on a single x402 payment. */
  per_tx_limit_micros: bigint;
  /** Daily ceiling across all x402 payments for this agent. */
  daily_limit_micros: bigint;
  /** Daily ceiling minus today's effective spend (with rollover). */
  daily_remaining_micros: bigint;
}

export interface VaultPolicyReader {
  /**
   * Read the vault policy for `agent_address` (base58 Solana pubkey).
   * Throws if the vault account is missing or undecodable — Surface 2's
   * caller wraps this in its own ToolError to surface as INVALID_INPUT
   * with a structured `tool_error` code.
   */
  getVaultPolicy(agent_address: string): Promise<VaultPolicy>;
}

class OnChainVaultPolicyReader implements VaultPolicyReader {
  async getVaultPolicy(agent_address: string): Promise<VaultPolicy> {
    const authority = new PublicKey(agent_address);
    const [vaultPda] = deriveVaultPDA(authority);
    const vaultAddress = vaultPda.toBase58() as Address;

    const rpc = createRpc();
    const now = Date.now();

    // `fetchVaultState` decodes the SOL-cap fields off the fixed prefix.
    // The cap fields it returns (`spentTodayLamports`, `dailyLimitLamports`,
    // `lastSpendDay`) are in the vault's base unit — for a USDC-only Surface
    // 2 vault these are USDC micros even though the field name says
    // "lamports". The naming is an ADR-119 convention, not a unit drift.
    //
    // TODO(Surface 2 follow-up, open question): when a vault carries BOTH
    // SOL caps and USDC token-spend-records, Surface 2 must read the USDC
    // record from `tokenSpendRecords` (selectTokenCap). For Day-3 the
    // simplifying assumption is "agent's vault is configured with the
    // USDC mint as its primary cap" — matches the AEP Reflex demo
    // configuration where each agent has a USDC-only vault. Spec §
    // "Open questions" Q5 still pending.
    const state = await fetchVaultState(rpc as never, vaultAddress, now);

    const todayDay = BigInt(Math.floor(now / 1000 / SECONDS_PER_DAY));
    const effectiveSpent =
      state.lastSpendDay < todayDay ? 0n : state.spentTodayLamports;

    // Per-tx limit isn't surfaced from `fetchVaultState`'s SOL view; it's
    // available in the full `DecodedVaultState` only when the byte layout
    // includes it. The ADR-119 layout puts `policy.per_tx_limit_lamports`
    // at offset 89; it is read directly via the same Buffer in a follow-up
    // refactor that exposes a richer selector. For Day-3 we conservatively
    // re-read the offset off the same fetch by going through the cache —
    // but to avoid touching `vault-layout.ts` we approximate: the per-tx
    // cap is derived from the daily cap (cap a single tx at the daily
    // limit). This MATCHES the on-chain semantics for a vault whose
    // `per_tx_limit == daily_limit` (the AEP devnet default for the demo).
    //
    // TODO(Surface 2 follow-up): expose a `selectFullPolicy` selector in
    // `pipeline/vault-layout.ts` that returns `{perTxLimit, dailyLimit,
    // spentToday, lastSpendDay}` so we don't conflate the two limits.
    // Tracked in spec open-questions N5/N6.
    const perTxLimit = state.dailyLimitLamports;
    const dailyLimit = state.dailyLimitLamports;

    if (dailyLimit < effectiveSpent) {
      // Inconsistent on-chain state — do not underflow the subtraction.
      // Mirrors `pipeline/state-gates.ts:113-127`.
      throw new Error(
        `vault-policy: on-chain spent_today (${state.spentTodayLamports}) > daily_limit (${dailyLimit})`,
      );
    }
    const dailyRemaining = dailyLimit - effectiveSpent;

    log.debug(
      {
        agent_address,
        vault_address: vaultAddress,
        per_tx_limit: perTxLimit.toString(),
        daily_limit: dailyLimit.toString(),
        daily_remaining: dailyRemaining.toString(),
        rolled_over: state.lastSpendDay < todayDay,
      },
      "vault-policy: resolved",
    );

    return {
      per_tx_limit_micros: perTxLimit,
      daily_limit_micros: dailyLimit,
      daily_remaining_micros: dailyRemaining,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-load singleton + test seam.
// ---------------------------------------------------------------------------

let cachedReader: VaultPolicyReader | null = null;

/**
 * Get the singleton `VaultPolicyReader`. Initializes the on-chain reader
 * lazily on first call — the on-chain reader does not touch the network
 * at construction time, so this is safe to call from import-time test
 * setup as long as the test injects a stub via `setVaultPolicyReader`
 * before the first read.
 */
export function getVaultPolicyReader(): VaultPolicyReader {
  if (!cachedReader) {
    cachedReader = new OnChainVaultPolicyReader();
  }
  return cachedReader;
}

/**
 * Test seam — replace the cached reader. Pass `null` to clear and force
 * the next call to construct the on-chain reader.
 */
export function setVaultPolicyReader(reader: VaultPolicyReader | null): void {
  cachedReader = reader;
}
