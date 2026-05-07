# Surface 2 — Open questions

Pulled from master `docs/aep-reflex-tech-spec.md` §"Open questions" (line ~602), filtered to questions that affect Surface 2, plus new questions raised during the focused spec read.

## From master §"Open questions"

### Q1 — Who owns each surface?
**Affects Surface 2:** yes — the `Owner` field in `spec.md` is `TBD`.
**Suggested answer:** needs decision. Assign before Day 3 per master.

### Q5 — Where does the agent's CDP wallet seed live?
**Affects Surface 2:** yes — Step 2 of the implementation flow (`getOrCreateAgentWallet`) needs an authoritative seed source.
**Master's tentative answer:** "AgentCore Identity vault. Confirmed?"
**Suggested answer:** AgentCore Identity vault is the right home (also matches the auth-boundaries table for AgentCore → x402 services). Treat as confirmed unless Surface 4 owner pushes back; close the question with a written note in `docs/adr/` once Surface 4 is up.

### Q6 — Self-monetized endpoint on mainnet Base or Sepolia?
**Affects Surface 2:** indirectly — the self-monetized endpoint itself is Surface 4's deliverable, but `pay_x402_service` is what would be used (by other agents) to call it. Whichever network the endpoint runs on determines whether `pay_x402_service`'s `payment.network = "base-mainnet"` path is exercised at demo time.
**Master's tentative answer:** "Mainnet — required for Bazaar indexing. Budget $5 USDC."
**Suggested answer:** mainnet (matches master). Surface 2 must therefore have its mainnet config path tested before demo day, not only Sepolia.

## Questions explicitly **not** Surface 2's

For traceability, these master open questions do not block Surface 2:
- Q2 (Nova Act US-account access) — Surface 4 only.
- Q3 (CCTP V2 Hook vs. relayer) — Surface 3 only. Surface 2's contract output (`payment.tx_hash`) is the same either way.
- Q4 (hero web2 site for Nova Act) — Surface 4 only.

## New questions raised by this spec

### N1 — Authoritative tool count (27 vs. 25)
**Suggested answer:** needs decision (lightweight). `README.md` line 3 says "27 tools"; `docs/api-reference.md` line 3 says "All 25 MCP tools". Master spec asserts 27. Reconcile during the docs-update step that bumps the count to 28 — either confirm the true current count by inspecting the `@agenomics/mcp-server` tool registry, or audit-drop the docs to match. Whoever updates `docs/api-reference.md` from 25→28 should verify the underlying tool list rather than just incrementing.

### N2 — Where is the v1→v2 vault-transfer migration in the path of Surface 2?
**Suggested answer:** out of path for v1 of this tool, **but** flag for any future change. The current design reads vault policy only and debits via CDP Server Wallet on Base — no vault-USDC movement. If Surface 2 ever moves USDC inside the Solana Vault (e.g., for a settlement-escrow alternate flow), it must use the v2 path (`AEP_USE_V2_VAULT_TRANSFER=1`, per `docs/STATUS.md` §7.C). Document this constraint in the tool's source comment so the next maintainer doesn't accidentally wire v1.

### N3 — npm publish blocker for downstream Surface 4 consumption
**Suggested answer:** workspace `file:` resolution covers the hackathon (per `docs/STATUS.md` §7.A line 152). Surface 4 should not block on `@agenomics/mcp-server@0.1.0` being on npm. Public Reflex contributors are blocked until the SAS bootstrap ceremony lands — call this out in any external Reflex docs but it does **not** affect demo-day functionality.

### N4 — Idempotency key / payment_id surface from `@coinbase/x402`
**Suggested answer:** needs decision (depends on SDK shape). The error-handling row "Network timeout post-payment / Retry idempotency check via `payment_id`" assumes `@coinbase/x402` exposes a stable `payment_id` (or equivalent) the tool can re-query. Verify on Day 1–2 against the actual SDK API; if the SDK doesn't expose this directly, design a wrapper that stores `(agent_address, service_url, request_hash, started_at)` in a short-lived store keyed before payment is initiated, and use that to dedupe retries.

### N5 — Refund failure surfacing semantics
**Suggested answer:** structured error with `code = "REFUND_FAILED"` plus the original 5xx + the refund-attempt result, **and** the call still counts as a failed call for pricing-history `quality_signal = 0`. Worth confirming with Surface 4 owner so the agent loop knows how to treat this case (retry a different candidate vs. surface to user).

### N6 — Tool-listing source of truth
**Suggested answer:** needs decision. If `docs/api-reference.md` is hand-maintained, the count and per-tool docs need a manual update (28 entries, new entry for `pay_x402_service`). If it's generated from the MCP server's tool registry, just regenerate. Confirm before the docs PR.

### N7 — Caching layer location for R8 retries
**Suggested answer:** in-tool, in-process LRU keyed on `(service_url, request_hash)` for idempotent GETs only. POSTs never cached. Lifetime: per-session (cleared between AgentCore microVM sessions). Don't over-engineer; the goal is rate-limit survival on demo day, not a general-purpose response cache.
