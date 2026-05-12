# AEP Reflex — Technical Spec

*Build spec for the four new surfaces that turn AEP into a Seeker-native, x402-enabled, cross-chain mobile cognition node. Designed for parallel execution by a dream team. Voice-matched to the pitch and roadmap docs.*

*Version: v1 · 2026-05-06*

---

## TL;DR

Four surfaces. Two are protocol-adjacent (extend AEP); two are integrations (mobile + agent). Built in parallel by separate owners against frozen interface contracts, joined at integration time on Day 8.

| # | Surface | Stack | Owner | Critical path? |
|---|---|---|---|---|
| 1 | **Mobile UI** | Kotlin + Compose on Seeker, MWA 2.0, Seed Vault | TBD | Yes (gates demo) |
| 2 | **`pay_x402_service` MCP tool** | TypeScript, x402 client, CDP Server Wallet | TBD | Yes (gates Surface 4) |
| 3 | **CCTP V2 Hook** (or relayer fallback) | Anchor program + TS hook payload | TBD | No (cinematic only) |
| 4 | **AgentCore Runtime agent** | Strands SDK, Bedrock Claude, Nova Act, Gateway | TBD | Yes (gates demo) |

The existing AEP devnet programs (Vault, Registry, Settlement) and the 27-real-tool MCP server are **inputs**, not work items. Don't modify the deployed programs unless absolutely required. Surface 2 added one new tool (`pay_x402_service`, stub) bringing the public count to 28 — the authoritative number lives in `docs/api-reference.md` and `README.md`.

---

## System diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        SEEKER (Surface 1)                       │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Compose UI → MWA 2.0 → Seed Vault Wallet → secure element  │ │
│  └────────────────────────────────────────────────────────────┘ │
│         │                                          │            │
│         │ HTTP + JWT                               │ NFC        │
│         ▼                                          ▼            │
└─────────┼──────────────────────────────────────────┼────────────┘
          │                                          │
          ▼                                          │
┌─────────────────────────────────────────┐          │
│   AgentCore (Surface 4) on AWS          │          │
│   ┌─────────────────────────────────┐   │          │
│   │ Strands agent (Claude Sonnet)   │   │          │
│   │ ├─ Memory: decision history     │   │          │
│   │ ├─ Identity: OAuth vault        │   │          │
│   │ ├─ Browser: Nova Act sub-agent  │   │          │
│   │ └─ Gateway → AEP MCP tools      │   │          │
│   └─────────────────────────────────┘   │          │
│           │              │              │          │
│           │              │              │          │
│           ▼              ▼              │          │
│  ┌────────────────┐  ┌──────────────┐   │          │
│  │ pay_x402_      │  │ AEP MCP      │   │          │
│  │ service tool   │  │ (existing)   │   │          │
│  │ (Surface 2)    │  │              │   │          │
│  └───────┬────────┘  └──────┬───────┘   │          │
└──────────┼─────────────────┼─────────────         │
           │                 │                       │
           ▼                 ▼                       ▼
   ┌──────────────┐    ┌─────────────────────────────────┐
   │ x402 + Base  │    │ AEP on Solana                   │
   │ ┌──────────┐ │    │ Vault │ Registry │ Settlement   │
   │ │ Bazaar   │ │    │     (existing devnet programs)  │
   │ │ services │ │    │                                 │
   │ └──────────┘ │    │     ▲                           │
   │      │       │    │     │ approve_milestone         │
   │      ▼       │    │     │                           │
   │ ┌──────────┐ │    │ ┌───┴────────────────┐          │
   │ │ CDP      │ │    │ │ CCTP V2 Hook       │          │
   │ │ Wallet   │ │────┼─▶│ (Surface 3)        │          │
   │ └──────────┘ │    │ └────────────────────┘          │
   └──────────────┘    └─────────────────────────────────┘
```

---

## Interface contracts (frozen Day 1)

These are the contracts between surfaces. Once the team agrees, they don't change without a written ADR. Parallel work depends on these being stable.

### IC-1: Mobile → AgentCore

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

### IC-2: AgentCore → AEP MCP (via Gateway)

The AEP MCP server is unchanged. Gateway wraps existing tools and exposes them as MCP tools to the Strands agent. **One new tool added: `pay_x402_service` (Surface 2)**.

### IC-3: `pay_x402_service` tool signature

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

The `reasoning` field is **mandatory** — calls without it are rejected. This is what makes the agent's decision auditable and is the primary AWS judging-criterion artifact.

### IC-4: CCTP Hook payload (Solana side)

```rust
// Hook called after CCTP V2 mint on Solana
pub struct ReflexHookPayload {
    pub escrow_pda: Pubkey,           // AEP Settlement escrow
    pub milestone_index: u8,          // which milestone to approve
    pub base_tx_hash: [u8; 32],       // Base-side x402 settle tx
    pub amount_returned_micros: u64,  // USDC returned to Solana
}
```

The Hook program calls AEP Settlement `approve_milestone` via CPI. Idempotent on `base_tx_hash` to prevent replay.

---

## Surface 1 — Mobile UI

**Owner: TBD · Critical path: yes**

### Stack

- **Kotlin + Jetpack Compose** (Solana Mobile recommendation)
- **MWA 2.0** (`com.solanamobile:mobile-wallet-adapter-clientlib-ktx`)
- **Solana Kotlin SDK** for direct RPC reads (Anchor IDL → Kotlin client codegen)
- **OkHttp** for AgentCore HTTP + SSE streaming
- **CameraX** + ML Kit for QR scanning (agent address sharing fallback if NFC fails)
- **Android NFC** with HCE (Host Card Emulation) for peer-to-peer agent handshake
- **DataStore** for local persistence of session history

### Screens

| Screen | Purpose | Key interactions |
|---|---|---|
| **Onboarding** | First launch; bind Genesis Token to AEP agent | Read Genesis Token via Mobile Wallet API; call AEP `register_agent` via MWA-signed tx |
| **Agent Home** | Default screen post-launch | Show agent reputation, vault balance, recent sessions; pulled from AEP RPC + dashboard API |
| **Task Input** | User types prompt + sets session budget | Compose text field; double-tap power → biometric → Seed Vault signs `update_vault_policy` |
| **Live Session** | Watch the agent work in real time | SSE stream from AgentCore renders reasoning, payments, results; embedded WebView for Browser sub-agent live view |
| **Two-Phone NFC** | Tap to handshake with another Seeker | NFC HCE service exchanges agent address + nonce; both phones build a `create_escrow` tx; both sign via MWA |
| **Settings** | Vault policy, allowlists, pause | Direct calls to AEP Vault program; biometric on every state-changing tx |

### MWA integration points

Every state-changing AEP transaction goes through MWA → Seed Vault. **Never store private keys in app memory.** Specifically:

1. `register_agent` (Onboarding) — `signAndSendTransactions`
2. `update_vault_policy` (Task Input session budget) — `signAndSendTransactions`, biometric prompted by Seed Vault Wallet
3. `create_escrow` (NFC handshake) — `signAndSendTransactions`, both phones sign their respective sides
4. `approve_milestone` (Settings, manual milestone approval) — `signAndSendTransactions`
5. `pause_vault` / `update_vault_allowlist` (Settings) — `signAndSendTransactions`

Use `signAndSendTransactions` (not the deprecated `signTransactions`); pass the latest blockhash; handle `TransactionExpiredBlockheightExceededError` with retry.

### NFC peer-to-peer flow

Both phones run an NFC HCE service. When tapped:

```
Phone A → Phone B: APDU SELECT { aid: AEP_HANDSHAKE_AID }
Phone B → Phone A: APDU READ_AGENT_CARD
                   { agent_address, nonce_b, capabilities[] }
Phone A → Phone B: APDU PROPOSE_ESCROW
                   { agent_address, nonce_a, amount, milestones[] }
Phone B → Phone A: APDU ACCEPT_OR_REJECT
                   { signature_b, terms_hash }
```

Both phones then build the same `create_escrow` transaction (deterministic from terms_hash), sign their respective sides via MWA, and submit. Reputation updates land on both screens via Helius webhook → app push.

**Risk:** NFC HCE on Android is reliable but Seeker-specific quirks possible. Mitigation: QR-code fallback (Phone A renders QR with terms_hash; Phone B scans). Functionally identical, just less cinematic.

### Acceptance criteria

- [ ] Onboarding completes in ≤ 30s on a factory-fresh Seeker (Genesis Token detect → AEP registered → home screen)
- [ ] Task Input → live agent narration latency ≤ 3s (network dependent)
- [ ] Vault policy update is biometric-gated; no policy changes possible without Seed Vault prompt
- [ ] NFC handshake completes in ≤ 5s and produces a valid on-chain `create_escrow` tx visible on Solscan
- [ ] App handles AgentCore SSE disconnection with graceful reconnect (no lost session state)
- [ ] APK is signed and installable via `adb install` and via dApp Store builder upload

---

## Surface 2 — `pay_x402_service` MCP tool

**Owner: TBD · Critical path: yes**

### What it is

A new tool added to the AEP MCP server. Wraps an x402 client, debits the agent's Vault, settles via CDP Facilitator on Base, returns the response + receipt.

### Implementation

TypeScript, lives in `@agenomics/mcp-server` alongside the existing 27 real tools (see `docs/api-reference.md`); landing this stub took the public count to 28 (the real CDP-backed implementation is the Day 3-7 owner's job — ADR-087 Phase B).

```typescript
// src/tools/pay-x402-service.ts
import { x402Client } from "@coinbase/x402";
import { CdpClient } from "@coinbase/cdp-sdk";
import { recordDecision } from "../memory";

export async function payX402Service(params: PayX402Params): Promise<PayX402Result> {
  // 1. Validate against agent's Vault policy
  const vault = await getVaultPolicy(params.agent_address);
  if (params.max_price_usdc_micros > vault.per_tx_limit_micros) {
    throw new ToolError("EXCEEDS_VAULT_PER_TX_LIMIT");
  }

  // 2. Get CDP Server Wallet for this agent (cached, derived from agent_address)
  const wallet = await getOrCreateAgentWallet(params.agent_address);

  // 3. Make the x402 call
  const client = new x402Client({ wallet, facilitator: "cdp" });
  const start = Date.now();
  const response = await client.fetch(params.service_url, params.request);
  const duration_ms = Date.now() - start;

  // 4. Record the decision in AgentCore Memory
  const decision_record_id = await recordDecision({
    agent_address: params.agent_address,
    service_url: params.service_url,
    reasoning: params.reasoning,
    payment: response.payment,
    duration_ms,
  });

  // 5. Update agent's pricing history (long-term Memory)
  await updatePricingHistory(params.agent_address, {
    service_url: params.service_url,
    paid_micros: response.payment.amount_paid_micros,
    quality_signal: response.status === 200 ? 1 : 0,
  });

  return {
    status: response.status,
    body: response.body,
    payment: response.payment,
    duration_ms,
    decision_record_id,
  };
}
```

### Why direct Vault debit, not Settlement escrow

x402 calls are one-shot, atomic, and don't have a counterparty in the AEP Registry. Wrapping every call in a Settlement escrow would create dead milestones. Settlement is for **AEP-to-AEP** relationships (where both sides are registered agents); `pay_x402_service` is for **AEP-to-Bazaar** consumption.

The exception is the CCTP cross-chain flow (Surface 3), which uses a *session-level* Settlement escrow to reconcile the budget. That's covered separately.

### Error handling

| Error | Behavior |
|---|---|
| `EXCEEDS_VAULT_PER_TX_LIMIT` | Reject before payment; tool returns error |
| `EXCEEDS_VAULT_DAILY_LIMIT` | Reject before payment; tool returns error |
| 402 with quote > `max_price_usdc_micros` | Reject; do not pay; return error with quote |
| 402 + payment + 200 | Standard success |
| 402 + payment + 5xx | Refund attempt via x402 facilitator; if refund fails, log and surface |
| Network timeout post-payment | Retry idempotency check via `payment_id`; do not double-pay |

### Acceptance criteria

- [ ] Tool registered in AEP MCP server and discoverable via Gateway
- [ ] All 6 error cases above produce structured error responses
- [ ] Decision record persisted to AgentCore Memory and retrievable by `decision_record_id`
- [ ] Pricing history updated on every call, queryable via existing `get_agent_profile`
- [ ] Test suite: 20+ unit tests (mocked CDP), 5 integration tests against Base Sepolia + AEP devnet

---

## Surface 3 — CCTP V2 Hook (or relayer fallback)

**Owner: TBD · Critical path: no** (cinematic close only; demo is complete without it)

### What it does

Lets the agent's session budget round-trip cleanly across chains: USDC starts on Solana (in AEP Vault), some flows to Base for x402 payments, leftover bridges back to Solana via CCTP V2, and the post-mint Hook calls AEP Settlement `approve_milestone` to close the session.

### The session-level escrow pattern

This is the architecture that makes Hooks meaningful:

1. User opens session with $0.50 budget → Mobile signs `update_vault_policy`
2. Agent calls AEP `create_escrow`:
   - Buyer: agent
   - Seller: a "session-pool" PDA that the agent itself controls
   - Amount: $0.50 USDC from Vault
   - Milestones: N (one per planned x402 call)
3. For each x402 call:
   - `pay_x402_service` debits via Base (CCTP-bridged USDC)
   - On payment success, `submit_milestone(i)` is called
   - CCTP V2 burn on Base side fires
   - On Solana mint, **Hook calls `approve_milestone(i)`** — funds released back to agent's Vault
4. Session closes: any unfilled milestones are `cancel_escrow`'d, USDC stays in Vault

The narrative at demo time: *"$0.50 went out as session budget, $0.42 was actually spent on three Bazaar services, $0.08 came back via CCTP and auto-closed the escrow."*

### Hook program (Solana, new)

A small Anchor program (~5–10 KB binary) that:
- Receives the CCTP mint with `ReflexHookPayload` (see IC-4)
- Validates: payload signer matches a registered agent's CDP wallet binding in AEP Registry
- Calls AEP Settlement `approve_milestone` via CPI
- Emits `MilestoneAutoApproved { escrow, milestone_index, base_tx_hash }` event

Idempotency on `(escrow, milestone_index, base_tx_hash)` to prevent replay.

### Fallback: off-chain relayer

If CCTP V2 Hooks slip on Solana side, ship the relayer instead:

- Lambda watching Base mainnet for x402 settle events from registered agents
- On detection, calls AEP Settlement `approve_milestone` directly with relayer signing key
- Relayer key is in AgentCore Identity vault; rotated per session
- Less cinematic (requires off-chain trust), but functionally equivalent and ships in a day

**Decision rule:** Day 7 status check. If CCTP V2 Solana Hook integration isn't end-to-end working in a test environment, switch to relayer. Don't sink the demo for an architectural purity point.

### Acceptance criteria

- [ ] Hook path: full Base → CCTP burn → Solana mint → Hook → `approve_milestone` → AEP Settlement state change in ≤ 30s
- [ ] OR Relayer path: Base x402 settle → Lambda detection → `approve_milestone` in ≤ 60s
- [ ] Idempotent on retry (test by re-emitting same Base tx hash)
- [ ] Replay-protected (test with malicious double-call)
- [ ] One demo-day rehearsal with $5 of real USDC round-tripped successfully

---

## Surface 4 — AgentCore Runtime agent

**Owner: TBD · Critical path: yes**

### Stack

- **Bedrock AgentCore Runtime** (microVM-isolated session, up to 8h)
- **Strands SDK** (agent framework)
- **Bedrock Claude Sonnet 4** (LLM)
- **AgentCore Gateway** (wraps AEP MCP server as MCP tools)
- **AgentCore Memory** (long-term: pricing history per service per agent; short-term: current session task graph)
- **AgentCore Identity** (OAuth token vault for any web2 services Nova Act needs)
- **AgentCore Browser** (managed Chromium with live view + replay)
- **Nova Act SDK** (browser automation; subordinate sub-agent)
- **AgentCore Observability** (CloudWatch — every economic decision logged)

### The agent loop

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

### The economic-reasoning prompt (the AWS-judge moment)

This prompt is what the AWS judges will see narrated on the phone screen. Tune it carefully.

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

### Self-monetized endpoint (Bazaar listing)

The agent itself is sellable on Bazaar. Deploy the AWS sample `sample-x402-content-monetization-with-cloudfront-and-waf` at `agent.agenomics.xyz`:

- Endpoint: `POST /v1/analyze` — takes a query, returns the agent's reasoning + cached results
- Price: 0.01 USDC per call (variable via x402 `upto` scheme)
- Listed on Bazaar with `discoverable: true` after one mainnet settle (~$0.05)

This is the reusability/dev-enablement criterion in the AWS rubric — *other agents* can find and pay this one.

### Acceptance criteria

- [ ] Agent receives a session via API Gateway, runs the loop, streams reasoning + payments + result over SSE
- [ ] At least 3 candidates evaluated per task; reasoning is human-readable and visibly numerical
- [ ] AgentCore Memory captures every decision (`decision_*` keys) and pricing history (`pricing_*` keys); both queryable
- [ ] AgentCore Identity holds at least one OAuth token (e.g., for a Nova Act demo on a test web2 site)
- [ ] Nova Act sub-agent successfully completes one browser task with live view streamed to mobile
- [ ] Self-monetized endpoint is live, indexed on Bazaar, and successfully purchased by a second agent during rehearsal

---

## Cross-cutting concerns

### Authentication boundaries

| Boundary | Auth mechanism |
|---|---|
| Mobile → AEP programs | Solana wallet signature via MWA → Seed Vault |
| Mobile → AgentCore HTTP | JWT issued at app install, signed by agent's Solana key, verified by Lambda authorizer |
| AgentCore → AEP MCP | HTTPS, Gateway-managed bearer auth tied to agent_address |
| AgentCore → x402 services | CDP Server Wallet ECDSA signature (EIP-3009 or Permit2) |
| AgentCore → CCTP | CDP Server Wallet ECDSA on Base; CCTP attestation on Solana |
| Nova Act → web2 sites | OAuth tokens from AgentCore Identity vault |

### Observability

- **AgentCore Observability** captures every LLM call, tool call, and economic decision → CloudWatch
- **Helius webhooks** stream AEP program events (Vault, Registry, Settlement) → `app.agenomics.xyz` dashboard in real time
- **x402 receipts** visible on Basescan; cross-link from session UI
- **CCTP transfers** visible on Solscan + Basescan; cross-link both directions

### Testing strategy

| Layer | Approach |
|---|---|
| AEP programs | Existing Anchor tests on devnet; do not modify |
| `pay_x402_service` tool | Unit tests with mocked CDP; integration tests against Base Sepolia + AEP devnet |
| CCTP Hook program | Anchor tests + integration test with real CCTP V2 attestation on devnet |
| AgentCore agent | Pytest with mocked MCP + LLM; one full e2e per day against real AgentCore |
| Mobile app | Compose UI tests; one full e2e per day on real Seeker hardware |
| Cross-surface integration | Daily 30-min rehearsal from Day 8 onward |

### Performance targets

| Metric | Target | Hard limit |
|---|---|---|
| Mobile cold start → home screen | ≤ 2s | 5s |
| Task input → first reasoning event | ≤ 3s | 8s |
| x402 call (cached CDP wallet, warm AgentCore) | ≤ 4s | 10s |
| NFC tap → on-chain `create_escrow` confirmed | ≤ 8s | 20s |
| CCTP round-trip (Base → Solana with Hook) | ≤ 30s | 90s |

If any *hard limit* is breached at demo time, that surface is fallback-mode only and gets cut from the live flow.

---

## Build sequence (14 days)

### Days 1–2: Foundations

| Stream | Tasks |
|---|---|
| **Surface 1** | Project scaffold, MWA hello world on Seeker, Genesis Token read working |
| **Surface 2** | x402 client integrated into AEP MCP server skeleton, returns mock payments |
| **Surface 3** | CCTP V2 docs read, Anchor program scaffold, devnet test wallet funded |
| **Surface 4** | AgentCore Runtime spun up, Bedrock Claude available, AEP MCP registered to Gateway |
| **Shared** | Kiro `.kiro/specs/` initialized with one spec per surface, checked into git |

**Stage gate end of Day 2:** All four owners can demo a 30-second hello-world from their surface. Interface contracts (IC-1 through IC-4) frozen.

### Days 3–7: Core build

| Stream | Tasks |
|---|---|
| **Surface 1** | All 6 screens built; MWA signing works for `register_agent` and `update_vault_policy` |
| **Surface 2** | `pay_x402_service` tool ships against real Base Sepolia; unit tests pass |
| **Surface 3** | Hook program deployed to devnet; integration test with simulated CCTP attestation passes; relayer fallback Lambda also deployed |
| **Surface 4** | Agent loop runs end-to-end with mock AEP responses; economic-reasoning prompt tuned; SSE streaming working |

**Stage gate end of Day 7:** Each surface independently demoable. Decision: CCTP Hook vs. relayer for the demo path.

### Days 8–10: Integration

| Day | Focus |
|---|---|
| **Day 8** | Mobile ↔ AgentCore wired up via SSE; first end-to-end session on devnet |
| **Day 9** | Nova Act sub-agent integrated; live browser view in mobile app; CCTP path live (or relayer if fallback chosen) |
| **Day 10** | NFC handshake working between two real Seekers; two-agent escrow on devnet from a tap |

**Stage gate end of Day 10:** Full demo flow runs end-to-end on real hardware in ≤ 100 seconds.

### Days 11–12: Polish

- Demo rehearsals (10x minimum)
- Performance tuning to hit hard limits in [Performance targets](#performance-targets)
- Self-monetized endpoint deployed, listed on Bazaar with one real settle
- Edge cases hardened (each contingency in pitch doc rehearsed)
- Demo videos shot (90s + 4-min cuts)

### Days 13–14: Submission

- Submission package: APK signed and hosted on GitHub Releases
- Two READMEs (Easy A + Coinbase × AWS), each judging-criterion-mapped
- dApp Store draft listing complete
- Public mainnet roadmap banner live on docs
- Sponsorship outreach replies actioned

---

## Risk register

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| R1 | NFC HCE fails or Seeker-quirky | Medium | Medium | QR fallback ready Day 5 |
| R2 | CCTP V2 Hook slips | High | Low | Relayer fallback ready Day 7 |
| R3 | Nova Act access (US-only) blocks team | Medium | Medium | Confirm Day 1; if blocked, swap to plain AgentCore Browser + Playwright |
| R4 | Bazaar listing requires mainnet settle | Certain | Low | Budget $0.10 USDC; do it Day 11 |
| R5 | Kiro Sonnet capacity throttled | Medium | Low | Claude Code as fallback IDE |
| R6 | AgentCore Gateway + AEP MCP integration glitches | Medium | High | Day-1 hello-world is canary; if glitchy, eat the day to fix |
| R7 | Seeker firmware updates break MWA mid-build | Low | High | Lock OS version on test devices; do not auto-update |
| R8 | x402 rate-limited under demo traffic | Low | Medium | Pre-purchase 50+ test calls; cache responses for retries |
| R9 | Dev wallet keys committed to git | Low | Catastrophic | Pre-commit hooks enforced from Day 1; secrets in AWS SSM only |
| R10 | Demo-day Wi-Fi unreliable | Medium | High | LTE hotspot per Seeker; pre-recorded 8-second segments for live-call slots |

---

## Out of scope (explicitly)

- Mainnet deploy of AEP programs (covered by mainnet roadmap, Day 15+ post-hackathon)
- Token launch
- DAO governance
- Multi-chain support beyond Base
- iOS app (Seeker is Android-only; iOS is post-v1.0)
- Public SDK releases for Rust / Swift (Milestone 2)
- Multi-tenant vault product (v1.0)

---

## Open questions

These need answers before Day 3:

1. **Who owns each surface?** Assign before build starts.
2. **Which teammate has Nova Act US-account access?** Confirm.
3. **CCTP V2 Hook vs. relayer — which is the Day-7 default assumption?** Default to Hook; relayer is fallback.
4. **What's the demo's hero web2 site for Nova Act?** Suggest a public-data site (no login required) to avoid OAuth complexity. Travel aggregator? Public DOAJ search?
5. **Where does the agent's CDP wallet seed live?** AgentCore Identity vault. Confirmed?
6. **Are we deploying the self-monetized endpoint on mainnet Base, or Sepolia?** Mainnet — required for Bazaar indexing. Budget $5 USDC.

---

*Spec is a living document. ADRs go in `docs/adr/` in the repo. Material changes to interface contracts (IC-1 through IC-4) require written ADR + sign-off from affected owners.*
