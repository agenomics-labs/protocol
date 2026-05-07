// Surface 2 — `pay_x402_service` MCP tool unit tests (SCAFFOLD).
//
// These tests pin the IC-3 contract surface (docs/aep-reflex-tech-spec.md
// lines 109–137) against the stub handler. They do NOT exercise the real
// x402 client or CDP wallet — that's the Day 3–7 owner's job. Coverage:
//   1. Registration: tool / action / router all wired
//   2. Schema: missing `reasoning` rejected
//   3. Schema: empty `reasoning` rejected
//   4. Schema: non-URL `service_url` rejected
//   5. Schema: http:// `service_url` rejected (https-only)
//   6. Schema: https:// `service_url` accepted (positive control)
//   7. Schema: non-base58 `agent_address` rejected
//   8. Domain: `max_price` over per-tx-limit → EXCEEDS_VAULT_PER_TX_LIMIT
//   9. Domain: `max_price` over daily-limit (but ≤ per-tx) →
//      EXCEEDS_VAULT_DAILY_LIMIT
//  10. Happy path: returns structurally-valid IC-3 response
//  11. Direct-call (`payX402Service`) throws ToolError on per-tx breach
//
// All tests are mocked — no network, no Solana RPC, no CDP.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { allTools } from "../../src/tools/index.js";
import { actionRouter } from "../../src/index.js";
import { pilotActions } from "../../src/actions/index.js";
import {
  payX402ServiceAction,
  payX402Service,
  ToolError,
  STUB_PER_TX_LIMIT_MICROS,
  STUB_DAILY_LIMIT_MICROS,
} from "../../src/actions/pay-x402-service.js";
import type { ActionContext } from "../../src/types/action.js";
import type { Capability } from "../../src/types/capability.js";

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

const VALID_AGENT = "11111111111111111111111111111111";
const VALID_URL = "https://bazaar.example.com/v1/inference";
const VALID_REASONING = "Need inference for user task; price within budget.";
const VALID_REQUEST = { method: "POST" as const, body: '{"prompt":"hi"}' };

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_address: VALID_AGENT,
    service_url: VALID_URL,
    max_price_usdc_micros: 1_000_000, // 1 USDC, well under per-tx cap
    request: VALID_REQUEST,
    reasoning: VALID_REASONING,
    ...overrides,
  };
}

describe("Surface 2 pay_x402_service (scaffold)", () => {
  describe("registration (router / tools / actions)", () => {
    it("is registered as an action", () => {
      const action = pilotActions.find((a) => a.name === "pay_x402_service");
      assert.ok(action, "pay_x402_service should be in pilotActions");
    });

    it("is registered as a tool", () => {
      assert.ok(
        allTools.some((t) => t.name === "pay_x402_service"),
        "pay_x402_service should be in allTools",
      );
    });

    it("is wired into the ADR-058 router", () => {
      assert.ok(
        actionRouter.names().includes("pay_x402_service"),
        "pay_x402_service should be wired into the router",
      );
    });

    it("brings the total tool count to 28", () => {
      assert.equal(allTools.length, 28);
    });

    it("declares the pay:x402 capability (write/spend claim)", () => {
      // Distinct from `read:vault` — this is a write-side action that will
      // (Day 3) debit the on-chain vault and settle on Base. See
      // `types/capability.ts` `X402Claim` + the SECURITY: comment in
      // `pay-x402-service.ts` near `requiresSigner`.
      assert.deepEqual(payX402ServiceAction.capabilities, ["pay:x402"]);
    });
  });

  describe("schema validation (IC-3 contract)", () => {
    it("rejects missing `reasoning` with INVALID_INPUT", async () => {
      const ctx = ctxWith(["pay:x402"]);
      const input = validInput();
      delete (input as Record<string, unknown>).reasoning;
      const result = await actionRouter.dispatch(
        "pay_x402_service",
        input,
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_INPUT");
      }
    });

    it("rejects empty `reasoning` with INVALID_INPUT (spec line 136)", async () => {
      const ctx = ctxWith(["pay:x402"]);
      const result = await actionRouter.dispatch(
        "pay_x402_service",
        validInput({ reasoning: "" }),
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_INPUT");
      }
    });

    it("rejects non-URL `service_url` with INVALID_INPUT", async () => {
      const ctx = ctxWith(["pay:x402"]);
      const result = await actionRouter.dispatch(
        "pay_x402_service",
        validInput({ service_url: "not a url" }),
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_INPUT");
      }
    });

    it("rejects http:// `service_url` with INVALID_INPUT (https-only)", async () => {
      // x402 settlement carries credential material; plain HTTP would
      // expose it to a passive MITM. Schema enforces https://.
      const ctx = ctxWith(["pay:x402"]);
      const result = await actionRouter.dispatch(
        "pay_x402_service",
        validInput({ service_url: "http://bazaar.example.com/v1/inference" }),
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_INPUT");
      }
    });

    it("accepts https:// `service_url` (positive control)", async () => {
      const ctx = ctxWith(["pay:x402"]);
      const result = await actionRouter.dispatch(
        "pay_x402_service",
        validInput({ service_url: "https://api.example.com/v1/inference" }),
        ctx,
      );
      assert.equal(
        result.ok,
        true,
        result.ok ? "" : `dispatch failed: ${JSON.stringify(result.error)}`,
      );
    });

    it("rejects non-base58 `agent_address` with INVALID_INPUT", async () => {
      const ctx = ctxWith(["pay:x402"]);
      const result = await actionRouter.dispatch(
        "pay_x402_service",
        validInput({ agent_address: "!".repeat(40) }),
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_INPUT");
      }
    });

    it("rejects unsupported HTTP method with INVALID_INPUT", async () => {
      const ctx = ctxWith(["pay:x402"]);
      const result = await actionRouter.dispatch(
        "pay_x402_service",
        validInput({ request: { method: "DELETE" } }),
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_INPUT");
      }
    });
  });

  describe("error-handling table (spec lines 286–296)", () => {
    it("rejects max_price > per-tx-limit with EXCEEDS_VAULT_PER_TX_LIMIT", async () => {
      const ctx = ctxWith(["pay:x402"]);
      const result = await actionRouter.dispatch(
        "pay_x402_service",
        validInput({ max_price_usdc_micros: STUB_PER_TX_LIMIT_MICROS + 1 }),
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        // Domain error is surfaced via details.tool_error (see action handler
        // comments + spec ambiguity note). The router-level code is
        // INVALID_INPUT until ADR-058's AepErrorCode union grows Surface-2
        // codes.
        assert.equal(result.error.code, "INVALID_INPUT");
        const details = result.error.details as
          | { tool_error?: string }
          | undefined;
        assert.equal(details?.tool_error, "EXCEEDS_VAULT_PER_TX_LIMIT");
      }
    });

    it("rejects max_price > daily-limit (but ≤ per-tx) with EXCEEDS_VAULT_DAILY_LIMIT", async () => {
      // Pre-condition this test relies on: daily cap is strictly tighter
      // than per-tx cap, so an input in (daily, per-tx] reaches the daily
      // branch without short-circuiting on per-tx first. Asserting it
      // here makes the test self-documenting if someone retunes the stubs.
      assert.ok(
        STUB_DAILY_LIMIT_MICROS < STUB_PER_TX_LIMIT_MICROS,
        "daily cap must be tighter than per-tx cap for this case to be reachable",
      );
      const overDaily = STUB_DAILY_LIMIT_MICROS + 1;
      assert.ok(
        overDaily <= STUB_PER_TX_LIMIT_MICROS,
        "test input must not also breach per-tx",
      );
      const ctx = ctxWith(["pay:x402"]);
      const result = await actionRouter.dispatch(
        "pay_x402_service",
        validInput({ max_price_usdc_micros: overDaily }),
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_INPUT");
        const details = result.error.details as
          | { tool_error?: string }
          | undefined;
        assert.equal(details?.tool_error, "EXCEEDS_VAULT_DAILY_LIMIT");
      }
    });

    it("direct call to payX402Service throws ToolError on per-tx breach", async () => {
      await assert.rejects(
        async () =>
          payX402Service({
            agent_address: VALID_AGENT,
            service_url: VALID_URL,
            max_price_usdc_micros: STUB_PER_TX_LIMIT_MICROS + 1,
            request: VALID_REQUEST,
            reasoning: VALID_REASONING,
          }),
        (e: unknown) => {
          assert.ok(e instanceof ToolError);
          assert.equal(
            (e as ToolError).code,
            "EXCEEDS_VAULT_PER_TX_LIMIT",
          );
          return true;
        },
      );
    });
  });

  describe("happy path (deterministic stub IC-3 response)", () => {
    it("returns a structurally-valid IC-3 response", async () => {
      const ctx = ctxWith(["pay:x402"]);
      const result = await actionRouter.dispatch(
        "pay_x402_service",
        validInput(),
        ctx,
      );
      assert.equal(
        result.ok,
        true,
        result.ok ? "" : `dispatch failed: ${JSON.stringify(result.error)}`,
      );
      if (result.ok) {
        const v = result.value as {
          status: number;
          body: string;
          payment: {
            tx_hash: string;
            amount_paid_micros: number;
            network: string;
            facilitator: string;
          };
          duration_ms: number;
          decision_record_id: string;
        };
        assert.equal(typeof v.status, "number");
        assert.equal(typeof v.body, "string");
        assert.equal(typeof v.payment.tx_hash, "string");
        assert.ok(v.payment.tx_hash.startsWith("0x"));
        assert.ok(["base-mainnet", "base-sepolia"].includes(v.payment.network));
        assert.ok(["cdp", "kora"].includes(v.payment.facilitator));
        assert.equal(typeof v.duration_ms, "number");
        assert.ok(v.duration_ms >= 0);
        assert.equal(typeof v.decision_record_id, "string");
        assert.ok(v.decision_record_id.length > 0);
      }
    });

    it("happy-path body echoes the requested service_url + method (stub determinism check)", async () => {
      const ctx = ctxWith(["pay:x402"]);
      const result = await actionRouter.dispatch(
        "pay_x402_service",
        validInput(),
        ctx,
      );
      assert.equal(result.ok, true);
      if (result.ok) {
        const v = result.value as { body: string };
        const parsed = JSON.parse(v.body);
        assert.equal(parsed.service_url, VALID_URL);
        assert.equal(parsed.method, "POST");
        assert.equal(parsed.stub, true);
      }
    });
  });
});
