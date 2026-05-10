# ADR-138: @agenomics/react drop-in component library

## Status

Proposed

## Date

2026-04-30

## Context

The 2026-04-30 DX research synthesis named **drop-in React components,
not raw client libraries, as the dominant adoption-driver for crypto
SDKs in 2025–2026**. The proof points:

- **OnchainKit** (Coinbase) — `<ConnectWallet/>`, `<Transaction/>`,
  `<Identity/>`. Pairs with x402 + Coinbase's agentic-commerce
  stack. Adopted by ~20k dApps in <12 months.
- **shadcn/ui** — set the "copy the source into your repo" pattern;
  10s of thousands of projects depend on it. Component libraries
  are no longer about npm-installed black boxes; the source is in
  the consumer's repo and editable.
- **thirdweb** — typed React hooks for any contract. `useContract`,
  `useMint`. Removed the hand-wired Web3 boilerplate that was the
  norm in 2022.
- **Privy / Dynamic / Reown** — auth as a `<Provider>` + drop-in
  `<LoginButton/>`. The "user has no idea they have a wallet"
  pattern.
- **Wagmi + Viem** — typed hooks; the Solana ecosystem has nothing
  yet at this level of polish.

`@agenomics/client@0.2.0` (after ADR-134) ships typed instruction
builders. A Solana app dev who imports it still has to hand-wire:

1. Wallet adapter (Solana Wallet Standard or the Privy SDK)
2. Connection / `AnchorProvider` setup
3. Transaction send + retry + confirm UX
4. Loading / pending / error / success states
5. Optimistic on-chain reads (e.g. show the freshly-registered
   profile before confirmation lands)

This is exactly the boilerplate OnchainKit and Wagmi removed for
EVM. Solana has no equivalent component library that ships as a
first-party SDK from a protocol team. AEP can ship one, scoped to
the AEP-specific flows (register agent, fund vault, create escrow,
submit milestone, raise dispute, view reputation).

## Decision

**Ship `@agenomics/react` as a sixth public package: a small,
well-typed React component + hook library that drops on top of
`@agenomics/client` (ADR-134) and a wallet adapter to give app
builders a "render an AEP flow" surface in <10 lines.**

### What ships

#### 1. Provider

```tsx
import { AgenomicsProvider } from "@agenomics/react";

<AgenomicsProvider cluster="devnet" rpcUrl="...">
  {/* ...app... */}
</AgenomicsProvider>
```

Holds: cluster, RPC URL, `AepClient` from `@agenomics/client`,
wallet handle (consumer-supplied — adapter-agnostic; we do **not**
ship a wallet UI ourselves, see Out-of-scope). Exposed via
`useAgenomics()` hook.

#### 2. Typed hooks (one per high-frequency flow)

- `useAgentProfile(authority, nonce?)` — read; returns
  `{ data, isLoading, error, refetch }`. Cached via TanStack Query
  v5 (peer dep).
- `useRegisterAgent()` — write; returns `{ mutate, mutateAsync,
  isPending, ... }`. Wraps the Codama-generated builder + `sendAndConfirm`.
- `useVault(authority)` / `useInitializeVault()` /
  `useVaultTransfer()` / `usePauseVault()` / `useResumeVault()`.
- `useEscrow(escrowPda)` / `useCreateEscrow()` / `useAcceptTask()` /
  `useSubmitMilestone()` / `useApproveMilestone()` /
  `useRejectMilestone()` / `useRaiseDispute()` /
  `useResolveDispute()` / `useCancelEscrow()`.
- `useAgentReputation(authority)` — read with
  `clampReputationScore` from ADR-098 already applied.
- `useDiscoverAgents({ category, minReputation, ... })` — paginated
  read via the indexer's read API (or, while indexer-API-less,
  `getProgramAccounts` with the ADR-042 client-side filter).

Each hook input is typed via the same Zod schema family ADR-135
defines for the MCP boundary, re-exported from
`@agenomics/client/schemas`. So the React layer's runtime
validation matches the MCP server's, automatically.

#### 3. Drop-in components (small, headless-friendly surface)

Inspired by OnchainKit's "compose primitives, not monolithic
widgets" pattern. The components render minimal default markup but
expose `className` + `as` props and re-export their primitives so
shadcn-style consumers can copy & customize.

- `<RegisterAgentButton/>` — wires `useRegisterAgent` + provider
  wallet. Renders a button; calls back with the resulting
  `profilePda`.
- `<AgentProfileCard authority={pubkey} />` — read-only profile
  preview: name, category, reputation, status. Suspended badge if
  applicable (per ADR-094 / ADR-095).
- `<EscrowStatusBadge escrowPda={pubkey} />` — pulls escrow state
  via `useEscrow`, renders the canonical state name + color
  (Created / Active / Submitted / Approved / Disputed / etc.).
- `<MilestoneList escrowPda={pubkey} />` — milestones with
  status + amount + actions (`approve`, `reject` if client;
  `submit` if provider).
- `<ReputationGauge authority={pubkey} />` — 0–100 score
  visualization.
- `<AgenomicsErrorBoundary>` — catches Anchor / RPC / Zod
  errors and renders a structured error with the AEP error code
  and a doc link. Implements ADR-103's Result shape pattern at
  the UI boundary.

Components render no styles by default beyond minimal class
hooks; consumers bring their own design system. We ship a
companion `@agenomics/react/themes` entry with a Tailwind preset
+ shadcn-compatible component variants for the `create-agenomics-app`
template (ADR-139).

#### 4. Wallet-adapter integration policy

`@agenomics/react` is **adapter-agnostic**: it accepts a wallet
handle (anything implementing the Wallet Standard `Wallet`
interface) via `<AgenomicsProvider wallet={...} />`. The repo
ships **adapters** (small dep-free bridges) for the three
adoption-relevant cases:

- **Privy** — `@agenomics/react/adapters/privy` (the
  embedded-wallet path, primary for `create-agenomics-app` per
  ADR-139).
- **Solana Wallet Adapter** (`@solana/wallet-adapter-react`) —
  `@agenomics/react/adapters/solana-wallet-adapter` (the path most
  Solana-native devs already use).
- **Dynamic** — same shape, deferred to v0.2 of this package
  unless an early adopter requires it.

This split keeps `@agenomics/react`'s direct deps small: only
`@agenomics/client`, `@solana/web3.js`, `@tanstack/react-query`,
React 18+. Privy and the Solana Wallet Adapter live behind
optional peer deps.

### Out of scope

- **No wallet UI.** Privy and Solana Wallet Adapter both have
  excellent connect UIs; we don't reinvent. Consumers wire their
  preferred connect surface and pass the wallet handle to our
  provider.
- **No themed CSS / icon library.** The Tailwind preset is a
  starter, not the full design system. Consumers diverge as needed.
- **No SSR-only support.** Components are client-side; an
  `"use client"` directive is included. Server-side fetching
  (RSC) is supported only for the read hooks via the TanStack
  Query SSR pattern.
- **No mobile (React Native) build.** Tracked for v0.3+ if there
  is demand.

## Consequences

### Positive

- **Closes the largest remaining DX gap.** With ADR-134 (typed
  builders), ADR-135 (Zod schemas), ADR-136 (publish flip), and
  this ADR, an app dev gets from `npm install` to a working
  on-chain flow in <20 lines.
- **Fits the 2026 ecosystem.** "Drop-in React components" is
  what crypto SDKs are evaluated on; we ship that surface.
- **Reuses everything.** No duplicated types, no duplicated
  validation: every hook's input is a Codama-builder input
  validated by the Zod schema from ADR-135.
- **Direct fuel for adoption.** Sample apps (ADR-140) and the
  scaffold (ADR-139) become much smaller and more compelling
  when the React layer carries the boilerplate.
- **TanStack Query gives us caching + refetch + optimistic
  updates for free**, and is the dominant Solana React data
  layer. Adopting it aligns with ecosystem norms.

### Negative

- **Maintenance load grows.** A sixth package; one more publish
  cadence; React API surface to keep stable. Mitigated by a
  conservative export policy (additive only post-v0.1) and the
  small initial component set (~10 components, ~12 hooks).
- **Peer-dep matrix.** React 18 vs 19, TanStack Query v5 vs v6,
  Solana Wallet Adapter, Privy. We pin to `react@>=18,<20`,
  `@tanstack/react-query@^5`, and the rest as optional peers
  with version ranges in the README. Minor breakage windows
  expected on major upgrades.
- **Two render targets imposed by ADR-087** — the v1 default
  Codama path is what the React hooks consume; if the v2 default
  flips later (ADR-133 trigger fires), the React layer follows
  via a single `@agenomics/client` upgrade. We document the
  coupling so consumers know to upgrade together.
- **Privy vendor concentration.** Picking Privy as the
  primary embedded-wallet partner is a real bet. If Privy
  deprecates a feature or changes pricing, downstream apps feel
  it. Mitigated by adapter-shaped integration (`@agenomics/react/
  adapters/privy` is ~150 LOC; swappable).

### Follow-ups

- ADR-139 (`create-agenomics-app`) consumes this package; the
  scaffold's first-screen demo is a `<RegisterAgentButton/>`.
- ADR-140 (sample-app gallery) — the React layer is what makes
  the gallery samples small and compelling.
- ADR-137 (`CLAUDE.md` per package) — `@agenomics/react/CLAUDE.md`
  is added at this package's v0.1.0.
- Storybook deployment for the components, hosted under
  `agenomics.xyz/components` (separate ADR if it adds infra).
- React Native build — tracked, not blocking.

## Alternatives Considered

**Don't ship a React layer; tell builders to use `@agenomics/client`
directly.** Rejected. Empirically, "use the SDK directly" is what
every crypto SDK said in 2022; the ecosystem-wide pivot to
component libraries over the last 18 months is the strong signal
that this loses adoption.

**Ship monolithic widgets** (e.g. `<EscrowDashboard/>` that
renders the full lifecycle UI). Rejected for v0.1. Monoliths are
hard to customize, hard to compose, and end up unused. The
OnchainKit / shadcn pattern of small primitives wins because
consumers can always assemble bigger surfaces from them.

**Build inside the existing `dashboard/` directory.** Rejected.
`dashboard/` is the protocol-team operations dashboard
(ADR-035). Conflating consumer-facing components with
internal-ops tooling would crowd both purposes.

**Skip Privy; require Solana Wallet Adapter.** Rejected for the
default. Wallet Adapter is correct for Solana-native devs; Privy
is correct for the broader cohort that doesn't have or want a
wallet extension. Both ship; Privy is the scaffold default
(ADR-139).

**Vue / Svelte builds.** Deferred. The ratio of Solana-app dev
React vs. other-frameworks is large enough that React is the
right place to invest first; we revisit if traction warrants.

## References

- ADR-098 — `@agenomics/client`; the read-side foundation this
  package wraps.
- ADR-100 — `@agenomics/action-runtime`; Result type at the
  React error boundary.
- ADR-103 — Result shape consolidation; this package's error
  boundary uses the canonical shape.
- ADR-134 — Codama-generated builders; the write-side this
  package wraps.
- ADR-135 — Zod ↔ MCP tool schemas; this package re-uses the
  same schemas for hook input validation.
- ADR-137 — AI-tool ingestible docs; per-package `CLAUDE.md`
  applies here at v0.1.0.
- ADR-139 — `create-agenomics-app` scaffold; the canonical
  consumer.
- ADR-140 — sample-app gallery; the proof of utility.
- OnchainKit: https://onchainkit.xyz
- shadcn/ui: https://ui.shadcn.com
- Privy: https://privy.io
- TanStack Query v5: https://tanstack.com/query
- Solana Wallet Adapter:
  https://github.com/anza-xyz/wallet-adapter
