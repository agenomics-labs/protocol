# Pitch 03 — Picks and Shovels

## Audience

Infrastructure VC. Person who funded Vercel, Supabase, Clerk, or
similar dev-tools / infra plays. Lives by the picks-and-shovels
heuristic: bet the platform, not the app.

## The 90-second script

```
[0:00]
A hundred AI-agent companies are funded right now. Maybe ten of
them survive past Series A. The other ninety teach the survivors
what infrastructure they actually needed. The picks-and-shovels
play is to BE that infrastructure — and to be the one piece every
agent eventually depends on.

[0:22]
Three pieces every agent eventually needs: a wallet that won't
spend more than it should, an identity that proves it's the same
agent across calls, and a way to settle work without trusting a
counterparty. None of these exist as primitives — every agent
team builds their own custodian, their own auth, their own
escrow. Wastefully and badly.

[0:50]
Agenomics ships all three as on-chain primitives — Agent Vault,
Agent Registry, Settlement — plus an MCP server that exposes
them as 28 tools. Live on Solana devnet, RPC-verifiable today.
Any agent runner — Claude Desktop, Cursor, custom — picks up
the wire-compatible interface for free.

[1:10]
Revenue: per-transaction fee on settlement, plus enterprise
licensing to platforms that want a white-labeled bundle. Same
shape as Auth0 in 2014 — invisible to end users, table-stakes
for builders, locked into the platform once integrated.

[1:30]
Coffee next week — I'll show you the integration path for one
of your portfolio companies in twenty minutes.
```

(~226 words.)

## Quotable line

> "Every agent team builds their own custodian, their own auth,
> their own escrow. Wastefully and badly."

## Monetization angle

**Three layered revenue streams, ordered by capital efficiency:**

1. **Per-transaction settlement fee** — 15–30 bps. Pure protocol
   revenue. Margin ~95% (gas + minimal infra).
2. **Platform licensing** — $25K–$250K/yr per platform for
   white-label MCP bundle, SLA, custom audit. Comparable: Auth0
   enterprise contracts pre-Okta-acquisition averaged $80K ACV.
3. **Reputation API** — freemium tier (1K queries/day free) →
   paid ($X/1K queries above). Comparable: Plaid's
   data-access tiers. Defensible because the reputation graph
   compounds with every settled escrow on the network.

The picks-and-shovels framing: as the agent economy expands
from $7B (2025) to $236B (2034), every dollar that flows
between agents has a non-zero probability of touching one of
the three primitives. We make money on the primitive layer, not
on which agent wins.

## Validation

- Agent platforms shipping production agents: ElizaOS, SendAI,
  Crew AI, AutoGen, LangChain, OpenAI Assistants, Anthropic's
  Claude with MCP — all shipped 2024–2025.
- Agentic AI market: $7B (2025) → $236B (2034), 45.82% CAGR
  per Precedence Research. See `README.md`.
- Auth0 / Okta acquisition $6.5B (2021) — comparable infra play.
- Solana mainnet finality ~400ms; native programmability via
  Anchor (no L2 trust assumptions).

## Anticipated objections + responses

**Objection 1:** "If agents are going to be infrastructure, won't
the foundation models — Anthropic, OpenAI — just bundle this in
and own it?"

**Response:** Possibly, for their own walled-garden agents.
But the cross-agent settlement layer can't sit inside any one
foundation provider's wall — by definition it's the thing that
lets agents from DIFFERENT providers transact with each other.
That's a neutral-protocol problem, and protocols are the answer.
Same reason DNS isn't owned by any one ISP.

**Objection 2:** "Auth0 took eight years to reach a $6.5B exit.
The agent economy doesn't have eight years."

**Response:** Auth0 was selling to the long tail of long-cycle
B2B procurement — banks, hospitals, governments. Agent platforms
are venture-funded, fast-deciding, and integrating new infra in
days not quarters. The comp is shape (picks-and-shovels infra),
not timeline. Cursor went from $0 to $200M ARR in 18 months once
the product was right; the same compression applies to the
infrastructure layer one tier down.

**Objection 3:** "What stops one of the big agent platforms —
Cursor, Anthropic — from building this themselves and giving
it away?"

**Response:** Two structural blockers: (1) building it requires
on-chain protocol expertise that's outside the core competence
of foundation-model and IDE companies — they're staffed for ML
and editor UX, not Anchor / Solana / cryptographic settlement;
(2) giving it away creates the conflict-of-interest problem we
just discussed — a Cursor-built settlement layer can't credibly
serve non-Cursor agents. The neutral position is the sustainable
position, and we're occupying it.

---

*Delivered to: [pending] · Date: — · Outcome: —*
