# Pitch 02 — Stripe for Agents

## Audience

SaaS / fintech VC. Person who funded Plaid, Mercury, or any
"infrastructure for new economic actors" play. Wants the comparable
spelled out and the unit economics legible.

## The 90-second script

```
[0:00]
Stripe acquired Privy this year. Privy made programmable wallets
for end-users. Read the move: Stripe — a 91-billion-dollar
company — sees programmable-wallet-as-API as the next layer of
its empire. We're betting the same shape repeats one level up,
for AI agents instead of human end-users. And the integration is
harder there, not easier — because agents also need identity,
reputation, and dispute resolution baked in.

[0:22]
Agenomics is the Stripe shape for AI agents. One MCP server
exposes 28 tools. An agent in Claude Desktop, Cursor, or any
custom runner gets a programmable wallet, a verifiable identity,
a discovery feed, and milestone-based escrow — through one API
surface, settling on Solana in 400 milliseconds.

[0:46]
Live demo at agenomics dot xyz. Three programs deployed and
RPC-verifiable on devnet. 580 tests passing. Per-transaction
fee at 15 to 30 basis points — Stripe takes 290 plus 30 cents
flat. We're cheaper because Anchor programs do the work
Stripe's ledger does.

[1:08]
Wedge: agent-platform operators. ElizaOS, SendAI, custom agent
deployments — every team building an agent product hits the
"how does this thing pay" wall in week three. We're the API they
write `import`-statement against.

[1:28]
Twenty-five thousand to integrate. Five-figure ARR per platform
within six months of integration.

[1:30]
What does your diligence on payment-rails plays usually look like?
```

(~232 words.)

## Quotable line

> "The Stripe shape, but the integration is harder — because
> agents also need identity, reputation, and dispute resolution
> baked in."

## Monetization angle

**Two revenue streams from day one:**

1. **Per-transaction settlement fee** — 15–30 bps on escrow value.
   Variable revenue scaling with platform GMV.
2. **Platform integration / SaaS** — $25K setup + $5K-$25K/mo per
   platform for compliance dashboards, multi-vault management,
   audit log retention. Comparable: Fireblocks enterprise tier.

Stripe's blended take rate on payments is ~2.9%. Ours is
~0.20% on-chain (15–30 bps), but the SaaS layer + reputation API
freemium tier closes the per-platform revenue gap. We're not
trying to *be* Stripe — we're trying to be the *agent-economy*
Stripe, where the per-tx work is cheaper but the integration
density per customer is much higher.

## Validation

- Stripe valuation $91.5B (March 2025 tender offer reporting).
- **Stripe acquired Privy in 2025** — Privy.io now reads "a Stripe
  company" in its footer. Privy was the leading programmable-wallet-
  as-API for human end-users. Stripe paying for that thesis at one
  level up validates the thesis at the next level (agents).
- Agentic AI market: $7.06B (2025) → $93.20B (2032), 44.6% CAGR
  (MarketsAndMarkets). See `README.md` table.
- Solana block time ~400ms; mainnet TPS capacity ~65,000.
- 28 MCP tools shipped; live MCP-server install path in
  `README.md` lines 41-55 — judges/investors can wire it up in
  <5 minutes.

## Anticipated objections + responses

**Objection 1:** "Stripe won because cards were already standardized.
What's the agent equivalent of the card network?"

**Response:** MCP. The Model Context Protocol is the closest thing
agents have to a standard wire format — Anthropic shipped it in
late 2024 and Cursor, Sourcegraph, Block, Replit, and dozens more
shipped MCP support within months. We're betting that MCP becomes
to agent-tool-calling what HTTP became to documents. Our 28 tools
ship behind that interface — every new MCP-compatible agent
client is automatic distribution.

**Objection 2:** "What stops Stripe from building this themselves
now that they've absorbed Privy?"

**Response:** Stripe builds in walled gardens by design — they need
the counterparty to be a Stripe-merchant. The agent-to-agent
settlement layer can't sit inside any single payment processor's
wall, by definition. Even if Stripe ships agent wallets through
Privy's surface, they'll need a neutral on-chain settlement layer
for cross-platform agent transactions. We're a complement to
Stripe-Privy, not a competitor — and we're chain-native, which
they can't be without becoming a chain themselves.

**Objection 3:** "If MCP is so standard, why hasn't Anthropic just
shipped these primitives themselves?"

**Response:** Because foundation-model providers have a structural
conflict with neutral settlement infrastructure — same reason
Visa isn't owned by any one bank. Anthropic SHIPPING the wallet
+ settlement layer means every non-Anthropic agent is a
second-class citizen on it. The neutral-protocol position is the
only stable one, and that's the one we're occupying.

---

*Delivered to: [pending] · Date: — · Outcome: —*
