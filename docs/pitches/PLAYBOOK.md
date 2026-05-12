# Pitch Playbook — Picker, Invariants, Disqualifiers

Meta-doc on top of the 10 pitches in this folder. When you walk
into a meeting, this is the page you re-read first.

## How to pick the right pitch in 60 seconds

Read the room before you open. The signals to listen for, mapped
to which pitch fits:

| If they say… | Or they look like… | Open with… |
|---|---|---|
| "What's the market size?" | Generalist, multi-stage VC | **01 Macro thesis** |
| "What are the unit economics?" | Fintech / SaaS specialist | **02 Stripe for agents** |
| "What's the moat?" | Infra / dev-tools VC | **03 Picks and shovels** |
| "Why Solana?" / "Why on-chain?" | Crypto-native fund | **04 Solana defensibility** |
| "What about Anthropic / OpenAI?" | AI-applied specialist | **05 MCP as distribution** |
| "What's the long-term value capture?" | Crypto + macro thesis | **06 Tokenized labor** |
| "How do you de-risk this?" | Late-stage / security-focused | **07 Hostile-audit quality** |
| "Tell me about the team" | Solo angels, scout funds | **08 Solo-builder bet** |
| "Who's the customer right now?" | B2B SaaS / operator-VC | **09 Coordination failure** |
| "What's the GTM?" | Vertical SaaS / GTM-focused | **10 B2B wedge** |

If multiple signals fire, the rule is: lead with the angle that
matches THEIR thesis, not the one that's strongest about us.
Meeting goes 30+ minutes? Use one as the opener and pivot to a
second when they ask the question that pitch answers best.

## Five invariants — every pitch assumes these

These are the same across all ten pitches. If any becomes false,
re-read every pitch.

1. **The agent economy exists by 2028.** The 45-47% CAGR holds
   at least directionally. If this breaks, the whole thesis
   breaks; pivot to a different protocol.
2. **MCP or a successor wins.** Some neutral-tool-protocol
   becomes standard for agent-tool-calling. Could be MCP, could
   be a fork — but a standard happens. (Pitch 05 covers this
   most explicitly.)
3. **On-chain settlement matters for cross-platform agents.**
   Without this, every payment can route through Stripe's
   centralized rails. (Pitches 02, 04 cover the why.)
4. **Solo-founder execution capability is increasing, not
   decreasing.** AI-assisted development means small teams ship
   what used to require large ones. (Pitch 08.)
5. **Quality compounds.** The hostile-audit work + ADR
   governance + 580-test bar pays off when capital flows
   through agent infrastructure. (Pitch 07.)

If you find yourself in a meeting where the investor explicitly
disbelieves any of these five, the right move is to disqualify
the meeting politely, not to try to convert them. Save the
energy for the next room.

## Three numbers that show up in every pitch

Memorize these. They're load-bearing across the deck:

- **$7B → $236B** (agentic AI market 2025 → 2034; Precedence
  Research)
- **45-47% CAGR** (multiple analyst-firm consensus)
- **28 MCP tools, 580 tests, 3 programs live on devnet**
  (Agenomics traction; verifiable by an investor in 5 minutes)

If you blank on one, the meeting recovers. If you blank on two,
the meeting does not.

## Disqualifiers — when NOT to pitch

Some rooms are not winnable, and pitching them is energy
mis-allocation. Skip if any of:

- **Investor is allergic to crypto.** Even pitch 02 (most
  fintech-shaped) requires explaining why the rails are on-chain.
  If the term "blockchain" generates a frown, reframe as a
  separate conversation OR move on.
- **Investor is allergic to solo founders.** Pitch 08 leans
  in; the others reference it. Some funds have explicit policy.
  Don't fight policy.
- **Investor wants to lead and is your only option.** Better
  to take 6 months to find 3 leads competing than to take the
  first lead with full-stack control rights. (This is a
  valuation/terms thing, not a pitch thing — but it's relevant
  to which pitches you deploy where.)
- **Investor's last 3 portfolio companies in agent infra
  failed.** Their pattern-matching is poisoned. They'll see
  Agenomics as the next failure shape regardless of what you
  pitch. Skip and revisit in 6 months.

## Universal pitch hygiene

Read aloud before every pitch:

- **No "obviously," no "of course."** Kills surprise.
- **No future tense outside roadmap.** Ban "trying to / hope
  to / aim to / would / should / could." (DePitch rule #2.)
- **One memorable line per pitch.** Repeat it twice — once at
  the appropriate beat, once in the close. Hallway repetition
  is what compounds.
- **End with concrete CTA.** "Coffee next week" / "Demo via
  this URL" / "Twenty minutes for a walkthrough." Never end
  with "thank you for your time."
- **3 real metrics on traction.** Revenue > growth % > users >
  waitlist. Currently traction = engineering proof, so lean
  on programs-live-on-devnet, tests-passing, MCP-tools-shipped.
  After mainnet ships, swap in revenue.

## Pitch sequencing in a multi-meeting cycle

If you're running a fundraise (vs. one-off meetings), the
sequence matters:

1. **Open with cold meetings using pitches 01, 09, or 10.**
   These have the broadest appeal and surface the audience's
   real interest fastest.
2. **In second meetings, pivot to the angle they leaned in on.**
   If they got excited about market size, deepen with 06.
   If they pushed on tech, deepen with 04 or 07.
3. **Save 08 (Solo-builder) for the partner meeting.** It's
   the most personal pitch and lands hardest with the partner
   who'll be on the board, not the associate doing diligence.

## After every meeting

Write the outcome in the per-pitch file's footer line:

```
*Delivered to: [investor / fund] · Date: YYYY-MM-DD · Outcome: [signal]*
```

Signals to track:
- **Pass** — and what specific objection killed it
- **Pass-but-stay-warm** — what they want to see before
  re-engagement
- **Fold-into-existing-investor** — they'd participate if a
  named lead commits
- **Lead-interest** — they want term-sheet conversation

After 10+ meetings across the deck, you'll see which pitches
have a real hit-rate vs. which sound great but don't close.
Iterate the deck on the data.

## What this folder is NOT

- Not a pitch deck. Slides are downstream — these are the
  speaker scripts that go INTO the deck.
- Not a one-pager. The one-pager (forthcoming) summarizes 5
  pitches' worth of material in 1 page; these are the source
  material it gets distilled from.
- Not a lockbox. Edit them as you learn what works. After
  every 5 meetings, re-read the worst-performing pitch and
  rewrite the weakest beat.

## Source

DePitch framework cribbed from
`https://github.com/SuperteamCanada/STCA-skills/tree/main/skills/winning-pitch-deck`.
Market data citations centralized in `README.md`.
