// Shared Vault account decoder + cache.
//
// Extracted from `state-gates.ts` so the SOL daily-cap gate
// (`daily_cap_not_exhausted`) and the per-mint daily-cap gate
// (`token_daily_cap_not_exhausted`) can read the same on-chain account through
// a single byte-level decode and a single TTL cache. Before this split the two
// gates had separate cache maps, separate offset constants, and duplicated the
// getAccountInfo + base64-decode scaffolding — see the TODO removed from
// `state-gates.ts` in the same refactor.
//
// Design (selector pattern):
//   1. `VAULT_LAYOUT` is the single source of truth for the byte offsets the
//      gates care about — both caps must stay in lock-step with the on-chain
//      Anchor serialization (programs/agent-vault/src/state.rs).
//   2. `decodeVaultState()` walks the full account once and returns a rich
//      `DecodedVaultState` that exposes BOTH views — the SOL-cap fields at the
//      top level and `tokenSpendRecords` for the per-mint gate.
//   3. `selectSolCap()` and `selectTokenCap()` are thin, intention-revealing
//      accessors each gate uses — the gates don't hand-pick fields and the
//      selector names document which slice they're consuming.
//   4. A single `vaultStateCache` keyed by vault address (TTL 5s) serves both
//      gates — if `daily_cap_not_exhausted` and `token_daily_cap_not_exhausted`
//      run for the same vault inside the same 5s window (the common path for a
//      mixed-payload dispatch) the second call is a cache hit.
//
// The cache-reset test hook `__resetVaultStateCacheForTests()` is re-exported
// from `state-gates.ts` and `preflight.ts` — tests clear both the old
// "SOL-only" and "full" cache names, so `__resetVaultFullStateCacheForTests()`
// still exists as an alias of the same reset to keep the test surface
// unchanged.

import type { Address } from "@solana/kit";
import type { AccountDataRpc } from "./preflight-types.js";
import {
  SPENT_TODAY_OFFSET as GEN_SPENT_TODAY_OFFSET,
  LAST_SPEND_DAY_OFFSET as GEN_LAST_SPEND_DAY_OFFSET,
  POLICY_PER_TX_LIMIT_OFFSET as GEN_POLICY_PER_TX_LIMIT_OFFSET,
  DAILY_LIMIT_OFFSET as GEN_DAILY_LIMIT_OFFSET,
  POLICY_FIXED_END_OFFSET as GEN_POLICY_FIXED_END_OFFSET,
  TOKEN_SPEND_RECORD_SIZE as GEN_TOKEN_SPEND_RECORD_SIZE,
} from "./vault-layout.generated.js";

// --------------------------------------------------------------------------
// Layout constants — re-exported from `vault-layout.generated.ts`
// --------------------------------------------------------------------------
//
// MCP-313 (ADR-119, Batch D): the byte offsets are now derived from
// `sdk/idl/src/idl/agent_vault.json` by `scripts/gen-vault-layout.ts` at
// build time. CI verifies `git diff --exit-code` on the generated file
// post-codegen so a Rust struct reorder surfaces as a CI failure.
//
// On-chain Vault account (programs/agent-vault/src/state.rs):
//
//   8   account discriminator
//   32  agent_identity
//   32  authority
//   1   paused
//   8   spent_today_lamports
//   8   last_spend_day             (unix_ts / 86_400)
//   8   policy.per_tx_limit_lamports
//   8   policy.daily_limit_lamports
//   4   policy.max_txs_per_hour
//   ?   policy.token_allowlist     (Vec<Pubkey>: u32 len + N*32)
//   ?   policy.program_allowlist   (Vec<Pubkey>: u32 len + M*32)
//   4   txs_in_current_window
//   8   rate_limit_window_start
//   ?   token_spend_records        (Vec<TokenSpendRecord>: u32 len + K*64)
//   1   bump
//
// Each `TokenSpendRecord` = 32 (mint) + 8 (per_tx_limit) + 8 (daily_limit)
//                         + 8 (spent_today) + 8 (last_spend_day) = 64 bytes.

export const VAULT_LAYOUT = {
  /** Minimum bytes required to read the SOL-cap header (up to daily_limit). */
  SOL_MIN_BYTES: GEN_DAILY_LIMIT_OFFSET + 8, // 105
  /** End of the fixed-width policy prefix; Vec<Pubkey> skips follow. */
  POLICY_FIXED_END_OFFSET: GEN_POLICY_FIXED_END_OFFSET, // 109
  SPENT_TODAY_OFFSET: GEN_SPENT_TODAY_OFFSET, // 73
  LAST_SPEND_DAY_OFFSET: GEN_LAST_SPEND_DAY_OFFSET, // 81
  POLICY_PER_TX_LIMIT_OFFSET: GEN_POLICY_PER_TX_LIMIT_OFFSET, // 89
  DAILY_LIMIT_OFFSET: GEN_DAILY_LIMIT_OFFSET, // 97
  TOKEN_SPEND_RECORD_SIZE: GEN_TOKEN_SPEND_RECORD_SIZE, // 64
  /**
   * Defensive upper bound on each variable-length vec. On-chain the true
   * ceilings are `MAX_TOKEN_ALLOWLIST = 10`, `MAX_PROGRAM_ALLOWLIST = 10`,
   * `MAX_TOKEN_SPEND_RECORDS = 10`. 64 gives headroom if those bump.
   */
  VEC_CEILING: 64,
} as const;

export const VAULT_STATE_CACHE_MS = 5_000;

// --------------------------------------------------------------------------
// Decoded types
// --------------------------------------------------------------------------

export interface TokenSpendRecordDecoded {
  /** 32-byte mint pubkey — compared byte-wise against the requested mint. */
  mint: Buffer;
  perTxLimit: bigint;
  dailyLimit: bigint;
  spentToday: bigint;
  lastSpendDay: bigint;
}

/**
 * Full decoded Vault account, covering every field either on-state-gate
 * consumes. Gates should prefer `selectSolCap()` / `selectTokenCap()` so
 * their intent is visible — this struct is the union of both views.
 *
 * `perTxLimitLamports` was added by the Surface 2 follow-up so the x402
 * pre-payment cap check (`adapters/vault-policy.ts`) can read the real
 * per-tx limit instead of conflating it with the daily limit. The field
 * lives at `VAULT_LAYOUT.POLICY_PER_TX_LIMIT_OFFSET` (89). For a USDC-only
 * Surface 2 vault the on-chain unit is USDC micros even though the field
 * name says "lamports" — same ADR-119 naming convention as the other cap
 * fields.
 */
export interface DecodedVaultState {
  spentTodayLamports: bigint;
  lastSpendDay: bigint;
  perTxLimitLamports: bigint;
  dailyLimitLamports: bigint;
  tokenSpendRecords: TokenSpendRecordDecoded[];
}

export interface SolCapView {
  spentTodayLamports: bigint;
  lastSpendDay: bigint;
  dailyLimitLamports: bigint;
}

/**
 * Surface 2 — full-policy view consumed by `adapters/vault-policy.ts` to
 * resolve both the per-tx and daily caps for an x402 pre-payment gate.
 *
 * Field naming mirrors `selectSolCap` (`*Lamports` for on-chain alignment)
 * but the Surface 2 caller renames to `*_micros` once it's known to be a
 * USDC vault — see `adapters/vault-policy.ts`.
 */
export interface FullPolicyView {
  /** USDC micros (or lamports for SOL-only vaults). */
  daily_limit_micros: bigint;
  /** USDC micros (or lamports for SOL-only vaults). */
  per_tx_limit_micros: bigint;
  /** Spent so far today, in the same unit. Caller applies UTC-midnight
   *  rollover (compare `last_spend_day` to `floor(now/86400)`). */
  spent_today_micros: bigint;
  /** Day index = floor(unix_ts / 86_400). */
  last_spend_day: number;
}

export interface TokenCapView {
  tokenSpendRecords: TokenSpendRecordDecoded[];
}

// --------------------------------------------------------------------------
// Decoder
// --------------------------------------------------------------------------

/**
 * Walk past a `Vec<Pubkey>` (Anchor layout: 4-byte LE length + N*32).
 * Returns the cursor position immediately after the vec. Throws if the
 * declared length exceeds a plausibility ceiling or would read past the
 * buffer.
 */
function skipPubkeyVec(data: Buffer, cursor: number): number {
  if (data.length < cursor + 4) {
    throw new Error(`vault account too short for Vec<Pubkey> length at ${cursor}`);
  }
  const len = data.readUInt32LE(cursor);
  if (len > VAULT_LAYOUT.VEC_CEILING) {
    throw new Error(`vault Vec<Pubkey> length implausible: ${len}`);
  }
  const end = cursor + 4 + len * 32;
  if (data.length < end) {
    throw new Error(
      `vault account too short for Vec<Pubkey> body: need ${end}, have ${data.length}`,
    );
  }
  return end;
}

/**
 * Decode the full Vault account into a `DecodedVaultState`. The SOL-cap
 * fields are readable off the fixed prefix; the token_spend_records tail
 * requires walking the two Vec<Pubkey> allowlists first.
 *
 * The decoder is best-effort on the tail: if the fixed prefix is valid but
 * the variable-length suffix is truncated (e.g. mocked account data that
 * only exposes enough bytes for the SOL-cap gate), it returns with an
 * empty `tokenSpendRecords` list rather than throwing. This preserves the
 * pre-refactor behaviour where the SOL-only decoder accepted 105-byte
 * blobs. A token-cap gate reading such a short blob will then fail
 * naturally at the "mint not tracked" check.
 */
export function decodeVaultState(data: Buffer): DecodedVaultState {
  if (data.length < VAULT_LAYOUT.SOL_MIN_BYTES) {
    throw new Error(
      `vault account too short: got ${data.length} bytes, need >= ${VAULT_LAYOUT.SOL_MIN_BYTES}`,
    );
  }

  const spentTodayLamports = data.readBigUInt64LE(VAULT_LAYOUT.SPENT_TODAY_OFFSET);
  const lastSpendDay = data.readBigUInt64LE(VAULT_LAYOUT.LAST_SPEND_DAY_OFFSET);
  const perTxLimitLamports = data.readBigUInt64LE(VAULT_LAYOUT.POLICY_PER_TX_LIMIT_OFFSET);
  const dailyLimitLamports = data.readBigUInt64LE(VAULT_LAYOUT.DAILY_LIMIT_OFFSET);

  // Walk the variable-length tail. If the blob is shorter than the policy
  // header (the SOL-cap gate never needs more than 105 bytes), return with
  // an empty token list — a later `selectTokenCap` lookup will report the
  // mint as untracked, which is the same outcome the previous separate
  // decoder would have reached for a zero-record vault.
  if (data.length < VAULT_LAYOUT.POLICY_FIXED_END_OFFSET) {
    return {
      spentTodayLamports,
      lastSpendDay,
      perTxLimitLamports,
      dailyLimitLamports,
      tokenSpendRecords: [],
    };
  }

  let cursor: number = VAULT_LAYOUT.POLICY_FIXED_END_OFFSET;
  cursor = skipPubkeyVec(data, cursor); // policy.token_allowlist
  cursor = skipPubkeyVec(data, cursor); // policy.program_allowlist

  // txs_in_current_window (u32) + rate_limit_window_start (i64)
  cursor += 4 + 8;
  if (data.length < cursor + 4) {
    throw new Error(
      `vault account too short for token_spend_records length at ${cursor}`,
    );
  }
  const recordCount = data.readUInt32LE(cursor);
  cursor += 4;
  if (recordCount > VAULT_LAYOUT.VEC_CEILING) {
    throw new Error(`vault token_spend_records length implausible: ${recordCount}`);
  }
  const bodyEnd = cursor + recordCount * VAULT_LAYOUT.TOKEN_SPEND_RECORD_SIZE;
  if (data.length < bodyEnd) {
    throw new Error(
      `vault account too short for token_spend_records body: need ${bodyEnd}, have ${data.length}`,
    );
  }

  const tokenSpendRecords: TokenSpendRecordDecoded[] = [];
  for (let i = 0; i < recordCount; i++) {
    const base = cursor + i * VAULT_LAYOUT.TOKEN_SPEND_RECORD_SIZE;
    tokenSpendRecords.push({
      // Slice without copy — the returned buffer is used only for equality
      // checks against the requested mint's 32-byte raw form.
      mint: data.subarray(base, base + 32),
      perTxLimit: data.readBigUInt64LE(base + 32),
      dailyLimit: data.readBigUInt64LE(base + 32 + 8),
      spentToday: data.readBigUInt64LE(base + 32 + 16),
      lastSpendDay: data.readBigUInt64LE(base + 32 + 24),
    });
  }

  return {
    spentTodayLamports,
    lastSpendDay,
    perTxLimitLamports,
    dailyLimitLamports,
    tokenSpendRecords,
  };
}

// --------------------------------------------------------------------------
// Selectors
// --------------------------------------------------------------------------

export function selectSolCap(state: DecodedVaultState): SolCapView {
  return {
    spentTodayLamports: state.spentTodayLamports,
    lastSpendDay: state.lastSpendDay,
    dailyLimitLamports: state.dailyLimitLamports,
  };
}

export function selectTokenCap(state: DecodedVaultState): TokenCapView {
  return { tokenSpendRecords: state.tokenSpendRecords };
}

/**
 * Surface 2 (`adapters/vault-policy.ts::resolveVaultPolicy`): full-policy
 * selector returning the per-tx + daily caps + today's spend in a single
 * shape. Reads `policy.per_tx_limit_lamports` from offset 89 (8 bytes LE
 * u64 — see `VAULT_LAYOUT.POLICY_PER_TX_LIMIT_OFFSET`) which `selectSolCap`
 * intentionally does NOT expose.
 *
 * Unit note: for a USDC-only vault (the AEP Reflex demo configuration) the
 * lamport-named on-chain field stores USDC micros directly (no scaling).
 * The `*_micros` rename in the returned shape mirrors what Surface 2 calls
 * the field downstream — there is no lamports → micros multiplication
 * because the unit is already the same on-chain.
 *
 * `selectSolCap` is intentionally left unchanged so the SOL-cap state-gate
 * path (`pipeline/state-gates.ts:97-102`) keeps the narrow view it consumes.
 */
export function selectFullPolicy(state: DecodedVaultState): FullPolicyView {
  return {
    daily_limit_micros: state.dailyLimitLamports,
    per_tx_limit_micros: state.perTxLimitLamports,
    spent_today_micros: state.spentTodayLamports,
    last_spend_day: Number(state.lastSpendDay),
  };
}

// --------------------------------------------------------------------------
// Fetch + cache
// --------------------------------------------------------------------------

interface VaultCacheEntry {
  expiresAt: number;
  state: DecodedVaultState;
}

// Single cache for both gates — shared by construction. Keyed on the vault
// address so distinct vaults never collide. Entries expire after
// `VAULT_STATE_CACHE_MS`; `now` is taken from the caller (`deps.now ??
// Date.now`) so tests can stub it.
const vaultStateCache = new Map<string, VaultCacheEntry>();

export function __resetVaultStateCacheForTests(): void {
  vaultStateCache.clear();
}

/**
 * MCP-314 (Batch D): explicit cache invalidation hook. Call this from the
 * post-confirm site of any vault-mutating handler (vault_transfer,
 * vault_token_transfer) so a follow-up cap check doesn't read pre-spend
 * `spent_today_lamports` for up to 5s after the on-chain ix landed.
 *
 * Idempotent — invalidating a key that isn't cached is a no-op.
 */
export function invalidateVaultStateCache(vaultAddress: Address): void {
  vaultStateCache.delete(vaultAddress);
}

export async function fetchVaultState(
  rpc: AccountDataRpc,
  vaultAddress: Address,
  now: number,
): Promise<DecodedVaultState> {
  const cached = vaultStateCache.get(vaultAddress);
  if (cached && cached.expiresAt > now) return cached.state;

  const info = await rpc
    .getAccountInfo(vaultAddress, { encoding: "base64" })
    .send();

  if (!info.value || !info.value.data) {
    throw new Error(`vault account not found: ${vaultAddress}`);
  }
  const [b64] = info.value.data;
  const raw = Buffer.from(b64, "base64");
  const state = decodeVaultState(raw);

  vaultStateCache.set(vaultAddress, {
    expiresAt: now + VAULT_STATE_CACHE_MS,
    state,
  });
  return state;
}
