# Surface 4 — AgentCore Runtime Agent

*Build spec for the autonomous agent that lives on AWS Bedrock AgentCore, plans/reasons over candidate services, executes payments via the AEP MCP server, and streams its work back to a Seeker phone over SSE. This is the AWS judging-criterion centerpiece.*

*Version: v1 · 2026-05-06*
*Master spec: `docs/aep-reflex-tech-spec.md` (lines 365–472 + cross-cutting §475–516, risks §573–586, open questions §602–611). Cite master for cross-surface details; this file inlines everything Surface-4-specific.*

---

## Owner

**TBD** — assign before Day 1. Critical-path surface (gates demo).

---

## Stack

- **Bedrock AgentCore Runtime** — microVM-isolated session, up to 8h
- **Strands SDK** — agent framework (the loop below is a Strands agent)
- **Bedrock Claude Sonnet 4** — LLM for reasoning + synthesis
- **AgentCore Gateway** — wraps the AEP MCP server (`@agenomics/mcp-server`) as MCP tools the Strands agent can call
- **AgentCore Memory** —
  - long-term: pricing history per service per agent (`pricing_*` keys)
  - short-term: current session task graph + decision records (`decision_*` keys)
- **AgentCore Identity** — OAuth token vault for any web2 services Nova Act needs
- **AgentCore Browser** — managed Chromium with live view + replay (live view is streamed to mobile via SSE)
- **Nova Act SDK** — browser-automation sub-agent invoked by Strands
- **AgentCore Observability** — every LLM call, tool call, and economic decision logged to CloudWatch

---

## Interface contracts

### IC-1: Mobile → AgentCore (inlined verbatim from master)

```
POST https://reflex.agenomics.xyz/v1/sessions
Authorization: Bearer <agent_jwt>  // signed by Solana wallet at install
Body: {
  agent_address: string,            // Solana pubkey
  prompt: string,                   // user's natural-language task
  budget_usdc_micros: number,       // already-signed Vault delegation
  vault_session_signature: string   // Solana signature over budget delegation
}
Response: {
  session_id: string,
  stream_url: string                // SSE endpoint for live narration
}
```

```
GET https://reflex.agenomics.xyz/v1/sessions/{session_id}/stream
→ Server-Sent Events:
  event: reasoning   data: { decision_text, candidates, selection }
  event: payment     data: { service_url, amount, tx_hash, network }
  event: result      data: { final_output, total_spent, refund }
  event: done        data: { session_id }
```

`reflex.agenomics.xyz` is a DNS subdomain owned by Surface 4. It is **not yet provisioned** — see `open-questions.md`.

### IC-2: AgentCore → AEP MCP (via Gateway)

The AEP MCP server (`@agenomics/mcp-server`) is **unchanged**. AgentCore Gateway wraps the server's existing tools and exposes them as MCP tools to the Strands agent.

- Current tool count per `README.md`: **27** (note: `docs/api-reference.md` says "25" — see open question, this is a master/repo inconsistency).
- After Surface 2 ships `pay_x402_service`: **28**.
- Surface 4 consumes both the existing tools (esp. `discover_agents`, `x402_bazaar_search`, `create_escrow`, `accept_task`, `submit_milestone`, `get_agent_profile`) and the new `pay_x402_service`.

Auth on this hop is HTTPS + Gateway-managed bearer auth tied to `agent_address` (see Cross-cutting §Auth boundaries).

For the full `pay_x402_service` tool signature (IC-3) see master §IC-3 lines 109–134; Surface 4 only consumes it.

---

## The agent loop

This is the Strands agent's main loop (pseudocode, verbatim from master):

```python
# Pseudocode of the Strands agent's main loop
async def run_session(prompt: str, budget_micros: int):
    # 1. Plan: what AEP-native providers and what x402 services?
    aep_candidates = await mcp.discover_agents(capability=infer_capability(prompt))
    bazaar_candidates = await mcp.x402_bazaar_search(query=prompt)

    # 2. Reason: score and pick
    candidates = aep_candidates + bazaar_candidates
    reasoning = await llm.invoke(
        prompt=ECONOMIC_REASONING_PROMPT.format(
            candidates=candidates,
            budget=budget_micros,
            task=prompt,
        ),
        max_tokens=400,
    )
    selection = parse_selection(reasoning)
    await memory.write(f"decision_{session_id}", reasoning)
    await stream_to_mobile("reasoning", reasoning)

    # 3. Execute: dispatch to AEP path or x402 path
    results = []
    for choice in selection:
        if choice.type == "aep":
            r = await mcp.create_escrow(seller=choice.agent, amount=choice.price)
            await mcp.accept_task(escrow=r.escrow)
            # ... wait for submit_milestone, then approve via biometric on phone
        elif choice.type == "x402":
            r = await mcp.pay_x402_service(
                service_url=choice.url,
                max_price_usdc_micros=choice.price,
                reasoning=choice.justification,
                request=build_request(choice, prompt),
            )
        results.append(r)
        await stream_to_mobile("payment", r.payment)

    # 4. Synthesize and return
    final = await llm.invoke(
        prompt=SYNTHESIS_PROMPT.format(results=results, task=prompt),
    )
    await stream_to_mobile("result", final)
    return final
```

Every call to `mcp.*` is a Gateway-wrapped MCP tool (IC-2). Every `stream_to_mobile` is an SSE event over the IC-1 stream URL. `memory.write` lands in AgentCore Memory.

---

## The economic-reasoning prompt (the AWS-judge moment)

This is what the AWS judges will see narrated on the phone screen. **Verbatim from master — do not paraphrase, do not edit without an ADR.**

```
You are an autonomous agent with a budget of {budget_micros} USDC micros.
You are choosing between {N} candidate services to complete this task:

  {task}

Candidates:
{candidates_table}  # name, source (AEP/Bazaar), price, reputation, reliability

Score each by: (1 / price_usdc) * reputation * historical_reliability.
Pick the top {k} that fit the budget.

Output JSON:
{
  "ranked_candidates": [...],
  "selection": [...],
  "reasoning": "Two to three sentences. Be concrete about why each was picked.
                Mention the score numerically. Do not hedge."
}
```

The `reasoning` text is what gets streamed as the SSE `reasoning` event (IC-1) and also written to AgentCore Memory keyed by `decision_{session_id}`. It is the primary human-readable artifact in the demo. The numeric scoring requirement (no hedging, mention scores numerically) is a deliberate prompt-design choice for the judging rubric.

A `SYNTHESIS_PROMPT` is also referenced in the loop (step 4); its exact wording is owner's discretion but must produce a final user-facing answer that cites which candidates were used.

---

## Self-monetized endpoint (Bazaar listing)

The agent itself is sellable on Bazaar. Deploy the AWS sample `sample-x402-content-monetization-with-cloudfront-and-waf` at **`agent.agenomics.xyz`** (a NEW subdomain — see `open-questions.md` for provisioning).

**Design:**

- **Hostname:** `agent.agenomics.xyz` (not yet provisioned; alongside `reflex.agenomics.xyz` from IC-1, this is Day-1 infra work)
- **Endpoint:** `POST /v1/analyze`
  - **Input:** a query (natural language)
  - **Output:** the agent's reasoning + cached results
- **Price:** 0.01 USDC per call, variable via x402 `upto` scheme
- **Listing:** Bazaar with `discoverable: true` after one mainnet settle (~$0.05 — budget $5 USDC per master open question #6)
- **Stack:** AWS sample `sample-x402-content-monetization-with-cloudfront-and-waf` (CloudFront + WAF + x402-protected Lambda origin)

This satisfies the **reusability / dev-enablement** criterion in the AWS rubric: *other agents* can discover and pay this one. At demo time, a second agent (orchestrated as part of rehearsal) calls this endpoint, the call settles on Base mainnet, and the receipt appears on Basescan.

Open question: mainnet vs. Sepolia for the deploy. Master defaults to mainnet (Bazaar indexing requires it). See open question #6.

---

## Cross-cutting concerns (Surface-4 slice)

### Authentication boundaries

Per master §Cross-cutting (lines 477–486):

| Boundary | Auth mechanism |
|---|---|
| Mobile → AgentCore HTTP (IC-1) | JWT issued at app install, signed by agent's Solana key, **verified by Lambda authorizer** in front of the AgentCore session API |
| AgentCore → AEP MCP (IC-2) | HTTPS + **Gateway-managed bearer auth** tied to `agent_address` |
| AgentCore → x402 services | Delegated to `pay_x402_service` (Surface 2) — uses CDP Server Wallet ECDSA (EIP-3009 or Permit2). Surface 4 never touches the wallet directly. |
| Nova Act → web2 sites | OAuth tokens drawn from **AgentCore Identity** vault |

The CDP wallet seed itself is held in AgentCore Identity (per master open question #5 — to be confirmed). Surface 4 reads/uses; it does not store.

### Observability

- **AgentCore Observability → CloudWatch** captures every LLM invocation, every MCP tool call, every economic decision.
- Each SSE `reasoning` and `payment` event emitted on IC-1 should be mirrored into a structured CloudWatch log line (one log line per event) with `session_id`, `agent_address`, and `decision_record_id` as indexed fields.
- x402 receipts are visible on Basescan; AgentCore should include the `tx_hash` returned by `pay_x402_service` in the SSE `payment` event so the mobile app can link out.

### Performance targets (Surface-4 binding)

| Metric | Target | Hard limit |
|---|---|---|
| **Task input → first reasoning event** | **≤ 3s** | **8s** |
| x402 call (cached CDP wallet, warm AgentCore) | ≤ 4s | 10s |
| Full session round-trip (3 candidates, 1 x402 settle, 1 synthesis) — soft | aim < 60s | (no hard cap; budget-bounded) |

The first-reasoning-event budget of 3s drives the warm-pool / pre-loaded-MCP-handle architecture: the AEP MCP discovery calls (`discover_agents`, `x402_bazaar_search`) must complete and the LLM's first token must stream within 3s of receiving `POST /v1/sessions`. Pre-warm Gateway connections at session start.

If the **8s hard limit** is breached at demo time, Surface 4 falls back to a pre-recorded reasoning narration for that 8s slot (per master Risk R10 mitigation).

---

## Acceptance criteria

(Verbatim from master §Surface 4 lines 466–471. Detailed checklist in `acceptance-criteria.md`.)

- [ ] Agent receives a session via API Gateway, runs the loop, streams reasoning + payments + result over SSE
- [ ] At least 3 candidates evaluated per task; reasoning is human-readable and visibly numerical
- [ ] AgentCore Memory captures every decision (`decision_*` keys) and pricing history (`pricing_*` keys); both queryable
- [ ] AgentCore Identity holds at least one OAuth token (e.g., for a Nova Act demo on a test web2 site)
- [ ] Nova Act sub-agent successfully completes one browser task with live view streamed to mobile
- [ ] Self-monetized endpoint is live, indexed on Bazaar, and successfully purchased by a second agent during rehearsal

---

## Risks (Surface-4 relevant)

From master §Risk register (lines 573–586):

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| **R3** | Nova Act access (US-only) blocks team | Medium | Medium | Confirm Day 1 (master open question #2); if blocked, swap to plain AgentCore Browser + Playwright as the sub-agent — keeps the live-view UX, loses the Nova Act branding moment |
| **R6** | AgentCore Gateway + AEP MCP integration glitches | Medium | High | Day-1 hello-world is the canary (Strands agent calls one Gateway-wrapped MCP tool end-to-end); if glitchy, eat Day 1 to fix. This is *the* foundational integration for this surface. |
| **R10** | Demo-day Wi-Fi unreliable | Medium | High | LTE hotspot per Seeker; pre-recorded 8-second segments for any live-call slot Surface 4 owns. The 3s first-reasoning target assumes good network; the pre-record is the safety net. |

Cross-reference: R4 (Bazaar mainnet settle requirement) and R8 (x402 rate-limited under demo traffic) also touch Surface 4 indirectly via the self-monetized endpoint and `pay_x402_service` consumption.

---

## Out of scope

Master §Out of scope (lines 590–598) plus Surface-4-specific exclusions:

- **Multi-tenant** AgentCore deployments (one agent per session; no shared agent state across users)
- **iOS** mobile client — Seeker is Android-only; Surface 4 doesn't need to support an iOS-shaped IC-1 caller
- **Mainnet AEP deploy** — AEP programs stay on Solana devnet for the hackathon; the self-monetized endpoint's mainnet settle is on **Base** for x402/Bazaar, not Solana mainnet. AEP mainnet is post-Day-15.
- Token launch, DAO governance, multi-chain support beyond Base, public Rust/Swift SDKs

Also explicitly out of scope for Surface 4 specifically:

- **Modifying the AEP MCP server** — Surface 2 owns the new tool; Surface 4 only consumes
- **Writing the CCTP Hook** — Surface 3 owns; Surface 4 may reference its outcome (escrow auto-close) but doesn't implement it
- **The Mobile UI** — Surface 1 owns; Surface 4 contracts at IC-1
