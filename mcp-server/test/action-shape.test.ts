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
    it("exposes all 29 existing tool names", () => {
      const names = allTools.map((t) => t.name).sort();
      assert.equal(names.length, 29);
      assert.ok(names.includes("create_vault"));
      assert.ok(names.includes("register_agent"));
      assert.ok(names.includes("create_escrow"));
      assert.ok(names.includes("get_agent_reputation"));
      // AUD-015 / PR-U: rotate_agent_identity wraps ADR-069's
      // update_agent_identity ix; tool count 24 → 25.
      assert.ok(names.includes("rotate_agent_identity"));
      // AUD-206 (cycle-3, roadmap §3 B2): verify_protocol_invariants
      // wraps the Registry batch-sweep ix; tool count 25 → 26.
      assert.ok(names.includes("verify_protocol_invariants"));
      // ADR-129 Phase 1 (cycle-3): find_similar_agents wraps the EVO L1
      // HNSW manifest-similarity primitive; tool count 26 → 27.
      assert.ok(names.includes("find_similar_agents"));
      // Surface 2 (scaffold/stub): pay_x402_service wraps the x402 payment
      // relay (debits vault, settles via CDP on Base). Tool count 27 → 28.
      // See docs/aep-reflex-tech-spec.md §"Surface 2".
      assert.ok(names.includes("pay_x402_service"));
      // ADR-138 (cycle-4): query_execution_history exposes the off-chain
      // indexer's execution-provenance projection. Tool count 28 → 29.
      assert.ok(names.includes("query_execution_history"));
      // ADR-111 (cycle-4): on-chain delegation grants landed in
      // programs/agent-vault/. The MCP tool surface (7 delegation tools)
      // is intentionally deferred to a follow-up PR that adds matching
      // handlers + action wrappers; only the on-chain primitive ships
      // in this iteration. Tool count stays at 29 until that follow-up.
    });

    it("the ADR-058 router handles all 29 tools", () => {
      const allNames = new Set(allTools.map((t) => t.name));
      for (const routed of actionRouter.names()) {
        assert.ok(allNames.has(routed), `routed action '${routed}' missing from allTools`);
      }
      assert.equal(pilotActionNames.size, 29);
      assert.deepEqual(actionRouter.names().sort(), [...allNames].sort());
    });
  });

  describe("readOnly action shape (PR1.5 + get_agent_reputation)", () => {
    it("all 5 read actions declare readOnly:true + empty capabilities[]", () => {
      const readOnlyNames = new Set([
        "get_vault_info",
        "get_agent_profile",
        "discover_agents",
        "get_escrow_status",
        "get_agent_reputation",
      ]);
      const readOnly = pilotActions.filter((a) => readOnlyNames.has(a.name));
      assert.equal(readOnly.length, 5, "expected 5 readOnly actions");
      for (const a of readOnly) {
        assert.equal(a.readOnly, true, `${a.name} should be readOnly:true`);
        assert.equal(a.capabilities.length, 0, `${a.name} should have empty capabilities[]`);
        assert.ok(!a.requiresSigner, `${a.name} should not require signer`);
      }
    });

    it("get_agent_reputation is registered and bypasses the capability gate", async () => {
      const action = pilotActions.find((a) => a.name === "get_agent_reputation");
      assert.ok(action, "get_agent_reputation should be in pilotActions");
      assert.equal(action!.readOnly, true);
      assert.equal(action!.capabilities.length, 0);
      assert.ok(!action!.requiresSigner);
      assert.ok(actionRouter.names().includes("get_agent_reputation"));

      // Dispatch with a zero-capability wallet. Input is zod-valid
      // (agentAddress is optional), so we must get past the gate and
      // into the handler. The handler then fails because no RPC /
      // keypair is configured in-process — `wrap()` surfaces that as
      // PROGRAM_ERROR. The point of this assertion is that we see
      // anything OTHER than CAPABILITY_MISSING / SIGNER_UNAVAILABLE /
      // INVALID_INPUT, which would indicate the gate is misconfigured.
      const ctx = ctxWith([]);
      const result = await actionRouter.dispatch(
        "get_agent_reputation",
        {},
        ctx,
      );
      if (!result.ok) {
        assert.notEqual(result.error.code, "CAPABILITY_MISSING");
        assert.notEqual(result.error.code, "SIGNER_UNAVAILABLE");
        assert.notEqual(result.error.code, "INVALID_INPUT");
      }
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

  // ========================================================================
  // AUD-015 / PR-U: rotate_agent_identity wraps ADR-069's
  // `update_agent_identity` instruction. The on-chain ix already shipped;
  // this tool surfaces it through the standard MCP interface so off-chain
  // operators can rotate the vault hot key without bespoke tooling.
  // ========================================================================
  describe("rotate_agent_identity (ADR-069 / AUD-015)", () => {
    it("is registered in actions, tools, and the router", () => {
      const action = pilotActions.find((a) => a.name === "rotate_agent_identity");
      assert.ok(action, "rotate_agent_identity should be in pilotActions");
      assert.ok(
        allTools.some((t) => t.name === "rotate_agent_identity"),
        "rotate_agent_identity should be in allTools",
      );
      assert.ok(
        actionRouter.names().includes("rotate_agent_identity"),
        "rotate_agent_identity should be wired into the router",
      );
    });

    it("declares the canonical sign:vault capability and authority signer", () => {
      const action = pilotActions.find((a) => a.name === "rotate_agent_identity");
      assert.ok(action);
      // Reuses the existing `sign:vault` capability — no new taxonomy entry
      // is introduced (cross-checked against ALL_CAPABILITIES in src/index.ts).
      assert.deepEqual(action!.capabilities, ["sign:vault"]);
      assert.equal(action!.requiresSigner, true);
      assert.equal(action!.readOnly, false);
      // Cluster-health gate matches the sibling key-rotation-style updates
      // (`update_vault_policy`); on-chain has_one + signer enforcement is
      // the authoritative gate, which is why no rent-exempt or daily-cap
      // gate is declared.
      assert.deepEqual(action!.preflight, ["cluster_health"]);
    });

    describe("input schema (AUD-015 base58 validation)", () => {
      it("rejects a missing newAgentIdentity", async () => {
        const ctx = ctxWith(["sign:vault"]);
        const result = await actionRouter.dispatch(
          "rotate_agent_identity",
          {},
          ctx,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
      });

      it("rejects a non-string newAgentIdentity", async () => {
        const ctx = ctxWith(["sign:vault"]);
        const result = await actionRouter.dispatch(
          "rotate_agent_identity",
          { newAgentIdentity: 12345 },
          ctx,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
      });

      it("rejects a non-base58 newAgentIdentity", async () => {
        const ctx = ctxWith(["sign:vault"]);
        const result = await actionRouter.dispatch(
          "rotate_agent_identity",
          { newAgentIdentity: "not-a-pubkey!!!" },
          ctx,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
      });

      it("rejects a too-short string that fails base58 pubkey decoding", async () => {
        const ctx = ctxWith(["sign:vault"]);
        const result = await actionRouter.dispatch(
          "rotate_agent_identity",
          { newAgentIdentity: "abc" },
          ctx,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
      });

      // AUD-210 (cycle-2): pin the `.refine(isValidPublicKey)` arm. The
      // earlier "non-base58" and "too-short" cases above both fail
      // `min(32)` first and never execute the refine. A 40-char string
      // of all-`!` characters passes min(32) but is not valid base58
      // and must fail at the refine. This test guards against a future
      // change that drops the refine relying on min(32) alone.
      it("rejects a 40-char non-base58 string at the .refine arm", async () => {
        const ctx = ctxWith(["sign:vault"]);
        const result = await actionRouter.dispatch(
          "rotate_agent_identity",
          { newAgentIdentity: "!".repeat(40) },
          ctx,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
      });

      it("accepts a valid base58 pubkey and passes the input gate", async () => {
        // Schema-valid input must clear the input gate. The handler then
        // attempts an RPC call and fails because no wallet/RPC is wired in
        // the unit-test harness — `wrap()` surfaces that as PROGRAM_ERROR.
        // The point of this assertion is that we did NOT trip on
        // INVALID_INPUT or CAPABILITY_MISSING — the schema and gate are
        // correctly wired.
        const ctx = ctxWith(["sign:vault"]);
        const result = await actionRouter.dispatch(
          "rotate_agent_identity",
          { newAgentIdentity: ZERO_PUBKEY.toBase58() },
          ctx,
        );
        if (!result.ok) {
          assert.notEqual(result.error.code, "INVALID_INPUT");
          assert.notEqual(result.error.code, "CAPABILITY_MISSING");
          assert.notEqual(result.error.code, "SIGNER_UNAVAILABLE");
        }
      });
    });

    describe("capability gating (ADR-058 §4)", () => {
      it("rejects when the wallet lacks sign:vault", async () => {
        const ctx = ctxWith([]);
        const result = await actionRouter.dispatch(
          "rotate_agent_identity",
          { newAgentIdentity: ZERO_PUBKEY.toBase58() },
          ctx,
        );
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error.code, "CAPABILITY_MISSING");
          const missing = (result.error.details as any).missing;
          assert.ok(missing.includes("sign:vault"));
        }
      });
    });

    describe("signer-mode assertion (ADR-058 §5)", () => {
      it("rejects under passthrough mode", async () => {
        const ctx = ctxWith(["sign:vault"], "passthrough");
        const result = await actionRouter.dispatch(
          "rotate_agent_identity",
          { newAgentIdentity: ZERO_PUBKEY.toBase58() },
          ctx,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "SIGNER_UNAVAILABLE");
      });
    });
  });
});
