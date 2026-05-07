# Surface 4 — Open Questions

Source: `docs/aep-reflex-tech-spec.md` §Open questions (lines 602–611). Subset of master questions that block or shape Surface 4, plus questions surfaced while writing this spec.

These need answers **before Day 3**.

---

## From master spec

### OQ-2 — Nova Act US-account access (master #2)

> Which teammate has Nova Act US-account access? Confirm.

**Why it matters for Surface 4:** Nova Act SDK is the listed browser-automation sub-agent (master line 378). Nova Act is US-only as of writing (Risk R3, line 579). If no teammate has access, AC-5 (Nova Act sub-agent demo) is blocked.

**Action:** Confirm Day 1. If blocked, swap to plain AgentCore Browser + Playwright (per R3 mitigation) — preserves the live-view UX, loses the Nova Act branding moment, and we should update the prompts/messaging accordingly.

**Owner:** TBD
**Status:** Open

---

### OQ-4 — Hero web2 site for Nova Act (master #4)

> What's the demo's hero web2 site for Nova Act? Suggest a public-data site (no login required) to avoid OAuth complexity. Travel aggregator? Public DOAJ search?

**Why it matters for Surface 4:** This is the target the Nova Act sub-agent operates against during the live demo. Choice cascades into:
- Whether AgentCore Identity actually needs an OAuth token (AC-4) or a placeholder one
- Whether the Browser session is reproducible across rehearsals (rate limits, anti-bot, regional content)
- Demo narrative — what does the audience see Nova Act *do*?

**Constraints to apply when picking:**
- No login → no OAuth complexity → reduces R3 + auth-vault risk
- Stable DOM (no aggressive A/B) → reproducible rehearsals
- Public, non-paywalled, non-rate-limited
- Visually legible at demo distance (large fonts, simple layout)

**Candidates floated by master:** travel aggregator, public DOAJ search.

**Owner:** TBD
**Status:** Open

---

### OQ-5 — CDP wallet seed location (master #5)

> Where does the agent's CDP wallet seed live? AgentCore Identity vault. Confirmed?

**Why it matters for Surface 4:** Surface 4 reads the CDP wallet via `pay_x402_service` (Surface 2 owns the actual call). Surface 4 itself never holds the seed but depends on Identity vault being the canonical store so that:
- Cross-session reuse works (cached wallet → meets AC-8 perf budget)
- The seed isn't accidentally re-derived per session (which would require a fresh on-chain funding flow each time)

**Action:** Confirm with Surface 2 owner that Identity vault is the chosen store and that derivation is deterministic from `agent_address`.

**Owner:** TBD (Surface 2 + Surface 4 jointly)
**Status:** Master *assumes* yes; needs explicit confirmation.

---

### OQ-6 — Mainnet vs. Sepolia for self-monetized endpoint (master #6)

> Are we deploying the self-monetized endpoint on mainnet Base, or Sepolia? Mainnet — required for Bazaar indexing. Budget $5 USDC.

**Why it matters for Surface 4:** AC-6 requires the endpoint to be **indexed on Bazaar** and **purchased by a second agent during rehearsal**. Bazaar indexing requires a real mainnet settle (master line 460 + Risk R4 line 580). If we deploy to Sepolia we skip the listing step and AC-6 is unmet.

**Master's default:** mainnet. Budget $5 USDC. Action by Day 11 (per build sequence line 559).

**Sub-questions this raises:**
- Who funds the $5 mainnet USDC float? (probably same wallet as deploy authority — see private memory note, but that key is not on this machine)
- Is there a mainnet CDP wallet ready, or do we need to provision one separately from the dev wallet?

**Owner:** TBD
**Status:** Master defaults to mainnet; need explicit go/no-go and funding source confirmed.

---

## Surfaced while writing this spec (Surface 4 specific)

### OQ-S4-A — Day-1 DNS / TLS provisioning for two new subdomains

`reflex.agenomics.xyz` (IC-1 endpoint, used by Mobile → AgentCore) and `agent.agenomics.xyz` (self-monetized endpoint, AC-6) are **both new subdomains** and **neither is provisioned yet**. They need:

- DNS records pointing at AgentCore session API (reflex) and CloudFront (agent)
- TLS certs (ACM)
- Lambda authorizer fronting `reflex.agenomics.xyz`

This is **Day-1 infra work**. Treat as a critical-path prerequisite — Mobile (Surface 1) cannot integrate IC-1 against a hostname that doesn't resolve.

**Owner:** TBD (likely Surface 4 owner with DevOps support)
**Status:** Open

---

### OQ-S4-B — Tool-count inconsistency between repo docs

`README.md` says **27 MCP tools** ("Three Solana programs, one MCP server, 27 tools — live on devnet"). `docs/api-reference.md` opens with *"All 25 MCP tools..."* — only 25.

The master spec (line 20) states the count is "27" and cites both files as authoritative. **They disagree.**

This is not a Surface 4 *deliverable* but Surface 4's IC-2 description references the count, and Gateway will register whatever is actually exposed. Pin down the real number before Surface 4's Day-1 canary so the Gateway tool registration matches what Strands expects to be able to call.

**Owner:** Surface 2 + docs maintainer
**Status:** Open — flag to Surface 2 owner. Likely the api-reference.md file is stale.

---

### OQ-S4-C — `SYNTHESIS_PROMPT` exact wording

The agent loop (step 4) calls `llm.invoke(prompt=SYNTHESIS_PROMPT.format(...))`. Master gives the **economic-reasoning** prompt verbatim but leaves `SYNTHESIS_PROMPT` undefined. Surface 4 owner must draft it; constraint is that the synthesized output cites which candidates were used and matches the demo-narrative tone of the pitch docs.

**Owner:** Surface 4 owner
**Status:** Open — not blocking until Day 5–7 when synthesis is wired in.

---

### OQ-S4-D — JWT issuance flow at app install

IC-1 says `Authorization: Bearer <agent_jwt>` "signed by Solana wallet at install." The **issuance** flow (who signs, what the claims are, what the Lambda authorizer validates exactly) is implicit. Needs a one-paragraph ADR before Mobile + AgentCore integrate (Day 8).

**Owner:** Surface 1 + Surface 4 jointly
**Status:** Open — needed by Day 7.

---

### OQ-S4-E — Second agent for the AC-6 rehearsal purchase

AC-6 requires "a second agent during rehearsal" to discover and purchase the self-monetized endpoint. Is this a separate AgentCore deployment? A scripted curl-with-x402-client? A teammate's laptop running a tiny Strands agent?

Cheapest credible option: a small standalone script that does Bazaar lookup → x402 fetch → prints the response. Demo-day-friendly. Confirm before Day 11.

**Owner:** Surface 4 owner
**Status:** Open
