# Surface 4 — Acceptance Criteria

Source of truth: `docs/aep-reflex-tech-spec.md` §Surface 4 (lines 464–471) plus performance targets (lines 506–516) and cross-cutting observability (lines 488–493).

## Master criteria (verbatim, 6 bullets)

- [ ] **AC-1** — Agent receives a session via API Gateway, runs the loop, streams reasoning + payments + result over SSE
- [ ] **AC-2** — At least 3 candidates evaluated per task; reasoning is human-readable and visibly numerical
- [ ] **AC-3** — AgentCore Memory captures every decision (`decision_*` keys) and pricing history (`pricing_*` keys); both queryable
- [ ] **AC-4** — AgentCore Identity holds at least one OAuth token (e.g., for a Nova Act demo on a test web2 site)
- [ ] **AC-5** — Nova Act sub-agent successfully completes one browser task with live view streamed to mobile
- [ ] **AC-6** — Self-monetized endpoint is live, indexed on Bazaar, and successfully purchased by a second agent during rehearsal

## Implicit / derived criteria (from cross-cutting concerns)

These aren't called out as Surface-4 bullets in master but follow directly from the cross-cutting sections and are demo-blocking if missed:

- [ ] **AC-7 (perf)** — Task input → first SSE `reasoning` event ≤ **3s** (target) / ≤ **8s** (hard limit). Hard limit breach → fallback to pre-recorded narration. (Master Performance targets, line 511.)
- [ ] **AC-8 (perf)** — x402 call round-trip (cached CDP wallet, warm AgentCore) ≤ **4s** target / ≤ **10s** hard limit. (Master line 512.)
- [ ] **AC-9 (auth)** — IC-1 `POST /v1/sessions` is **JWT-protected** by a Lambda authorizer that verifies the JWT was signed by the agent's Solana key. Unsigned / expired / wrong-key requests return 401. (Master line 482.)
- [ ] **AC-10 (auth)** — AgentCore → AEP MCP traffic uses Gateway-managed bearer auth tied to `agent_address`. Cross-agent token reuse is rejected. (Master line 483.)
- [ ] **AC-11 (obs)** — Every LLM call, MCP tool call, and economic decision is logged to CloudWatch via AgentCore Observability with `session_id` + `agent_address` indexed. (Master line 490.)
- [ ] **AC-12 (obs)** — Each SSE `reasoning` / `payment` event has a 1:1 corresponding CloudWatch log line.
- [ ] **AC-13 (reasoning)** — The economic-reasoning prompt is used **verbatim** as specified in the master spec (lines 433–452). Any change requires a written ADR. The output JSON's `reasoning` field is what gets streamed to mobile.
- [ ] **AC-14 (infra)** — `reflex.agenomics.xyz` (IC-1 endpoint) and `agent.agenomics.xyz` (self-monetized endpoint, AC-6) are both DNS-provisioned and TLS-terminated by Day 1.
- [ ] **AC-15 (test)** — Pytest suite with mocked MCP + LLM passes; one full e2e per day against real AgentCore from Day 3 onward. (Master line 502.)
- [ ] **AC-16 (integration)** — Day-1 canary: Strands agent calls one Gateway-wrapped MCP tool end-to-end. Required to de-risk R6. (Master Risk R6, line 582.)
- [ ] **AC-17 (rehearsal)** — Surface 4 participates in the daily 30-min cross-surface rehearsal from Day 8 onward. (Master line 504.)

## Stage-gate alignment

- **End of Day 2** — AC-16 (Day-1 canary), and IC-1 / IC-2 frozen.
- **End of Day 7** — AC-1, AC-2, AC-13 demoable independently with mock AEP responses; SSE streaming works.
- **End of Day 10** — AC-1 through AC-5 working end-to-end with real Mobile (Surface 1) and real AEP MCP (Surface 2 + existing).
- **Day 11** — AC-6 (self-monetized endpoint live + one rehearsal purchase).
- **Demo day** — AC-7 / AC-8 hard limits not breached; if breached, fallback to pre-recorded segment.
