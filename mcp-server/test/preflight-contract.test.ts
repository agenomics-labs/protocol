/**
 * MCP-312 (Batch E) — preflight contract pin.
 *
 * The preflight pipeline is NOT a chain oracle. The only invariant it
 * guarantees is:
 *
 *     PREFLIGHT-FAIL ⇒ CHAIN-REJECT-FOR-THE-GATED-REASON
 *
 * The inverse (preflight-pass ⇒ chain-accept) is NOT guaranteed because:
 *   - Gate caches admit racy chain-side state changes
 *     (cluster_health 10s, vault-state 5s).
 *   - The chain enforces invariants beyond preflight's five gates.
 *   - Commitment-level skew between preflight reads (`confirmed`) and tx
 *     submit (`processed`/`finalized`) admits TOCTOU.
 *
 * This test pins both directions:
 *   1. Each gate fails when its precondition is violated (the "→" direction).
 *   2. A representative scenario shows preflight-pass + chain-reject coexist
 *      (the "INVERSE-NOT-GUARANTEED" direction): the cached vault state
 *      reports under-cap, but the chain rejects because spent_today moved
 *      between the gate read and the simulated submit.
 *
 * Runs under `node --import tsx --test`.
 */

import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  executePreflight,
  __resetClusterHealthCacheForTests,
  __resetVaultStateCacheForTests,
  type PreflightDeps,
} from "../src/pipeline/preflight.js";
import type { ActionContext } from "../src/types/action.js";
import { VAULT_LAYOUT } from "../src/pipeline/vault-layout.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctxNoSig(): ActionContext {
  return {
    mode: "passthrough",
    wallet: {
      publicKey: new PublicKey("11111111111111111111111111111111"),
      capabilities: new Set(),
    },
    signer: null,
  };
}

function makeVaultBytes(params: {
  spentToday: bigint;
  lastSpendDay: bigint;
  dailyLimit: bigint;
  perTxLimit?: bigint;
}): Buffer {
  const buf = Buffer.alloc(VAULT_LAYOUT.SOL_MIN_BYTES);
  buf.writeBigUInt64LE(params.spentToday, VAULT_LAYOUT.SPENT_TODAY_OFFSET);
  buf.writeBigUInt64LE(params.lastSpendDay, VAULT_LAYOUT.LAST_SPEND_DAY_OFFSET);
  buf.writeBigUInt64LE(
    params.perTxLimit ?? 0n,
    VAULT_LAYOUT.POLICY_PER_TX_LIMIT_OFFSET,
  );
  buf.writeBigUInt64LE(params.dailyLimit, VAULT_LAYOUT.DAILY_LIMIT_OFFSET);
  return buf;
}

function makeRpcWithVault(buf: Buffer): PreflightDeps["rpc"] {
  let slot = 1000n;
  return {
    getSlot: () => ({
      send: async () => {
        const v = slot;
        slot += 1n;
        return v;
      },
    }),
    getRecentPerformanceSamples: () => ({
      send: async () => [{ numSlots: 60n, numTransactions: 12_000n }],
    }),
    getMinimumBalanceForRentExemption: () => ({
      send: async () => 890_880n,
    }),
    getAccountInfo: () => ({
      send: async () => ({
        value: { data: [buf.toString("base64"), "base64"] as [string, string] },
      }),
    }),
  };
}

const VAULT_ADDR = "VauLt1111111111111111111111111111111111111";
const SECONDS_PER_DAY = 86_400;

describe("MCP-312 — preflight contract: forward direction (fail ⇒ reject)", () => {
  beforeEach(() => {
    __resetClusterHealthCacheForTests();
    __resetVaultStateCacheForTests();
  });

  it("daily_cap_not_exhausted: fail when remaining < requested", async () => {
    const today = BigInt(Math.floor(Math.floor(Date.now() / 1000) / SECONDS_PER_DAY));
    const buf = makeVaultBytes({
      spentToday: 950n,
      lastSpendDay: today,
      dailyLimit: 1000n,
    });
    const r = await executePreflight(
      ["daily_cap_not_exhausted"],
      ctxNoSig(),
      { rpc: makeRpcWithVault(buf) },
      { vaultAddress: VAULT_ADDR, amountLamports: 100n },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "PREFLIGHT_FAILED");
      assert.match(r.error.message, /daily_cap/);
    }
  });

  it("daily_cap_not_exhausted: pass when requested fits within remaining", async () => {
    const today = BigInt(Math.floor(Math.floor(Date.now() / 1000) / SECONDS_PER_DAY));
    const buf = makeVaultBytes({
      spentToday: 100n,
      lastSpendDay: today,
      dailyLimit: 1000n,
    });
    const r = await executePreflight(
      ["daily_cap_not_exhausted"],
      ctxNoSig(),
      { rpc: makeRpcWithVault(buf) },
      { vaultAddress: VAULT_ADDR, amountLamports: 500n },
    );
    assert.equal(r.ok, true);
  });

  it("cluster_health: fail when sample window reports zero tx", async () => {
    const r = await executePreflight(
      ["cluster_health"],
      ctxNoSig(),
      {
        rpc: {
          getSlot: () => ({ send: async () => 1000n }),
          getRecentPerformanceSamples: () => ({
            send: async () => [{ numSlots: 60n, numTransactions: 0n }],
          }),
          getMinimumBalanceForRentExemption: () => ({ send: async () => 0n }),
          getAccountInfo: () => ({ send: async () => ({ value: null }) }),
        },
      },
    );
    assert.equal(r.ok, false);
  });

  it("cluster_health: pass when cluster meets the floor", async () => {
    const r = await executePreflight(
      ["cluster_health"],
      ctxNoSig(),
      { rpc: makeRpcWithVault(Buffer.alloc(VAULT_LAYOUT.SOL_MIN_BYTES)) },
    );
    assert.equal(r.ok, true);
  });
});

describe("MCP-312 — preflight contract: inverse NOT guaranteed", () => {
  beforeEach(() => {
    __resetClusterHealthCacheForTests();
    __resetVaultStateCacheForTests();
  });

  it("preflight-pass with stale cache + chain-side spend ⇒ simulated chain reject", async () => {
    // Scenario: at t=0 the vault's spent_today is 100/1000 lamports (well
    // under the cap). Preflight reads this and passes the user's 500-lamport
    // request. Between the gate read and the chain submit, ANOTHER instance
    // of mcp-server (or the user's same process before invalidation
    // landed) committed 600 lamports — chain now has spent_today=700. The
    // user's 500 would push to 1200 > 1000 and the chain rejects.
    //
    // Preflight cannot prevent this. The contract is "preflight-fail ⇒
    // chain-reject-for-the-gated-reason", not "preflight-pass ⇒
    // chain-accept". This test pins that asymmetry by demonstrating the
    // pass-then-reject path is reachable.

    const today = BigInt(Math.floor(Math.floor(Date.now() / 1000) / SECONDS_PER_DAY));

    // Phase 1: at gate read time, only 100 lamports have been spent.
    const earlyState = makeVaultBytes({
      spentToday: 100n,
      lastSpendDay: today,
      dailyLimit: 1000n,
    });
    const passResult = await executePreflight(
      ["daily_cap_not_exhausted"],
      ctxNoSig(),
      { rpc: makeRpcWithVault(earlyState) },
      { vaultAddress: VAULT_ADDR, amountLamports: 500n },
    );
    assert.equal(passResult.ok, true, "preflight pass at t=0");

    // Phase 2: simulate the chain's enforcement against the LATER state.
    // The cap check on chain is `spent_today + amount <= daily_limit`. With
    // spent_today=700 (third party committed 600 between gate and submit)
    // and amount=500, that's 1200 > 1000 → chain rejects.
    const chainState = { spentToday: 700n, dailyLimit: 1000n, request: 500n };
    const wouldChainAccept =
      chainState.spentToday + chainState.request <= chainState.dailyLimit;
    assert.equal(
      wouldChainAccept,
      false,
      "chain would reject despite preflight pass — inverse-not-guaranteed",
    );
  });
});
