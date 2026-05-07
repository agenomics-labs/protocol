# Surface 2 — Acceptance criteria

Source: master `docs/aep-reflex-tech-spec.md` §"Surface 2 / Acceptance criteria" plus implicit criteria surfaced from elsewhere in the master spec.

## Explicit (from master §"Surface 2 / Acceptance criteria")

- [ ] Tool `pay_x402_service` is registered in the AEP MCP server (`@agenomics/mcp-server`) and discoverable through the AgentCore Gateway as an MCP tool.
- [ ] All 6 error cases produce structured error responses (stable `code` field, JSON-RPC tool-error shape — not transport-level exceptions):
  - [ ] `EXCEEDS_VAULT_PER_TX_LIMIT`
  - [ ] `EXCEEDS_VAULT_DAILY_LIMIT`
  - [ ] 402-with-quote-over-cap (no payment made; quote returned)
  - [ ] 402 + payment + 200 (success path)
  - [ ] 402 + payment + 5xx (refund attempted; refund failure surfaces)
  - [ ] Network timeout post-payment (idempotency check via `payment_id`; no double-pay)
- [ ] A decision record is persisted to AgentCore Memory on every call and is retrievable by the returned `decision_record_id`.
- [ ] Pricing history is updated on every call and is queryable through the existing `get_agent_profile` MCP tool.
- [ ] Test suite ships with 20+ unit tests (mocked CDP) and 5 integration tests against Base Sepolia + AEP devnet.

## Implicit (derived from master IC-3, cross-cutting, and risk register)

- [ ] `reasoning` field is enforced as mandatory in tool input validation; calls without a non-empty `reasoning` are rejected before any vault read or payment (master IC-3: "calls without it are rejected").
- [ ] Returned `payment.tx_hash` is a real Base mainnet or Base Sepolia transaction hash, cross-linkable on Basescan (master §"Cross-cutting / Observability"; required by Surface 3 to key on).
- [ ] Returned `payment.network` and `payment.facilitator` match the runtime configuration (master IC-3 enum: `"base-mainnet" | "base-sepolia"`, `"cdp" | "kora"`).
- [ ] End-to-end latency (vault read → x402 fetch → memory write → return) hits the master perf target: ≤ 4s for cached-CDP-wallet warm path; never above 10s hard limit (master §"Cross-cutting / Performance targets").
- [ ] CDP Server Wallet seed is sourced from AgentCore Identity (or AWS SSM during local dev). No CDP secrets in repo, env files, or CI logs (master §"Risk register" R9).
- [ ] Pre-commit hooks block CDP secret commits from Day 1 (master §"Risk register" R9).
- [ ] Surface 2 does not modify deployed AEP programs (Vault / Registry / Settlement); vault policy is read-only from this tool (master §TL;DR + §"Out of scope").
- [ ] No Settlement escrow is created per x402 call (master §"Why direct Vault debit, not Settlement escrow").
- [ ] Surface 2 does not bypass the Gateway-managed bearer-auth boundary (master §"Cross-cutting / Authentication boundaries" row 3); `agent_address` is trusted because the Gateway has bound it to the bearer.
- [ ] Idempotent retry uses x402 `payment_id` to query facilitator; only the upstream request is ever retried, never the payment.
- [ ] Cache layer for retried idempotent GETs is in place (master R8 mitigation: "cache responses for retries"). 50+ test calls pre-purchased before demo.
- [ ] `README.md` and `docs/api-reference.md` are updated to reflect the new tool count (currently 27 in `README.md` line 3 and 25 in `docs/api-reference.md` line 3 — both need to land at 28 and reconcile the existing inconsistency).
- [ ] The new tool is added to whatever tool-listing source-of-truth `docs/api-reference.md` is generated from (or hand-edited there if no generator).
- [ ] Tool is consumable from Surface 4 in-monorepo via workspace `file:` resolution while `@agenomics/mcp-server` v0.1.0 publish remains held on the SAS bootstrap ceremony (per `docs/STATUS.md` §7.A).
