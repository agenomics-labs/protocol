# Pitch 10 — B2B Wedge

## Audience

Vertical SaaS / GTM-focused VC. Person who funded Snowflake,
Datadog, MongoDB. Wants the wedge product and the expansion
path mapped before believing the platform thesis.

## The 90-second script

```
[0:00]
The biggest mistake "platform" plays make is selling the
platform. Platforms don't sell — wedges do. The wedge for
Agenomics is one painful, narrow, urgent problem agent-platform
companies have today: their agents can't pay each other
without a human approving every transaction.

[0:24]
Wedge product: a single MCP server that drops into Claude
Desktop, Cursor, ElizaOS, or any custom runner and gives the
agent a programmable wallet plus milestone-based payment
escrow. Live on Solana devnet, RPC-verifiable. Five-minute
integration. Per-transaction fee, 15 to 30 basis points.

[0:50]
Expansion path: agent operators integrating the wallet
inevitably need three more things — discovery, reputation,
multi-vault management. We ship all three. Land-and-expand,
clean.

[1:08]
Already-shipped surface: 27 MCP tools, 547 tests passing,
four hostile audit cycles closed at zero open, self-deploying
CI. Three Solana programs live on devnet. The wedge product
is functional today; mainnet ships Q3.

[1:25]
We're targeting the first ten platform integrations as paid
design partners — $25K each. Pre-seed checks fund mainnet
deployment plus the first three integrations.

[1:30]
Coffee next week — let's pick one of your portfolio
companies and walk the integration.
```

(~228 words.)

## Quotable line

> "Platforms don't sell. Wedges do. Our wedge: agents can't
> pay each other without a human approving every transaction."

## Monetization angle

**Land-and-expand revenue ramp:**

- **Land:** wedge product (MCP server with vault + escrow)
  at $25K setup per platform. Targets the first 10 design
  partners (≈$250K initial revenue at zero CAC because the
  audience is identifiable in <1 hour of research).
- **Expand-1:** discovery + reputation API at $5K-$15K/mo per
  platform. Activated once the platform's agents are
  transacting via Settlement. Comparable: Plaid expansion
  motion (link → identity → assets → income).
- **Expand-2:** multi-vault enterprise SaaS at $25K-$100K/yr
  per platform. Activated when a platform is managing >10
  agent vaults. Comparable: Snowflake's storage→compute→
  Snowpark expansion shape.
- **Per-transaction settlement fee** (15–30 bps) flows through
  every escrow regardless of which expand-tier the platform
  is on. The "always-on" revenue line.

GTM motion: direct-to-engineering at agent-platform companies.
Sales cycle is short because the integration is one MCP config
line and the value-prop ("your agents can pay each other in
400ms without a human") tests in a 20-minute demo.

## Validation

- Agent-platform companies with active development as of
  2026: Cursor, ElizaOS, SendAI, Crew AI, AutoGPT, OpenAI
  Assistants, Anthropic MCP-enabled clients, Continue,
  Replit Agent. Each is a single conversation away.
- 27 MCP tools shipped; complete catalog in `README.md`
  + `mcp-server/test/action-shape.test.ts:34` (snapshot
  asserts count = 27).
- Live MCP install path documented in `README.md:41-55` —
  judges/investors can wire it up in <5 min.
- Land-and-expand comparables: Plaid (link → ARR expansion),
  Snowflake (storage → compute → Snowpark), MongoDB Atlas
  (DB → search → vector). All shipped wedge first, expanded
  via NRR > 130%.
- 547+ tests passing in CI; ADR-governed decisions; four
  hostile-audit cycles closed.

## Anticipated objections + responses

**Objection 1:** "Agent platforms don't have budget for $25K
integrations. They're mostly venture-funded with 18-month
runway and no revenue."

**Response:** True for the bottom 80%. Top 20% — Cursor,
Cognition, Anthropic-tier — already have enterprise revenue
and procurement processes. We start there. The bottom 80%
gets a $0 self-serve tier (1K transactions/month free), and
the conversion path is "your agent volume crossed the
threshold; here's an invoice." Same self-serve-up-to-paid
shape Twilio used to convert single-developer hobbyists into
Fortune 500 contracts.

**Objection 2:** "What's the competitive landscape — who else is
shipping agent payment infrastructure today?"

**Response:** Three categories of competitor: (1) Stripe-Privy
post-acquisition, but they're focused on human-end-user wallets
that agents BORROW, not agent-native wallets — different shape;
(2) Crossmint and similar wallet-as-a-service plays, but they're
NFT-and-collectibles-first, not transactional-first; (3) various
crypto-native agent frameworks (ElizaOS, SendAI) shipping their
own one-off settlement, which validates demand but doesn't compete
on the neutral-protocol axis. We're the only team shipping
purpose-built on-chain primitives + neutral-protocol positioning +
MCP-native distribution as a unified play.

**Objection 3:** "Land-and-expand only works if NRR > 130%. What's
the actual expansion path mechanic?"

**Response:** Each of the three primitives has a distinct
expansion trigger. Vault → Reputation flips when the platform
has >100 active vaults (operators want a "trustworthy
counterparty" filter). Reputation → Multi-vault SaaS flips when
audit/compliance requirements arrive (typically a Series B
event for the platform). Multi-vault SaaS → Premium audit
services flips when the platform handles regulated funds or
hits an exploit and needs hardening. Each trigger is observable
in the platform's growth metrics, which means our expansion is
predictable from the outside — modeled at 140-160% NRR for
design-partner cohort year-2.

---

*Delivered to: [pending] · Date: — · Outcome: —*
