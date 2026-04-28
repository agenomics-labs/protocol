/**
 * MCP-311 / MCP-313 / MCP-314 (ADR-119, Batch D) — vault-layout drift +
 * cache invalidation tests.
 *
 *   1. Drift assertion passes against the live IDL.
 *   2. Drift assertion throws VaultLayoutDriftError when injected IDL
 *      shifts a field offset (simulating a Rust struct reorder).
 *   3. Drift assertion throws when injected IDL adds a new field before
 *      the existing fixed prefix.
 *   4. invalidateVaultStateCache removes the cached entry; the next
 *      fetchVaultState call re-fetches from RPC.
 *
 * Runs under `node --import tsx --test`.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  assertVaultLayoutMatchesIdl,
  VaultLayoutDriftError,
} from "../src/pipeline/vault-layout-drift.js";
import {
  invalidateVaultStateCache,
  __resetVaultStateCacheForTests,
  fetchVaultState,
  VAULT_LAYOUT,
} from "../src/pipeline/vault-layout.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const IDL_PATH = path.join(REPO_ROOT, "sdk/idl/src/idl/agent_vault.json");

describe("MCP-311 — vault-layout drift assertion", () => {
  it("passes against the live IDL", () => {
    assert.doesNotThrow(() => assertVaultLayoutMatchesIdl());
  });

  it("throws VaultLayoutDriftError when a field's offset shifts", () => {
    const live = JSON.parse(fs.readFileSync(IDL_PATH, "utf8")) as {
      types: { name: string; type: { kind: string; fields: { name: string; type: unknown }[] } }[];
    };
    // Mutate the Vault struct: insert a fake u8 BEFORE `paused`. This
    // pushes spent_today_lamports forward by 1.
    const vaultType = live.types.find((t) => t.name === "Vault")!;
    const fields = (vaultType.type as { fields: { name: string; type: unknown }[] }).fields;
    const idx = fields.findIndex((f) => f.name === "paused");
    fields.splice(idx, 0, { name: "_drift_canary", type: "u8" });

    assert.throws(
      () => assertVaultLayoutMatchesIdl({ idlJson: live }),
      (err: unknown) => {
        assert.ok(err instanceof VaultLayoutDriftError, `got ${err}`);
        const driftErr = err as VaultLayoutDriftError;
        assert.ok(driftErr.diffs.length > 0, "expected at least one diff");
        assert.match(
          driftErr.message,
          /SPENT_TODAY_OFFSET|drift detected/,
        );
        return true;
      },
    );
  });

  it("throws when TokenSpendRecord size changes", () => {
    const live = JSON.parse(fs.readFileSync(IDL_PATH, "utf8")) as {
      types: { name: string; type: { kind: string; fields: { name: string; type: unknown }[] } }[];
    };
    const tsr = live.types.find((t) => t.name === "TokenSpendRecord")!;
    const fields = (tsr.type as { fields: { name: string; type: unknown }[] }).fields;
    fields.push({ name: "_extra", type: "u64" });

    assert.throws(
      () => assertVaultLayoutMatchesIdl({ idlJson: live }),
      (err: unknown) => {
        assert.ok(err instanceof VaultLayoutDriftError);
        assert.match(
          (err as Error).message,
          /TOKEN_SPEND_RECORD_SIZE/,
        );
        return true;
      },
    );
  });
});

describe("MCP-313 — generated constants match live IDL exactly", () => {
  it("VAULT_LAYOUT exposes the codegen output", () => {
    // Spot-checks: the key constants the runtime gates consume match the
    // values the codegen produced. If this asserts ever fails, somebody
    // hand-edited `vault-layout.generated.ts` (which is forbidden) OR the
    // IDL changed without regen (caught by drift check above).
    assert.equal(VAULT_LAYOUT.SPENT_TODAY_OFFSET, 73);
    assert.equal(VAULT_LAYOUT.LAST_SPEND_DAY_OFFSET, 81);
    assert.equal(VAULT_LAYOUT.POLICY_PER_TX_LIMIT_OFFSET, 89);
    assert.equal(VAULT_LAYOUT.DAILY_LIMIT_OFFSET, 97);
    assert.equal(VAULT_LAYOUT.POLICY_FIXED_END_OFFSET, 109);
    assert.equal(VAULT_LAYOUT.TOKEN_SPEND_RECORD_SIZE, 64);
  });
});

describe("MCP-314 — vault-state cache invalidation hook", () => {
  it("invalidateVaultStateCache removes the cached entry; next fetch goes to RPC", async () => {
    __resetVaultStateCacheForTests();

    let rpcCalls = 0;
    const FIXED_VAULT = "vault-addr-x";
    // Build a synthetic Vault account body matching the SOL_MIN_BYTES
    // contract (just the fixed prefix is enough for the SOL-cap path).
    const buf = Buffer.alloc(VAULT_LAYOUT.SOL_MIN_BYTES);
    buf.writeBigUInt64LE(100n, VAULT_LAYOUT.SPENT_TODAY_OFFSET);
    buf.writeBigUInt64LE(20_000n, VAULT_LAYOUT.LAST_SPEND_DAY_OFFSET);
    buf.writeBigUInt64LE(1_000n, VAULT_LAYOUT.POLICY_PER_TX_LIMIT_OFFSET);
    buf.writeBigUInt64LE(5_000n, VAULT_LAYOUT.DAILY_LIMIT_OFFSET);

    const fakeRpc = {
      getAccountInfo: (_addr: unknown, _opts: unknown) => ({
        send: async () => {
          rpcCalls++;
          return {
            value: {
              data: [buf.toString("base64"), "base64"] as [string, string],
            },
          };
        },
      }),
    };

    const now = 1_000_000;
    // First fetch — populates cache.
    const s1 = await fetchVaultState(
      fakeRpc as unknown as Parameters<typeof fetchVaultState>[0],
      FIXED_VAULT as unknown as Parameters<typeof fetchVaultState>[1],
      now,
    );
    assert.equal(rpcCalls, 1);
    assert.equal(s1.spentTodayLamports, 100n);

    // Second fetch within TTL — cache hit, no RPC call.
    const s2 = await fetchVaultState(
      fakeRpc as unknown as Parameters<typeof fetchVaultState>[0],
      FIXED_VAULT as unknown as Parameters<typeof fetchVaultState>[1],
      now + 1000,
    );
    assert.equal(rpcCalls, 1);
    assert.equal(s2.spentTodayLamports, 100n);

    // Invalidate the entry — next fetch goes to RPC.
    invalidateVaultStateCache(
      FIXED_VAULT as unknown as Parameters<typeof invalidateVaultStateCache>[0],
    );

    const s3 = await fetchVaultState(
      fakeRpc as unknown as Parameters<typeof fetchVaultState>[0],
      FIXED_VAULT as unknown as Parameters<typeof fetchVaultState>[1],
      now + 2000,
    );
    assert.equal(rpcCalls, 2, "invalidation must force a re-fetch");
    assert.equal(s3.spentTodayLamports, 100n);
  });

  it("invalidateVaultStateCache is idempotent on missing keys", () => {
    __resetVaultStateCacheForTests();
    assert.doesNotThrow(() =>
      invalidateVaultStateCache(
        "nonexistent" as unknown as Parameters<typeof invalidateVaultStateCache>[0],
      ),
    );
  });
});
