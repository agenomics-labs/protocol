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
  synthesizePaymentId,
} from "../../src/actions/pay-x402-service.js";
import {
  setX402CdpAdapter,
  type X402CdpAdapter,
  type X402CallRequest,
  type X402CallResult,
  parseQuoteFromJsonBody,
  parseQuoteFromWwwAuth,
} from "../../src/adapters/x402-cdp.js";
import {
  setAgentCoreMemory,
  type AgentCoreMemoryWriter,
  type CachedX402Receipt,
} from "../../src/adapters/agent-core-memory.js";
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

// ---------------------------------------------------------------------------
// Surface 2 follow-up tests — selectFullPolicy, payment_id idempotency,
// 402 pre-flight quote, 5xx-refund handling.
// ---------------------------------------------------------------------------

/**
 * In-memory `AgentCoreMemoryWriter` test stub. Does NOT touch EVO. The
 * idempotency cache is a Map; recordDecision returns a deterministic
 * "decision-test-…" id so the action handler's IC-3 contract is honored.
 */
class TestMemoryWriter implements AgentCoreMemoryWriter {
  public readonly idempotencyCache = new Map<string, CachedX402Receipt>();
  public recordDecisionCalls = 0;
  public pricingHistoryCalls = 0;

  async recordDecision(): Promise<string> {
    this.recordDecisionCalls++;
    return "decision-test-" + this.recordDecisionCalls;
  }
  async updatePricingHistory(): Promise<void> {
    this.pricingHistoryCalls++;
  }
  async getIdempotencyReceipt(
    payment_id: string,
  ): Promise<CachedX402Receipt | null> {
    return this.idempotencyCache.get(payment_id) ?? null;
  }
  async storeIdempotencyReceipt(
    payment_id: string,
    receipt: CachedX402Receipt,
  ): Promise<void> {
    this.idempotencyCache.set(payment_id, receipt);
  }
}

/**
 * In-memory `X402CdpAdapter` test stub. Records every call and returns a
 * caller-controlled response. Activated by setting `AEP_X402_LIVE=1` for
 * the duration of the test (so the action handler routes through
 * `callX402Live` which reads the injected adapter).
 */
class TestX402Adapter implements X402CdpAdapter {
  public calls: X402CallRequest[] = [];
  constructor(private readonly response: X402CallResult) {}
  async pay(request: X402CallRequest): Promise<X402CallResult> {
    this.calls.push(request);
    return this.response;
  }
}

function withLive<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.AEP_X402_LIVE;
  process.env.AEP_X402_LIVE = "1";
  return fn().finally(() => {
    if (prev === undefined) delete process.env.AEP_X402_LIVE;
    else process.env.AEP_X402_LIVE = prev;
  });
}

const FIXED_NONCE = "0123456789abcdef0123456789abcdef"; // 32-hex = 16 bytes

describe("Surface 2 — payment_id idempotency (spec error-table row 6)", () => {
  it("synthesizePaymentId is deterministic on (agent, url, method, max_price, nonce)", () => {
    const id1 = synthesizePaymentId({
      agent_address: VALID_AGENT,
      service_url: VALID_URL,
      method: "POST",
      max_price_usdc_micros: 1_000_000,
      nonce: FIXED_NONCE,
    });
    const id2 = synthesizePaymentId({
      agent_address: VALID_AGENT,
      service_url: VALID_URL,
      method: "POST",
      max_price_usdc_micros: 1_000_000,
      nonce: FIXED_NONCE,
    });
    assert.equal(id1, id2, "same inputs → same payment_id");
    assert.match(id1, /^[0-9a-f]{32}$/);
  });

  it("differs when ANY input changes", () => {
    const base = {
      agent_address: VALID_AGENT,
      service_url: VALID_URL,
      method: "POST",
      max_price_usdc_micros: 1_000_000,
      nonce: FIXED_NONCE,
    };
    const id0 = synthesizePaymentId(base);
    assert.notEqual(
      synthesizePaymentId({ ...base, agent_address: "22222222222222222222222222222222" }),
      id0,
    );
    assert.notEqual(
      synthesizePaymentId({ ...base, service_url: VALID_URL + "/v2" }),
      id0,
    );
    assert.notEqual(synthesizePaymentId({ ...base, method: "GET" }), id0);
    assert.notEqual(
      synthesizePaymentId({ ...base, max_price_usdc_micros: 2_000_000 }),
      id0,
    );
    assert.notEqual(
      synthesizePaymentId({ ...base, nonce: "ffffffffffffffffffffffffffffffff" }),
      id0,
    );
  });

  it("rejects malformed nonce with INVALID_INPUT (32-hex required)", async () => {
    const ctx = ctxWith(["pay:x402"]);
    const result = await actionRouter.dispatch(
      "pay_x402_service",
      validInput({ nonce: "not-hex" }),
      ctx,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "INVALID_INPUT");
    }
  });

  it("retry with same nonce returns CACHED receipt, does NOT re-pay", async () => {
    const memory = new TestMemoryWriter();
    setAgentCoreMemory(memory);
    const adapter = new TestX402Adapter({
      status: 200,
      body: '{"first":true}',
      payment: {
        tx_hash: "0xabc123" + "0".repeat(58),
        amount_paid_micros: 500_000,
        network: "base-sepolia",
        facilitator: "cdp",
      },
      duration_ms: 42,
    });
    setX402CdpAdapter(adapter);
    try {
      await withLive(async () => {
        const r1 = await payX402Service({
          agent_address: VALID_AGENT,
          service_url: VALID_URL,
          max_price_usdc_micros: 1_000_000,
          request: { method: "POST", body: "{}" },
          reasoning: VALID_REASONING,
          nonce: FIXED_NONCE,
        });
        const r2 = await payX402Service({
          agent_address: VALID_AGENT,
          service_url: VALID_URL,
          max_price_usdc_micros: 1_000_000,
          request: { method: "POST", body: "{}" },
          reasoning: VALID_REASONING,
          nonce: FIXED_NONCE,
        });
        assert.equal(adapter.calls.length, 1, "second call MUST hit cache, not re-pay");
        assert.equal(r1.payment.tx_hash, r2.payment.tx_hash);
        assert.equal(r2.body, '{"first":true}');
        assert.equal(memory.recordDecisionCalls, 1, "recordDecision only on first call");
      });
    } finally {
      setX402CdpAdapter(null);
      setAgentCoreMemory(null);
    }
  });

  it("different nonces → both calls fire (no false cache hit)", async () => {
    const memory = new TestMemoryWriter();
    setAgentCoreMemory(memory);
    const adapter = new TestX402Adapter({
      status: 200,
      body: "{}",
      payment: {
        tx_hash: "0x" + "1".repeat(64),
        amount_paid_micros: 100_000,
        network: "base-sepolia",
        facilitator: "cdp",
      },
      duration_ms: 1,
    });
    setX402CdpAdapter(adapter);
    try {
      await withLive(async () => {
        await payX402Service({
          agent_address: VALID_AGENT,
          service_url: VALID_URL,
          max_price_usdc_micros: 1_000_000,
          request: { method: "POST" },
          reasoning: VALID_REASONING,
          nonce: FIXED_NONCE,
        });
        await payX402Service({
          agent_address: VALID_AGENT,
          service_url: VALID_URL,
          max_price_usdc_micros: 1_000_000,
          request: { method: "POST" },
          reasoning: VALID_REASONING,
          nonce: "ffffffffffffffffffffffffffffffff",
        });
        assert.equal(adapter.calls.length, 2);
      });
    } finally {
      setX402CdpAdapter(null);
      setAgentCoreMemory(null);
    }
  });
});

describe("Surface 2 — 402 pre-flight quote parsers", () => {
  it("parseQuoteFromJsonBody extracts maxAmountRequired from accepts[0]", () => {
    const body = JSON.stringify({
      x402Version: 1,
      accepts: [
        { scheme: "exact", network: "base-sepolia", maxAmountRequired: "12345" },
      ],
    });
    assert.equal(parseQuoteFromJsonBody(body), 12345);
  });

  it("parseQuoteFromJsonBody returns null on unparseable JSON", () => {
    assert.equal(parseQuoteFromJsonBody("not json"), null);
    assert.equal(parseQuoteFromJsonBody(""), null);
    assert.equal(parseQuoteFromJsonBody("{}"), null);
    assert.equal(parseQuoteFromJsonBody('{"accepts":[]}'), null);
    assert.equal(
      parseQuoteFromJsonBody('{"accepts":[{"maxAmountRequired":"abc"}]}'),
      null,
    );
  });

  it("parseQuoteFromWwwAuth handles key=value form", () => {
    assert.equal(
      parseQuoteFromWwwAuth("x402 maxAmountRequired=999, scheme=exact"),
      999,
    );
    assert.equal(
      parseQuoteFromWwwAuth('x402 maxAmountRequired="1500"'),
      1500,
    );
  });

  it("parseQuoteFromWwwAuth handles JSON-after-keyword form", () => {
    assert.equal(
      parseQuoteFromWwwAuth(
        'x402 {"maxAmountRequired":"7000","scheme":"exact"}',
      ),
      7000,
    );
  });

  it("parseQuoteFromWwwAuth returns null when no maxAmountRequired", () => {
    assert.equal(parseQuoteFromWwwAuth(""), null);
    assert.equal(parseQuoteFromWwwAuth("x402 scheme=exact"), null);
    assert.equal(parseQuoteFromWwwAuth("Bearer realm=foo"), null);
  });
});

describe("Surface 2 — 5xx + refund handling (spec error-table row 5)", () => {
  it("upstream 503 with refund.requested → PROVIDER_5XX with refund_tx_hash", async () => {
    const memory = new TestMemoryWriter();
    setAgentCoreMemory(memory);
    const adapter = new TestX402Adapter({
      status: 503,
      body: "service unavailable",
      payment: {
        tx_hash: "0x" + "9".repeat(64),
        amount_paid_micros: 250_000,
        network: "base-sepolia",
        facilitator: "cdp",
      },
      duration_ms: 100,
      refund: {
        status: "requested",
        refund_tx_hash: "0x" + "f".repeat(64),
      },
    });
    setX402CdpAdapter(adapter);
    try {
      await withLive(async () => {
        await assert.rejects(
          () =>
            payX402Service({
              agent_address: VALID_AGENT,
              service_url: VALID_URL,
              max_price_usdc_micros: 1_000_000,
              request: { method: "POST" },
              reasoning: VALID_REASONING,
              nonce: FIXED_NONCE,
            }),
          (e: unknown) => {
            assert.ok(e instanceof ToolError, `not a ToolError: ${e}`);
            const te = e as ToolError;
            assert.equal(te.code, "PROVIDER_5XX");
            assert.equal(te.details?.upstream_status, 503);
            assert.equal(te.details?.refund_status, "requested");
            assert.equal(te.details?.refund_tx_hash, "0x" + "f".repeat(64));
            return true;
          },
        );
      });
    } finally {
      setX402CdpAdapter(null);
      setAgentCoreMemory(null);
    }
  });

  it("upstream 502 with refund.not_supported → PROVIDER_5XX with refund_status flag", async () => {
    const memory = new TestMemoryWriter();
    setAgentCoreMemory(memory);
    const adapter = new TestX402Adapter({
      status: 502,
      body: "bad gateway",
      payment: {
        tx_hash: "0x" + "a".repeat(64),
        amount_paid_micros: 250_000,
        network: "base-sepolia",
        facilitator: "cdp",
      },
      duration_ms: 100,
      refund: { status: "not_supported", reason: "facilitator returned 404" },
    });
    setX402CdpAdapter(adapter);
    try {
      await withLive(async () => {
        await assert.rejects(
          () =>
            payX402Service({
              agent_address: VALID_AGENT,
              service_url: VALID_URL,
              max_price_usdc_micros: 1_000_000,
              request: { method: "POST" },
              reasoning: VALID_REASONING,
              nonce: FIXED_NONCE,
            }),
          (e: unknown) => {
            assert.ok(e instanceof ToolError);
            const te = e as ToolError;
            assert.equal(te.code, "PROVIDER_5XX");
            assert.equal(te.details?.refund_status, "not_supported");
            // No refund_tx_hash field when facilitator doesn't support refunds.
            assert.equal(te.details?.refund_tx_hash, undefined);
            return true;
          },
        );
      });
    } finally {
      setX402CdpAdapter(null);
      setAgentCoreMemory(null);
    }
  });

  it("router maps PROVIDER_5XX into INVALID_INPUT result with details.tool_error", async () => {
    // The action layer wraps ToolError into a Result<INVALID_INPUT, …>
    // pending an AepErrorCode union expansion. The structural promise to
    // callers is `details.tool_error === "PROVIDER_5XX"`.
    const memory = new TestMemoryWriter();
    setAgentCoreMemory(memory);
    const adapter = new TestX402Adapter({
      status: 500,
      body: "boom",
      payment: {
        tx_hash: "0x" + "b".repeat(64),
        amount_paid_micros: 100_000,
        network: "base-sepolia",
        facilitator: "cdp",
      },
      duration_ms: 50,
      refund: { status: "failed", reason: "network error: timeout" },
    });
    setX402CdpAdapter(adapter);
    try {
      await withLive(async () => {
        const ctx = ctxWith(["pay:x402"]);
        const result = await actionRouter.dispatch(
          "pay_x402_service",
          validInput({ nonce: FIXED_NONCE }),
          ctx,
        );
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error.code, "INVALID_INPUT");
          const details = result.error.details as
            | { tool_error?: string; refund_status?: string }
            | undefined;
          assert.equal(details?.tool_error, "PROVIDER_5XX");
          assert.equal(details?.refund_status, "failed");
        }
      });
    } finally {
      setX402CdpAdapter(null);
      setAgentCoreMemory(null);
    }
  });
});
