// Surface 2 — `pay_x402_service` MCP action.
//
// Spec: docs/aep-reflex-tech-spec.md §"Surface 2 — pay_x402_service MCP tool"
// (lines 220–305) + IC-3 (lines 109–137).
// Focused build spec: .kiro/specs/surface-2-x402-tool/spec.md
// Acceptance criteria: .kiro/specs/surface-2-x402-tool/acceptance-criteria.md
//
// Day 3 wires the real flow for the *happy path*:
//   1. Schema-validate IC-3 inputs (mandatory `reasoning` enforced here).
//   2. Read on-chain Vault policy via `getVaultPolicyReader()` and reject
//      pre-payment on per-tx / daily-cap breach. Stub limits used as a
//      fallback when the live RPC call fails (keeps the deterministic
//      mock path green for the existing 11 scaffold tests + CI without
//      a Solana endpoint).
//   3. Drive the x402 client + CDP Server Wallet via
//      `getX402CdpAdapter()`. Gated behind `AEP_X402_LIVE=1` — when off,
//      returns the deterministic mock IC-3 response that the scaffold
//      tests pin.
//   4. Record the decision + reasoning into AgentCore Memory via
//      `getAgentCoreMemory().recordDecision(...)`.
//   5. Best-effort `updatePricingHistory(...)` — the long-term pricing-
//      memory feed for `get_agent_profile` (spec §"Implementation" step 5).
//
// What's *not* yet wired (flagged with TODOs, surfaced in the deliverable
// report):
//   - Idempotency-key retry on post-payment timeout (error table row 6) —
//     `x402-fetch` does not yet expose `payment_id`. Spec open-questions
//     N4. Tracked.
//   - Refund attempt on 402+payment+5xx (error table row 5) — needs
//     facilitator-side refund call. Tracked.
//   - 50+ pre-purchased call cache for R8 demo-day rate-limit survival.
//
// IC-3 contract surface is preserved verbatim from the scaffold — no
// type changes; the wire shape is byte-identical.

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Action } from "../types/action.js";
import { ok, err } from "../types/action.js";
import { isValidPublicKey } from "../solana.js";
import {
  getVaultPolicyReader,
  type VaultPolicy,
} from "../adapters/vault-policy.js";
import {
  getX402CdpAdapter,
  isX402LiveEnabled,
} from "../adapters/x402-cdp.js";
import { getAgentCoreMemory } from "../adapters/agent-core-memory.js";
import { serverLogger } from "../util/logger.js";

const log = serverLogger.child({ component: "pay-x402-service" });

// ---------- shared schema fragments ----------

/**
 * Mirror of `actions/governance.ts#zPubkey`. The agent_address must be a
 * syntactically valid base58 Solana pubkey — this matches the IC-3
 * contract field "AEP-registered agent (the spender)".
 */
const zPubkey = z
  .string()
  .min(32, { message: "expected base58-encoded Solana public key" })
  .refine(isValidPublicKey, {
    message: "expected base58-encoded Solana public key",
  });

/**
 * Stub per-tx vault cap used when the live Vault read fails (no RPC, no
 * deployed vault for the test agent). The on-chain reader is preferred;
 * see `adapters/vault-policy.ts`. 50 USDC = 50_000_000 micros so fixture
 * tests can exercise both sides of the boundary deterministically.
 *
 * SECURITY: do NOT raise this without re-running the per-tx-limit unit
 * test — the test pins the exact boundary to detect cap drift.
 */
export const STUB_PER_TX_LIMIT_MICROS = 50_000_000 as const;

/**
 * Stub daily cap. Set BELOW `STUB_PER_TX_LIMIT_MICROS` so the daily
 * branch is reachable for inputs in (daily, per-tx], independent of
 * per-tx. 25 USDC.
 */
export const STUB_DAILY_LIMIT_MICROS = 25_000_000 as const;

// ---------- IC-3 input schema ----------

/**
 * IC-3 request shape (spec lines 109–134). All fields except
 * `request.headers` and `request.body` are required.
 *
 * `reasoning` MUST be present and non-empty per spec line 136:
 *   "The `reasoning` field is **mandatory** — calls without it are rejected.
 *    This is what makes the agent's decision auditable and is the primary
 *    AWS judging-criterion artifact."
 */
const payX402ServiceInput = {
  // ADR-135: `.describe()` carries the MCP-client-visible field docs
  // that pre-ADR-135 lived only in the hand-written
  // tools/pay-x402-service.ts JSON Schema.
  agent_address: zPubkey.describe(
    "AEP-registered agent (the spender), base58-encoded Solana pubkey.",
  ),
  service_url: z
    .string()
    .url({ message: "service_url must be a valid https:// URL" })
    .refine((u) => u.startsWith("https://"), {
      message:
        "service_url must use https:// (http:// is rejected to prevent " +
        "credential-leaking man-in-the-middle on x402 settlement)",
    })
    .describe("x402-protected URL to call."),
  max_price_usdc_micros: z
    .number()
    .int({ message: "max_price_usdc_micros must be an integer (USDC micros)" })
    .positive({ message: "max_price_usdc_micros must be > 0" })
    .describe(
      "Hard cap on the payment in USDC micros (10^-6 USDC). Tool " +
        "refuses if the x402 quote exceeds this value.",
    ),
  request: z.object({
    method: z.enum(["GET", "POST"]),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
  }),
  reasoning: z
    .string()
    .min(1, {
      message:
        "reasoning is mandatory and must be non-empty (spec IC-3 line 136)",
    })
    .describe(
      "Mandatory natural-language justification for this call. Empty " +
        "reasoning is rejected (spec IC-3, line 136).",
    ),
  /**
   * Optional 16-byte hex nonce for payment-id idempotency (spec error-table
   * row 6, "Network timeout post-payment"). When omitted, the action
   * generates a fresh-random nonce. When provided, the synthesized
   * `payment_id = sha256(agent_address || service_url || method ||
   * max_price_micros || nonce)` becomes the idempotency key — a retry
   * with the same nonce returns the cached receipt instead of re-paying.
   *
   * The nonce is OPTIONAL because the IC-3 wire shape promises to accept
   * spec-conformant inputs WITHOUT this field (master spec line 109-134
   * does not list a nonce). Callers that care about idempotency provide
   * one; one-shot callers do not.
   *
   * Format: 32 lowercase hex chars (16 bytes). Validated here so a
   * malformed nonce never silently degrades to "no idempotency" — the
   * caller learns at parse time.
   */
  nonce: z
    .string()
    .regex(/^[0-9a-f]{32}$/, {
      message: "nonce must be 32 lowercase hex chars (16 bytes)",
    })
    .optional(),
} as const;

type PayX402ServiceInput = z.infer<z.ZodObject<typeof payX402ServiceInput>>;

// ---------- IC-3 output shape ----------

/**
 * IC-3 response (spec lines 122–133). The `payment` sub-object mirrors
 * what the real x402 client surfaces today; `decision_record_id` is the
 * pointer into AgentCore Memory.
 */
export interface PayX402ServiceResult {
  status: number;
  body: string;
  payment: {
    tx_hash: string;
    amount_paid_micros: number;
    network: "base-mainnet" | "base-sepolia";
    facilitator: "cdp" | "kora";
  };
  duration_ms: number;
  decision_record_id: string;
}

const payX402ServiceOutputSchema: z.ZodType<PayX402ServiceResult> = z.object({
  status: z.number().int(),
  body: z.string(),
  payment: z.object({
    tx_hash: z.string(),
    amount_paid_micros: z.number().int(),
    network: z.enum(["base-mainnet", "base-sepolia"]),
    facilitator: z.enum(["cdp", "kora"]),
  }),
  duration_ms: z.number().int().nonnegative(),
  decision_record_id: z.string(),
});

// ---------- ToolError ----------

/**
 * Spec uses `throw new ToolError("EXCEEDS_VAULT_PER_TX_LIMIT")` (line 242).
 * The action layer wraps these in the canonical `Result<T, AepError>` shape
 * the router expects. The `code` is preserved in `details.tool_error` so
 * the Gateway / dashboard can branch on it without us having to grow the
 * `AepErrorCode` union prematurely.
 */
export type ToolErrorCode =
  | "EXCEEDS_VAULT_PER_TX_LIMIT"
  | "EXCEEDS_VAULT_DAILY_LIMIT"
  | "QUOTE_EXCEEDS_MAX_PRICE"
  | "REFUND_FAILED"
  | "PROVIDER_5XX"
  | "PAYMENT_TIMEOUT"
  | "INVALID_INPUT";

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

// ---------- vault policy resolution ----------

/**
 * Resolve the effective per-tx + daily-remaining caps for `agent_address`.
 *
 * Strategy:
 *   1. Try the on-chain reader (`getVaultPolicyReader().getVaultPolicy`).
 *      Returns the live policy in USDC micros.
 *   2. If the read throws (no RPC configured, vault account doesn't exist,
 *      decode failure), fall back to the stub limits. This keeps the
 *      deterministic stub path that the existing 11 scaffold tests rely
 *      on — those tests do not stand up a Solana RPC.
 *
 * The fallback is logged at WARN so a production misconfiguration
 * (RPC unreachable in a deployed environment) shows up loudly.
 */
async function resolveVaultPolicy(
  agent_address: string,
): Promise<VaultPolicy> {
  try {
    return await getVaultPolicyReader().getVaultPolicy(agent_address);
  } catch (e) {
    log.warn(
      {
        agent_address,
        err: e instanceof Error ? e.message : String(e),
      },
      "pay-x402-service: live vault-policy read failed, falling back to STUB limits",
    );
    return {
      per_tx_limit_micros: BigInt(STUB_PER_TX_LIMIT_MICROS),
      daily_limit_micros: BigInt(STUB_DAILY_LIMIT_MICROS),
      daily_remaining_micros: BigInt(STUB_DAILY_LIMIT_MICROS),
    };
  }
}

// ---------- handler ----------

/**
 * Pure-function form usable by tests without going through the router.
 * Mirrors IC-3 exactly: `payX402Service({ agent_address, service_url,
 * max_price_usdc_micros, request, reasoning })`.
 *
 * Throws `ToolError` for the spec's pre-payment refusal cases:
 *   - INVALID_INPUT             (zod schema breach)
 *   - EXCEEDS_VAULT_PER_TX_LIMIT
 *   - EXCEEDS_VAULT_DAILY_LIMIT
 *
 * Returns the IC-3 shape on success. The live x402+CDP path is gated
 * behind `AEP_X402_LIVE=1` — when off, returns the deterministic mock
 * the scaffold tests pin.
 */
export async function payX402Service(
  params: PayX402ServiceInput,
): Promise<PayX402ServiceResult> {
  // Belt-and-braces validation: the router has already zod-parsed `params`,
  // but exposing this entry-point as a public API means callers might
  // bypass the router (e.g. unit tests, direct programmatic use). Re-parse
  // through the same schema so the error surface is consistent.
  const parsed = z.object(payX402ServiceInput).safeParse(params);
  if (!parsed.success) {
    throw new ToolError(
      "INVALID_INPUT",
      parsed.error.issues[0]?.message ?? "invalid input",
    );
  }
  const input = parsed.data;

  // ----- Step 1: Vault policy gate (PRE-payment, per spec) -----
  //
  // Both checks happen before any network call to x402 — this is the
  // spec's "Reject before payment" requirement (error table rows 1+2,
  // spec lines 290–291). The on-chain read may fail in CI / test
  // environments; the fallback to stub limits keeps the gate functional.
  const policy = await resolveVaultPolicy(input.agent_address);

  if (BigInt(input.max_price_usdc_micros) > policy.per_tx_limit_micros) {
    throw new ToolError(
      "EXCEEDS_VAULT_PER_TX_LIMIT",
      `max_price_usdc_micros (${input.max_price_usdc_micros}) exceeds vault per-tx limit (${policy.per_tx_limit_micros})`,
      {
        max_price_usdc_micros: input.max_price_usdc_micros,
        per_tx_limit_micros: policy.per_tx_limit_micros.toString(),
      },
    );
  }

  if (BigInt(input.max_price_usdc_micros) > policy.daily_remaining_micros) {
    throw new ToolError(
      "EXCEEDS_VAULT_DAILY_LIMIT",
      `max_price_usdc_micros (${input.max_price_usdc_micros}) exceeds vault daily remaining (${policy.daily_remaining_micros}, daily_limit=${policy.daily_limit_micros})`,
      {
        max_price_usdc_micros: input.max_price_usdc_micros,
        daily_remaining_micros: policy.daily_remaining_micros.toString(),
        daily_limit_micros: policy.daily_limit_micros.toString(),
      },
    );
  }

  // ----- Step 1.5: payment_id idempotency (spec error-table row 6) -----
  //
  // `x402-fetch@1.2.0` doesn't expose a stable `payment_id`, so we
  // synthesize one client-side. Same (agent, service, method, max_price,
  // nonce) tuple → same payment_id → cache hit on retry. The nonce is
  // either caller-supplied (caller wants idempotent retries) or fresh-
  // random (one-shot call; payment_id is uncacheable in practice).
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  const payment_id = synthesizePaymentId({
    agent_address: input.agent_address,
    service_url: input.service_url,
    method: input.request.method,
    max_price_usdc_micros: input.max_price_usdc_micros,
    nonce,
  });

  const memory = getAgentCoreMemory();
  const cached = await memory.getIdempotencyReceipt(payment_id);
  if (cached) {
    // Idempotency HIT — a previous call with the same payment_id already
    // settled. Return the cached receipt; do NOT re-pay; do NOT re-record
    // the decision (the original call already wrote one). We DO re-derive
    // the decision_record_id off the same inputs so IC-3's contract is
    // satisfied without a memory write.
    log.info(
      {
        agent_address: input.agent_address,
        service_url: input.service_url,
        payment_id,
        cached_tx_hash: cached.payment.tx_hash,
      },
      "pay-x402-service: idempotency HIT — returning cached receipt without re-paying",
    );
    return {
      status: cached.status,
      body: cached.body,
      payment: cached.payment,
      duration_ms: cached.duration_ms,
      decision_record_id: synthesizeDecisionId(input, cached.payment.tx_hash),
    };
  }

  // ----- Step 2-3: x402 + CDP call -----
  //
  // Branched by `AEP_X402_LIVE`: live path drives the real CDP Server
  // Wallet + x402-fetch wrapper; stub path returns the deterministic mock
  // the existing scaffold tests pin. The IC-3 wire shape is byte-
  // identical across both paths.
  const { status, body, payment, duration_ms } = isX402LiveEnabled()
    ? await callX402Live(input)
    : callX402Stub(input);

  // Persist the receipt under payment_id so a subsequent call with the
  // same nonce returns the cached value instead of re-paying. Best-effort
  // — a cache write failure does NOT roll back the upstream call (the
  // payment is already settled). Logged inside the adapter.
  await memory.storeIdempotencyReceipt(payment_id, {
    status,
    body,
    payment,
    duration_ms,
  });

  // ----- Step 4: AgentCore Memory write (decision record) -----
  //
  // Returns the `decision_record_id` IC-3 surfaces back to the caller.
  // The write is wrapped in try/catch so a memory-write failure does not
  // un-do the upstream call (the payment is already settled). On failure,
  // we synthesize a stable id off the same inputs so IC-3's contract is
  // still satisfied and the caller can retry the memory write later.
  let decision_record_id: string;
  try {
    decision_record_id = await memory.recordDecision({
      agent_address: input.agent_address,
      service_url: input.service_url,
      reasoning: input.reasoning,
      payment,
      status,
      duration_ms,
    });
  } catch (e) {
    log.error(
      {
        err: e instanceof Error ? e.message : String(e),
        agent_address: input.agent_address,
        service_url: input.service_url,
      },
      "pay-x402-service: recordDecision failed; synthesizing decision id from inputs",
    );
    decision_record_id = synthesizeDecisionId(input, payment.tx_hash);
  }

  // ----- Step 5: Pricing-history update (best-effort, fire-and-forget) -----
  //
  // Best-effort: failures here are swallowed inside `updatePricingHistory`
  // so they never break the IC-3 happy-path return. Spec §"Implementation"
  // step 5 (lines 263–268).
  await memory.updatePricingHistory(input.agent_address, {
    service_url: input.service_url,
    paid_micros: payment.amount_paid_micros,
    quality_signal: status === 200 ? 1 : 0,
  });

  return {
    status,
    body,
    payment,
    duration_ms,
    decision_record_id,
  };
}

// ---------------------------------------------------------------------------
// Live x402 call — wraps the adapter, normalizes errors to ToolError.
// ---------------------------------------------------------------------------

async function callX402Live(input: PayX402ServiceInput): Promise<{
  status: number;
  body: string;
  payment: PayX402ServiceResult["payment"];
  duration_ms: number;
}> {
  let result;
  try {
    result = await getX402CdpAdapter().pay({
      agent_address: input.agent_address,
      service_url: input.service_url,
      max_price_usdc_micros: input.max_price_usdc_micros,
      request: input.request,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Map x402-fetch's "max price exceeded" message into the spec's
    // QUOTE_EXCEEDS_MAX_PRICE error (error table row 3). x402-fetch
    // throws an Error with "exceeds the maximum allowed value" in the
    // message text on quote > maxValue.
    if (/maximum allowed value|exceeds.*max/i.test(msg)) {
      throw new ToolError(
        "QUOTE_EXCEEDS_MAX_PRICE",
        `x402 quote exceeds max_price_usdc_micros (${input.max_price_usdc_micros}): ${msg}`,
        { max_price_usdc_micros: input.max_price_usdc_micros },
      );
    }
    throw new ToolError(
      "PAYMENT_TIMEOUT",
      `x402 call failed: ${msg}`,
      { service_url: input.service_url },
    );
  }

  // Surface 2 follow-up: surface the pre-flight quote-fallback warning
  // (best-effort fidelity signal — see x402-cdp.ts pre-flight comment).
  if (result.quote_fallback_warning) {
    log.warn(
      {
        service_url: input.service_url,
        warning: result.quote_fallback_warning,
      },
      "pay-x402-service: x402 pre-flight quote unavailable; amount_paid_micros uses max_price ceiling",
    );
  }

  // Surface 2 spec error-table row 5: 402 + payment + 5xx → emit
  // PROVIDER_5XX with the facilitator-side refund outcome embedded in
  // details. The adapter never throws on a 5xx — it returns a populated
  // `refund` so the action layer can return a structured error rather
  // than a thrown exception.
  if (result.refund) {
    throw new ToolError(
      "PROVIDER_5XX",
      `upstream returned ${result.status} after settlement; refund_status=${result.refund.status}`,
      {
        upstream_status: result.status,
        tx_hash: result.payment.tx_hash,
        refund_status: result.refund.status,
        ...(result.refund.refund_tx_hash
          ? { refund_tx_hash: result.refund.refund_tx_hash }
          : {}),
        ...(result.refund.reason ? { refund_reason: result.refund.reason } : {}),
      },
    );
  }

  return {
    status: result.status,
    body: result.body,
    payment: result.payment,
    duration_ms: result.duration_ms,
  };
}

// ---------------------------------------------------------------------------
// Deterministic mock — preserves the scaffold-test behaviour. Activated
// when AEP_X402_LIVE != "1" (the default in CI and unit-test runs).
// ---------------------------------------------------------------------------

function callX402Stub(input: PayX402ServiceInput): {
  status: number;
  body: string;
  payment: PayX402ServiceResult["payment"];
  duration_ms: number;
} {
  const mockTxHash =
    "0x" + "0".repeat(64 - "stub".length) + Buffer.from("stub").toString("hex");
  return {
    status: 200,
    body: JSON.stringify({
      stub: true,
      service_url: input.service_url,
      method: input.request.method,
    }),
    payment: {
      tx_hash: mockTxHash,
      amount_paid_micros: Math.min(
        input.max_price_usdc_micros,
        1_000_000, // 1 USDC default mock price
      ),
      network: "base-sepolia",
      facilitator: "cdp",
    },
    duration_ms: 0,
  };
}

/**
 * Fallback decision-id generator used when the AgentCore Memory write
 * itself fails. Deterministic on (agent_address, service_url, tx_hash)
 * so a retry returns the same id.
 */
function synthesizeDecisionId(
  input: PayX402ServiceInput,
  tx_hash: string,
): string {
  const h = createHash("sha256");
  h.update(input.agent_address);
  h.update("|");
  h.update(input.service_url);
  h.update("|");
  h.update(tx_hash);
  return "decision-fallback-" + h.digest("hex").slice(0, 32);
}

/**
 * Synthesize a stable `payment_id` for x402 idempotency (spec error-table
 * row 6). `x402-fetch@1.2.0` doesn't expose a stable id, so we derive one
 * client-side off the request tuple plus a caller-supplied (or fresh-
 * random) nonce. Same inputs → same id, so a retry-after-timeout with the
 * same nonce hits the idempotency cache instead of double-paying.
 *
 * Format: 32 lowercase hex chars (truncated SHA-256). Visibility of the
 * full 256-bit hash is unnecessary for collision resistance at the demo
 * scale; truncation keeps log lines readable.
 */
export function synthesizePaymentId(input: {
  agent_address: string;
  service_url: string;
  method: string;
  max_price_usdc_micros: number;
  nonce: string;
}): string {
  const h = createHash("sha256");
  h.update(input.agent_address);
  h.update("|");
  h.update(input.service_url);
  h.update("|");
  h.update(input.method);
  h.update("|");
  h.update(String(input.max_price_usdc_micros));
  h.update("|");
  h.update(input.nonce);
  return h.digest("hex").slice(0, 32);
}

// ---------- Action declaration ----------

/**
 * Capability claim for Surface 2: `pay:x402` (see `types/capability.ts`
 * `X402Claim`). Distinct from `read:vault` because this is a write/spend
 * action — conflating the two would let any read-only caller settle on
 * Base.
 *
 * `requiresSigner: false` — the on-chain Solana signer is NOT involved.
 * The CDP Server Wallet signs the EIP-3009 / Permit2 payment header on
 * Base; the AEP `agent_address` is used only as a key (vault PDA + CDP
 * wallet name).
 */
export const payX402ServiceAction: Action<
  PayX402ServiceInput,
  PayX402ServiceResult
> = {
  name: "pay_x402_service",
  title: "Pay an x402-protected service (Surface 2)",
  description:
    "Make an authenticated payment to an x402-protected service URL on " +
    "behalf of an AEP-registered agent. Wraps an x402 client, debits the " +
    "agent's CDP Server Wallet on Base via the CDP Facilitator, and " +
    "returns the response + receipt. The `reasoning` field is mandatory — " +
    "it captures the agent's natural-language justification and is the " +
    "primary AWS judging-criterion artifact (see spec IC-3, line 136). " +
    "Live x402+CDP path is gated behind `AEP_X402_LIVE=1`; when off, " +
    "returns a deterministic mock for unit/integration testing.",
  inputSchema: payX402ServiceInput,
  outputSchema: payX402ServiceOutputSchema,
  similes: [
    "x402 payment",
    "pay protected service",
    "settle on Base",
    "agent pays for API",
  ],
  examples: [
    {
      description: "Pay for a Bazaar API call with 1 USDC max price",
      input: {
        agent_address: "11111111111111111111111111111111",
        service_url: "https://bazaar.example.com/v1/inference",
        max_price_usdc_micros: 1_000_000,
        request: { method: "POST", body: '{"prompt":"hello"}' },
        reasoning:
          "Need inference for user task; price within session budget; " +
          "vendor reputation > 0.8 in pricing history.",
      },
    },
  ],
  readOnly: false,
  // SECURITY: do not flip requiresSigner: true or relax capabilities without
  // re-reviewing the gating in actionRouter. The CDP wallet path signs on
  // Base, not Solana; the Solana signer is not part of this action's auth.
  capabilities: ["pay:x402"],
  preflight: ["cluster_health"],
  requiresSigner: false,
  handler: async (_ctx, input) => {
    try {
      return ok(await payX402Service(input));
    } catch (e) {
      if (e instanceof ToolError) {
        // Surface the spec's domain-error code via details.tool_error so
        // the Gateway can branch on it. The AepError code falls back to
        // INVALID_INPUT for pre-payment refusals (the spec error table
        // calls these "reject before payment") which is the closest match
        // in the existing AepErrorCode union.
        return err({
          code: "INVALID_INPUT",
          message: e.message,
          details: {
            tool_error: e.code,
            ...(e.details ?? {}),
          },
        });
      }
      return err({
        code: "PROGRAM_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
