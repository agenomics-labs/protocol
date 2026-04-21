// PR1 (ADR-058) — non-breaking tool-set snapshot + capability-denial tests.
//
// Runs under Node's built-in test runner (`node:test`) via `tsx` — avoids the
// mocha-11 / chai-v6 ESM loader collision that would break `.js`-extension
// imports in the src tree. The existing mocha integration test is untouched.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { allTools } from "../src/tools/index.js";
import { actionRouter } from "../src/index.js";
import { pilotActionNames, pilotActions } from "../src/actions/index.js";
import { createActionRouter } from "../src/adapters/mcp.js";
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

describe("ADR-058 Action pipeline", () => {
  describe("non-breaking tool set (ADR-058 §8)", () => {
    it("exposes all 23 existing tool names", () => {
      const names = allTools.map((t) => t.name).sort();
      assert.equal(names.length, 23);
      assert.ok(names.includes("create_vault"));
      assert.ok(names.includes("register_agent"));
      assert.ok(names.includes("create_escrow"));
    });

    it("pilot actions (5) are a subset of the existing tool names", () => {
      const allNames = new Set(allTools.map((t) => t.name));
      for (const pilot of pilotActionNames) {
        assert.ok(
          allNames.has(pilot),
          `pilot action '${pilot}' missing from allTools`,
        );
      }
      assert.equal(pilotActionNames.size, 5);
    });

    it("the ADR-058 router handles exactly the pilot action set", () => {
      assert.deepEqual(actionRouter.names().sort(), [...pilotActionNames].sort());
    });
  });

  describe("default-deny capability gating (ADR-058 §4)", () => {
    it("rejects a call when the wallet has zero capabilities", async () => {
      const ctx = ctxWith([]);
      const result = await actionRouter.dispatch(
        "cancel_escrow",
        { escrowAddress: "11111111111111111111111111111111" },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "CAPABILITY_MISSING");
        const missing = (result.error.details as any).missing;
        assert.ok(missing.includes("sign:settlement"));
      }
    });

    it("rejects when the wallet has an unrelated capability", async () => {
      const ctx = ctxWith(["sign:vault"]);
      const result = await actionRouter.dispatch(
        "cancel_escrow",
        { escrowAddress: "11111111111111111111111111111111" },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "CAPABILITY_MISSING");
    });

    it("rejects admin actions when only sign:settlement is held", async () => {
      const ctx = ctxWith([
        "sign:settlement",
        "sign:cross_program:settlement+registry",
      ]);
      const result = await actionRouter.dispatch(
        "resolve_dispute",
        {
          escrowAddress: "11111111111111111111111111111111",
          clientRefundTokens: 0,
          providerPaymentTokens: 0,
          clientTokenAccount: "11111111111111111111111111111111",
          providerTokenAccount: "11111111111111111111111111111111",
        },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "CAPABILITY_MISSING");
        const missing = (result.error.details as any).missing;
        assert.ok(missing.includes("admin:settlement"));
      }
    });
  });

  describe("signer-mode assertion (ADR-058 §5)", () => {
    it("rejects requiresSigner actions under passthrough mode", async () => {
      const ctx = ctxWith(["sign:vault"], "passthrough");
      const result = await actionRouter.dispatch(
        "vault_transfer",
        { recipientAddress: "11111111111111111111111111111111", amountSol: 0.1 },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "SIGNER_UNAVAILABLE");
    });
  });

  describe("input validation (INVALID_INPUT)", () => {
    it("rejects missing required fields", async () => {
      const ctx = ctxWith([]);
      const result = await actionRouter.dispatch("vault_transfer", {}, ctx);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
    });
  });

  describe("idempotency spec (ADR-059 §5)", () => {
    it("idempotent actions declare a pure-input keying function", () => {
      const idempotent = pilotActions.filter((a) => a.idempotent === true);
      assert.ok(idempotent.length > 0);
      for (const a of idempotent) {
        assert.equal(typeof a.idempotencyKey, "function", `action ${a.name}`);
      }
    });

    it("keying functions are deterministic on input", () => {
      const approveMilestone = pilotActions.find(
        (a) => a.name === "approve_milestone",
      );
      assert.ok(approveMilestone);
      const k1 = approveMilestone!.idempotencyKey!({
        escrowAddress: "ABC",
        milestoneIndex: 2,
        providerTokenAccount: "XYZ",
      });
      const k2 = approveMilestone!.idempotencyKey!({
        escrowAddress: "ABC",
        milestoneIndex: 2,
        providerTokenAccount: "XYZ",
      });
      assert.equal(k1, k2);
      assert.equal(k1, "ABC:2:approve");
    });
  });

  describe("registration-time invariants", () => {
    it("throws when a non-readOnly action declares empty capabilities[]", () => {
      assert.throws(
        () =>
          createActionRouter([
            {
              ...pilotActions[0],
              name: "broken_test_action",
              readOnly: false,
              capabilities: [],
            },
          ]),
        /default-deny/,
      );
    });

    it("throws when idempotent:true lacks idempotencyKey", () => {
      assert.throws(
        () =>
          createActionRouter([
            {
              ...pilotActions[0],
              name: "broken_test_idem",
              idempotent: true,
              idempotencyKey: undefined,
            },
          ]),
        /idempotencyKey/,
      );
    });
  });
});
