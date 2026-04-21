// ADR-059 §6 — The two preflight gates that read on-chain state.
//
// Split out from `preflight.ts` to keep each concern-file under the
// 500-line guideline in the project CLAUDE.md. The orchestrator in
// `preflight.ts` calls into these runners; the account-decode logic
// (byte layouts, rollover, Option<T> tag handling) lives here.
//
//   - daily_cap_not_exhausted: decodes Vault account; checks that the
//     vault's remaining SOL daily cap >= requested lamports, with
//     UTC-midnight rollover. Cached at 5s per vault.
//   - dispute_window_open:     decodes TaskEscrow; passes iff
//     `disputed_at.is_some()` AND `now_seconds < escrow.deadline`.

import type { Address } from "@solana/kit";
import type { Result, ActionContext } from "../types/action.js";
import { ok, err } from "../types/action.js";
import type {
  AccountDataRpc,
  PreflightDeps,
  PreflightInputContext,
} from "./preflight-types.js";

// --------------------------------------------------------------------------
// daily_cap_not_exhausted
// --------------------------------------------------------------------------
//
// Byte-level decode of the on-chain Vault account (programs/agent-vault/
// src/state.rs) against the fields we care about:
//
//   8   account discriminator
//   32  agent_identity
//   32  authority
//   1   paused
//   8   spent_today_lamports         (offset 73)
//   8   last_spend_day               (offset 81, Unix ts / 86_400)
//   8   policy.per_tx_limit_lamports (offset 89)
//   8   policy.daily_limit_lamports  (offset 97)
//
// Daily rollover: if the stored `last_spend_day` is strictly less than
// today's UTC-midnight day-number, the on-chain program resets
// `spent_today_lamports` to 0 on its next spend. We mirror that rule here
// so a gate check that runs before the reset instruction doesn't over-count
// yesterday's spend.
//
// Cache: 5s per the PR spec — mirror of the cluster_health TTL pattern,
// keyed on vault address so distinct vaults don't share a cache entry.

const VAULT_STATE_CACHE_MS = 5_000;
const SECONDS_PER_DAY = 86_400;

// Byte offsets in the Anchor-serialized Vault account.
const VAULT_SPENT_TODAY_OFFSET = 8 + 32 + 32 + 1; // 73
const VAULT_LAST_SPEND_DAY_OFFSET = VAULT_SPENT_TODAY_OFFSET + 8; // 81
// policy.per_tx_limit_lamports follows last_spend_day ...
const VAULT_POLICY_PER_TX_LIMIT_OFFSET = VAULT_LAST_SPEND_DAY_OFFSET + 8; // 89
// ... and policy.daily_limit_lamports follows it.
const VAULT_DAILY_LIMIT_OFFSET = VAULT_POLICY_PER_TX_LIMIT_OFFSET + 8; // 97
const VAULT_MIN_ACCOUNT_BYTES = VAULT_DAILY_LIMIT_OFFSET + 8; // 105

interface DecodedVaultState {
  spentTodayLamports: bigint;
  lastSpendDay: bigint;
  dailyLimitLamports: bigint;
}

interface VaultCacheEntry {
  expiresAt: number;
  state: DecodedVaultState;
}

const vaultStateCache = new Map<string, VaultCacheEntry>();

export function __resetVaultStateCacheForTests(): void {
  vaultStateCache.clear();
}

function decodeVaultState(data: Buffer): DecodedVaultState {
  if (data.length < VAULT_MIN_ACCOUNT_BYTES) {
    throw new Error(
      `vault account too short: got ${data.length} bytes, need >= ${VAULT_MIN_ACCOUNT_BYTES}`,
    );
  }
  return {
    spentTodayLamports: data.readBigUInt64LE(VAULT_SPENT_TODAY_OFFSET),
    lastSpendDay: data.readBigUInt64LE(VAULT_LAST_SPEND_DAY_OFFSET),
    dailyLimitLamports: data.readBigUInt64LE(VAULT_DAILY_LIMIT_OFFSET),
  };
}

async function fetchVaultState(
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
    const state = await fetchVaultState(
      deps.rpc as AccountDataRpc,
      input.vaultAddress as Address,
      now,
    );

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
