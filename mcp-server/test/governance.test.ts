// AUD-206 (cycle-3, roadmap §3 B2): unit tests for the
// `verify_protocol_invariants` MCP tool.
//
// Coverage targets (per the AUD-206 task spec):
//   1. Schema rejects batch > MAX_INVARIANT_BATCH (16) — INVALID_INPUT
//   2. Schema rejects batch of 0 accounts — INVALID_INPUT
//   3. Schema accepts the boundary case (exactly 16 accounts)
//   4. Schema rejects malformed (non-base58) account entries
//   5. Capability gate rejects when `gov:invariant:check` is absent
//   6. Capability gate rejects under passthrough signing mode
//   7. Action declares the canonical `gov:invariant:check` claim and is
//      registered in actions / tools / router
//
// The handler's RPC path is intentionally NOT exercised here — the
// `wrap()` boundary surfaces missing wallet / RPC config as PROGRAM_ERROR,
// and the existing `loadwallet-permission.test.ts` already covers that
// failure mode for the surrounding handler family. The spec explicitly
// asks us NOT to require a live validator.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { allTools } from "../src/tools/index.js";
import { actionRouter } from "../src/index.js";
import { pilotActions } from "../src/actions/index.js";
import {
  verifyProtocolInvariantsAction,
  MAX_INVARIANT_BATCH,
} from "../src/actions/governance.js";
import type { ActionContext } from "../src/types/action.js";
import type { Capability } from "../src/types/capability.js";

const ZERO_PUBKEY = new PublicKey("11111111111111111111111111111111");

function ctxWith(
  caps: Capability[],
  mode: "signed" | "passthrough" = "signed",
): ActionContext {
  return {
    mode,
    wallet: { publicKey: ZERO_PUBKEY, capabilities: new Set(caps) },
    signer: mode === "signed" ? {} : null,
  };
}

/**
 * Generate `n` syntactically-valid (but otherwise distinct) base58 pubkeys
 * for the schema-boundary tests. We avoid `Keypair.generate()` to keep
 * the test deterministic and free of any sodium / wasm init cost.
 */
function nDistinctPubkeys(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const bytes = new Uint8Array(32);
    // Big-endian counter into the last 4 bytes is enough to make every
    // entry distinct without leaving the on-curve / off-curve domain
    // distinction undefined for the test corpus.
    bytes[28] = (i >>> 24) & 0xff;
    bytes[29] = (i >>> 16) & 0xff;
    bytes[30] = (i >>> 8) & 0xff;
    bytes[31] = i & 0xff;
    out.push(new PublicKey(bytes).toBase58());
  }
  return out;
}

describe("AUD-206 verify_protocol_invariants (governance)", () => {
  describe("registration (router / tools / actions)", () => {
    it("is registered as an action", () => {
      const action = pilotActions.find(
        (a) => a.name === "verify_protocol_invariants",
      );
      assert.ok(action, "verify_protocol_invariants should be in pilotActions");
    });

    it("is registered as a tool", () => {
      assert.ok(
        allTools.some((t) => t.name === "verify_protocol_invariants"),
        "verify_protocol_invariants should be in allTools",
      );
    });

    it("is wired into the ADR-058 router", () => {
      assert.ok(
        actionRouter.names().includes("verify_protocol_invariants"),
        "verify_protocol_invariants should be wired into the router",
      );
    });

    it("MAX_INVARIANT_BATCH constant is 16 (mirrors AUD-106 on-chain cap)", () => {
      assert.equal(MAX_INVARIANT_BATCH, 16);
    });
  });

  describe("action shape", () => {
    it("declares the canonical gov:invariant:check capability", () => {
      assert.deepEqual(verifyProtocolInvariantsAction.capabilities, [
        "gov:invariant:check",
      ]);
    });

    it("is non-readOnly and requires a signer", () => {
      assert.equal(verifyProtocolInvariantsAction.readOnly, false);
      assert.equal(verifyProtocolInvariantsAction.requiresSigner, true);
    });

    it("declares the cluster_health preflight gate", () => {
      assert.deepEqual(verifyProtocolInvariantsAction.preflight, [
        "cluster_health",
      ]);
    });

    it("is not idempotent (sweep is read-only on-chain; no replay key)", () => {
      // The on-chain ix is a pure invariant check — re-running it is a
      // no-op (other than the tx fee), so no idempotency mutex is needed.
      assert.notEqual(verifyProtocolInvariantsAction.idempotent, true);
    });
  });

  describe("schema-level batch-cap enforcement (AUD-106)", () => {
    it("rejects an empty batch with INVALID_INPUT", async () => {
      const ctx = ctxWith(["gov:invariant:check"]);
      const result = await actionRouter.dispatch(
        "verify_protocol_invariants",
        { accounts: [] },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_INPUT");
      }
    });

    it(`rejects a batch larger than MAX_INVARIANT_BATCH (${MAX_INVARIANT_BATCH}) with INVALID_INPUT`, async () => {
      const ctx = ctxWith(["gov:invariant:check"]);
      const result = await actionRouter.dispatch(
        "verify_protocol_invariants",
        { accounts: nDistinctPubkeys(MAX_INVARIANT_BATCH + 1) },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_INPUT");
        // The zod issue should mention the cap so operators get an
        // actionable error without having to grep the on-chain message.
        const issues = (result.error.details as { issues: unknown[] }).issues;
        assert.ok(Array.isArray(issues) && issues.length > 0);
      }
    });

    it(`accepts the boundary batch of exactly MAX_INVARIANT_BATCH (${MAX_INVARIANT_BATCH}) accounts (does not trip INVALID_INPUT)`, async () => {
      // Schema-valid input must clear the input gate. The handler then
      // attempts an RPC call and fails because no wallet/RPC is wired in
      // the unit-test harness — `wrap()` surfaces that as PROGRAM_ERROR.
      // The point of this assertion is that we did NOT trip on
      // INVALID_INPUT — the schema is correctly tuned to allow exactly
      // MAX_INVARIANT_BATCH entries (the on-chain `<=` boundary).
      const ctx = ctxWith(["gov:invariant:check"]);
      const result = await actionRouter.dispatch(
        "verify_protocol_invariants",
        { accounts: nDistinctPubkeys(MAX_INVARIANT_BATCH) },
        ctx,
      );
      if (!result.ok) {
        assert.notEqual(result.error.code, "INVALID_INPUT");
        assert.notEqual(result.error.code, "CAPABILITY_MISSING");
        assert.notEqual(result.error.code, "SIGNER_UNAVAILABLE");
      }
    });

    it("rejects a missing accounts field with INVALID_INPUT", async () => {
      const ctx = ctxWith(["gov:invariant:check"]);
      const result = await actionRouter.dispatch(
        "verify_protocol_invariants",
        {},
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
    });

    it("rejects a non-base58 entry inside an otherwise-valid batch", async () => {
      const ctx = ctxWith(["gov:invariant:check"]);
      const accounts = nDistinctPubkeys(3);
      accounts[1] = "!".repeat(40); // 40-char string clears min(32) but fails the .refine arm
      const result = await actionRouter.dispatch(
        "verify_protocol_invariants",
        { accounts },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
    });

    it("rejects a too-short entry inside an otherwise-valid batch", async () => {
      const ctx = ctxWith(["gov:invariant:check"]);
      const accounts = nDistinctPubkeys(2);
      accounts[0] = "abc";
      const result = await actionRouter.dispatch(
        "verify_protocol_invariants",
        { accounts },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
    });
  });

  describe("capability gating (ADR-058 §4)", () => {
    it("rejects when the wallet has zero capabilities", async () => {
      const ctx = ctxWith([]);
      const result = await actionRouter.dispatch(
        "verify_protocol_invariants",
        { accounts: nDistinctPubkeys(1) },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "CAPABILITY_MISSING");
        const missing = (result.error.details as { missing: string[] }).missing;
        assert.ok(missing.includes("gov:invariant:check"));
      }
    });

    it("rejects when the wallet holds unrelated admin claims", async () => {
      // admin:registry alone is not enough — gov:invariant:check is the
      // dedicated claim for protocol-wide governance ops (see roadmap §3 B2).
      const ctx = ctxWith(["admin:registry", "admin:settlement", "admin:vault"]);
      const result = await actionRouter.dispatch(
        "verify_protocol_invariants",
        { accounts: nDistinctPubkeys(1) },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "CAPABILITY_MISSING");
        const missing = (result.error.details as { missing: string[] }).missing;
        assert.ok(missing.includes("gov:invariant:check"));
      }
    });
  });

  describe("signer-mode assertion (ADR-058 §5)", () => {
    it("rejects under passthrough mode even with the right capability", async () => {
      const ctx = ctxWith(["gov:invariant:check"], "passthrough");
      const result = await actionRouter.dispatch(
        "verify_protocol_invariants",
        { accounts: nDistinctPubkeys(1) },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "SIGNER_UNAVAILABLE");
    });
  });

  describe("tool descriptor (JSON schema for MCP clients)", () => {
    it("publishes minItems=1 and maxItems=16 on the accounts array", () => {
      const tool = allTools.find((t) => t.name === "verify_protocol_invariants");
      assert.ok(tool);
      const schema = tool!.inputSchema as {
        properties: { accounts: { minItems?: number; maxItems?: number } };
        required?: string[];
      };
      assert.equal(schema.properties.accounts.minItems, 1);
      assert.equal(schema.properties.accounts.maxItems, MAX_INVARIANT_BATCH);
      assert.ok(schema.required?.includes("accounts"));
    });
  });
});
