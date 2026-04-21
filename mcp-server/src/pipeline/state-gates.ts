// ADR-059 §6 — The three preflight gates that read on-chain state.
//
// Split out from `preflight.ts` to keep each concern-file under the
// 500-line guideline in the project CLAUDE.md. The orchestrator in
// `preflight.ts` calls into these runners; the account-decode logic
// (byte layouts, rollover, Option<T> tag handling) lives here.
//
//   - daily_cap_not_exhausted:       decodes Vault account; checks that the
//                                     vault's remaining SOL daily cap >=
//                                     requested lamports, with UTC-midnight
//                                     rollover.
//   - token_daily_cap_not_exhausted: decodes Vault `token_spend_records`;
//                                     enforces per-mint daily cap + per-tx
//                                     ceiling with the same rollover rule.
//   - dispute_window_open:           decodes TaskEscrow; passes iff
//                                     `disputed_at.is_some()` AND
//                                     `now_seconds < escrow.deadline`.
//
// The two vault-reading gates share a SINGLE account fetch + decode via
// `./vault-layout.ts` — one `getAccountInfo` call, one cache entry per vault,
// one set of byte-offset constants (`VAULT_LAYOUT`) that both gates are
// guaranteed to stay in sync with.

import type { Address } from "@solana/kit";
import bs58 from "bs58";
import type { Result, ActionContext } from "../types/action.js";
import { ok, err } from "../types/action.js";
import type {
  AccountDataRpc,
  PreflightDeps,
  PreflightInputContext,
} from "./preflight-types.js";
import {
  fetchVaultState,
  selectSolCap,
  selectTokenCap,
  __resetVaultStateCacheForTests as __resetSharedVaultCache,
} from "./vault-layout.js";

const SECONDS_PER_DAY = 86_400;

// Cache-reset hooks used by tests. Both names clear the same shared cache:
// before the refactor there were two caches (SOL-only and full), so tests
// call both. Keeping both exports avoids touching the test suite.
export function __resetVaultStateCacheForTests(): void {
  __resetSharedVaultCache();
}
export function __resetVaultFullStateCacheForTests(): void {
  __resetSharedVaultCache();
}

// --------------------------------------------------------------------------
// daily_cap_not_exhausted
// --------------------------------------------------------------------------
//
// SOL daily-cap check. Reads the Vault account's `spent_today_lamports`,
// `last_spend_day`, and `policy.daily_limit_lamports` via the shared
// decoder, then applies UTC-midnight rollover: if `last_spend_day` is
// strictly less than today's day-number, the on-chain program will reset
// `spent_today_lamports` to 0 on its next spend, so we mirror that here to
// avoid rejecting a perfectly-fundable request on yesterday's tally.
//
// Cache: shared with `token_daily_cap_not_exhausted` via `vault-layout.ts`.
// Keyed on vault address, 5s TTL.

export async function runDailyCapNotExhausted(
  deps: PreflightDeps,
  _ctx: ActionContext,
  input: PreflightInputContext | undefined,
): Promise<Result<void>> {
  if (!input?.vaultAddress) {
    return err({
      code: "PREFLIGHT_FAILED",
      message:
        "daily_cap_not_exhausted: missing required input 'vaultAddress' — action must declare preflightContext",
      details: { gate: "daily_cap_not_exhausted" },
    });
  }
  if (input.amountLamports === undefined) {
    return err({
      code: "PREFLIGHT_FAILED",
      message:
        "daily_cap_not_exhausted: missing required input 'amountLamports' — action must declare preflightContext",
      details: { gate: "daily_cap_not_exhausted" },
    });
  }
  if (!deps.rpc || typeof deps.rpc.getAccountInfo !== "function") {
    return err({
      code: "PREFLIGHT_FAILED",
      message: "daily_cap_not_exhausted: no RPC configured",
      details: { gate: "daily_cap_not_exhausted" },
    });
  }

  const now = (deps.now ?? Date.now)();
  try {
    const full = await fetchVaultState(
      deps.rpc as AccountDataRpc,
      input.vaultAddress as Address,
      now,
    );
    const state = selectSolCap(full);

    // Today in the same "day number" units the program uses.
    const todayDay = BigInt(Math.floor(now / 1000 / SECONDS_PER_DAY));

    // If the stored day is stale, the next on-chain spend will reset
    // `spent_today_lamports` to 0 — mirror that view here so we don't reject
    // a perfectly-fundable request on yesterday's tally.
    const effectiveSpent =
      state.lastSpendDay < todayDay ? 0n : state.spentTodayLamports;

    if (state.dailyLimitLamports < effectiveSpent) {
      // Inconsistent on-chain state — treat as PREFLIGHT_FAILED rather than
      // underflow the subtraction below.
      return err({
        code: "PREFLIGHT_FAILED",
        message:
          "daily_cap_not_exhausted: on-chain spent_today exceeds daily_limit (inconsistent state)",
        details: {
          gate: "daily_cap_not_exhausted",
          vaultAddress: input.vaultAddress,
          dailyLimitLamports: state.dailyLimitLamports.toString(),
          spentTodayLamports: state.spentTodayLamports.toString(),
        },
      });
    }

    const remaining = state.dailyLimitLamports - effectiveSpent;
    if (remaining < input.amountLamports) {
      return err({
        code: "PREFLIGHT_FAILED",
        message: `daily_cap_not_exhausted: remaining ${remaining} < requested ${input.amountLamports}`,
        details: {
          gate: "daily_cap_not_exhausted",
          vaultAddress: input.vaultAddress,
          remainingLamports: remaining.toString(),
          requestedLamports: input.amountLamports.toString(),
          dailyLimitLamports: state.dailyLimitLamports.toString(),
          effectiveSpentLamports: effectiveSpent.toString(),
          rolledOver: state.lastSpendDay < todayDay,
        },
      });
    }

    return ok(undefined);
  } catch (e) {
    return err({
      code: "PREFLIGHT_FAILED",
      message: `daily_cap_not_exhausted: ${e instanceof Error ? e.message : String(e)}`,
      details: {
        gate: "daily_cap_not_exhausted",
        vaultAddress: input.vaultAddress,
      },
    });
  }
}

// --------------------------------------------------------------------------
// token_daily_cap_not_exhausted
// --------------------------------------------------------------------------
//
// Per-mint daily spend cap check. Uses the same shared decode as
// `daily_cap_not_exhausted`, then selects the `TokenSpendRecord` whose
// `mint` matches the requested SPL mint and enforces both the record's
// `per_tx_limit` and its remaining `daily_limit - spent_today` (with
// UTC-midnight rollover, same rule as the SOL gate above).
//
// Fail-closed on missing record: if the requested mint is NOT present in
// `token_spend_records`, the gate fails — an untracked mint cannot be
// spent. This matches the on-chain `manage_allowlist(add_token)` flow
// that seeds a record on add; a missing record means either the mint
// isn't allowlisted or limits were never configured, both of which
// should block the spend loudly.

/**
 * Decode a base58 mint address into its raw 32-byte form for byte-equality
 * comparison against on-chain `TokenSpendRecord.mint`.
 */
function decodeMintAddress(mint: string): Buffer {
  const bytes = bs58.decode(mint);
  if (bytes.length !== 32) {
    throw new Error(`mint must decode to 32 bytes, got ${bytes.length}`);
  }
  return Buffer.from(bytes);
}

export async function runTokenDailyCapNotExhausted(
  deps: PreflightDeps,
  _ctx: ActionContext,
  input: PreflightInputContext | undefined,
): Promise<Result<void>> {
  if (!input?.vaultAddress) {
    return err({
      code: "PREFLIGHT_FAILED",
      message:
        "token_daily_cap_not_exhausted: missing required input 'vaultAddress' — action must declare preflightContext",
      details: { gate: "token_daily_cap_not_exhausted" },
    });
  }
  if (!input.tokenMint) {
    return err({
      code: "PREFLIGHT_FAILED",
      message:
        "token_daily_cap_not_exhausted: missing required input 'tokenMint' — action must declare preflightContext",
      details: { gate: "token_daily_cap_not_exhausted" },
    });
  }
  if (input.tokenAmountBaseUnits === undefined) {
    return err({
      code: "PREFLIGHT_FAILED",
      message:
        "token_daily_cap_not_exhausted: missing required input 'tokenAmountBaseUnits' — action must declare preflightContext",
      details: { gate: "token_daily_cap_not_exhausted" },
    });
  }
  if (!deps.rpc || typeof deps.rpc.getAccountInfo !== "function") {
    return err({
      code: "PREFLIGHT_FAILED",
      message: "token_daily_cap_not_exhausted: no RPC configured",
      details: { gate: "token_daily_cap_not_exhausted" },
    });
  }

  const now = (deps.now ?? Date.now)();

  let mintBytes: Buffer;
  try {
    mintBytes = decodeMintAddress(input.tokenMint);
  } catch (e) {
    return err({
      code: "PREFLIGHT_FAILED",
      message: `token_daily_cap_not_exhausted: invalid tokenMint — ${e instanceof Error ? e.message : String(e)}`,
      details: {
        gate: "token_daily_cap_not_exhausted",
        vaultAddress: input.vaultAddress,
        tokenMint: input.tokenMint,
      },
    });
  }

  try {
    const full = await fetchVaultState(
      deps.rpc as AccountDataRpc,
      input.vaultAddress as Address,
      now,
    );
    const { tokenSpendRecords } = selectTokenCap(full);

    const record = tokenSpendRecords.find((r) => r.mint.equals(mintBytes));
    if (!record) {
      return err({
        code: "PREFLIGHT_FAILED",
        message: `token_daily_cap_not_exhausted: mint ${input.tokenMint} not tracked by vault (not allowlisted or no limits configured)`,
        details: {
          gate: "token_daily_cap_not_exhausted",
          vaultAddress: input.vaultAddress,
          tokenMint: input.tokenMint,
          knownMintsCount: tokenSpendRecords.length,
        },
      });
    }

    if (record.perTxLimit < input.tokenAmountBaseUnits) {
      return err({
        code: "PREFLIGHT_FAILED",
        message: `token_daily_cap_not_exhausted: requested ${input.tokenAmountBaseUnits} exceeds per_tx_limit ${record.perTxLimit}`,
        details: {
          gate: "token_daily_cap_not_exhausted",
          vaultAddress: input.vaultAddress,
          tokenMint: input.tokenMint,
          perTxLimit: record.perTxLimit.toString(),
          requestedBaseUnits: input.tokenAmountBaseUnits.toString(),
        },
      });
    }

    const todayDay = BigInt(Math.floor(now / 1000 / SECONDS_PER_DAY));
    // Mirror the on-chain reset: if the stored day is stale, the next spend
    // zeroes `spent_today` — treat it as 0 here so we don't reject on a
    // tally that will be wiped by the same instruction that would settle
    // this transfer.
    const effectiveSpent =
      record.lastSpendDay < todayDay ? 0n : record.spentToday;

    if (record.dailyLimit < effectiveSpent) {
      return err({
        code: "PREFLIGHT_FAILED",
        message:
          "token_daily_cap_not_exhausted: on-chain spent_today exceeds daily_limit (inconsistent state)",
        details: {
          gate: "token_daily_cap_not_exhausted",
          vaultAddress: input.vaultAddress,
          tokenMint: input.tokenMint,
          dailyLimit: record.dailyLimit.toString(),
          spentToday: record.spentToday.toString(),
        },
      });
    }

    const remaining = record.dailyLimit - effectiveSpent;
    if (remaining < input.tokenAmountBaseUnits) {
      return err({
        code: "PREFLIGHT_FAILED",
        message: `token_daily_cap_not_exhausted: remaining ${remaining} < requested ${input.tokenAmountBaseUnits}`,
        details: {
          gate: "token_daily_cap_not_exhausted",
          vaultAddress: input.vaultAddress,
          tokenMint: input.tokenMint,
          remainingBaseUnits: remaining.toString(),
          requestedBaseUnits: input.tokenAmountBaseUnits.toString(),
          dailyLimit: record.dailyLimit.toString(),
          effectiveSpent: effectiveSpent.toString(),
          rolledOver: record.lastSpendDay < todayDay,
        },
      });
    }

    return ok(undefined);
  } catch (e) {
    return err({
      code: "PREFLIGHT_FAILED",
      message: `token_daily_cap_not_exhausted: ${e instanceof Error ? e.message : String(e)}`,
      details: {
        gate: "token_daily_cap_not_exhausted",
        vaultAddress: input.vaultAddress,
        tokenMint: input.tokenMint,
      },
    });
  }
}

// --------------------------------------------------------------------------
// dispute_window_open
// --------------------------------------------------------------------------
//
// Byte-level decode of the on-chain TaskEscrow account
// (programs/settlement/src/state.rs):
//
//   8   account discriminator
//   32  client
//   32  provider
//   32  client_vault
//   32  provider_vault
//   32  token_mint
//   8   total_amount
//   8   released_amount
//   ?   milestones: Vec<Milestone>         (4-byte LE length prefix + N * 41)
//   1   status
//   8   task_id
//   32  description_hash
//   8   created_at
//   8   deadline                           ← we read this
//   ?   dispute_resolver: Option<Pubkey>   (1 + 32 iff Some)
//   ?   disputed_at: Option<i64>           ← we read this  (1 + 8 iff Some)
//   1   bump
//
// Each Milestone = [u8; 32] description_hash + u64 amount + 1-byte enum = 41.
//
// ADR-030 / PR spec: the gate PASSES when both
//    a) disputed_at.is_some()        (dispute has actually been raised)
//    b) now (unix seconds) < deadline
// Either failing closes the window.

const MILESTONE_SIZE = 32 + 8 + 1; // 41
// Offset of the milestones length-prefix within the Escrow account:
const ESCROW_MILESTONES_LEN_OFFSET = 8 + 32 + 32 + 32 + 32 + 32 + 8 + 8; // 184

interface DecodedEscrowState {
  deadline: bigint; // i64 normalized to bigint
  disputedAt: bigint | null;
}

function decodeEscrowState(data: Buffer): DecodedEscrowState {
  if (data.length < ESCROW_MILESTONES_LEN_OFFSET + 4) {
    throw new Error(
      `escrow account too short: got ${data.length} bytes, need >= ${ESCROW_MILESTONES_LEN_OFFSET + 4}`,
    );
  }
  const milestonesLen = data.readUInt32LE(ESCROW_MILESTONES_LEN_OFFSET);
  // Plausibility: MAX_MILESTONES = 5 on-chain (programs/settlement/
  // src/state.rs). Reject anything beyond a generous ceiling so a
  // truncated / corrupt account doesn't parse as a giant offset.
  if (milestonesLen > 64) {
    throw new Error(`escrow milestones length implausible: ${milestonesLen}`);
  }

  let cursor = ESCROW_MILESTONES_LEN_OFFSET + 4 + milestonesLen * MILESTONE_SIZE;

  cursor += 1; // status (1)
  cursor += 8; // task_id (8)
  cursor += 32; // description_hash (32)
  cursor += 8; // created_at (8)

  // deadline:
  if (data.length < cursor + 8) {
    throw new Error(`escrow account too short for deadline at offset ${cursor}`);
  }
  const deadline = data.readBigInt64LE(cursor);
  cursor += 8;

  // dispute_resolver: Option<Pubkey>
  if (data.length < cursor + 1) {
    throw new Error(`escrow account too short for dispute_resolver tag`);
  }
  const drTag = data.readUInt8(cursor);
  cursor += 1;
  if (drTag === 1) {
    cursor += 32;
  } else if (drTag !== 0) {
    throw new Error(`invalid dispute_resolver option tag: ${drTag}`);
  }

  // disputed_at: Option<i64>
  if (data.length < cursor + 1) {
    throw new Error(`escrow account too short for disputed_at tag`);
  }
  const daTag = data.readUInt8(cursor);
  cursor += 1;
  let disputedAt: bigint | null;
  if (daTag === 1) {
    if (data.length < cursor + 8) {
      throw new Error(`escrow account too short for disputed_at value`);
    }
    disputedAt = data.readBigInt64LE(cursor);
  } else if (daTag === 0) {
    disputedAt = null;
  } else {
    throw new Error(`invalid disputed_at option tag: ${daTag}`);
  }

  return { deadline, disputedAt };
}

async function fetchEscrowState(
  rpc: AccountDataRpc,
  escrowAddress: Address,
): Promise<DecodedEscrowState> {
  const info = await rpc
    .getAccountInfo(escrowAddress, { encoding: "base64" })
    .send();

  if (!info.value || !info.value.data) {
    throw new Error(`escrow account not found: ${escrowAddress}`);
  }
  const [b64] = info.value.data;
  const raw = Buffer.from(b64, "base64");
  return decodeEscrowState(raw);
}

export async function runDisputeWindowOpen(
  deps: PreflightDeps,
  _ctx: ActionContext,
  input: PreflightInputContext | undefined,
): Promise<Result<void>> {
  if (!input?.escrowAddress) {
    return err({
      code: "PREFLIGHT_FAILED",
      message:
        "dispute_window_open: missing required input 'escrowAddress' — action must declare preflightContext",
      details: { gate: "dispute_window_open" },
    });
  }
  if (!deps.rpc || typeof deps.rpc.getAccountInfo !== "function") {
    return err({
      code: "PREFLIGHT_FAILED",
      message: "dispute_window_open: no RPC configured",
      details: { gate: "dispute_window_open" },
    });
  }

  const now = (deps.now ?? Date.now)();
  const nowSeconds = BigInt(Math.floor(now / 1000));
  try {
    const state = await fetchEscrowState(
      deps.rpc as AccountDataRpc,
      input.escrowAddress as Address,
    );

    if (state.disputedAt === null) {
      return err({
        code: "PREFLIGHT_FAILED",
        message: "dispute_window_open: no dispute raised on this escrow",
        details: {
          gate: "dispute_window_open",
          escrowAddress: input.escrowAddress,
          disputedAt: null,
        },
      });
    }

    if (nowSeconds >= state.deadline) {
      return err({
        code: "PREFLIGHT_FAILED",
        message: `dispute_window_open: window closed (now ${nowSeconds} >= deadline ${state.deadline})`,
        details: {
          gate: "dispute_window_open",
          escrowAddress: input.escrowAddress,
          nowSeconds: nowSeconds.toString(),
          deadline: state.deadline.toString(),
          disputedAt: state.disputedAt.toString(),
        },
      });
    }

    return ok(undefined);
  } catch (e) {
    return err({
      code: "PREFLIGHT_FAILED",
      message: `dispute_window_open: ${e instanceof Error ? e.message : String(e)}`,
      details: {
        gate: "dispute_window_open",
        escrowAddress: input.escrowAddress,
      },
    });
  }
}
