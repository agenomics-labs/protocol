# Pitches — 10 × 90-second Investor Angles

Ten independently-deliverable 90-second pitches for Agenomics. Each
takes a different angle on the same underlying protocol, optimized
for a different investor audience or moment. Pick the one that fits
the room.

## Why ten

Different rooms reward different framings. A crypto-native fund
hears a different pitch than a SaaS infrastructure VC than an
applied-AI angel than a solo angel chasing a thesis bet. Same
product, same traction — different load-bearing angle.

The canonical 3-minute pitch lives at `docs/VIDEO_SCRIPTS.md`.
These ten are tighter (~225 spoken words / 90 seconds), monetization-
forward, and tuned per audience.

## Framework — DePitch (mandatory rules)

Cribbed from `SuperteamCanada/STCA-skills/winning-pitch-deck`. Every
pitch in this folder honors these:

1. **One slide = one message.** Titles 3–4 words max.
2. **Tense discipline.** Present or past only. Future tense allowed
   *only* on roadmap. Banned: "trying to / hope to / aim to /
   would / should / could".
3. **No "obviously" or "of course."** Kills the surprise hook.
4. **Demo before 2:00 mark.** (Adapted: a *visible artifact* —
   live URL, on-chain transaction, MCP tool call — referenced
   before the 60-second mark of every pitch.)
5. **Business-model slide mandatory.** Each pitch has a Monetization
   section. Without it, it's a concept pitch, not a business pitch.
6. **Traction = 3 real metrics.** Hierarchy: revenue > growth % >
   users > waitlist. *Never* social followers.
7. **Team slide = one outstanding achievement.** Solo-builder
   framing leans into execution-credibility, not headcount.
8. **Every transition scripted.** Read aloud and rehearse — the glue
   matters as much as the slides.
9. **End with CTA, not "thank you."** Each pitch ends with a
   concrete next step (call, demo invite, link).
10. **One memorable quotable line per pitch.** Reusable in hallway
    conversation.

## Speaker pace

- **150 words per minute** spoken. So 90 seconds ≈ **225 words**.
- All pitches in this folder hit ~210–235 words. Read once with a
  stopwatch; if it runs over 95s, cut a clause.

## Validation data (cite from these — don't fabricate)

These are the load-bearing market numbers we lean on across the
pitches. Every citation in a pitch file points back here.

| Claim | Number | Source |
|---|---|---|
| Agentic AI market 2024 | **USD 5.43B** | Precedence Research, Aug 2025 |
| Agentic AI market 2025 | **USD 7.06B – 7.92B** | MarketsAndMarkets (Jun 2025) + Precedence Research |
| Agentic AI market 2030 | **USD 46.04B** (enterprise segment) | MarketsAndMarkets, Jul 2025 |
| Agentic AI market 2032 | **USD 93.20B** | MarketsAndMarkets, Jun 2025 |
| Agentic AI market 2034 | **USD 236.03B** | Precedence Research, Aug 2025 |
| CAGR (2025–2034) | **45.82%** | Precedence Research |
| CAGR (2025–2032, MaM) | **44.6%** | MarketsAndMarkets |
| North America 2024 | **USD 2.23B**, 45.97% CAGR | Precedence Research |

Solana network claims (general / well-established):
- Mainnet TPS capacity: ~65,000 (Solana docs)
- Block time: ~400ms (Solana docs)
- Anchor framework adoption: standard for Solana programs

Agenomics-specific traction (live as of 2026-05-02):
- 3 programs live on devnet, RPC-verified executable
- 27 MCP tools shipped, 547+ tests passing in CI
- Live landing site at agenomics.xyz with end-to-end
  Resend-backed signup
- Self-deploying CI pipeline
- Solo-builder execution over the hackathon window

**Do not invent numbers.** If a pitch needs a number not in this
table, either (a) add it here with a real source first, or
(b) substitute a directional phrase ("growing rapidly", "early but
accelerating") that doesn't pretend precision.

## Monetization models referenced across pitches

Different pitches lean on different revenue angles. The full
spectrum:

- **Per-transaction fee on settlement** (15–30 bps on escrow value).
  Comparable: Stripe's 2.9% + 30¢; PayPal's 2.99%. We're cheaper
  per-transaction because the on-chain primitives do the work.
- **SaaS for vault operators** (compliance dashboards, multi-vault
  policy management, audit log retention). $99–$2,000/mo per org
  depending on volume. Comparable: Fireblocks enterprise, MetaMask
  Institutional.
- **Reputation API as freemium → paid.** First N queries free,
  then $X per 1,000 queries. Comparable: Plaid's data-access tiers.
- **Enterprise deals with agent platforms** (white-labeled MCP
  bundle, SLA, custom audit). $25K–$250K/yr per platform.
- **Token at network maturity** (governance + transaction-fee
  accrual + staking). Long-tail; explicitly *not* the primary
  revenue thesis — included only when the audience is crypto-native.
- **Premium audit / security services** for agent operators.
  $5K–$50K per engagement. Adjacent to the existing security work.

## Index — pick one for the room

| # | Pitch | Best audience | Lead with |
|---|---|---|---|
| 01 | Macro thesis | Generalist VC | Market size + protocol-level positioning |
| 02 | Stripe for agents | SaaS / fintech VC | Comparable + monetization clarity |
| 03 | Picks and shovels | Infrastructure VC | Bottleneck framing |
| 04 | Solana defensibility | Crypto-native fund | Why this chain, why now |
| 05 | MCP as distribution | AI-applied investor | Distribution channel + product attach |
| 06 | Tokenized labor | Crypto-native + macro VC | Agents-as-economic-actors thesis |
| 07 | Hostile-audit quality | Security-focused / late-stage | Code quality + de-risking |
| 08 | Solo-builder bet | Angels / solo capital | Execution credibility + capital efficiency |
| 09 | Coordination failure | Operator / B2B SaaS VC | Pain quantification |
| 10 | B2B wedge | Vertical SaaS / GTM-focused | Wedge product + expansion path |

## How to iterate

Each pitch file follows the same structure:

```markdown
# Pitch NN — [Name]
## Audience
## The 90-second script  (verbatim, deliverable)
## Quotable line
## Monetization angle
## Validation
## Anticipated objection + response
```

After delivering one in a real meeting, write a 1-line note at the
bottom of that pitch's file: "Delivered to [investor / fund],
[date], [outcome / signal]." Over time, this builds a per-pitch
hit-rate so we know which angle actually closes vs. which one
sounds good but doesn't.

## Source repo for the framework

`https://github.com/SuperteamCanada/STCA-skills/tree/main/skills/winning-pitch-deck`
