# ADR-139: create-agenomics-app scaffold (Privy + devnet by default)

## Status

Proposed

## Date

2026-04-30

## Context

The 2026-04-30 DX research synthesis named **`npx create-x-app` style
scaffolds as a baseline expectation in 2026** for any SDK that wants
broad adoption: `create-next-app`, `create-vite`, `create-t3-app`,
`create-onchain` (Coinbase OnchainKit), `create-solana-dapp`
(Solana Foundation). Time-to-first-success is the dominant adoption
metric, and the ceiling is now ~5 minutes from `npm create x` to a
running deployed app.

The protocol today has:

- `examples/register-agent.ts` — read-only, ~150 LOC, requires the
  consumer to provide their own `tsx` runner, env vars, and keypair.
- `dashboard/` — internal protocol operations dashboard (ADR-035),
  not a consumer template.
- No first-run experience for someone who lands on `agenomics.xyz`,
  installs the SDK, and wants to ship something.

The conversion gap from "I read the README" to "I have a deployed
demo" is 100% and entirely fixable. Scaffolds also serve as the
**most credible documentation a protocol can ship**: the scaffold
is by definition the canonical wiring, so it's the example consumers
fork instead of copying snippets from prose docs.

This ADR sequences after ADR-134 (Codama-generated builders),
ADR-136 (npm publish flip), and ADR-138 (`@agenomics/react`). All
three are prerequisites: the scaffold imports from them, not from
local files.

## Decision

**Ship `create-agenomics-app`: a standalone npm CLI that scaffolds a
Next.js (App Router) starter wired to Solana devnet via Privy
embedded wallet, with `<RegisterAgentButton/>` and the escrow flow
from `@agenomics/react` already pre-wired. Default cluster: devnet.
Default wallet: Privy embedded. Time-to-first-success target: <5
minutes including npm install.**

### What ships

#### 1. CLI entry point

Published to npm as **`create-agenomics-app`** (no scope, so the
`npm create agenomics-app@latest` short form works per the
`create-*` npm convention). Implementation lives at
`templates/create-agenomics-app/` in this repo.

```sh
npm create agenomics-app@latest my-aep-app
# or
pnpm create agenomics-app my-aep-app
# or
yarn create agenomics-app my-aep-app
```

Interactive prompts (with sensible non-interactive defaults via
flags, so CI / hackathon-judge use is fast):

- Project name (default: `my-aep-app`)
- Template (default: `next-app`; future: `vite`, `remix`)
- Cluster (default: `devnet`; choices: `devnet`, `localnet`,
  `mainnet-beta`)
- Wallet (default: `privy-embedded`; choices: `privy-embedded`,
  `solana-wallet-adapter`)
- Package manager (auto-detected; flag override available)

Non-interactive: `npm create agenomics-app@latest my-app -- --yes
--cluster=devnet --wallet=privy-embedded`.

#### 2. `next-app` template content

Generated repo structure:

```
my-aep-app/
├── app/
│   ├── layout.tsx          # AgenomicsProvider + PrivyProvider
│   ├── page.tsx            # landing: "Register Agent" + "Create Escrow"
│   ├── agent/
│   │   └── [authority]/page.tsx   # AgentProfileCard demo
│   └── escrow/
│       └── [pda]/page.tsx         # MilestoneList demo
├── components/             # copy-pastable starting components
├── lib/agenomics.ts        # cluster config + program IDs
├── .env.example            # NEXT_PUBLIC_PRIVY_APP_ID, RPC_URL
├── .cursorrules            # protocol-aware AI hints (per ADR-137)
├── CLAUDE.md               # AI-readable starter context
├── README.md               # 5-step quickstart
├── package.json
├── tsconfig.json
└── tailwind.config.ts
```

Out of the box:

- **Devnet** as the active cluster. Program IDs resolved via
  `getProgramIds("devnet")` from `@agenomics/idl` (ADR-099).
- **Privy embedded wallet** with email + social login by default.
  The user does **not** need a Solana CLI keypair, a browser
  extension wallet, or even an external SOL balance to start: Privy
  provisions an embedded wallet on first login, and a
  `<RequestDevnetSolBanner/>` component (in the scaffold's
  `components/`) calls `connection.requestAirdrop()` on click. If
  the public devnet faucet rate-limits, the banner falls back to
  pointing at the Google Cloud Solana Devnet faucet
  (`docs/DEVNET_FAUCETS.md`).
- **Tailwind v4 + shadcn/ui** preset, matching the
  `@agenomics/react/themes` companion (ADR-138).
- **Anchor IDL types** auto-installed via the `@agenomics/idl`
  peer dep.

#### 3. First-run UX

On first `npm run dev`, the app:

1. Renders a landing page with a single "Login with Privy" button.
2. After login (email magic link or Google), shows the embedded
   wallet's pubkey + a "Request 1 devnet SOL" button.
3. After airdrop confirms, surfaces a "Register your agent" card
   that calls `<RegisterAgentButton/>` from `@agenomics/react`
   (which builds + sends the `register_agent` IX via the Codama
   builder from ADR-134).
4. After confirmation, displays the live `<AgentProfileCard/>` for
   the just-registered profile, with a link to a second flow
   ("Create your first escrow") that walks through
   `useCreateEscrow → useAcceptTask → useSubmitMilestone →
   useApproveMilestone`.

The full flow is ~30 LOC of app code; the rest is provided by
`@agenomics/react`. Total: from `npm create` to "agent registered
on devnet" in under 5 minutes (target).

#### 4. Optional template variants (post-v0.1)

- `next-mcp` — Next.js + an embedded MCP server bridge (consumes
  the protocol MCP server; demonstrates the AI-agent-as-user path).
- `vite-spa` — Vite + React for non-Next consumers.
- `bun-server` — server-only template for headless agent builders.

### Out of scope

- **Mainnet defaults.** The scaffold defaults to devnet; selecting
  mainnet is possible but emits a banner pointing at ADR-080
  + the audit-status section of `docs/STATUS.md`. We do not ship a
  mainnet-ready template until the external audit closes.
- **Backend deployment.** The scaffold targets Vercel-style
  edge/serverless deploy via Next.js. No backend stack
  (Postgres, Redis) is included; the protocol's indexer +
  x402-relay live in this repo and are out-of-scope for the
  starter.
- **Custom contracts or extensions.** The scaffold uses the
  three deployed AEP programs as-is; it does not generate new
  Anchor programs (that's outside the protocol's scope by design).

## Consequences

### Positive

- **Closes the time-to-first-success gap.** From `npm create` to
  agent-registered-on-devnet in <5 minutes is the bar; the
  scaffold hits it because Privy removes the wallet step and
  `@agenomics/react` removes the boilerplate.
- **The scaffold is the canonical example.** Forks of
  `create-agenomics-app` will be the most-cited reference
  consumers see. Quality compounds: every improvement to the
  scaffold lifts the entire downstream ecosystem.
- **Hackathon fuel.** Colosseum / Renaissance / Solana
  Foundation grant participants disproportionately use protocols
  whose templates compile on first try. The scaffold is the
  single most leveraged piece of "ecosystem grant" infrastructure
  we can ship.
- **Combines with the gallery (ADR-140).** Each gallery entry
  starts as a fork of the scaffold; reviewers can see the
  mechanical "scaffold + N LOC of app code" story.
- **AI-assisted development.** The scaffold ships a
  `.cursorrules` + `CLAUDE.md` (per ADR-137) seeded with the
  protocol context, so a builder asking Cursor "now add a
  reputation leaderboard" gets typed, working code.

### Negative

- **Vendor coupling on Privy** for the default wallet path. Same
  exposure ADR-138 takes; same mitigation (the scaffold can
  swap to Solana Wallet Adapter via the `--wallet=
  solana-wallet-adapter` flag without touching app code, since
  the adapter abstraction lives in `@agenomics/react`).
- **Templates rot.** Next.js, Tailwind, Privy, and TanStack Query
  all ship breaking changes; the scaffold can fall behind. We
  mitigate by (a) pinning to `^x` minor ranges, (b) running an
  `npm create agenomics-app` smoke test in CI, (c) a quarterly
  template-bump review.
- **One more publish surface.** `create-agenomics-app` joins the
  publish list. Mitigated by reusing the existing publish
  workflow (ADR-089 / ADR-136); the CLI is just another package.
- **Scope creep risk.** "Just one more template" is an evergreen
  invitation; we explicitly cap v0.1 at `next-app` only, with the
  `next-mcp` / `vite-spa` / `bun-server` variants gated behind
  recorded demand.
- **Devnet RPC rate limits.** The default public devnet RPC is
  quickly throttled at scale. The `.env.example` includes
  commented-out lines for Helius / Triton / QuickNode so a
  consumer can swap in 30 seconds when they hit the limit.

### Follow-ups

- After this ADR is Accepted, scaffold lives at
  `templates/create-agenomics-app/`; CI runs `npm create
  agenomics-app@latest sandbox -- --yes` end-to-end on every PR
  that touches the template directory.
- Sample-app gallery (ADR-140) entries are forks-of-the-scaffold
  + N LOC of app code; the gallery's "diff against the scaffold"
  link makes it obvious how to graft features.
- Hosted demo: `agenomics.xyz/demo` runs the scaffold output on
  Vercel as the public reference deployment. Tracked, not
  blocking on this ADR.
- Telemetry: opt-in anonymous count of `create-agenomics-app`
  invocations, scaffolded to the same observability stack as
  ADR-104 (Prometheus + OpenTelemetry). Strictly opt-in and
  documented; tracked separately.

## Alternatives Considered

**Skip the scaffold; rely on docs + examples.** Rejected. Every
crypto SDK that has gained traction in the last 18 months has
shipped a scaffold; the conversion delta is large and well-
documented. The cost of building one is small relative to the
adoption uplift.

**Use Solana Foundation's `create-solana-dapp` as the entry
point.** Considered. `create-solana-dapp` produces a generic
Solana app and would still require the consumer to hand-wire
AEP. The protocol-specific scaffold's value is the AEP-flow
preconfiguration; we'd want our scaffold even if Foundation's
existed at higher quality (which we'd happily seed PRs into,
not block on).

**Multiple template variants in v0.1** (`vite-spa`, `bun-server`,
etc.). Rejected. Maintenance load scales with template count;
v0.1 ships the one template that matches the broadest cohort
(Next.js + React + Tailwind + Privy) and revisits.

**Use a wallet that doesn't require external infra (e.g. a local
keypair generated in the browser).** Rejected as the default. The
embedded-wallet pattern is what removes onboarding friction for
non-crypto-native users; offering a "no infra" toggle as a
secondary path is fine, but the default must be Privy because
that's what produces the fastest first-success.

**Support React Native first.** Deferred to a future ADR. The
addressable Solana mobile dev cohort is much smaller than Next.js;
RN can follow if traction warrants.

## References

- ADR-035 — dashboard-devnet (the existing internal app; this
  scaffold is the consumer-facing counterpart).
- ADR-099 — `@agenomics/idl` cluster-keyed program IDs (the
  source of truth the scaffold imports).
- ADR-134 — Codama-generated builders (the write-side
  surface the scaffold demonstrates).
- ADR-136 — license + publish flip (must land first).
- ADR-137 — AI-tool ingestible docs (the scaffold ships a
  starter `.cursorrules` + `CLAUDE.md` per this).
- ADR-138 — `@agenomics/react` (the React layer the scaffold
  consumes).
- ADR-140 — sample-app gallery (the canonical use of the
  scaffold).
- `docs/DEVNET_FAUCETS.md` — devnet airdrop options the scaffold
  surfaces.
- `create-onchain` (Coinbase OnchainKit) — the closest
  ecosystem precedent.
- `create-solana-dapp` — Solana Foundation's generic scaffold;
  complementary, not a substitute.
- Privy: https://privy.io ; Solana Wallet Adapter:
  https://github.com/anza-xyz/wallet-adapter.
