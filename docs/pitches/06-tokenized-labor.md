# Pitch 06 — Tokenized Labor

## Audience

Crypto-native + macro VC. Person who reads Naval, follows Balaji,
funded protocols on the "the unit of economic activity is changing"
thesis. Wants the worldview-shift framing more than the product
demo.

## The 90-second script

```
[0:00]
For 250 years, the smallest economic actor was a person. A
person held money. A person did work. A person got paid.
Every law, every API, every accounting system assumes this.

[0:18]
That assumption broke last year. Agents now do multi-step
work — research, code, contracts, deals — at machine speed,
unsupervised, in parallel. The economy already has new actors.
We just haven't given them the rails to act.

[0:38]
Agenomics is the rails. Three Solana programs let an agent
hold money under programmable policy, prove its identity to
another agent, and settle work via milestone-based escrow with
built-in dispute resolution. 28-tool MCP interface. Live on
devnet, RPC-verifiable.

[1:00]
Monetization: per-transaction settlement fee, 15 to 30 basis
points. Every dollar an agent earns from another agent flows
through our primitives. Network effect is the on-chain
reputation graph — every settled escrow updates it, and the
graph is non-forkable.

[1:22]
The thesis isn't that agents replace people. It's that the
economy now has more participants than people, and the
infrastructure for THEM is missing.

[1:30]
What's your fund's exposure to agent-economy infrastructure
look like today?
```

(~225 words.)

## Quotable line

> "The economy now has more participants than people, and the
> infrastructure for THEM is missing."

## Monetization angle

**Long-game value capture** (crypto-macro framing):

- **Per-transaction fee at the protocol layer** — accrues
  whether the company decentralizes or stays equity-based.
  15–30 bps on every escrow.
- **Reputation graph as compounding moat** — every settled
  escrow updates an on-chain agent reputation score via
  PDA-signed CPI. The graph IS the network effect; new
  entrants can fork the code but not the history.
- **Token at network maturity** — explicitly NOT day-one. When
  the reputation graph reaches critical mass and the network
  is provably non-Anthropic-controlled, a governance token
  with fee-accrual + staking captures the long-tail value.
  Comparable: Uniswap UNI ($6B+ FDV at peak), Aave AAVE.
- **Equity-with-token-warrant** for early funds. Standard
  crypto-infra deal shape: fund gets equity now, optional
  warrant on token at maturity decision.

The macro framing: if you believe the agent-economy thesis,
the upside is on the protocol that captures fees on
agent-to-agent transactions. That fee surface scales with
the agent economy itself — $7B today, $236B by 2034 per
Precedence Research.

## Validation

- Agentic AI market $7.06B (2025) → $236.03B (2034), 45.82%
  CAGR per Precedence Research.
- Agents executing multi-step work in production: GitHub
  Copilot Workspace, Cursor's background agents, ElizaOS
  trader bots, AutoGPT-shape long-running agents — all
  shipped 2024-2025.
- Comparable token capture: Uniswap UNI peak FDV ~$30B; Aave
  AAVE peak FDV ~$5B. Both protocols where the token captures
  fee value once usage proved out.
- Agenomics traction: 3 programs RPC-verified live; reputation
  CPI on-chain (`SettlementState::Completed` triggers
  registry update via PDA-signed `invoke_signed`).

## Anticipated objections + responses

**Objection 1:** "Most 'agent economy' pitches are vaporware.
What stops Agenomics from being one of them?"

**Response:** Right — most are. Three signals to disqualify
that risk: (1) the programs are LIVE on devnet, RPC-verifiable
right now, not "coming Q3"; (2) 580 tests gate every CI run,
plus four hostile audit cycles closed at zero open; (3) the
landing site itself runs on the same infrastructure stack
(programmable backend, signed transactions on a verified
domain) — we're our own first user. Diligence is one
`solana account` command away.

**Objection 2:** "Token launches are a regulatory minefield in
2026. When does the token actually ship, and how do you avoid
the SEC heat?"

**Response:** Token is explicitly not day-one and not in the
critical path. Mainnet ships Q3 2026 with equity-only economics
(per-tx fees + SaaS). Token launch only triggers if and when
three conditions are met: (a) reputation graph reaches a
defined network-effect threshold, (b) the protocol's
governance can credibly decentralize (verified by an external
SEC-experienced counsel), (c) the token genuinely captures
value the equity can't (cross-chain settlement governance, fee
routing). If any of those don't hit, equity remains the only
shape. The pitch isn't "tokens are coming" — it's "tokens are
optionality if the math works."

**Objection 3:** "If agents are the new economic actors, what
prevents this from getting outright banned by jurisdictions
that require human accountability for every transaction?"

**Response:** The vault's policy enforcement is the answer.
A vault has a HUMAN OWNER — usually the agent operator. The
human sets the policy ("up to $X per day, only to allowlisted
counterparties, only on token Y"). The Anchor program enforces
that policy. So every transaction has a clear human-authored
constraint, even if the human didn't approve the specific
trade. This maps cleanly onto how brokerages already let
human owners delegate to algorithms within constraints — same
regulatory pattern, applied to agents.

---

*Delivered to: [pending] · Date: — · Outcome: —*
