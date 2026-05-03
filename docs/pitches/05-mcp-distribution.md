# Pitch 05 — MCP as Distribution

## Audience

AI-applied investor. Person who funded LangChain, Vercel AI SDK,
LlamaIndex, or any "tooling layer for AI app developers" play.
Cares about distribution-channel control more than market size.

## The 90-second script

```
[0:00]
Anthropic shipped Model Context Protocol in November 2024.
Eighteen months later, every serious agent runtime supports it —
Claude Desktop, Cursor, Sourcegraph, Block, Replit, dozens
more. MCP is becoming to AI agents what HTTP was to documents:
the boring standard that makes the rest of the stack possible.

[0:24]
Whoever ships the most useful MCP servers in the next 24 months
owns distribution to every agent on every runtime. Not because
they're locked in — because they're the default.

[0:38]
Agenomics ships 27 MCP tools today. Programmable wallets,
on-chain identity, reputation, milestone-based escrow with
dispute resolution. Live on Solana devnet, RPC-verifiable, 547
tests passing. Any MCP-compatible client gets the financial
primitives by adding one config line.

[1:00]
Wedge: agent operators who hit the "how does this thing
actually pay" wall. Today they bolt together Stripe, an
auth provider, a reputation hack, a Postgres for state.
Three months and four bugs later they're back. We replace
that whole stack with one MCP entry.

[1:22]
Revenue: per-tx settlement fee plus enterprise SaaS for
multi-vault operators. Agents get the rails for free; their
operators pay for management. Same pattern as Twilio.

[1:30]
Want a Claude Desktop demo? Three commands and you're calling
the tools live.
```

(~228 words.)

## Quotable line

> "MCP is becoming to AI agents what HTTP was to documents —
> the boring standard that makes the rest of the stack
> possible."

## Monetization angle

**Distribution-driven monetization** (the AI investor framing):

- **Free at the agent layer** — every MCP-compatible client gets
  the 27 tools at zero marginal cost. Drives adoption, builds
  the reputation graph.
- **Paid at the operator layer** — multi-vault management
  dashboards, compliance audit log retention, custom policy
  enforcement, SLA. $99–$2,000/mo per organization depending
  on volume. Comparable: Twilio's developer-free /
  enterprise-paid split.
- **Per-transaction settlement fee** — 15–30 bps. Accrues
  whether the agent is on a free tier or an enterprise tier.

The distribution lever: every NEW MCP-compatible client that
ships (and Anthropic alone ships ~one per quarter) adds
free distribution. We don't pay for it. We just ship the most
useful MCP server in the financial-primitives category and
let the platform do the marketing.

## Validation

- MCP shipped November 2024 (Anthropic).
- Mainstream MCP adopters as of 2026: Claude Desktop, Cursor,
  Sourcegraph, Block, Replit, Goose, Continue.
- Agentic AI market: $7B (2025) → $93B (2032), 44.6% CAGR
  (MarketsAndMarkets). See `README.md`.
- 27 MCP tools shipped + tested in CI (action-shape.test.ts
  asserts the count).
- Twilio comparable: market cap ~$10B, primarily
  developer-free + enterprise-paid model.

## Anticipated objection + response

**Objection:** "What stops Anthropic from shipping their own
financial-primitives MCP server and obviating you?"

**Response:** The on-chain settlement layer can't sit inside any
single foundation provider — by definition it's neutral
infrastructure that lets Claude transact with a non-Claude agent.
Anthropic shipping their own would be like Visa shipping their
own bank: possible, but the conflict-of-interest is the reason
the neutral layer exists. The defensibility is exactly that we
DON'T have a foundation-model business — we're the protocol that
sits between them.

---

*Delivered to: [pending] · Date: — · Outcome: —*
