# Surface 2 — `pay_x402_service` MCP tool

*Focused build spec. Self-contained for the Surface 2 owner. Cross-references the master spec (`docs/aep-reflex-tech-spec.md`) for cross-surface contracts only.*

*Master version: v1 · 2026-05-06 · Surface 2 lives at master §"Surface 2 — `pay_x402_service` MCP tool" (lines ~220–305).*

---

## Owner

**TBD** — assign before Day 3 (master §"Open questions" Q1).

Critical path: **yes**. Surface 2 gates Surface 4 — the AgentCore agent's `pay_x402_service` call (master IC-3, master §"Surface 4 / agent loop") is non-functional until this tool ships.

---

## What it is

A new tool added to the AEP MCP server (`@agenomics/mcp-server`). It:

1. Wraps an x402 client (`@coinbase/x402`).
2. Validates spend against the agent's on-chain Vault policy (per-tx + daily limits).
3. Settles via the **CDP Server Wallet** (`@coinbase/cdp-sdk`) on Base, using the CDP Facilitator.
4. Records the agent's natural-language `reasoning` and the resulting receipt to AgentCore Memory (the auditable artifact for the AWS judging criterion).
5. Returns the upstream service's response body + a payment receipt + a `decision_record_id` pointer.

This is the **only** new MCP tool in the Reflex hackathon scope. Per master §TL;DR, the existing AEP MCP server currently exposes **27 tools** (per `README.md` line 3); after Surface 2 lands the count becomes **28**. The Surface 2 owner is responsible for updating `README.md` and `docs/api-reference.md` to reflect 28.

> **Repo-state inconsistency to be aware of:** `docs/api-reference.md` line 3 currently asserts "All 25 MCP tools". `README.md` says 27. Master spec asserts 27 as authoritative. Reconcile during the docs-update step.

---

## Stack & dependencies

From master §"Surface 2 / Implementation":

| Dep | Source | Notes |
|---|---|---|
| TypeScript | existing in `@agenomics/mcp-server` | tool lives at `src/tools/pay-x402-service.ts` |
| `@coinbase/x402` | npm | x402 client; provides `x402Client`, request/response types, refund helpers |
| `@coinbase/cdp-sdk` | npm | CDP Server Wallet; per-agent wallet derivation, EIP-3009 / Permit2 signing |
| `recordDecision` | local module: `../memory` | persists decisions to AgentCore Memory; long-term + short-term keys (master §"Surface 4 / Memory") |
| `getVaultPolicy(agent_address)` | existing AEP RPC client | reads `per_tx_limit_micros`, `daily_limit_micros`, allowlist from on-chain Vault |
| `getOrCreateAgentWallet(agent_address)` | helper, new | derives a CDP Server Wallet keyed by `agent_address`; cached; seed lives in AgentCore Identity vault (master §"Open questions" Q5 — needs confirmation) |
| `updatePricingHistory(agent_address, ...)` | local module: `../memory` | feeds existing `get_agent_profile` MCP tool |

**Workspace consumption note (per `docs/STATUS.md` §7):** `@agenomics/mcp-server` is **not yet published to npm** — publish is held on the SAS bootstrap ceremony (`docs/STATUS.md` §7.A, line 152). Surface 2 development unblocks via workspace `file:` resolution inside this monorepo; consumers of the new tool from Surface 4 (AgentCore Gateway) similarly resolve via the in-repo path until v0.1.0 ships. Public Reflex contributors who need this from npm are blocked until the bootstrap ceremony completes.

**v2 vault transfer plug-point (per `docs/STATUS.md` §7.C, line 156):** the existing v2 `vault_transfer` path is env-gated behind `AEP_USE_V2_VAULT_TRANSFER=1` and is proven end-to-end on devnet (smoke Step 9b). Step 1 of this tool's flow ("validate against agent's Vault policy") reads policy only; if/when this tool ever moves USDC through the vault directly (rather than via CDP Server Wallet on Base), the implementation **must** route through the v2 layer, not v1. Today the design is debit-via-CDP-on-Base, so vault USDC movement is upstream of this tool — but flag any future change that touches USDC inside the vault.

---

## Interface contract

**IC-3 (inlined verbatim from master §"Interface contracts / IC-3"):**

```typescript
pay_x402_service({
  agent_address: string,            // AEP-registered agent (the spender)
  service_url: string,              // x402-protected URL
  max_price_usdc_micros: number,    // hard cap; tool refuses if quote exceeds
  request: {
    method: "GET" | "POST",
    headers?: Record<string, string>,
    body?: string
  },
  reasoning: string                 // the agent's natural-language justification
}) → {
  status: number,
  body: string,
  payment: {
    tx_hash: string,
    amount_paid_micros: number,
    network: "base-mainnet" | "base-sepolia",
    facilitator: "cdp" | "kora"
  },
  duration_ms: number,
  decision_record_id: string        // pointer into AgentCore Memory
}
```

> **`reasoning` is mandatory.** Calls without it are rejected. This is what makes the agent's decision auditable and is the primary AWS judging-criterion artifact. Enforce in tool input validation, not downstream.

For the other interface contracts (IC-1 mobile↔AgentCore, IC-2 AgentCore↔MCP, IC-4 CCTP hook payload), see master §"Interface contracts" — Surface 2 does not own them and must not break them.

---

## Implementation outline

The 5-step flow from master §"Surface 2 / Implementation". Reproduced here so the owner has it without flipping back. The master shows pseudocode; treat the steps below as authoritative for ordering and the master's TS as the reference shape.

**1. Validate against agent's Vault policy.**
Read on-chain Vault state for `agent_address`. Reject pre-payment if:
- `max_price_usdc_micros > vault.per_tx_limit_micros` → `EXCEEDS_VAULT_PER_TX_LIMIT`
- cumulative-today + `max_price_usdc_micros > vault.daily_limit_micros` → `EXCEEDS_VAULT_DAILY_LIMIT`

This is a read-only check. Do not move USDC inside the vault here. (See "Why direct Vault debit, not Settlement escrow" below.)

**2. Get CDP Server Wallet for this agent.**
Derive (cached) a CDP wallet keyed by `agent_address`. Seed material lives in AgentCore Identity vault (master §"Authentication boundaries" row 4; master §"Open questions" Q5 pending confirmation). One wallet per registered AEP agent.

**3. Make the x402 call.**
```ts
const client = new x402Client({ wallet, facilitator: "cdp" });
const start = Date.now();
const response = await client.fetch(params.service_url, params.request);
const duration_ms = Date.now() - start;
```
The x402 client handles the 402 → quote → pay → 200 dance. If the upstream returns a quote `> max_price_usdc_micros`, abort without paying.

**4. Record the decision in AgentCore Memory.**
```ts
const decision_record_id = await recordDecision({
  agent_address, service_url, reasoning, payment: response.payment, duration_ms,
});
```
Returned `decision_record_id` is the pointer surfaced in IC-3's response.

**5. Update agent's pricing history (long-term Memory).**
```ts
await updatePricingHistory(agent_address, {
  service_url,
  paid_micros: response.payment.amount_paid_micros,
  quality_signal: response.status === 200 ? 1 : 0,
});
```
Feeds the existing `get_agent_profile` MCP tool. Surface 4's reasoning loop reads this on the next session for the same agent (master §"Surface 4 / agent loop", `pricing_*` keys).

Return the IC-3 response shape.

---

## Error handling

The 6-row table from master §"Surface 2 / Error handling". All six cases must produce **structured** error responses (JSON-RPC tool error with a stable `code`), not exceptions to the MCP transport.

| Error | Behavior |
|---|---|
| `EXCEEDS_VAULT_PER_TX_LIMIT` | Reject before payment; tool returns error |
| `EXCEEDS_VAULT_DAILY_LIMIT` | Reject before payment; tool returns error |
| 402 with quote > `max_price_usdc_micros` | Reject; do not pay; return error with quote |
| 402 + payment + 200 | Standard success |
| 402 + payment + 5xx | Refund attempt via x402 facilitator; if refund fails, log and surface |
| Network timeout post-payment | Retry idempotency check via `payment_id`; do not double-pay |

Idempotency note: the post-payment timeout case is the high-stakes one. The retry path must use the x402 `payment_id` (or equivalent) to ask the facilitator whether the prior settle succeeded, and only retry the upstream request — never the payment.

---

## Why direct Vault debit, not Settlement escrow

(From master §"Surface 2 / Why direct Vault debit, not Settlement escrow".)

x402 calls are one-shot, atomic, and don't have a counterparty in the AEP Registry. Wrapping every call in a Settlement escrow would create dead milestones. Settlement is for **AEP-to-AEP** relationships (where both sides are registered agents); `pay_x402_service` is for **AEP-to-Bazaar** consumption.

The exception is the CCTP cross-chain flow (Surface 3), which uses a *session-level* Settlement escrow to reconcile the budget. That's covered in master §"Surface 3" and is **not Surface 2's problem** — Surface 2 just emits a payment receipt; Surface 3 (or the relayer fallback) is what reconciles back to the on-chain escrow. Surface 2's only obligation toward Surface 3 is that the `payment.tx_hash` returned in IC-3 is the Base-side settle tx that Surface 3 will key on.

---

## Cross-cutting concerns (Surface-2-applicable rows only)

### Authentication boundaries

From master §"Cross-cutting / Authentication boundaries". Surface 2 sits on these rows:

| Boundary | Auth mechanism |
|---|---|
| AgentCore → AEP MCP | HTTPS, Gateway-managed bearer auth tied to `agent_address` |
| AgentCore → x402 services | CDP Server Wallet ECDSA signature (EIP-3009 or Permit2) |

Surface 2 must **not** accept calls that bypass the Gateway bearer-auth layer. The `agent_address` passed in IC-3 is trusted because the Gateway has already bound it to the bearer token; Surface 2 does not re-verify Solana signatures.

### Observability

From master §"Cross-cutting / Observability":
- **AgentCore Observability** must capture every `pay_x402_service` invocation (tool call) and every economic decision → CloudWatch.
- **x402 receipts** are visible on Basescan; the `payment.tx_hash` in IC-3 must be a real, cross-linkable Base tx hash for the session UI.
- Pricing-history updates feed the existing `app.agenomics.xyz` dashboard via the same Helius-webhook surface used for AEP program events.

### Performance targets

From master §"Cross-cutting / Performance targets". The row that applies:

| Metric | Target | Hard limit |
|---|---|---|
| x402 call (cached CDP wallet, warm AgentCore) | ≤ 4s | 10s |

The 4s target is end-to-end through `pay_x402_service` — vault-policy read + x402 fetch + memory write + return. The 10s hard limit triggers the master's "fallback-mode only / cut from live flow" rule. Cold-start (uncached CDP wallet) is allowed to be slower but should never breach 10s.

---

## Acceptance criteria

From master §"Surface 2 / Acceptance criteria":

- Tool registered in AEP MCP server and discoverable via Gateway.
- All 6 error cases above produce structured error responses.
- Decision record persisted to AgentCore Memory and retrievable by `decision_record_id`.
- Pricing history updated on every call, queryable via existing `get_agent_profile`.
- Test suite: 20+ unit tests (mocked CDP), 5 integration tests against Base Sepolia + AEP devnet.

See `acceptance-criteria.md` for the actionable checklist (including the implicit ones — `reasoning` rejection, idempotency, Basescan-visible tx, docs update from 27→28).

---

## Risks that affect this surface

From master §"Risk register":

**R8 — x402 rate-limited under demo traffic** (probability: low, impact: medium).
Mitigation: pre-purchase 50+ test calls; cache responses for retries. **This is a Surface 2 implementation concern.** The retry/cache layer for idempotent GETs should live inside or adjacent to this tool. POSTs are not retried for cache reasons (only for the payment-idempotency reason in error-handling row 6).

Other risks that touch Surface 2 indirectly:
- **R6 — AgentCore Gateway + AEP MCP integration glitches** (medium / high). Tool must register cleanly through the Gateway's MCP-tool wrapping — Day-1 hello-world is the canary.
- **R9 — Dev wallet keys committed to git** (low / catastrophic). The CDP Server Wallet seed must come from AgentCore Identity (or AWS SSM during local dev). **Never** commit a CDP secret. Pre-commit hooks enforced from Day 1.

---

## Out-of-scope reminders

From master §"Out of scope":
- **No mainnet deploy of AEP programs.** This tool runs against the existing devnet AEP programs.
- **No multi-chain support beyond Base.** x402 settlement is Base-only for v1.
- **No iOS, no token launch, no DAO governance, no public Rust/Swift SDKs.**

Surface-2-specific scope cuts:
- Do **not** modify the deployed AEP programs (Vault, Registry, Settlement). Vault policy is read-only from this tool's perspective.
- Do **not** introduce a Settlement escrow per x402 call (covered in "Why direct Vault debit" above).
- Do **not** own the CCTP round-trip — that's Surface 3 (or the relayer fallback).
- The self-monetized Bazaar endpoint (`agent.agenomics.xyz`) is **Surface 4's** deliverable, not Surface 2's, even though it uses x402.

---

## Open questions

See `open-questions.md` for the Surface-2-relevant subset of master §"Open questions" plus new questions raised during this spec.
