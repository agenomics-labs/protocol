// Surface 2 — `pay_x402_service` MCP action (SCAFFOLD / STUB).
//
// Spec: docs/aep-reflex-tech-spec.md §"Surface 2 — pay_x402_service MCP tool"
// (lines 220–305) + IC-3 (lines 109–137).
//
// What this is:
//   A typed action skeleton wired through the standard ADR-058 ActionRouter.
//   The handler validates inputs, surfaces the spec's trivially-detectable
//   error cases (EXCEEDS_VAULT_PER_TX_LIMIT, etc.), and returns a
//   deterministic mock IC-3 response on the happy path. NO real x402 client,
//   NO real CDP wallet, NO real AgentCore Memory write.
//
// What this is NOT:
//   The real implementation. Spec §"Implementation" (lines 232–278) wires:
//     1. `getVaultPolicy(agent_address)` — actual on-chain lookup
//     2. `getOrCreateAgentWallet(agent_address)` — CDP Server Wallet derive
//     3. `new x402Client({ wallet, facilitator: "cdp" }).fetch(...)` — real
//        x402 settle on Base mainnet/sepolia
//     4. `recordDecision(...)` — AgentCore Memory write returning a real id
//     5. `updatePricingHistory(...)` — long-term Memory append
//   Each step is marked with a `TODO(Surface 2 Day 3)` cite below.
//
// Error-handling table is from spec lines 286–296. Domain errors are
// surfaced as `INVALID_INPUT` with `details.tool_error` set to the spec
// code; the existing `AepErrorCode` union (types/action.ts lines 62–70) is
// closed and the AEP error layer should not grow Surface-2-specific codes
// until the real implementation lands and we know which of these need
// distinct wire-level treatment by the Gateway. See "spec ambiguity" in
// the scaffold report.

import { z } from "zod";
import type { Action } from "../types/action.js";
import { ok, err } from "../types/action.js";
import { isValidPublicKey } from "../solana.js";

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
 * Stub per-tx vault cap used by the trivially-detectable
 * EXCEEDS_VAULT_PER_TX_LIMIT branch. The real implementation reads this
 * from the on-chain vault policy via `getVaultPolicy(agent_address)`
 * (spec §"Implementation" step 1). Set to 50 USDC = 50_000_000 micros so
 * fixture tests can exercise both sides of the boundary deterministically.
 */
export const STUB_PER_TX_LIMIT_MICROS = 50_000_000 as const;

/**
 * Stub daily vault cap (EXCEEDS_VAULT_DAILY_LIMIT branch). Real impl:
 * compare against `vault.daily_remaining_micros`. Stub: a single per-call
 * upper bound. Set BELOW `STUB_PER_TX_LIMIT_MICROS` so an input in the
 * range (daily, per-tx] exercises the daily branch independently — the
 * order of checks below means inputs > per-tx always trip per-tx first,
 * and the daily-limit branch is reachable for inputs that pass per-tx
 * but exceed the daily window.
 */
export const STUB_DAILY_LIMIT_MICROS = 25_000_000 as const; // 25 USDC

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
  agent_address: zPubkey,
  service_url: z
    .string()
    .url({ message: "service_url must be a valid https:// URL" })
    .refine((u) => u.startsWith("https://"), {
      message:
        "service_url must use https:// (http:// is rejected to prevent " +
        "credential-leaking man-in-the-middle on x402 settlement)",
    }),
  max_price_usdc_micros: z
    .number()
    .int({ message: "max_price_usdc_micros must be an integer (USDC micros)" })
    .positive({ message: "max_price_usdc_micros must be > 0" }),
  request: z.object({
    method: z.enum(["GET", "POST"]),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
  }),
  reasoning: z
    .string()
    .min(1, {
      message:
        "reasoning is mandatory and must be non-empty (spec IC-3 line 136)",
    }),
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

// ---------- handler (STUB) ----------

/**
 * Pure-function form usable by tests without going through the router.
 * Mirrors IC-3 exactly: `payX402Service({ agent_address, service_url,
 * max_price_usdc_micros, request, reasoning })`. Throws domain errors for
 * trivially-detectable cases; returns a deterministic mock for the
 * happy path.
 *
 * Real implementation (spec §"Implementation" lines 232–278):
 *   1. const vault = await getVaultPolicy(params.agent_address);
 *   2. const wallet = await getOrCreateAgentWallet(params.agent_address);
 *   3. const client = new x402Client({ wallet, facilitator: "cdp" });
 *      const response = await client.fetch(service_url, request);
 *   4. const decision_record_id = await recordDecision({...});
 *   5. await updatePricingHistory(...);
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
    throw new ToolError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "invalid input");
  }
  const input = parsed.data;

  // Error case 1 (spec line 290): EXCEEDS_VAULT_PER_TX_LIMIT
  // Real impl reads `vault.per_tx_limit_micros` from on-chain vault policy.
  // TODO(Surface 2 Day 3): replace `STUB_PER_TX_LIMIT_MICROS` with a real
  // `getVaultPolicy(agent_address)` call per spec §"Implementation" step 1
  // (lines 239–243).
  if (input.max_price_usdc_micros > STUB_PER_TX_LIMIT_MICROS) {
    throw new ToolError(
      "EXCEEDS_VAULT_PER_TX_LIMIT",
      `max_price_usdc_micros (${input.max_price_usdc_micros}) exceeds vault per-tx limit (${STUB_PER_TX_LIMIT_MICROS})`,
      {
        max_price_usdc_micros: input.max_price_usdc_micros,
        per_tx_limit_micros: STUB_PER_TX_LIMIT_MICROS,
      },
    );
  }

  // Error case 2 (spec line 291): EXCEEDS_VAULT_DAILY_LIMIT
  // Real impl computes `vault.daily_remaining_micros` and compares against
  // the requested cap. Stub uses a fixed upper bound below the per-tx cap
  // so this branch is reachable for inputs in (daily, per-tx]. The real
  // impl just swaps the source of `daily_remaining_micros`.
  // TODO(Surface 2 Day 3): wire daily-cap state per spec §"Implementation"
  // step 1 + spec error table line 291.
  if (input.max_price_usdc_micros > STUB_DAILY_LIMIT_MICROS) {
    throw new ToolError(
      "EXCEEDS_VAULT_DAILY_LIMIT",
      `max_price_usdc_micros (${input.max_price_usdc_micros}) exceeds vault daily limit (${STUB_DAILY_LIMIT_MICROS})`,
      {
        max_price_usdc_micros: input.max_price_usdc_micros,
        daily_limit_micros: STUB_DAILY_LIMIT_MICROS,
      },
    );
  }

  // Error case 3 (spec line 292): 402 with quote > max_price_usdc_micros.
  // Real impl: HEAD / GET → server returns 402 with x-payment-required
  // header carrying the quote; if quote > cap, refuse.
  // Stub: cannot be detected without a network round-trip, so we skip it
  // here. The real impl wires this in step 3.
  // TODO(Surface 2 Day 3): implement 402-quote check per spec error table
  // line 292 and §"Implementation" step 3 (x402 client.fetch).

  // Error cases 4–6 (spec lines 293–295) — 5xx refund, network timeout
  // idempotency, etc — also require a real network call. Stub returns
  // success below.
  // TODO(Surface 2 Day 3): error-table lines 293–295 — refund / timeout
  // idempotency. Wire `payment_id` retry path per spec line 295.

  // ----- HAPPY PATH: deterministic mock IC-3 response -----
  // Deterministic so test assertions are stable. Real impl returns the
  // x402 client's actual response + payment receipt + AgentCore Memory id.
  //
  // TODO(Surface 2 Day 3): replace mock with real x402 client per spec
  // §"Implementation" step 3 (lines 248–252) and AgentCore Memory write
  // per step 4 (lines 254–261).
  const mockTxHash =
    "0x" +
    "0".repeat(64 - "stub".length) +
    Buffer.from("stub").toString("hex");
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
    decision_record_id: `stub-decision-${input.agent_address.slice(0, 8)}`,
  };
}

// ---------- ToolError ----------

/**
 * Spec uses `throw new ToolError("EXCEEDS_VAULT_PER_TX_LIMIT")` (line 242).
 * The action layer wraps these in the canonical `Result<T, AepError>` shape
 * the router expects. The `code` is preserved in `details.tool_error` so
 * the Gateway / dashboard can branch on it without us having to grow the
 * `AepErrorCode` union prematurely (see spec ambiguity note).
 */
export type ToolErrorCode =
  | "EXCEEDS_VAULT_PER_TX_LIMIT"
  | "EXCEEDS_VAULT_DAILY_LIMIT"
  | "QUOTE_EXCEEDS_MAX_PRICE"
  | "REFUND_FAILED"
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

// ---------- Action declaration ----------

/**
 * Capability claim for Surface 2: `pay:x402` (see `types/capability.ts`
 * `X402Claim`). Distinct from `read:vault` because this is a write/spend
 * action — conflating the two would let any read-only caller settle on
 * Base. ADR-058 §2.1 + spec §"Acceptance criteria" line 299 ("Tool
 * registered in AEP MCP server and discoverable via Gateway").
 *
 * Day-3 wires the real CDP wallet + on-chain vault debit; this scaffold
 * already carries the claim so the gating surface is pinned by tests
 * from day one.
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
    "agent's Vault, settles via CDP Facilitator on Base, and returns the " +
    "response + receipt. The `reasoning` field is mandatory — it captures " +
    "the agent's natural-language justification and is the primary AWS " +
    "judging-criterion artifact (see spec IC-3, line 136). " +
    "STATUS: Surface 2 scaffold (stub) — real x402 / CDP integration lands " +
    "Day 3–7 per docs/aep-reflex-tech-spec.md §'Surface 2'.",
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
  // The call ultimately debits a vault, but the stub doesn't sign anything.
  // `readOnly: false` so the router treats it as a write-side dispatch and
  // the eventual real implementation doesn't need to flip this flag.
  readOnly: false,
  // SECURITY: do not flip requiresSigner: true or relax capabilities without
  // re-reviewing the gating in actionRouter — see docs/aep-reflex-tech-spec.md
  // IC-3 (Surface 2 Day 3 implementation will switch this to a write action).
  capabilities: ["pay:x402"],
  preflight: ["cluster_health"],
  // SECURITY: do not flip requiresSigner: true or relax capabilities without
  // re-reviewing the gating in actionRouter — see docs/aep-reflex-tech-spec.md
  // IC-3 (Surface 2 Day 3 implementation will switch this to a write action).
  // Today the stub does not sign anything; Day-3 wires the real CDP wallet
  // path (spec §"Implementation" step 2) and flips this to `true`.
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
