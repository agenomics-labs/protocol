// ADR-059 PR3 — pipeline unit tests.
//
// Covers:
//   - IdempotencyStore: mutex-per-key serialization + TTL eviction.
//   - executePreflight: cluster_health gate (mocked RPC) — fail short-circuits handler.
//   - capability-gated-tool: preflight failure prevents handler invocation.
//   - sendAndConfirmWithBlockhashExpiry: BLOCK_HEIGHT_EXCEEDED → retry, then succeed.
//
// Runs under `node --import tsx --test` — same harness as
// action-shape.test.ts and solana-v2.test.ts.

import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import {
  InMemoryIdempotencyStore,
  createIdempotencyStore,
  activeIdempotencyBackend,
} from "../src/pipeline/idempotency.js";
import { RedisIdempotencyStore } from "../src/pipeline/idempotency-redis.js";
// `ioredis-mock` ships a CommonJS default export whose constructor implements
// the subset of the `ioredis` surface we touch (`set`, `get`, `del`, `eval`,
// `quit`, …). We treat it as an opaque `RedisClient` for typing here — the
// Redis store only needs structural compatibility (see RedisClient in
// ../src/pipeline/idempotency-redis.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const IoRedisMock = require("ioredis-mock") as new () => any;
import {
  executePreflight,
  __resetClusterHealthCacheForTests,
  __resetVaultStateCacheForTests,
  __resetVaultFullStateCacheForTests,
  type PreflightDeps,
  type PreflightInputContext,
} from "../src/pipeline/preflight.js";
import {
  sendAndConfirmWithBlockhashExpiry,
  isBlockHeightExceeded,
} from "../src/pipeline/confirm.js";
import { capabilityGated } from "../src/adapters/capability-gated-tool.js";
import { ok, err } from "../src/types/action.js";
import type { Action, ActionContext, Result } from "../src/types/action.js";
import type { Capability } from "../src/types/capability.js";

const ZERO_PUBKEY = new PublicKey("11111111111111111111111111111111");

function ctxWith(caps: Capability[]): ActionContext {
  return {
    mode: "signed",
    wallet: { publicKey: ZERO_PUBKEY, capabilities: new Set(caps) },
    signer: {},
  };
}

// Small utility — resolves on a microtask tick so we can test concurrency
// without real timers.
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ==========================================================================
// IdempotencyStore
// ==========================================================================

describe("ADR-059 §5 InMemoryIdempotencyStore", () => {
  it("serializes concurrent calls with the same key (fn invoked once)", async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 60_000 });
    let invocations = 0;
    let release: ((v: Result<number>) => void) | null = null;

    const fn = () =>
      new Promise<Result<number>>((resolve) => {
        invocations++;
        release = resolve;
      });

    const p1 = store.acquire("k1", fn);
    const p2 = store.acquire("k1", fn);
    const p3 = store.acquire("k1", fn);

    // All three acquires should see the same in-flight promise.
    await tick();
    assert.equal(invocations, 1, "fn should run exactly once");

    release!(ok(42));
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.deepEqual(r1, { ok: true, data: 42 });
    assert.deepEqual(r2, { ok: true, data: 42 });
    assert.deepEqual(r3, { ok: true, data: 42 });
    assert.equal(invocations, 1);
    assert.equal(store.size(), 1);
  });

  it("parallelizes calls with different keys", async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 60_000 });
    let invocA = 0;
    let invocB = 0;

    const fnA = async () => {
      invocA++;
      return ok("A");
    };
    const fnB = async () => {
      invocB++;
      return ok("B");
    };

    const [rA, rB] = await Promise.all([
      store.acquire("a", fnA),
      store.acquire("b", fnB),
    ]);

    assert.deepEqual(rA, { ok: true, data: "A" });
    assert.deepEqual(rB, { ok: true, data: "B" });
    assert.equal(invocA, 1);
    assert.equal(invocB, 1);
    assert.equal(store.size(), 2);
  });

  it("evicts entries after TTL elapses", async () => {
    // Short TTL to keep the test quick.
    const store = new InMemoryIdempotencyStore({ ttlMs: 50 });
    let invocations = 0;
    const fn = async () => {
      invocations++;
      return ok(invocations);
    };

    const r1 = await store.acquire("k", fn);
    assert.deepEqual(r1, { ok: true, data: 1 });
    assert.equal(store.size(), 1);

    // Before TTL expiry — cache hit, same result, same count.
    const r1b = await store.acquire("k", fn);
    assert.deepEqual(r1b, { ok: true, data: 1 });
    assert.equal(invocations, 1);

    // Wait past TTL so the entry is evicted.
    await new Promise((resolve) => setTimeout(resolve, 80));

    const r2 = await store.acquire("k", fn);
    assert.deepEqual(r2, { ok: true, data: 2 }, "should re-run after TTL");
    assert.equal(invocations, 2);
    assert.equal(store.size(), 1);
  });
});

// ==========================================================================
// RedisIdempotencyStore (against ioredis-mock)
// ==========================================================================

describe("ADR-059 §5 RedisIdempotencyStore (ioredis-mock)", () => {
  // Each test gets a fresh mock client so keys don't bleed across cases.
  function freshClient() {
    return new IoRedisMock();
  }

  it("serializes concurrent calls with the same key (fn invoked once)", async () => {
    const client = freshClient();
    const store = new RedisIdempotencyStore({
      client,
      prefix: "t1:",
      resultTtlMs: 60_000,
      pendingTtlMs: 5_000,
      // Make the polling loop snappy so the test finishes quickly.
      pollInitialMs: 2,
      pollMaxMs: 10,
      inflightWaitMs: 2_000,
    });

    let invocations = 0;
    let release: ((v: Result<number>) => void) | null = null;
    const fn = () =>
      new Promise<Result<number>>((resolve) => {
        invocations++;
        release = resolve;
      });

    const p1 = store.acquire("same", fn);
    // Yield so p1 takes the pending marker before p2/p3 try to SET NX.
    await tick();
    const p2 = store.acquire("same", fn);
    const p3 = store.acquire("same", fn);
    await tick();

    assert.equal(invocations, 1, "fn should run exactly once");

    release!(ok(42));
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.deepEqual(r1, { ok: true, data: 42 });
    assert.deepEqual(r2, { ok: true, data: 42 });
    assert.deepEqual(r3, { ok: true, data: 42 });
    assert.equal(invocations, 1);
  });

  it("returns the cached result on a subsequent acquire without re-invoking fn", async () => {
    const client = freshClient();
    const store = new RedisIdempotencyStore({
      client,
      prefix: "t2:",
      resultTtlMs: 60_000,
      pendingTtlMs: 5_000,
    });

    let invocations = 0;
    const fn = async () => {
      invocations++;
      return ok({ answer: invocations });
    };

    const r1 = await store.acquire("k", fn);
    assert.deepEqual(r1, { ok: true, data: { answer: 1 } });

    const r2 = await store.acquire("k", fn);
    assert.deepEqual(r2, { ok: true, data: { answer: 1 } }, "cache hit");
    assert.equal(invocations, 1, "fn only ran on the first acquire");
  });

  it("evicts the cached result after TTL elapses (Redis PX expiry)", async () => {
    const client = freshClient();
    const store = new RedisIdempotencyStore({
      client,
      prefix: "t3:",
      // Very short result TTL so the test stays quick.
      resultTtlMs: 40,
      pendingTtlMs: 5_000,
    });

    let invocations = 0;
    const fn = async () => {
      invocations++;
      return ok(invocations);
    };

    const r1 = await store.acquire("k", fn);
    assert.deepEqual(r1, { ok: true, data: 1 });

    await new Promise((resolve) => setTimeout(resolve, 80));

    const r2 = await store.acquire("k", fn);
    assert.deepEqual(r2, { ok: true, data: 2 }, "should re-run after TTL");
    assert.equal(invocations, 2);
  });

  it("releases the pending marker when the handler throws (next acquire re-enters)", async () => {
    const client = freshClient();
    const store = new RedisIdempotencyStore({
      client,
      prefix: "t4:",
      resultTtlMs: 60_000,
      pendingTtlMs: 60_000,
    });

    let attempts = 0;
    const flakyFn = async (): Promise<Result<string>> => {
      attempts++;
      if (attempts === 1) throw new Error("boom");
      return ok("ok");
    };

    await assert.rejects(
      () => store.acquire("k", flakyFn),
      /boom/,
    );

    // Marker must be gone — next acquire must re-enter and succeed.
    const pending = await client.get("t4:k");
    assert.equal(pending, null, "pending marker should be released");

    const r2 = await store.acquire("k", flakyFn);
    assert.deepEqual(r2, { ok: true, data: "ok" });
    assert.equal(attempts, 2, "handler was re-entered after the first throw");
  });

  it("factory selects Redis when AEP_REDIS_URL is set, memory otherwise", () => {
    const prev = process.env.AEP_REDIS_URL;
    try {
      delete process.env.AEP_REDIS_URL;
      assert.equal(activeIdempotencyBackend(), "memory");
      const memStore = createIdempotencyStore();
      assert.ok(memStore instanceof InMemoryIdempotencyStore);

      // Note: we don't instantiate with a live URL here — ioredis would
      // attempt a real connection. activeIdempotencyBackend() reports the
      // env-selected backend without constructing anything, which is the
      // invariant we care about at startup logging time.
      process.env.AEP_REDIS_URL = "redis://localhost:6379";
      assert.equal(activeIdempotencyBackend(), "redis");
    } finally {
      if (prev === undefined) delete process.env.AEP_REDIS_URL;
      else process.env.AEP_REDIS_URL = prev;
    }
  });
});

// ==========================================================================
// Preflight — executePreflight + integration with capabilityGated
// ==========================================================================

describe("ADR-059 §6 executePreflight", () => {
  beforeEach(() => {
    __resetClusterHealthCacheForTests();
  });

  function mockRpcHealthy(): PreflightDeps["rpc"] {
    let slotCounter = 1000n;
    return {
      getSlot: () => ({
        send: async () => {
          const s = slotCounter;
          slotCounter += 1n;
          return s;
        },
      }),
      getRecentPerformanceSamples: () => ({
        send: async () => [
          { numSlots: 60n, numTransactions: 12_000n },
        ],
      }),
      getMinimumBalanceForRentExemption: () => ({
        send: async () => 890_880n,
      }),
      getAccountInfo: () => ({
        send: async () => ({ value: null }),
      }),
    };
  }

  function mockRpcUnhealthy(): PreflightDeps["rpc"] {
    return {
      getSlot: () => ({
        send: async () => 1000n,
      }),
      getRecentPerformanceSamples: () => ({
        send: async () => [{ numSlots: 60n, numTransactions: 0n }],
      }),
      getMinimumBalanceForRentExemption: () => ({
        send: async () => 0n,
      }),
      getAccountInfo: () => ({
        send: async () => ({ value: null }),
      }),
    };
  }

  it("passes when no gates are declared", async () => {
    const r = await executePreflight(undefined, ctxWith([]), {});
    assert.equal(r.ok, true);
  });

  it("passes cluster_health with healthy mock RPC", async () => {
    const r = await executePreflight(
      ["cluster_health"],
      ctxWith([]),
      { rpc: mockRpcHealthy() },
    );
    assert.equal(r.ok, true);
  });

  it("fails cluster_health when tx/slot is below floor", async () => {
    const r = await executePreflight(
      ["cluster_health"],
      ctxWith([]),
      { rpc: mockRpcUnhealthy() },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /cluster_health/);
    }
  });

  it("account_rent_exempt passes when no accounts declared", async () => {
    const r = await executePreflight(
      ["account_rent_exempt"],
      ctxWith([]),
      { rpc: mockRpcHealthy() },
    );
    assert.equal(r.ok, true);
  });

});

// ==========================================================================
// PR6 — daily_cap_not_exhausted gate (real vault-account decode)
// ==========================================================================

describe("PR6 daily_cap_not_exhausted gate", () => {
  beforeEach(() => {
    __resetClusterHealthCacheForTests();
    __resetVaultStateCacheForTests();
  });

  const VAULT_ADDR = "VauLt1111111111111111111111111111111111111";
  const SECONDS_PER_DAY = 86_400;

  /**
   * Build an Anchor-serialized Vault account blob sufficient for the
   * `daily_cap_not_exhausted` gate to decode.
   *
   *  offset  0..8    disc
   *          8..40   agent_identity
   *          40..72  authority
   *          72..73  paused (0)
   *          73..81  spent_today_lamports  (u64 LE)
   *          81..89  last_spend_day        (u64 LE = unix_ts / 86_400)
   *          89..97  policy.per_tx_limit_lamports (unused here; 0)
   *          97..105 policy.daily_limit_lamports  (u64 LE)
   *
   * The decoder's length check passes at exactly 105 bytes; extra trailing
   * fields (rate-limit window, token_spend_records, bump) are not read.
   */
  function makeVaultBytes(params: {
    spentToday: bigint;
    lastSpendDay: bigint;
    dailyLimit: bigint;
  }): Buffer {
    const buf = Buffer.alloc(105);
    // disc + 32 + 32 + paused — leave zero.
    buf.writeBigUInt64LE(params.spentToday, 73);
    buf.writeBigUInt64LE(params.lastSpendDay, 81);
    buf.writeBigUInt64LE(0n, 89); // per_tx_limit
    buf.writeBigUInt64LE(params.dailyLimit, 97);
    return buf;
  }

  function mockVaultRpc(vaultBytes: Buffer): PreflightDeps["rpc"] {
    return {
      // cluster_health methods — unused here but must satisfy the type.
      getSlot: () => ({ send: async () => 0n }),
      getRecentPerformanceSamples: () => ({
        send: async () => [{ numSlots: 60n, numTransactions: 12_000n }],
      }),
      getMinimumBalanceForRentExemption: () => ({ send: async () => 0n }),
      // The gate reads via getAccountInfo(encoding:"base64"):
      getAccountInfo: () => ({
        send: async () => ({
          value: {
            lamports: 10_000_000n,
            data: [vaultBytes.toString("base64"), "base64"] as const,
          },
        }),
      }),
    };
  }

  // Fixed "now" so lastSpendDay arithmetic is deterministic.
  const FIXED_NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20Z
  const TODAY_DAY = BigInt(
    Math.floor(FIXED_NOW_MS / 1000 / SECONDS_PER_DAY),
  );

  it("passes when remaining >= amount", async () => {
    const vaultBytes = makeVaultBytes({
      spentToday: 500_000_000n, // 0.5 SOL spent
      lastSpendDay: TODAY_DAY,
      dailyLimit: 10_000_000_000n, // 10 SOL cap
    });
    const r = await executePreflight(
      ["daily_cap_not_exhausted"],
      ctxWith([]),
      { rpc: mockVaultRpc(vaultBytes), now: () => FIXED_NOW_MS },
      { vaultAddress: VAULT_ADDR, amountLamports: 1_000_000_000n }, // 1 SOL
    );
    assert.equal(r.ok, true);
  });

  it("fails when remaining < amount", async () => {
    const vaultBytes = makeVaultBytes({
      spentToday: 9_500_000_000n, // 9.5 SOL already spent
      lastSpendDay: TODAY_DAY,
      dailyLimit: 10_000_000_000n, // 10 SOL cap → 0.5 SOL remaining
    });
    const r = await executePreflight(
      ["daily_cap_not_exhausted"],
      ctxWith([]),
      { rpc: mockVaultRpc(vaultBytes), now: () => FIXED_NOW_MS },
      { vaultAddress: VAULT_ADDR, amountLamports: 1_000_000_000n }, // 1 SOL
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /daily_cap_not_exhausted/);
      const d = r.error.details as { rolledOver: boolean };
      assert.equal(d.rolledOver, false, "same-day, no rollover");
    }
  });

  it("rolls over a stale last_spend_day and passes on a fresh day", async () => {
    // spent_today is "9.5 SOL" on YESTERDAY — mirror the on-chain reset
    // and a full 10 SOL should be available today.
    const vaultBytes = makeVaultBytes({
      spentToday: 9_500_000_000n,
      lastSpendDay: TODAY_DAY - 1n,
      dailyLimit: 10_000_000_000n,
    });
    const r = await executePreflight(
      ["daily_cap_not_exhausted"],
      ctxWith([]),
      { rpc: mockVaultRpc(vaultBytes), now: () => FIXED_NOW_MS },
      { vaultAddress: VAULT_ADDR, amountLamports: 9_000_000_000n }, // 9 SOL
    );
    assert.equal(
      r.ok,
      true,
      "stale last_spend_day should reset and allow full daily cap",
    );
  });

  it("fails loudly when required input is missing (no vaultAddress)", async () => {
    const r = await executePreflight(
      ["daily_cap_not_exhausted"],
      ctxWith([]),
      {
        rpc: mockVaultRpc(
          makeVaultBytes({
            spentToday: 0n,
            lastSpendDay: TODAY_DAY,
            dailyLimit: 10_000_000_000n,
          }),
        ),
        now: () => FIXED_NOW_MS,
      },
      { amountLamports: 1_000_000_000n } as PreflightInputContext, // no vaultAddress
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /vaultAddress/);
    }
  });

  it("fails loudly when required input is missing (no amountLamports)", async () => {
    const r = await executePreflight(
      ["daily_cap_not_exhausted"],
      ctxWith([]),
      {
        rpc: mockVaultRpc(
          makeVaultBytes({
            spentToday: 0n,
            lastSpendDay: TODAY_DAY,
            dailyLimit: 10_000_000_000n,
          }),
        ),
        now: () => FIXED_NOW_MS,
      },
      { vaultAddress: VAULT_ADDR } as PreflightInputContext, // no amountLamports
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /amountLamports/);
    }
  });

  it("fails loudly when preflightContext is entirely absent", async () => {
    const r = await executePreflight(
      ["daily_cap_not_exhausted"],
      ctxWith([]),
      {
        rpc: mockVaultRpc(
          makeVaultBytes({
            spentToday: 0n,
            lastSpendDay: TODAY_DAY,
            dailyLimit: 10_000_000_000n,
          }),
        ),
        now: () => FIXED_NOW_MS,
      },
      // no input at all — simulates a mis-wired action
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "PREFLIGHT_FAILED");
  });
});

// ==========================================================================
// token_daily_cap_not_exhausted gate (per-mint SPL daily cap)
// ==========================================================================

describe("token_daily_cap_not_exhausted gate", () => {
  beforeEach(() => {
    __resetClusterHealthCacheForTests();
    __resetVaultStateCacheForTests();
    __resetVaultFullStateCacheForTests();
  });

  const VAULT_ADDR = "VauLt1111111111111111111111111111111111111";
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const WSOL_MINT = "So11111111111111111111111111111111111111112";
  const SECONDS_PER_DAY = 86_400;

  /**
   * Build an Anchor-serialized Vault account blob that reaches all the way
   * through `token_spend_records` so the token-cap gate can decode it.
   *
   * Layout (aligned with programs/agent-vault/src/state.rs):
   *   disc (8) + agent_identity (32) + authority (32) + paused (1)
   *   + spent_today_lamports (8) + last_spend_day (8)
   *   + policy.per_tx_limit_lamports (8) + policy.daily_limit_lamports (8)
   *   + policy.max_txs_per_hour (4)
   *   + policy.token_allowlist   : Vec<Pubkey> (u32 len + N*32)
   *   + policy.program_allowlist : Vec<Pubkey> (u32 len + M*32)
   *   + txs_in_current_window (u32) + rate_limit_window_start (i64)
   *   + token_spend_records : Vec<TokenSpendRecord> (u32 len + K*64)
   *   + bump (1)
   *
   * TokenSpendRecord = mint(32) + per_tx_limit(u64) + daily_limit(u64)
   *                  + spent_today(u64) + last_spend_day(u64) = 64 bytes.
   *
   * `tokenAllowlistLen` / `programAllowlistLen` padding exists to exercise
   * the decoder's Vec<Pubkey> skip logic — the contents don't matter for the
   * token-cap gate, only the length-prefix math.
   */
  interface TokenRecordFixture {
    mint: string; // base58 pubkey
    perTxLimit: bigint;
    dailyLimit: bigint;
    spentToday: bigint;
    lastSpendDay: bigint;
  }
  function makeVaultWithTokenRecords(
    records: TokenRecordFixture[],
    opts: { tokenAllowlistLen?: number; programAllowlistLen?: number } = {},
  ): Buffer {
    const tokenAllowlistLen = opts.tokenAllowlistLen ?? records.length;
    const programAllowlistLen = opts.programAllowlistLen ?? 0;

    const policyHeader = 8 + 32 + 32 + 1 + 8 + 8 + 8 + 8 + 4; // up to max_txs_per_hour
    const tokenAllowVecLen = 4 + tokenAllowlistLen * 32;
    const programAllowVecLen = 4 + programAllowlistLen * 32;
    const rateLimitLen = 4 + 8; // txs_in_current_window + rate_limit_window_start
    const tokenRecordsVecLen = 4 + records.length * 64;
    const bumpLen = 1;
    const total =
      policyHeader +
      tokenAllowVecLen +
      programAllowVecLen +
      rateLimitLen +
      tokenRecordsVecLen +
      bumpLen;

    const buf = Buffer.alloc(total);

    // All fixed-offset fields we don't care about stay zero. Start writing
    // from the first variable-length boundary.
    let c = policyHeader;

    // token_allowlist vec: length + zeroed pubkeys.
    buf.writeUInt32LE(tokenAllowlistLen, c);
    c += 4 + tokenAllowlistLen * 32;

    // program_allowlist vec: length + zeroed pubkeys.
    buf.writeUInt32LE(programAllowlistLen, c);
    c += 4 + programAllowlistLen * 32;

    // txs_in_current_window (u32) + rate_limit_window_start (i64) — zero.
    c += rateLimitLen;

    // token_spend_records vec: length + records.
    buf.writeUInt32LE(records.length, c);
    c += 4;
    for (const r of records) {
      const mintBytes = new PublicKey(r.mint).toBytes();
      Buffer.from(mintBytes).copy(buf, c);
      buf.writeBigUInt64LE(r.perTxLimit, c + 32);
      buf.writeBigUInt64LE(r.dailyLimit, c + 32 + 8);
      buf.writeBigUInt64LE(r.spentToday, c + 32 + 16);
      buf.writeBigUInt64LE(r.lastSpendDay, c + 32 + 24);
      c += 64;
    }
    // bump — leave zero.
    return buf;
  }

  function mockVaultRpc(vaultBytes: Buffer): PreflightDeps["rpc"] {
    return {
      getSlot: () => ({ send: async () => 0n }),
      getRecentPerformanceSamples: () => ({
        send: async () => [{ numSlots: 60n, numTransactions: 12_000n }],
      }),
      getMinimumBalanceForRentExemption: () => ({ send: async () => 0n }),
      getAccountInfo: () => ({
        send: async () => ({
          value: {
            lamports: 10_000_000n,
            data: [vaultBytes.toString("base64"), "base64"] as const,
          },
        }),
      }),
    };
  }

  const FIXED_NOW_MS = 1_700_000_000_000;
  const TODAY_DAY = BigInt(Math.floor(FIXED_NOW_MS / 1000 / SECONDS_PER_DAY));

  it("passes when mint is allowlisted and remaining >= amount", async () => {
    const vaultBytes = makeVaultWithTokenRecords([
      {
        mint: USDC_MINT,
        perTxLimit: 5_000_000n, // 5 USDC
        dailyLimit: 10_000_000n, // 10 USDC
        spentToday: 2_000_000n, // 2 USDC already spent → 8 USDC remaining
        lastSpendDay: TODAY_DAY,
      },
    ]);
    const r = await executePreflight(
      ["token_daily_cap_not_exhausted"],
      ctxWith([]),
      { rpc: mockVaultRpc(vaultBytes), now: () => FIXED_NOW_MS },
      {
        vaultAddress: VAULT_ADDR,
        tokenMint: USDC_MINT,
        tokenAmountBaseUnits: 3_000_000n, // 3 USDC
      },
    );
    assert.equal(r.ok, true);
  });

  it("fails when the requested mint is NOT on the allowlist", async () => {
    const vaultBytes = makeVaultWithTokenRecords([
      {
        mint: USDC_MINT,
        perTxLimit: 5_000_000n,
        dailyLimit: 10_000_000n,
        spentToday: 0n,
        lastSpendDay: TODAY_DAY,
      },
    ]);
    const r = await executePreflight(
      ["token_daily_cap_not_exhausted"],
      ctxWith([]),
      { rpc: mockVaultRpc(vaultBytes), now: () => FIXED_NOW_MS },
      {
        vaultAddress: VAULT_ADDR,
        tokenMint: WSOL_MINT, // not in records
        tokenAmountBaseUnits: 1_000_000n,
      },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /not tracked by vault/);
      const d = r.error.details as { knownMintsCount: number };
      assert.equal(d.knownMintsCount, 1);
    }
  });

  it("fails when remaining daily cap < requested amount", async () => {
    const vaultBytes = makeVaultWithTokenRecords([
      {
        mint: USDC_MINT,
        perTxLimit: 10_000_000n, // 10 USDC per-tx (high enough to not fail first)
        dailyLimit: 10_000_000n, // 10 USDC/day
        spentToday: 9_500_000n, // 9.5 USDC already spent → 0.5 USDC remaining
        lastSpendDay: TODAY_DAY,
      },
    ]);
    const r = await executePreflight(
      ["token_daily_cap_not_exhausted"],
      ctxWith([]),
      { rpc: mockVaultRpc(vaultBytes), now: () => FIXED_NOW_MS },
      {
        vaultAddress: VAULT_ADDR,
        tokenMint: USDC_MINT,
        tokenAmountBaseUnits: 1_000_000n, // 1 USDC — more than remaining 0.5
      },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /remaining .* < requested/);
      const d = r.error.details as { rolledOver: boolean };
      assert.equal(d.rolledOver, false);
    }
  });

  it("fails when requested amount exceeds per_tx_limit", async () => {
    const vaultBytes = makeVaultWithTokenRecords([
      {
        mint: USDC_MINT,
        perTxLimit: 2_000_000n, // 2 USDC per-tx cap
        dailyLimit: 100_000_000n, // plenty of daily headroom
        spentToday: 0n,
        lastSpendDay: TODAY_DAY,
      },
    ]);
    const r = await executePreflight(
      ["token_daily_cap_not_exhausted"],
      ctxWith([]),
      { rpc: mockVaultRpc(vaultBytes), now: () => FIXED_NOW_MS },
      {
        vaultAddress: VAULT_ADDR,
        tokenMint: USDC_MINT,
        tokenAmountBaseUnits: 3_000_000n, // 3 USDC — exceeds per_tx
      },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /exceeds per_tx_limit/);
    }
  });

  it("rolls over a stale last_spend_day (yesterday's spent_today is treated as 0)", async () => {
    const vaultBytes = makeVaultWithTokenRecords([
      {
        mint: USDC_MINT,
        perTxLimit: 10_000_000n,
        dailyLimit: 10_000_000n,
        spentToday: 9_500_000n, // "from yesterday"
        lastSpendDay: TODAY_DAY - 1n,
      },
    ]);
    const r = await executePreflight(
      ["token_daily_cap_not_exhausted"],
      ctxWith([]),
      { rpc: mockVaultRpc(vaultBytes), now: () => FIXED_NOW_MS },
      {
        vaultAddress: VAULT_ADDR,
        tokenMint: USDC_MINT,
        tokenAmountBaseUnits: 9_000_000n, // would fail on yesterday's tally
      },
    );
    assert.equal(
      r.ok,
      true,
      "stale last_spend_day should reset token spent_today and allow full daily cap",
    );
  });

  it("selects the correct record when multiple mints are tracked", async () => {
    // Two mints in allowlist; one is exhausted, the other has room. The gate
    // must pick the record matching `tokenMint` — mixing them up would be
    // a silent mis-decode.
    const vaultBytes = makeVaultWithTokenRecords([
      {
        // First: USDC is nearly exhausted
        mint: USDC_MINT,
        perTxLimit: 10_000_000n,
        dailyLimit: 10_000_000n,
        spentToday: 9_999_000n,
        lastSpendDay: TODAY_DAY,
      },
      {
        // Second: WSOL has full headroom
        mint: WSOL_MINT,
        perTxLimit: 1_000_000_000n,
        dailyLimit: 5_000_000_000n,
        spentToday: 0n,
        lastSpendDay: TODAY_DAY,
      },
    ]);
    // Request WSOL: should pass (second record). A naive decoder that
    // always returned the first record would fail this request.
    const r = await executePreflight(
      ["token_daily_cap_not_exhausted"],
      ctxWith([]),
      { rpc: mockVaultRpc(vaultBytes), now: () => FIXED_NOW_MS },
      {
        vaultAddress: VAULT_ADDR,
        tokenMint: WSOL_MINT,
        tokenAmountBaseUnits: 500_000_000n,
      },
    );
    assert.equal(r.ok, true);
  });

  it("walks past non-empty token_allowlist/program_allowlist vecs", async () => {
    // Make sure the decoder isn't assuming the policy Vec<Pubkey>s are empty
    // — a bug where the offset math omitted their bodies would land the
    // token_spend_records read on the wrong bytes and the mint lookup would
    // fail.
    const vaultBytes = makeVaultWithTokenRecords(
      [
        {
          mint: USDC_MINT,
          perTxLimit: 5_000_000n,
          dailyLimit: 10_000_000n,
          spentToday: 0n,
          lastSpendDay: TODAY_DAY,
        },
      ],
      { tokenAllowlistLen: 3, programAllowlistLen: 2 },
    );
    const r = await executePreflight(
      ["token_daily_cap_not_exhausted"],
      ctxWith([]),
      { rpc: mockVaultRpc(vaultBytes), now: () => FIXED_NOW_MS },
      {
        vaultAddress: VAULT_ADDR,
        tokenMint: USDC_MINT,
        tokenAmountBaseUnits: 1_000_000n,
      },
    );
    assert.equal(r.ok, true);
  });

  it("fails loudly when vaultAddress is missing", async () => {
    const vaultBytes = makeVaultWithTokenRecords([
      {
        mint: USDC_MINT,
        perTxLimit: 10_000_000n,
        dailyLimit: 10_000_000n,
        spentToday: 0n,
        lastSpendDay: TODAY_DAY,
      },
    ]);
    const r = await executePreflight(
      ["token_daily_cap_not_exhausted"],
      ctxWith([]),
      { rpc: mockVaultRpc(vaultBytes), now: () => FIXED_NOW_MS },
      {
        tokenMint: USDC_MINT,
        tokenAmountBaseUnits: 1_000_000n,
      } as PreflightInputContext,
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /vaultAddress/);
    }
  });

  it("fails loudly when tokenMint is missing", async () => {
    const vaultBytes = makeVaultWithTokenRecords([
      {
        mint: USDC_MINT,
        perTxLimit: 10_000_000n,
        dailyLimit: 10_000_000n,
        spentToday: 0n,
        lastSpendDay: TODAY_DAY,
      },
    ]);
    const r = await executePreflight(
      ["token_daily_cap_not_exhausted"],
      ctxWith([]),
      { rpc: mockVaultRpc(vaultBytes), now: () => FIXED_NOW_MS },
      {
        vaultAddress: VAULT_ADDR,
        tokenAmountBaseUnits: 1_000_000n,
      } as PreflightInputContext,
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /tokenMint/);
    }
  });

  it("fails loudly when tokenAmountBaseUnits is missing", async () => {
    const vaultBytes = makeVaultWithTokenRecords([
      {
        mint: USDC_MINT,
        perTxLimit: 10_000_000n,
        dailyLimit: 10_000_000n,
        spentToday: 0n,
        lastSpendDay: TODAY_DAY,
      },
    ]);
    const r = await executePreflight(
      ["token_daily_cap_not_exhausted"],
      ctxWith([]),
      { rpc: mockVaultRpc(vaultBytes), now: () => FIXED_NOW_MS },
      {
        vaultAddress: VAULT_ADDR,
        tokenMint: USDC_MINT,
      } as PreflightInputContext,
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /tokenAmountBaseUnits/);
    }
  });
});

// ==========================================================================
// PR6 — dispute_window_open gate (real escrow-account decode)
// ==========================================================================

describe("PR6 dispute_window_open gate", () => {
  const ESCROW_ADDR = "EscRow1111111111111111111111111111111111111";

  /**
   * Build an Anchor-serialized TaskEscrow blob reaching through `disputed_at`
   * so the decoder can read both `deadline` and the `disputed_at` Option.
   * Milestones is empty (len=0) to keep the fixture tiny.
   *
   *   0..8      disc
   *   8..40     client
   *  40..72     provider
   *  72..104    client_vault
   * 104..136    provider_vault
   * 136..168    token_mint
   * 168..176    total_amount
   * 176..184    released_amount
   * 184..188    milestones.len = 0 (u32 LE)
   *         (no milestone bodies)
   * 188..189    status = 0
   * 189..197    task_id
   * 197..229    description_hash
   * 229..237    created_at
   * 237..245    deadline (i64 LE)
   * 245..246    dispute_resolver tag = 0 (None)
   * 246..247    disputed_at tag (1 iff Some)
   * 247..255    disputed_at value iff tag=1
   *   ..+1      bump
   */
  function makeEscrowBytes(params: {
    deadline: bigint;
    disputedAt: bigint | null;
  }): Buffer {
    const disputedSome = params.disputedAt !== null;
    const bodyLen = 247 + (disputedSome ? 8 : 0) + 1;
    const buf = Buffer.alloc(bodyLen);

    // Zero pubkeys + u64s — leave default.
    // milestones.len at 184
    buf.writeUInt32LE(0, 184);
    // status enum byte at 188 — stays 0 (Created)
    // deadline at 237
    buf.writeBigInt64LE(params.deadline, 237);
    // dispute_resolver tag = 0 (None) at 245 — default
    // disputed_at tag at 246
    buf.writeUInt8(disputedSome ? 1 : 0, 246);
    if (disputedSome) {
      buf.writeBigInt64LE(params.disputedAt as bigint, 247);
    }
    // bump — trailing 0
    return buf;
  }

  function mockEscrowRpc(escrowBytes: Buffer): PreflightDeps["rpc"] {
    return {
      getSlot: () => ({ send: async () => 0n }),
      getRecentPerformanceSamples: () => ({
        send: async () => [{ numSlots: 60n, numTransactions: 12_000n }],
      }),
      getMinimumBalanceForRentExemption: () => ({ send: async () => 0n }),
      getAccountInfo: () => ({
        send: async () => ({
          value: {
            lamports: 1_000_000n,
            data: [escrowBytes.toString("base64"), "base64"] as const,
          },
        }),
      }),
    };
  }

  // Fixed "now" for deterministic window checks.
  const FIXED_NOW_MS = 1_700_000_000_000;
  const NOW_SEC = BigInt(Math.floor(FIXED_NOW_MS / 1000));

  it("passes when disputed_at is set and now < deadline", async () => {
    const bytes = makeEscrowBytes({
      deadline: NOW_SEC + 86_400n, // 1 day from now
      disputedAt: NOW_SEC - 3_600n, // 1h ago
    });
    const r = await executePreflight(
      ["dispute_window_open"],
      ctxWith([]),
      { rpc: mockEscrowRpc(bytes), now: () => FIXED_NOW_MS },
      { escrowAddress: ESCROW_ADDR },
    );
    assert.equal(r.ok, true);
  });

  it("fails when disputed_at is None", async () => {
    const bytes = makeEscrowBytes({
      deadline: NOW_SEC + 86_400n,
      disputedAt: null,
    });
    const r = await executePreflight(
      ["dispute_window_open"],
      ctxWith([]),
      { rpc: mockEscrowRpc(bytes), now: () => FIXED_NOW_MS },
      { escrowAddress: ESCROW_ADDR },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /no dispute raised/);
    }
  });

  it("fails when now >= deadline (window has closed)", async () => {
    const bytes = makeEscrowBytes({
      deadline: NOW_SEC - 1n, // already past
      disputedAt: NOW_SEC - 7_200n,
    });
    const r = await executePreflight(
      ["dispute_window_open"],
      ctxWith([]),
      { rpc: mockEscrowRpc(bytes), now: () => FIXED_NOW_MS },
      { escrowAddress: ESCROW_ADDR },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /window closed/);
    }
  });

  it("fails loudly when escrowAddress is missing from preflightContext", async () => {
    const bytes = makeEscrowBytes({
      deadline: NOW_SEC + 86_400n,
      disputedAt: NOW_SEC - 100n,
    });
    const r = await executePreflight(
      ["dispute_window_open"],
      ctxWith([]),
      { rpc: mockEscrowRpc(bytes), now: () => FIXED_NOW_MS },
      {} as PreflightInputContext, // forgot to supply escrowAddress
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /escrowAddress/);
    }
  });
});

describe("capability-gated preflight wiring", () => {
  beforeEach(() => {
    __resetClusterHealthCacheForTests();
  });

  function makeAction(
    handlerCallsRef: { count: number },
  ): Action<{ foo: string }, number> {
    return {
      name: "test_preflight_action",
      title: "t",
      description: "d",
      inputSchema: { foo: z.string() } as const,
      outputSchema: z.number(),
      similes: [],
      examples: [],
      readOnly: false,
      capabilities: ["sign:settlement"],
      preflight: ["cluster_health"],
      requiresSigner: true,
      handler: async (_ctx, _input) => {
        handlerCallsRef.count++;
        return ok(1);
      },
    };
  }

  it("preflight FAIL → handler is NOT called and PREFLIGHT_FAILED is returned", async () => {
    const calls = { count: 0 };
    const action = makeAction(calls);

    const wrapped = capabilityGated(action, {
      preflightDeps: {
        rpc: {
          getSlot: () => ({ send: async () => 1000n }),
          getRecentPerformanceSamples: () => ({
            send: async () => [{ numSlots: 60n, numTransactions: 0n }],
          }),
          getMinimumBalanceForRentExemption: () => ({ send: async () => 0n }),
          getAccountInfo: () => ({ send: async () => ({ value: null }) }),
        },
      },
    });

    const ctx = ctxWith(["sign:settlement"]);
    const r = await wrapped.handler(ctx, { foo: "bar" });

    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "PREFLIGHT_FAILED");
    assert.equal(calls.count, 0, "handler should not have run");
  });

  it("preflight PASS → handler IS called", async () => {
    const calls = { count: 0 };
    const action = makeAction(calls);
    let slotCounter = 500n;

    const wrapped = capabilityGated(action, {
      preflightDeps: {
        rpc: {
          getSlot: () => ({
            send: async () => {
              const s = slotCounter;
              slotCounter += 1n;
              return s;
            },
          }),
          getRecentPerformanceSamples: () => ({
            send: async () => [{ numSlots: 60n, numTransactions: 12_000n }],
          }),
          getMinimumBalanceForRentExemption: () => ({
            send: async () => 890_880n,
          }),
          getAccountInfo: () => ({ send: async () => ({ value: null }) }),
        },
      },
    });

    const ctx = ctxWith(["sign:settlement"]);
    const r = await wrapped.handler(ctx, { foo: "bar" });

    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.data, 1);
    assert.equal(calls.count, 1);
  });

  // PR6: end-to-end proof that an Action's `preflightContext` reaches the
  // gate. Uses `dispute_window_open` because it has the simplest required
  // input (escrowAddress only) and we already have makeEscrowBytes-shaped
  // account-data in this file.
  it("flows preflightContext from Action → gate (dispute_window_open)", async () => {
    __resetVaultStateCacheForTests();

    // Build an escrow blob with a closed window so the gate fails — this
    // proves the gate actually executed the input-context path.
    function escrowClosedBytes(): Buffer {
      const buf = Buffer.alloc(256);
      // milestones.len = 0 at offset 184
      buf.writeUInt32LE(0, 184);
      // deadline at 237 — set to epoch 0 so it's always past "now"
      buf.writeBigInt64LE(0n, 237);
      // dispute_resolver tag = 0 (None) at 245
      buf.writeUInt8(0, 245);
      // disputed_at tag = 1 (Some) at 246
      buf.writeUInt8(1, 246);
      // disputed_at value at 247 — any in-range i64
      buf.writeBigInt64LE(-1n, 247);
      return buf;
    }

    const calls = { count: 0 };
    const action: Action<{ escrowAddress: string }, number> = {
      name: "e2e_preflight_action",
      title: "t",
      description: "d",
      inputSchema: { escrowAddress: z.string() } as const,
      outputSchema: z.number(),
      similes: [],
      examples: [],
      readOnly: false,
      capabilities: ["sign:settlement"],
      preflight: ["dispute_window_open"],
      preflightContext: (input) => ({ escrowAddress: input.escrowAddress }),
      requiresSigner: true,
      handler: async () => {
        calls.count++;
        return ok(1);
      },
    };

    const wrapped = capabilityGated(action, {
      preflightDeps: {
        rpc: {
          getSlot: () => ({ send: async () => 0n }),
          getRecentPerformanceSamples: () => ({
            send: async () => [{ numSlots: 60n, numTransactions: 12_000n }],
          }),
          getMinimumBalanceForRentExemption: () => ({ send: async () => 0n }),
          getAccountInfo: () => ({
            send: async () => ({
              value: {
                lamports: 1_000n,
                data: [escrowClosedBytes().toString("base64"), "base64"] as const,
              },
            }),
          }),
        },
      },
    });

    const ctx = ctxWith(["sign:settlement"]);
    const r = await wrapped.handler(ctx, {
      escrowAddress: "EscRow1111111111111111111111111111111111111",
    });

    assert.equal(r.ok, false, "gate should have failed on closed window");
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /dispute_window_open/);
    }
    assert.equal(calls.count, 0, "handler must not run when preflight fails");
  });
});

// ==========================================================================
// sendAndConfirmWithBlockhashExpiry
// ==========================================================================

describe("ADR-059 §4 sendAndConfirmWithBlockhashExpiry", () => {
  // Stand-in "signed tx" shape — single signature in map form.
  function makeSigned(sigByte: number) {
    const sig = new Uint8Array(64);
    sig.fill(sigByte);
    return { signatures: { somePubkey: sig } } as const;
  }

  it("retries on BLOCK_HEIGHT_EXCEEDED and returns signature after success", async () => {
    let buildAndSignCalls = 0;
    let sendCalls = 0;

    const r = await sendAndConfirmWithBlockhashExpiry(
      async () => {
        buildAndSignCalls++;
        return makeSigned(buildAndSignCalls); // distinguishable per attempt
      },
      {
        maxRetries: 2,
        sendAndConfirm: async (_signed) => {
          sendCalls++;
          if (sendCalls === 1) {
            throw new Error(
              "SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED: blockhash expired",
            );
          }
        },
      },
    );

    assert.equal(r.ok, true, "wrapper should resolve on retry success");
    assert.equal(buildAndSignCalls, 2, "buildAndSign called per attempt");
    assert.equal(sendCalls, 2);
    if (r.ok) assert.equal(typeof r.data, "string");
  });

  it("gives up with RPC_ERROR after maxRetries exhausted", async () => {
    let sendCalls = 0;
    const r = await sendAndConfirmWithBlockhashExpiry(
      async () => ({ signatures: { x: new Uint8Array(64) } }) as const,
      {
        maxRetries: 1,
        sendAndConfirm: async () => {
          sendCalls++;
          throw new Error("BLOCK_HEIGHT_EXCEEDED");
        },
      },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "RPC_ERROR");
    // maxRetries=1 means the loop runs attempts 0 and 1 → 2 send calls.
    assert.equal(sendCalls, 2);
  });

  it("returns RPC_ERROR immediately on a non-expiry failure", async () => {
    let sendCalls = 0;
    const r = await sendAndConfirmWithBlockhashExpiry(
      async () => ({ signatures: { x: new Uint8Array(64) } }) as const,
      {
        maxRetries: 5,
        sendAndConfirm: async () => {
          sendCalls++;
          throw new Error("PROGRAM_FAILED: custom program error 0x42");
        },
      },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "RPC_ERROR");
    assert.equal(sendCalls, 1, "non-expiry errors are terminal");
  });

  it("isBlockHeightExceeded detects the typed error code by string", () => {
    assert.equal(
      isBlockHeightExceeded(new Error("SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED")),
      true,
    );
    assert.equal(
      isBlockHeightExceeded(new Error("blockhash not found")),
      true,
    );
    assert.equal(isBlockHeightExceeded(new Error("unrelated")), false);
    assert.equal(isBlockHeightExceeded(null), false);
  });
});
