# Pitch 01 — Macro Thesis

## Audience

Generalist VC. Stage-agnostic. Person who reads The Information and
needs the market size to do the talking before the technical detail.

## The 90-second script

```
[0:00]
The agentic AI market is 7 billion dollars this year and 236 billion
by 2034 — a 46 percent compound growth rate. That's a Stripe-sized
trajectory. And like every other compute platform that scaled past
human-attention bandwidth, the bottleneck moved from the compute to
the COORDINATION.

[0:18]
Today: Claude, GPT, ElizaOS — every agent shipped in the last year
can reason, plan, write contracts. None of them can hold money.
None of them can prove they're real to another agent. None of them
can settle a payment without a human approving it. The agent
economy is running on training wheels nobody actually wants.

[0:40]
We built Agenomics — three Solana programs and a Model Context
Protocol server that fix exactly that gap. Programmable wallets
with policy enforcement. On-chain identity and reputation.
Milestone-based escrow with built-in dispute resolution. 27 tools
exposed to any MCP-compatible agent client.

[1:00]
Live on devnet right now — RPC-verifiable. 547 tests passing. Solo
builder, three months. Revenue model is per-transaction settlement
fee at 15 to 30 basis points. That's an order of magnitude under
Stripe and the on-chain primitives do the work.

[1:22]
We're raising a pre-seed to ship mainnet and onboard the first ten
agent platforms as design partners.

[1:30]
Twenty minutes — I'll show you the live system end-to-end.
```

(~228 words. Stopwatch it once.)

## Quotable line

> "The compute scaled. Now the bottleneck is coordination —
> and that's the gap blockchains were literally built to close."

## Monetization angle

**Per-transaction settlement fee** — 15–30 bps on escrow value.
Comparable: Stripe charges 2.9% + 30¢. We're an order of magnitude
cheaper because the on-chain primitives (escrow, milestones,
dispute resolution) replace the off-chain ledger work Stripe does.

**Why this scales:** every agent-to-agent transaction routes
through Settlement. The fee accrues per-tx, not per-seat. As the
agent economy grows from $7B (2025) → $236B (2034), the addressable
fee surface grows linearly.

## Validation

- Agentic AI market: $7.06B–$7.92B (2025) → $236.03B (2034) — see
  `README.md` validation table for citations.
- CAGR 45.82% (Precedence Research, Aug 2025).
- 3 programs RPC-verified live on devnet (run
  `solana account 4wjdJ…gvwN --url devnet` for live proof).
- 547+ tests passing in CI; ADR governance with 134 decisions
  documented.

## Anticipated objection + response

**Objection:** "Agent transactions are still a small percentage of
the agent market — most of that $236B is enterprise agent SaaS."

**Response:** Right — *today*. The Stripe of 2008 was also a small
slice of total e-commerce. The thesis is that as agents take on
multi-step economic work — buying compute, paying contractors,
licensing data — the percentage that flows through programmatic
settlement grows from ~0% to a meaningful share. We're positioning
for that shift, not for the current state.

---

*Delivered to: [pending] · Date: — · Outcome: —*
