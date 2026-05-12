# Pitch 08 — Solo-Builder Bet

## Audience

Angels, solo capital, scout funds, micro-VCs. Person who funds
people more than companies. Wants the execution-credibility
proof and the capital-efficiency math.

## The 90-second script

```
[0:00]
The cliché is that solo founders don't ship complete protocols.
The reality, in 2026, is that one builder with Claude Code
does what a 5-person team did three years ago. Agenomics is
the proof.

[0:18]
One person, three months, three Solana programs, an MCP server
with 28 tools, a React dashboard, a landing page, a thesis
presentation, four hostile-audit cycles, self-deploying CI.
580 tests passing. Live on devnet today. Live signup form
sending welcome emails through a verified domain.

[0:42]
The capital-efficiency math is what matters. $250K SAFE buys
18 months of execution at this velocity. Compare to a 4-person
team burning $80K a month on the same roadmap — they're out of
runway in three. Same shipped surface, four times the cushion.

[1:02]
Monetization is per-transaction settlement fee at 15 to 30
basis points, plus enterprise SaaS for vault operators. Both
revenue lines start the same week mainnet ships — Q3 2026.

[1:22]
What I want from this round: $250K SAFE, mainnet ship + first
ten platform integrations as design partners.

[1:30]
Twenty minutes — I'll walk the live system end-to-end.
```

(~226 words.)

## Quotable line

> "One builder with Claude Code does what a 5-person team did
> three years ago. Agenomics is the proof."

## Monetization angle

**Capital-efficient revenue ramp:**

- **Per-transaction settlement fee** — 15–30 bps on escrow value.
  Starts firing the day mainnet ships; no sales cycle, no
  enterprise procurement.
- **Platform integration SaaS** — $25K setup + $5K-$25K/mo per
  platform. First ten platforms via design-partner program; no
  sales hires needed pre-Series A.
- **Reputation API freemium → paid** — covers the long-tail
  of one-off integrators who don't need full SaaS.

The angel-friendly framing: $250K SAFE buys 18 months. Mainnet
ship at month 4. First $10K MRR at month 9. $50K MRR at month
15. Series A on $100K+ MRR with 3+ design-partner case studies.
Capital efficiency comes from the solo-builder posture, not from
underpricing — the per-tx fee is reasonable, the SaaS pricing is
in-line with comparables.

Comparable solo-shipped infra plays: Cal.com (Peer Richelsen
solo to $4M ARR pre-team), Plain (solo to YC then team), Linear
(2-person founding team). Solo-shipped early stages compound when
the builder is also the design lead.

## Validation

- 12 commits in the last 2 hours of the most recent autonomous
  session alone — observable in `git log --oneline --since="2 hours ago"`.
- Run `git log --shortstat | grep "files changed" | wc -l` for
  per-commit-touch density.
- ADR-134 closure cycle (welcome email Issue A → fix → DNS
  diagnosis → end-to-end verification) shipped in <90 minutes.
- Automated CI gates added in same session (4 new workspace
  test jobs + dashboard build).
- All-time: 134 ADRs, 580 passing tests, 3 deployed programs,
  one verified-domain transactional-email pipeline, one
  self-deploying Vercel workflow.
- Cal.com (single-founder ARR run): public statements ~$4M ARR
  before scaling team, ~2022.

## Anticipated objections + responses

**Objection 1:** "Solo founders bottleneck on themselves. What
happens when you get hit by a bus / burn out / take a break?"

**Response:** Real concern. Three mitigations: (1) the codebase
is documented to a degree that's atypical — every nontrivial
decision has an ADR with implementation cross-references, so
the "bus factor" is lower than usual; (2) the on-chain protocol
runs without the maintainer — once mainnet ships, the programs
are immutable on the chain, the registry and reputation graph
keep updating, settled escrows keep settling; (3) the use-of-funds
explicitly includes hiring an engineer at the $50K MRR mark.
Solo today is capital efficiency, not solo forever.

**Objection 2:** "What's the hiring plan, specifically? Solo-now
without a credible scaling story is fragile."

**Response:** Two key hires post-Series A — a protocol engineer
(focus: mainnet ops, multi-region indexer) and a developer-
relations lead (focus: design-partner onboarding, MCP-ecosystem
relationships). Both come from the existing Solana / Anchor
contributor pool, not blind sourcing — there's a known network
of ex-Helius, ex-Magic Eden, ex-Drift engineers who are looking
for the next protocol play. Pre-Series A, no hires; the
$250K runway funds two design partners through to mainnet plus
the external audit (Trail of Bits or OtterSec).

**Objection 3:** "Solo means design-by-committee-of-one. How do
you avoid building something only you would use?"

**Response:** The waitlist + welcome-email loop is already
shipping; signups in the first week test the landing-page-level
problem-clarity. Beyond that, the design-partner program (first
ten platforms at $25K each) IS the product-validation loop. If
no platform pays the integration fee, the wedge is wrong and
we pivot before mainnet. The $250K covers TWO failed wedge
attempts plus the successful one — the funding shape assumes
the first wedge guess might miss.

---

*Delivered to: [pending] · Date: — · Outcome: —*
