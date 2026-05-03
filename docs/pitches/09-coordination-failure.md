# Pitch 09 — Coordination Failure

## Audience

Operator-turned-VC, B2B SaaS investor, anyone who funds
"painkiller" plays. Wants the pain quantified before the
solution.

## The 90-second script

```
[0:00]
Pull up any production AI agent today. Ask it to negotiate
with another agent on a different platform — buy compute,
license data, hire a contractor. It can't. Not because the
LLM can't reason about the deal. Because there's no
infrastructure for two agents on different runtimes to
TRANSACT.

[0:24]
The cost shows up as the human-in-the-loop tax. Every
agent-to-agent deal today routes through a human approving
the payment. Average latency: minutes to hours. Average cost:
the salary of whoever's clicking approve. Multiply by every
team running production agents — this is a real line item on
real budgets in 2026.

[0:48]
Agenomics removes the tax. Three Solana programs handle
identity, programmable spending, and milestone-based
settlement with built-in dispute resolution. 27-tool MCP
server. Any agent on any runtime — Claude, Cursor, ElizaOS,
custom — pays another agent natively, in 400 milliseconds,
with policy enforcement at the program level.

[1:10]
Live on devnet. RPC-verifiable. 547 tests. Solo-built, three
months. Revenue: per-transaction settlement fee at 15-30 bps
plus enterprise SaaS for vault operators.

[1:28]
Want me to show your portfolio's agent teams the integration
path? Twenty minutes per team.

[1:30]
```

(~226 words.)

## Quotable line

> "The human-in-the-loop tax. Every agent-to-agent deal today
> routes through a human approving the payment."

## Monetization angle

**Pain-removal pricing:**

- **Per-transaction settlement fee** (15–30 bps) — replaces
  the "human clicking approve" cost. If the average
  agent-to-agent deal value is $X, the per-tx fee is bounded
  while the human-cost was unbounded.
- **Enterprise SaaS for agent ops teams** — $500–$5,000/mo
  per organization for multi-vault management, audit log
  retention, compliance dashboards. Comparable: Mercury
  Treasury starts at $500/mo for similar surface (multi-account
  management + audit).
- **Reputation API freemium tier** — agent ops teams query
  before transacting; pays for itself by avoiding bad
  counterparties.

The B2B framing: this is a painkiller, not a vitamin. Every
team running production agents already pays the human-in-loop
tax — they just don't have a P&L line called that. We surface
it and replace it. Sales motion is direct-to-engineering at
agent-platform companies; deal cycle is short because the
integration is one MCP config line.

## Validation

- AI agent platforms with paying customers running production
  workloads in 2026: Cursor (background agents), GitHub
  Copilot Workspace, Cognition Devin, ElizaOS, AutoGen
  enterprise tier — all shipped 2024-2025 with multi-million
  user bases.
- Stripe/Mercury/Brex enterprise pricing at $500-$5,000/mo
  per organization is the established comparable for
  treasury-shape SaaS.
- Agentic AI market growing 44.6%-47% CAGR per multiple
  analyst firms (see `README.md`).
- Live demo: 3 programs RPC-verified on devnet, 27 MCP tools
  shipped, signup form on agenomics.xyz routing through the
  same hardened backend the protocol describes.

## Anticipated objection + response

**Objection:** "The human-in-the-loop tax is a feature, not a
bug. Companies want a human approving agent payments because
of liability and compliance."

**Response:** Today, yes, because the alternative is "agent
spends with no policy enforcement." We don't remove the human
oversight — we move it from approving every transaction to
SETTING the policy. An agent ops team configures: "this vault
spends up to $X/day, only to allowlisted counterparties, only
on token Y." The Anchor program enforces that on-chain.
Humans set the rails; agents run on them. Same shift Stripe
made: the bank still owns the rails, but the developer doesn't
talk to the bank for every transaction.

---

*Delivered to: [pending] · Date: — · Outcome: —*
