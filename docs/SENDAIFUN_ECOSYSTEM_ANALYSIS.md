# SendAI Fun Ecosystem Analysis

**Scan date**: 2026-04-21
**Org**: https://github.com/orgs/sendaifun/repositories
**Repos analyzed**: 21 of 31 (substantive code only; 10 empty/forks/docs skipped)
**Methodology**: Shallow `git clone --depth=1` into `/tmp/sendaifun-scan/`, read source only (`.ts`/`.tsx`/`.js`/`.py`/`.rs`/`.json`/`.toml`). Markdown/README files explicitly excluded.
**Scan agents**: 4 parallel Explore agents coordinated by claude-flow V3 swarm `swarm-1776751686552-60i3sy`.
**Companion**: [`SOLANA_ECOSYSTEM_ANALYSIS.md`](./SOLANA_ECOSYSTEM_ANALYSIS.md) — a follow-up scan of Solana Foundation + solana-labs orgs that **materially revises** several recommendations in this doc. See *Post-Foundation Revisions* section below.

---

## Post-Foundation Revisions (READ FIRST)

This doc was written before scanning solana-foundation + solana-labs. The Foundation scan changed the strategic picture:

1. **sendaifun is a downstream consumer of Foundation primitives.** Their `solana-mcp` reinvents hot-keypair MCP in a way `solana-mcp-official` deliberately rejects. AEP's architecture should conform to the Foundation layer (`@solana/kit`, `@solana/keychain-core`, `mpp-sdk`, `solana-mcp-official` tool shape), not sendaifun's shortcuts.

2. **ADR-058 scope collapses ~60%.** `@solana/keychain-core` ships `SolanaSigner` with 9 backends (Vault, Privy, Turnkey, Para, Fireblocks, Dfns, CDP, AWS-KMS, GCP-KMS) — AEP's planned `BaseWallet` trait becomes dependency adoption + `KeypairSigner` + `PassthroughSigner` adapters. See SOLANA doc.

3. **ADR-059 scope collapses ~50%.** `framework-kit` already ships blockhash cache + compute-budget injection. AEP's remaining work is mutex-per-sig (from `solana-mpp`) + per-action preflight flags.

4. **Two new ADRs**: **ADR-061** (SAS integration depth) and **ADR-062** (MPP canonical wire-format conformance) — neither existed in the original sendaifun-only analysis.

5. **The AEP-unique surface is narrower than this doc originally estimated** — capability gating + milestone state machine + dispute flow + cross-program CPI coordination. Everything else is composition of Foundation parts (plus port-patterns from `kora`, `commerce-kit`, `fiber`, `token-acl`).

**Where this doc and the SOLANA doc disagree, the SOLANA doc wins.** This doc remains accurate for the *distribution ring* (sendaifun's skills marketplace, plugin-god-mode, create-solana-agent scaffolder) — that analysis is unchanged.

---

## Executive Summary

SendAI Fun is building the **agent-toolkit** side of AI+Solana (SDKs, skill marketplaces, MCP servers, scaffolders). AEP is building the **economic-protocol** side (agent identity, programmable vaults, settlement/escrow). **The two are complementary, not competitive** — SendAI's agents are AEP's customers.

However, **SendAI's MCP security posture is incompatible with AEP's trust model.** `solana-mcp` ships a single env-var hot keypair, blanket tool registration, untyped handler returns, and no capability gating. A settlement protocol's MCP endpoint cannot inherit those assumptions. The integration strategy therefore:

- **Adopts** architecturally-load-bearing shapes (`Action`, `BaseWallet`, tx-pipeline helpers)
- **Strengthens** them (typed output schemas, default-deny capability gating, custody-free `UnsignedTxWallet`)
- **Rejects** the signing / auth / registration / error patterns outright (see *Explicit rejects* section)

Three concentric distribution rings exist in the sendaifun ecosystem:

1. **Core SDK layer** — `solana-agent-kit` (1656⭐) with its typed plugin system
2. **MCP server layer** — `solana-mcp`, `solana-mcp-cloudflare` (AEP already operates here, but with stricter guarantees)
3. **Discovery layer** — `skills` marketplace, `solana-new` CLI, `create-solana-agent` scaffolder

The universal primitive across all 21 repos is the **Action shape** — AEP's variant strengthens it:

```ts
interface Action<I, O> {
  name: string;
  similes: string[];
  description: string;
  examples: Example[];
  readOnly: boolean;               // AEP addition
  capabilities: Capability[];       // AEP addition — default-deny
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;       // AEP strengthening — no Record<string, any>
  handler: (ctx, input) => Promise<Result<O>>;
}
```

### Highest-leverage move (revised)

The highest-leverage move is **not** publishing `@agenomics/plugin-solana-agent-kit` — that would force us to mirror SendAI's anti-patterns. The highest-leverage move is **adopting the strengthened `Action` abstraction inside `mcp-server/` first**, with `RemoteSigner` capability gating, and using that as the source from which external artefacts (plugin, skill, scaffolder) are derived. **Architecture before distribution.**

---

## Tier 1 — Architecture refactor + derivative distribution

Every external artefact (plugin package, skill marketplace entry, scaffolder template) is a derivative of the internal Action + signer abstraction. **1.A must ship before 1.B.** See forthcoming **ADR-058, ADR-059, ADR-060**.

### 1.A — Architecture refactor (prerequisite)

#### P0-A: Adopt `Action<I, O>` abstraction in `mcp-server/`

- New type `Action<I, O>` at `mcp-server/src/types/action.ts`
- New adapter `mcp-server/src/adapters/mcp.ts` — port `zodToMCPShape()` from sendaifun's `packages/adapter-mcp/src/index.ts`
- Refactor `mcp-server/src/handlers/{settlement,registry,vault}.ts` to export `Action[]`
- `mcp-server/src/index.ts` registers via adapter and enforces `wallet.capabilities ⊇ action.capabilities` at boundary; default-deny
- **Divergence from agent-kit**: typed `O` (not `Record<string, any>`), explicit `readOnly` + `capabilities[]` per action, default-deny registration
- **Known precision loss**: `zodToMCPShape` flattens discriminated unions / refinements / transforms into MCP's JSON Schema subset — document per-action where this bites
- **Non-breaking**: every existing tool registers under its current name; add a snapshot test asserting `mcp/list_tools` returns the same set before/after

#### P0-B: Define `RemoteSigner` / `BaseWallet` with capability set

- New interface `mcp-server/src/types/wallet.ts` shaped after agent-kit's `BaseWallet` (`packages/core/src/types/wallet.ts`) — `{ publicKey, signTransaction, signAllTransactions, signMessage?, signAndSendTransaction?, capabilities: Set<Capability> }`
- Ship two implementations:
  - `KeypairWallet` (dev-only, gated behind explicit `--allow-dev-keypair` flag)
  - `UnsignedTxWallet` (**default**): returns serialized txs via MCP response convention `{ type: "unsigned_transaction", serialized_tx, required_signers[] }`; caller signs with their own wallet
- MCP boundary enforces `wallet.capabilities ⊇ action.capabilities` intersect
- **Do not ship** the env-var single-key signer that `solana-mcp` uses by default

**P0 ordering note**: P0-A and P0-B are coupled. Ship them in one PR, or P0-B first — not P0-A alone. Otherwise new actions inherit today's signing assumptions and the refactor touches them twice.

#### P1-A: Port tx-pipeline helpers to `mcp-server/src/solana.ts`

- `getComputeBudgetInstructions(connection, tx, signer)` — simulates, reads `unitsConsumed`, sets CU limit to `max(unitsConsumed + 100k, unitsConsumed * 1.2, 200k)` (source: agent-kit `packages/core/src/utils/send_tx.ts`)
- `estimatePriorityFee(connection, writableAccounts, tier)` — Helius API if `HELIUS_API_KEY` present, else percentile over `getRecentPrioritizationFees` (`min 0.01 / mid 0.5 / max 0.95`)
- **Fix what agent-kit gets wrong**: replace its 90s blind poll with `sendAndConfirmWithBlockhashExpiry(tx, connection, { maxRetries, commitment, checkSlotLag })` — blockhash refresh + rebroadcast on slot expiry
- **Borrow from `solana-mpp`**: mutex-per-signature replay protection for settlement-submit actions — prevents concurrent verification races on milestone approval

#### P1-B: Three high-value read-only tools

Port behavior (not code), all `readOnly: true`, no capabilities required:

- `resolveDomain` — SNS `.sol` resolver; co-locate in `handlers/registry.ts` (used by agent profile lookup)
- `getAsset` — Metaplex DAS API unified metadata (fungible + NFT + cNFT); co-locate in `handlers/vault.ts` (used for deposit previews)
- `getClusterHealth` — `getRecentPerformanceSamples` + `getSlot` lag check; **per-action opt-in** via `Action.preflight?: ('cluster_health' | 'account_rent_exempt')[]`, not a global gate

### 1.B — Distribution (after 1.A ships)

These are **derivatives** of Phase 1.A's `Action[]` exports, not net-new code.

#### D-1: Publish `@agenomics/plugin-solana-agent-kit`

Reference `plugin-god-mode` file layout:
```
packages/plugin-aep/
├── src/
│   ├── vault/       { tools/, actions/ }
│   ├── registry/    { tools/, actions/ }
│   ├── settlement/  { tools/, actions/ }
│   └── index.ts
├── package.json  // tsup ESM+CJS dual build, peer-deps solana-agent-kit@^2
└── tsconfig.json
```

Users install via `new SolanaAgentKit({ plugins: [aepPlugin] })` — automatically exposed through `adapter-mcp`, LangChain, Vercel AI, OpenAI, Claude SDK adapters.

#### D-2: `skills/aep/SKILL.md` PR to `sendaifun/skills`

**DX only, no protocol binding.** Markdown skill teaching agents how to invoke AEP's MCP tools. PR adds entry to `skills/marketplace.json` + creates `skills/aep/{SKILL.md, templates/, examples/}`. If the upstream repo disappears, nothing breaks. Explicitly **not** used as a capability/schema format — see *Explicit rejects*.

#### D-3: `solana-new` CLI index + optional `create-aep-agent`

- Submit PR adding `{ slug, title, github_url, raw_url }` to `solana-new/cli/data/solana-skills.json` for CLI auto-indexing
- Two paths on scaffolder: (A) PR `--aep` flag to `create-solana-agent`, or (B) publish standalone `create-aep-agent` mirroring its template structure

---

## Tier 2 — Protocol alignment (strategic, deeper)

### 2.1 Adopt `charge` + `session` intent schema in AEP settlement

**Reference**: `solana-mpp` (12⭐) — **"Micropayment Protocol"** for Solana SPL, HTTP 402 standard

**Core primitives** (from `solana-mpp/src/`):
- **`charge` intent**: single-tx payment. Client signs tx with reference nonce → server finds on-chain transfer via `findAndVerifyTransfer()` → returns Receipt.
- **`session` intent**: deposit-based metering. Open (deposit) → bearer token → topup → close (refund unused balance).
- **Replay protection**: Store-backed consumed-signature set, plus mutex per-sig to prevent concurrent verification races.
- **Reference-PDA lookup**: deterministic reference PDA embedded in tx makes O(1) on-chain lookup possible.

**Mapping to AEP**:

| MPP concept | AEP equivalent |
|---|---|
| `charge` intent | Single-tx escrow lock (existing Settlement program) |
| `session` intent | Agent Vault deposit + metered per-action charging |
| Reference PDA | Your `vault_nonce` |
| `findAndVerifyTransfer()` | Should use Anchor event logs or indexed reference (don't scan all recent txs) |

**Gaps AEP adds on top of MPP**:
- MPP has no signer identity → AEP needs Ed25519 per-agent signer enforced by Registry program.
- MPP bearer tokens are opaque → AEP needs JWT + vault-ownership proof.

### 2.2 Adopt reservation → settlement pattern with micro-USD accounting

**Reference**: `x-research-x402` (1⭐) — production `ExactSvmScheme` implementation

**Pattern** (from `x-research-x402/src/server.ts`):
```
wallet login
  → reservation (lock funds, no charge yet)
    → fetcher executes (the real work)
      → settlement (charge actual usage = posts_read × micro_USD_per_post)
        → release-on-error if execution failed
```

**Accounting unit**: micro-USD (1 USD = 1,000,000 micro-USD) — internal unit avoiding float drift.

**Response meta** always includes:
- `charged_usd` (actual settle amount)
- `balance_usd` (remaining vault balance)

**Action for AEP**: Settlement program should emit matching balance-update events + adopt micro-USD as internal unit for milestone partial payments.

### 2.3 Future: Cross-chain bridge to Base USDC

**Reference**: `x402-mcp` (2⭐ fork, EVM-only)

**Wire-format gap**:
- x402-mcp uses EIP-712 sigs + centralized `useFacilitator` HTTP endpoint for verification
- AEP settles on-chain via Solana program state

**Bridge requires**:
- SPL-wrapped USDC on Solana (Wormhole, Allbridge, or native Circle CCTP)
- Multisig or light-client verification of Base payment proofs before releasing Solana-side escrow
- Opaque `x402/payment` header translation (x402 uses `_meta.x402/payment` opaque string decoded via `exact.evm.decodePayment()`)

Priority: **low** — only pursue if significant demand for Base-side agent payments emerges.

### 2.4 Optional: Durable Objects for per-agent session state

**Reference**: `solana-mcp-cloudflare` (2⭐)

**Pattern**: `MyMCP extends McpAgent<Env>` — stateful session per user, persisted across requests, OAuth-gated with JWT containing wallet address.

**Use case for AEP**: if AEP deploys its MCP server as a hosted service (vs. npx), Durable Objects give free per-agent state machines without running a separate DB for session tracking.

---

## Tier 3 — Reference patterns (learn, don't integrate)

### `fraction` (5⭐)
Rust/Anchor program: 5-party basis-points settlement with clean PDA derivation `("fraction_config", authority, name)` and `("fraction_vault", authority, name)`. Studies well for AEP's multi-party escrow if expanding beyond 2-party. Hard-coded 5-participant limit, fixed-size array (no Vec). `bot_wallet` parameter suggests keeper-bot-automated payouts.

### `raycast` (10⭐)
Dual-schema tool definitions: each tool is both a Raycast "command" (with View/Form UI) and a "tool" (with LLM-ai-instructions). The `ai.instructions` field per tool contains MCP-style system prompts telling the LLM how to resolve tickers, reuse price data across steps, etc. Directly reusable if AEP wants a Raycast frontend.

### `solana-app-kit` (147⭐)
Full mobile stack already wired: Privy social login + Turnkey passkeys + Dynamic Labs wallets + `@solana-mobile/mobile-wallet-adapter` + MoonPay fiat onramp + Jito MEV priority fee estimation + Redux-persist offline-first state. Copy wholesale if AEP builds a mobile agent client.

### `trumpit` (14⭐)
Vercel AI SDK streaming pattern (`for await (const textPart of stream.textStream)`), Privy per-Telegram-ID wallet pattern, Telegramify MarkdownV2 escaping for untrusted LLM output. Reusable Telegram UX patterns.

### `PToken-Lens` (4⭐)
Program-log parsing pattern: reconstructs SPL Token instruction call stack from `Program invoke` → `Instruction` → `Program success/failed` log lines. Useful if AEP wants to audit settlement-tx compute spend or build a tx-inspection tool.

---

## Tier 4 — Ignore

| Repo | Why |
|---|---|
| `website-v0` | Generic Next.js landing page |
| `sak-web` | Marketing site |
| `suzi-pnl-card-generator` | Satori→PNG card generator, no blockchain logic |
| `devrel-mcp` | Jito docs Qdrant semantic search, no payment logic |
| `action-registry` | Empty stub repo — file issues later if it matures |
| `awesome-solana-mcp-servers` | README-only list repo |
| `eliza`, `ax`, `extensions`, `defillama-dimension-adapters` | Unmodified upstream forks |
| `cf-cdn`, `boilerplate` | Empty/placeholder |

---

## Explicit rejects (do NOT adopt)

| SendAI pattern | Why we reject |
|---|---|
| `solana-mcp` env-var hot keypair | A settlement/vault MCP endpoint cannot have a drainable signer. Default to `UnsignedTxWallet`; gate any Keypair behind `--allow-dev-keypair`. |
| agent-kit flat `Config` god-object of API keys | Secrets must be injected per-plugin / per-action, not globally loaded into a process-wide struct. |
| Blanket `for (action of agent.actions) register(action)` | Each deployment profile must explicitly allow-list action names (e.g. `settlement-only`, `registry-read`). Default-deny. |
| `Record<string, any>` handler returns | Breaks typing at LLM + indexer boundary. Every action declares `outputSchema: z.ZodType<O>`. |
| agent-kit `sendTx` poll loop without blockhash refresh | Silent failure on slot expiry — a known footgun. Our version must rebroadcast. |
| SendAI `skills` format as capability schema | LLM prompt shrapnel, not an authorization contract. No typed I/O, no signing, no versioning. Different abstraction layer from capabilities — see ADR-060. |

---

## Open design decisions (resolve in ADRs before P0 PRs)

These gaps are flagged so they don't get silently filled in at PR-review time:

1. **Capability taxonomy** (ADR-058) — concrete enum for `Capability`:
   ```ts
   type Capability =
     | `read:${Domain}`                     // read:settlement | read:registry | read:vault
     | `sign:${Domain}`                     // sign:settlement | sign:vault
     | `sign:cross_program:${ProgramSet}`   // multi-program CPI scopes
     | `admin:${Domain}`;                   // dispute resolution, registry moderation
   ```
   Without this, capability gating degenerates into untyped string compares.

2. **Unsigned-tx MCP response convention** (ADR-058) — MCP has no native "return a blob for the client to sign" primitive. Needs an AEP-side convention:
   ```json
   { "type": "unsigned_transaction",
     "serialized_tx": "base64...",
     "required_signers": ["..."] }
   ```
   Calling clients (Claude Code via wallet-adapter, custom runtimes) must handle this shape. Otherwise `UnsignedTxWallet` serves responses no one can use.

3. **Error shape** (ADR-058) — "typed `O`" doesn't cover errors. Pick one:
   - Agent-kit's `{ status: 'ok'|'error', data?, error? }` discriminated union
   - Node-idiomatic thrown errors with a typed error catalog
   Every handler must conform.

4. **Idempotency for settlement submits** (ADR-059) — port `solana-mpp`'s mutex-per-signature pattern. `submitMilestone` / `approveSettlement` actions must be idempotent against retry.

5. **Preflight granularity** (ADR-059) — `cluster_health` is right for time-sensitive settlement submit, wrong for async vault reconfig. Per-action opt-in flag, not global gate.

6. **Scope of ADR-060 (capability descriptor)** — "hash-pinned, signed, typed I/O" descriptor implies Registry program schema changes. Either:
   - Scope to **off-chain only** (manifest lives in IPFS/Arweave, registry stores CID), OR
   - Acknowledge a `programs/**` follow-up is required and is explicitly out of scope for this MCP-layer plan.

---

## ADRs to draft

- **ADR-058**: `Action` / `Plugin` / `RemoteSigner` abstraction for `mcp-server/`. Covers `Action<I, O>` contract, capability taxonomy, default-deny gating, `BaseWallet` variants, unsigned-tx response convention, error shape.
- **ADR-059**: Tx submission pipeline. Canonicalizes compute-budget + priority-fee helpers, blockhash-refresh fix, mutex-per-signature replay protection, per-action preflight flags.
- **ADR-060**: AEP capability descriptor format. Off-chain hash-pinned / signed / typed-I/O manifest; Registry stores pointer. Explicitly rejects SendAI's unstructured skills format as a capability schema.

---

## Per-Repo Code-Level Findings

### `solana-agent-kit` (1656⭐)
- **Stack**: TypeScript + Turbo monorepo, `@solana/web3.js`, `@anthropic-ai/claude-agent-sdk`, `@langchain/core`, `@openai/agents`, Vercel `ai` SDK, tsup + rollup
- **Architecture**: Monorepo with `core` + 5 plugins (`token`, `nft`, `defi`, `misc`, `blinks`) + `adapter-mcp`
- **Key pattern**: `SolanaAgentKit<TPlugins>` generic class — immutable plugin composition via `.use(plugin)` returns `SolanaAgentKit<T & PluginMethods<P>>` giving compile-time type safety over the merged method surface
- **MCP integration**: `zodToMCPShape()` flattens Zod schemas into MCP tool shapes; examples-as-prompts embedded with each action

### `solana-mcp` (157⭐)
- Thin wrapper around `solana-agent-kit`: initializes `SolanaAgentKit`, converts actions via `adapter-mcp`
- **Dual transport**: stdio (default) + SSE over Express (opt-in via `PORT` env var)
- Per-session transport isolation for multi-client scenarios
- `GodModePlugin` auto-included — full wallet control via MCP

### `solana-mcp-cloudflare` (2⭐)
- Cloudflare Workers + Durable Objects port
- `CustomOAuthProvider` JWT → wallet address mapping
- Conditional init: `?blink` query param → Solana Actions/Blinks mode; otherwise god-mode
- Sentry sourcemaps for post-deployment observability
- Supabase for cross-region session replay

### `solana-mpp` (12⭐)
- **Full stack**: TypeScript, `@solana/web3.js`, `@solana/spl-token`, `mppx` framework, `@noble/hashes`, bs58
- **charge flow**: client signs tx with reference nonce → `findAndVerifyTransfer()` reads recipient ATA + mint + decimals + amount + signature → returns Receipt
- **session flow**: open (deposit) → bearer token → topup → close (refund)
- **Critical design detail**: recipient is Associated Token Account, not wallet address; mint + decimals specified client-side

### `x-research-x402` (1⭐)
- **Stack**: Bun + Hono, `@x402/*` ecosystem (`core`, `extensions`, `svm`), `@solana/kit`, Redis, `tweetnacl` + bs58
- **Dual-tier API**: free `/x402/*` with cache-check middleware; metered `/metered/*` with SIWx auth + Solana sig verification
- **`ExactSvmScheme`**: Solana-native x402 (not EVM — note this is the SPL variant)
- **Fixed tier pricing**: $0.01 read, $0.10–$0.50 search, $1.00+ thread, all encoded as micro-USD
- Redis-backed account store for balance tracking

### `x402-mcp` (2⭐ fork)
- **Stack**: viem 2.37+, `@modelcontextprotocol/sdk`, x402 EVM payment framework, Zod
- **Server side**: wraps MCP tools with payment middleware. Extracts `x402/payment` from `_meta`, verifies via `useFacilitator`, settles only on successful tool execution (prevents double-spend on errors)
- **Client side**: injects `generatePaymentAuthorization` + `viewAccountBalance` helper tools
- **Settlement**: Base mainnet USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), 6-decimal encoding
- **Reflect-based proxy** for `paidTool` method injection without subclassing

### `plugin-god-mode` (2⭐)
- **Peer dep**: `solana-agent-kit@^2.0.10`, tsup ESM+CJS dual build
- **100+ actions across 14 domains**: wallet, Jupiter, Lulo, Birdeye, Sanctum, Kamino, Rugcheck, Tensor, PumpFun, Debridge, Manifest, Meteora, Polymarket, Orca
- **Two-tier per domain**: `tools/` (core async logic) + `actions/` (LLM-friendly Action wrapper with similes, examples, Zod schema)
- **Plugin init pattern**: creates methods object, binds handler closures with agent instance

### `skills` (90⭐)
- **Pure JSON marketplace** — no runtime deps, no SDK
- `marketplace.json`: array of `{ name, source, category, description }` for 42+ integrations
- Each skill at `skills/<protocol>/` with `SKILL.md` (YAML frontmatter + markdown body) + `templates/` + `examples/`
- Validation script ensures every `marketplace.json` entry has a matching directory + `SKILL.md`

### `solana-new` (94⭐)
- CLI `superstack`/`solana-new` with 4 phases: `idea`, `build`, `launch`, `data`
- Subcommands: `init`, `ship`, `search`, `mcps`, `skills`, `repos`, `journey`
- Pre-indexed skill data: `cli/data/solana-skills.json` (15 official + 62 community skills from solana.com/skills), `solana-mcps.json`
- **Telemetry**: Convex backend, three privacy tiers (anonymous / community / full), no PII
- State: `~/.superstack/config.json` + `telemetry.jsonl` append log

### `create-solana-agent` (29⭐)
- NPX scaffolder, two templates: `templates/next/` (Next.js + LangChain + DeepSeek/OpenAI) and `templates/vite/` (Vite + TanStack Router + Drizzle + Privy + Postgres)
- CLI UX via `@clack/prompts`
- Next template pins `solana-agent-kit@1.4.5`; Vite pins `2.0.0-beta`

### `solana-agent-kit-py` (17⭐ fork)
- Python port: `SolanaAgentKit` class + async `AsyncClient`
- Manager pattern for exchange-specific logic (`AdrenaTradeManager`, `DriftManager`, `FlashTradeManager`)
- `pydantic-ai` for type-safe LLM I/O
- LangChain integration via `create_solana_tools()`

### `sonic-agent-kit` (10⭐)
- Direct fork of `solana-agent-kit` for Sonic chain (EVM-compatible Solana variant)
- Identical Action/Tool shape — validates the chain-agnostic abstraction
- Adds SendArcade game integration (rock-paper-scissors) as extensibility demo

### `raycast` (10⭐)
- Raycast extension with 25+ commands
- Each tool exports dual schema: command-mode (Raycast UI) + LLM-mode (`ai.instructions` field)
- LocalStorage session token + CacheAdapter for rate limit handling
- Axios wrapper with sorted-param cache keys for idempotent API calls

### `fraction` (5⭐)
- Anchor program, 3 instructions: `initialize_fraction` (create with 5 participants), `update_fraction` (reconfig), `claim_and_distribute` (settle)
- Participant struct: `{ wallet, shareBps }`, validation enforces 0–10000 bps
- PDA seeds: `("fraction_config", authority, name)` and `("fraction_vault", authority, name)`
- Codama-generated TS SDK

### `trumpit` (14⭐)
- TypeScript Telegram bot, DeepSeek via Vercel AI SDK
- `streamText({ ..., maxSteps: 10 })` with Solana tools bound
- Tools: Jupiter swap, Perplexity search, SPL transfer
- Privy per-Telegram-ID wallet (non-custodial), Redis + Prisma for user persistence
- Jito bundle client for MEV-protected swaps

### `PToken-Lens` (4⭐)
- Vite + React + `@solana/web3.js` + `@solana/kit`
- Transaction analyzer parses `Program invoke` / `Instruction` / `Program success/failed` log lines to reconstruct SPL Token call stack
- Hardcoded CU microbenchmarks: `TRANSACTION_TYPES` maps op → `(splTokenCU, ptokenCU)` pairs
- UI: txid input, devnet/mainnet switch, shows CU+SOL savings estimate for P-Token migration

### `solana-app-kit` (147⭐)
- React Native + Expo mobile app
- Wallet stack: Dynamic Labs + Privy + Turnkey + `@solana-mobile/mobile-wallet-adapter`
- Transaction service: Jito priority fees + MEV protection + commission calc + structured error parsing
- Redux + Redux Persist for offline-first state
- Socket.io for real-time updates, MoonPay fiat onramp

### `suzi-pnl-card-generator` (0⭐)
- Satori (React→SVG) + Resvg (SVG→PNG WASM), no DOM dep
- Templates for Polymarket, Hyperliquid PnL cards
- Font embedding: Inter, Palatino, DM Mono as `Uint8Array` buffers

### `devrel-mcp` (0⭐)
- Express + `@modelcontextprotocol/sdk` 1.15
- Qdrant vector DB + OpenAI embeddings + optional Jina reranker (`jina-reranker-v1-turbo-en`)
- Dual transport: modern Streamable HTTP (2025-03-26) + deprecated SSE (2024-11-05)
- Two tools: `search` (semantic) + `fetch` (by ID)

### `action-registry` (1⭐)
- Stub repo — only types + README + GitHub-issue-based coordination
- Defines `Action` interface: `{ name, similes, description, examples, handler, validate }` (inspired by ElizaOS)

---

## Recommended execution order

### Week 1 — ADRs (unblocks everything)
Draft **ADR-058** (Action + RemoteSigner), **ADR-059** (tx pipeline), **ADR-060** (capability descriptor). Resolve all six open design decisions before any P0 PR opens.

### Week 2 — Phase 1.A-1 architecture refactor
PR: P0-A (`Action<I,O>`) + P0-B (`RemoteSigner`, `UnsignedTxWallet`, capability gating). Must ship together.
- Verification: `npx tsc --noEmit` passes; `mcp/list_tools` snapshot unchanged; boot without `SOLANA_PRIVATE_KEY` → read-only tools work, write-tools return `"signer capability missing"`.

### Week 3 — Phase 1.A-2 tx pipeline + read-only tools
PR: P1-A (compute budget / priority fee / blockhash refresh / mutex-per-sig) + P1-B (`resolveDomain`, `getAsset`, `getClusterHealth`).
- Verification: force blockhash-expiry mid-submit (sleep 90s) → rebroadcasts, doesn't error; `HELIUS_API_KEY` on/off both land.

### Week 4 — Phase 1.B distribution
PR D-1 (`@agenomics/plugin-solana-agent-kit` alpha). PR D-2 (`skills/aep/SKILL.md` to sendaifun/skills). PR D-3 (`solana-new` index entry; `create-aep-agent` path choice).

### Week 5+ — Phase 2 protocol alignment (stretch)
`solana-mpp` charge/session intent adoption as AEP settlement schema (ADR, then program work). `x-research-x402` reservation + micro-USD pattern. Cross-chain x402 bridge only on demand.
