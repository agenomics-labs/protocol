/**
 * ADR-124 (AUD-116 path-a) — schema + capability tests for the
 * `create_vault` MCP action's new `agentIdentitySecretKey` parameter.
 *
 * Roadmap §3 B1 specifies the mcp-server tool/action wiring must validate
 * the agent_identity proof-of-control input shape at the boundary, before
 * the handler fans out to RPC. These tests pin:
 *
 *   1. **Action / tool registration** — the action is reachable via the
 *      router and the tool is exposed in `allTools`.
 *   2. **Schema** — `agentIdentitySecretKey` is optional (omitting it
 *      routes to the self-bind flow); when supplied, both the base58
 *      string shape and the `number[64]` array shape are accepted; common
 *      malformed inputs (wrong-length array, non-byte values) are
 *      rejected with INVALID_INPUT.
 *   3. **Capability gate** — `sign:vault` is the canonical claim, and
 *      passthrough mode rejects.
 *
 * The handler's RPC path is intentionally NOT exercised — the test
 * harness has no wallet/RPC and `wrap()` would surface the missing
 * environment as PROGRAM_ERROR. We pin the schema gate fires BEFORE the
 * handler runs.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { allTools } from "../src/tools/index.js";
import { actionRouter } from "../src/index.js";
import { pilotActions } from "../src/actions/index.js";
import { createVaultAction } from "../src/actions/vault.js";
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
 * Generate a syntactically-valid base58-encoded 64-byte secret key for a
 * fresh ed25519 keypair. Used to exercise the schema's "happy path"
 * branch: a real Solana secret key passes the length / charset checks and
 * the schema does not reject before the handler runs.
 */
function freshAgentIdentityBase58(): { pubkey: string; secret: string } {
  const kp = Keypair.generate();
  return {
    pubkey: kp.publicKey.toBase58(),
    secret: bs58.encode(kp.secretKey),
  };
}

describe("ADR-124 / AUD-116 (path-a): create_vault agent_identity proof-of-control", () => {
  describe("registration (router / tools / actions)", () => {
    it("is registered as an action", () => {
      const action = pilotActions.find((a) => a.name === "create_vault");
      assert.ok(action, "create_vault should be in pilotActions");
    });

    it("is registered as a tool", () => {
      assert.ok(
        allTools.some((t) => t.name === "create_vault"),
        "create_vault should be in allTools",
      );
    });

    it("is wired into the ADR-058 router", () => {
      assert.ok(
        actionRouter.names().includes("create_vault"),
        "create_vault should be wired into the router",
      );
    });
  });

  describe("action shape", () => {
    it("declares the canonical sign:vault capability", () => {
      assert.deepEqual(createVaultAction.capabilities, ["sign:vault"]);
    });

    it("is non-readOnly and requires a signer", () => {
      assert.equal(createVaultAction.readOnly, false);
      assert.equal(createVaultAction.requiresSigner, true);
    });

    it("declares the cluster_health + account_rent_exempt preflight gates", () => {
      assert.deepEqual(createVaultAction.preflight, [
        "cluster_health",
        "account_rent_exempt",
      ]);
    });

    it("description references ADR-124 / AUD-116 path-a so operators see the new flow in `tools/list`", () => {
      assert.match(createVaultAction.description, /ADR-124/);
      assert.match(createVaultAction.description, /AUD-116/);
      assert.match(createVaultAction.description, /agentIdentitySecretKey/);
    });
  });

  describe("schema-level agentIdentitySecretKey validation", () => {
    // Common non-secret-key fields used across the schema tests. The
    // handler's RPC path will fail (no wallet) but the schema gate must
    // accept these as syntactically valid.
    const baseInput = {
      agentIdentity: ZERO_PUBKEY.toBase58(),
      dailyLimitSol: 1,
      perTxLimitSol: 0.5,
      maxTxsPerHour: 10,
    };

    it("accepts input WITHOUT agentIdentitySecretKey (self-bind flow)", async () => {
      const ctx = ctxWith(["sign:vault"]);
      const result = await actionRouter.dispatch(
        "create_vault",
        baseInput,
        ctx,
      );
      // Schema accepts → either ok (impossible without a wallet) or
      // PROGRAM_ERROR from the handler. We only pin "did not trip
      // INVALID_INPUT" — schema is the boundary under test.
      if (!result.ok) {
        assert.notEqual(
          result.error.code,
          "INVALID_INPUT",
          `expected schema to accept self-bind flow, got INVALID_INPUT: ${JSON.stringify(result.error)}`,
        );
      }
    });

    it("accepts agentIdentitySecretKey as a base58-encoded 64-byte secret key", async () => {
      const { pubkey, secret } = freshAgentIdentityBase58();
      const ctx = ctxWith(["sign:vault"]);
      const result = await actionRouter.dispatch(
        "create_vault",
        { ...baseInput, agentIdentity: pubkey, agentIdentitySecretKey: secret },
        ctx,
      );
      if (!result.ok) {
        assert.notEqual(result.error.code, "INVALID_INPUT");
      }
    });

    it("accepts agentIdentitySecretKey as a number[64] array", async () => {
      const kp = Keypair.generate();
      const ctx = ctxWith(["sign:vault"]);
      const result = await actionRouter.dispatch(
        "create_vault",
        {
          ...baseInput,
          agentIdentity: kp.publicKey.toBase58(),
          agentIdentitySecretKey: Array.from(kp.secretKey),
        },
        ctx,
      );
      if (!result.ok) {
        assert.notEqual(result.error.code, "INVALID_INPUT");
      }
    });

    it("rejects agentIdentitySecretKey when the array has the wrong length", async () => {
      const ctx = ctxWith(["sign:vault"]);
      const result = await actionRouter.dispatch(
        "create_vault",
        {
          ...baseInput,
          agentIdentitySecretKey: new Array(63).fill(0),
        },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_INPUT");
      }
    });

    it("rejects agentIdentitySecretKey when array entries are not byte values (>255)", async () => {
      const ctx = ctxWith(["sign:vault"]);
      const overflowing = new Array(64).fill(256);
      const result = await actionRouter.dispatch(
        "create_vault",
        { ...baseInput, agentIdentitySecretKey: overflowing },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_INPUT");
      }
    });

    it("rejects agentIdentitySecretKey when array entries are negative", async () => {
      const ctx = ctxWith(["sign:vault"]);
      const negatives = new Array(64).fill(-1);
      const result = await actionRouter.dispatch(
        "create_vault",
        { ...baseInput, agentIdentitySecretKey: negatives },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_INPUT");
      }
    });

    it("rejects agentIdentitySecretKey when array entries are non-integer floats", async () => {
      const ctx = ctxWith(["sign:vault"]);
      const floats = new Array(64).fill(1.5);
      const result = await actionRouter.dispatch(
        "create_vault",
        { ...baseInput, agentIdentitySecretKey: floats },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_INPUT");
      }
    });

    it("rejects agentIdentitySecretKey when string is too short for a base58 64-byte secret", async () => {
      const ctx = ctxWith(["sign:vault"]);
      const result = await actionRouter.dispatch(
        "create_vault",
        { ...baseInput, agentIdentitySecretKey: "tooshort" },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_INPUT");
      }
    });
  });

  describe("capability gate", () => {
    it("rejects when the sign:vault capability is missing", async () => {
      const ctx = ctxWith([]); // empty caps
      const result = await actionRouter.dispatch(
        "create_vault",
        {
          agentIdentity: ZERO_PUBKEY.toBase58(),
          dailyLimitSol: 1,
          perTxLimitSol: 0.5,
          maxTxsPerHour: 10,
        },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "CAPABILITY_MISSING");
      }
    });

    it("rejects under passthrough signing mode", async () => {
      const ctx = ctxWith(["sign:vault"], "passthrough");
      const result = await actionRouter.dispatch(
        "create_vault",
        {
          agentIdentity: ZERO_PUBKEY.toBase58(),
          dailyLimitSol: 1,
          perTxLimitSol: 0.5,
          maxTxsPerHour: 10,
        },
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        // Either SIGNER_UNAVAILABLE (the canonical passthrough rejection)
        // or CAPABILITY_MISSING — both are acceptable rejection codes.
        assert.ok(
          ["SIGNER_UNAVAILABLE", "CAPABILITY_MISSING"].includes(
            result.error.code,
          ),
          `expected passthrough rejection, got ${result.error.code}`,
        );
      }
    });
  });
});
