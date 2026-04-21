# Solana Foundation + solana-labs Ecosystem Analysis

**Scan date**: 2026-04-21
**Orgs**: https://github.com/solana-foundation (70 repos), https://github.com/solana-labs (~100+ repos, 95% archived)
**Repos analyzed**: 22 (triaged by AEP relevance — **not stars** — per directive)
**Methodology**: Shallow `git clone --depth=1` into `/tmp/solana-scan/`, read source only (`.rs`/`.ts`/`.tsx`/`.toml`/`.json`). Markdown/README files explicitly excluded.
**Scan agents**: 4 parallel Explore agents coordinated by claude-flow V3 swarm `swarm-1776751686552-60i3sy`.
**Companion**: [`SENDAIFUN_ECOSYSTEM_ANALYSIS.md`](./SENDAIFUN_ECOSYSTEM_ANALYSIS.md)

---

## Executive Summary

**The Solana Foundation already ships ~60% of what AEP was planning to design from scratch.** This scan collapses the scope of ADR-058/059/060 significantly: most of the "signer trait", "tx pipeline", "token handling", and "wire format" work becomes dependency adoption rather than bespoke design.

**Key strategic reframe:** sendaifun is a *downstream consumer* of Foundation primitives. Their `solana-mcp` reinvents hot-keypair MCP in a way `solana-mcp-official` deliberately rejects. **AEP's architecture should conform to the Foundation layer, not sendaifun's shortcuts.** Use sendaifun only for distribution (skills marketplace, plugin ecosystem).

**The real AEP-unique surface is narrower than expected**:
- **Capability gating** (neither sendaifun nor `solana-mcp-official` has this)
- **Milestone state machine** with dispute semantics
- **Cross-program CPI coordination** between Vault / Registry / Settlement
- **Unsigned-tx MCP response convention** (MCP protocol lacks this primitive)
- **Capability descriptor format** (off-chain, hash-pinned, signed — ADR-060)

Everything else is composition of Foundation parts.

### solana-labs note

The solana-labs org is **95% archived** (mass-archive date 2026-03-09) — active development moved to `anza-xyz` (Firedancer/Agave). Only two archived-but-canonical reference programs matter for AEP: `perpetuals` (custody PDA patterns) and `launchpad` (phased-release patterns).

---

## Tier 1 — Direct dependencies (adopt as dep; no reinvention)

| Package | Use for | ADR impact |
|---|---|---|
| `@solana/kit` | Unified underlying SDK (replaces legacy `@solana/web3.js`) | All of ADR-058/059 |
| `@solana/keychain-core` | `SolanaSigner` trait + 9 backends (Vault, Privy, Turnkey, Para, Fireblocks, Dfns, CDP, AWS-KMS, GCP-KMS) | **ADR-058 scope collapses ~60%** |
| `framework-kit` helpers | Blockhash cache (TTL-based refresh), compute-budget injection (`getSetComputeUnitLimitInstruction`, `getSetComputeUnitPriceInstruction`) | **ADR-059 scope collapses ~50%** |
| `@solana/token-helpers` | ATA creation with Token/Token-2022 auto-detection + token-acl auto-thaw | Eliminates hand-rolled ATA derivation |
| `mosaic` | Token-2022 mint creation (metadata, permanent-delegate, default-account-state, confidential-transfers, transfer-fee, scaled-ui-amount) | ADOPT for Vault asset mints; **gap: no TransferHooks wrapper — AEP builds that** |
| `mpp-sdk` | Canonical Solana HTTP-402 wire format (`PaymentChallenge` + `PaymentCredential`, canonical JSON, base64url, challenge echo, splits up to 8, fee_payer mode, session mode) | **If AEP settlement speaks x402, conform — don't invent** |

---

## Tier 2 — Pattern ports (copy design, not code)

Foundation primitives where depending on the crate is too heavy or too narrow, but the **design pattern** should be reproduced.

### 2.1 `kora` authorization model → AEP vault policy engine

`kora` is a Solana relayer with a production-grade authorization stack. Port these patterns into AEP's Vault program:

- **Config-driven instruction/program/account whitelist** (static policy in account data)
- **Usage limits**: per-instruction / per-tx / per-bundle counters with time windows (Redis or in-memory)
- **Plugin validator system** — each validator is a typed trait impl; composable pre-sign gates (e.g., `GasSwapPlugin` for fee abstraction)
- **Signer pool with pluggable backends** (Memory / Privy / Turnkey / Vault / HSM) + selection strategies (RoundRobin / Weighted / HighestBalance)

AEP's Vault daily cap + per-recipient limit + token allowlist maps directly onto this shape.

### 2.2 `token-acl` gating-program delegation → Vault policy indirection

`token-acl` stores `freeze_authority` + a pointer to an external **gating program** that actually decides freeze/thaw. Adopt this indirection:

- Vault PDA holds `policy_program: Pubkey`
- Policy decisions CPI to the pointed program
- Swap policies without re-deploying the Vault program
- Enables future pluggable policies (KYC gating, time-lock overrides, cross-chain proofs)

### 2.3 `commerce-kit` payment state machine → AEP milestone state machine

`commerce-kit` ships a production payment escrow with clean state transitions:

| commerce-kit status | AEP milestone status |
|---|---|
| `Paid` (escrow locked) | `Funded` |
| `Cleared` (merchant settled, refund window closed) | `Released` |
| `Refunded` (dispute resolution) | `Disputed` / `Resolved` |

Patterns to port:
- **PDA seeds with `order_id` for uniqueness**: `[b"payment", config, buyer, mint, order_id]`
- **Settlement delay validation** (`validate_can_close(days_to_close)`) — enforced cliff (e.g., 3-day dispute window after release)
- **Multi-token support** from day 1 (not SOL-only)
- **Event emission instruction** for off-chain indexing (`process_emit_event` pattern)

### 2.4 `fiber` two-phase settlement → AEP escrow finalization

`fiber` ships on-chain payment channels with a clean `finalize → distribute` split:

- **42-byte account**: `{ deposit, settled, close_requested_at, distribution_hash (Blake3 truncated to 16 bytes), status, bump }`
- **Phase 1 — finalize**: off-chain actor commits the final `settled` amount
- **Phase 2 — distribute**: on-chain verification that sum(splits) ≤ settled, then transfer
- **Distribution hash**: Blake3 commitment to the split tree — on-chain only verifies hash membership, not signatures; off-chain constructs the tree

**Open decision**: build AEP escrow **on top of fiber** (use its primitive, add milestone/dispute layers) vs. **diverge** (build bespoke milestone escrow). Pushed to ADR-059.

### 2.5 `governance-program-library` voter PDA → lightweight dispute resolver

Heavyweight Anchor governance isn't right for AEP, but the **voter PDA structure** is:

```rust
pub struct Voter {
  pub voter_authority: Pubkey,
  pub registrar: Pubkey,
  pub deposits: Vec<DepositEntry>,  // per-mint deposits
  pub voter_bump: u8,
  pub voter_weight_record_bump: u8,
}

pub struct DepositEntry {
  pub mint: Pubkey,
  pub amount: u64,
  pub voting_power: u64,
  pub deposit_slot_hash: u64,  // timelock marker
}
```

Port as lightweight AEP `DisputeResolver` program. Don't depend on the full governance library.

### 2.6 `perpetuals` per-user position PDA → AEP Vault custody

The canonical custody pattern for multi-user programs:
- **Global program account**: `Perpetuals` / AEP `Vault` config
- **Per-pool account**: `Pool` / AEP asset-class config
- **Per-user account**: `Position` PDA seeded by `[b"position", owner, pool, custody, collateral_custody, nonce]`

Port the seed structure; skip the leverage/liquidation logic.

---

## Tier 3 — Substrate (wrap, don't compete)

Primitives where AEP should **wrap** the Foundation primitive as a substrate layer, keeping AEP's own semantics on top.

### 3.1 `solana-attestation-service` (SAS) — third-party reputation

**SAS does NOT replace AEP's Agent Registry.** SAS is a credential issuance system (schema + attestation + authorized-signer); AEP Registry is identity + state + governance. Hybrid approach:

- **AEP Registry**: keeps internal state (tier, delegations, active vaults, capability manifests, in-program revocation governance)
- **SAS layer on top**: third-party attestations about agents (KYC, behavioral scores, cross-party reputation)

SAS schema seeds: `["schema", credential, name, version]`; attestation seeds: `["attestation", credential, schema, nonce]`. AEP can publish an "Agent Manifest" schema and reference SAS attestations from the Registry.

### 3.2 `connectorkit` — wallet enumeration, upstream of signing

`connectorkit` is a Wallet-Standard-based session manager — **upstream** of signing. When AEP's MCP returns an unsigned tx, the client uses `connectorkit` to enumerate available wallets, pick one, and produce the signature. It complements `@solana/keychain-core` (which is the signer trait), not replaces it.

**Integration**: AEP MCP returns `{ type: "unsigned_transaction", serialized_tx, required_signers[] }` → client's `connectorkit` session resolves signers → signs via `SolanaSigner` backends → submits.

---

## Tier 4 — Conform to shape

Where AEP should conform to the Foundation's canonical shape rather than invent its own.

### 4.1 `solana-mcp-official` `SolanaTool` shape → AEP MCP tool interface

```ts
type SolanaTool = {
  title: string;
  description: string;
  parameters: ZodRawShape;
  outputSchema?: ZodRawShape;
  func: (params) => Promise<any>;
}
```

AEP's `Action<I, O>` shape (ADR-058) should be a **strict superset** of this:

```ts
interface Action<I, O> extends SolanaTool {
  similes: string[];                 // LLM hint
  examples: Example[];
  readOnly: boolean;                  // AEP addition
  capabilities: Capability[];         // AEP addition — default-deny
  preflight?: PreflightGate[];        // AEP addition
  // inputSchema === parameters, outputSchema unchanged
}
```

**Critical divergence**: `solana-mcp-official` is read-only with zero auth. AEP ships state-mutating operations (vault deposit, settlement release, dispute resolution) and **must** add the capability-gating layer that `solana-mcp-official` deliberately omits. Reject sendaifun's hot-keypair shortcut.

### 4.2 `solana-dev-skill` Markdown+YAML → AEP skill format

Skills are **not code** — they're structured Markdown with YAML frontmatter. The format defines the March 2026 best-practices spec:

- Frontmatter: `name`, `description`, `user-invocable`, `license`, metadata
- Body sections: "What this Skill is for", "Default stack decisions", "Agent safety guardrails" (immutable rules like W009 transaction review, W011 untrusted data handling), "Operating procedure"
- Progressive disclosure: links to reference docs
- Env-var standard: `NO_DNA=1` for non-human agents (disables TUI prompts)

**AEP skill distribution**: publish `skills/aep/{vault-initialization,settlement-lifecycle,dispute-resolution}.md` in **both** repos — `solana-dev-skill` is the format authority, `sendaifun/skills` is the distribution channel.

---

## Tier 5 — Ignore

| Repo | Why |
|---|---|
| `mpp` (solana-foundation, TS) | Documentation-only wrapper around `mpp-sdk` (Rust). Consume the Rust SDK via its published wire format, not this repo. |
| `solana-dev-mcp` | Demo/reference MCP on outdated SDK (1.6.1 vs official's 1.29.0). Use `solana-mcp-official` instead. |
| `txtx` | HCL deployment runbooks — a different abstraction layer than ADR-060's capability descriptor (runbook vs. capability contract). Reference action-request pattern only if AEP adds multi-sig consent flows. |
| `solana-record-service` (SRS) | Too generic; AEP needs agent-specific semantics (tier, delegation, vault bindings). Could reuse dual-ownership pattern (Pubkey vs. Token) but not the program itself. |
| `moneymq` | Stripe-webhook bridge; relevant only if AEP adds fiat onramps. No new primitives over `mpp-sdk` for pure on-chain flows. |
| `solana-payments-app` (solana-labs, archived) | Legacy Solana Pay on `@solana/web3.js` v1. Superseded by `mpp-sdk`. |
| `pay` (solana-foundation) | Useful split-resolution semantics (percent-of-original, not remaining-balance) — but AEP likely builds its own escrow. Reference the split model only. |

---

## Explicit rejects (do NOT adopt)

| Pattern | Why we reject |
|---|---|
| `solana-mcp-official` zero-auth model | AEP ships state-mutating ops; read-only-with-no-auth is wrong for settlement. Add capability-gating. |
| sendaifun `solana-mcp` hot-keypair model | Already rejected in sendaifun analysis; reinforced by solana-mcp-official's deliberate omission. |
| Full `governance-program-library` dependency | Anchor-heavyweight for AEP's use case; port the voter PDA shape only. |
| Building our own ATA/Token-2022 detection | `token-helpers` already does this. |
| Building our own `BaseWallet` trait from scratch | `@solana/keychain-core` `SolanaSigner` already has 9 production backends. |
| Inventing an x402 dialect | `mpp-sdk` defines the canonical wire format; conform. |

---

## ADR impact — scope collapse

| Layer | ADR was going to design | Foundation ships | AEP's remaining work |
|---|---|---|---|
| Signer trait | `BaseWallet` interface | `@solana/keychain-core` `SolanaSigner` + 9 backends | `KeypairSigner` (dev) + `PassthroughSigner` (unsigned-tx) + `CapabilityGatedTool` wrapper + unsigned-tx MCP response convention |
| Tx pipeline | compute-budget + priority-fee + blockhash refresh helpers | `framework-kit` ships all of them | Mutex-per-sig replay protection (from solana-mpp) + per-action preflight flags + `sendAndConfirmWithBlockhashExpiry` if `framework-kit` doesn't already have it |
| Token handling | ATA + Token-2022 detection | `token-helpers` | Add as dep |
| Token-2022 mints | Hand-roll extensions | `mosaic` (minus TransferHooks) | Build TransferHooks wrapper only |
| Wire format | Invent | `mpp-sdk` canonical x402 | Conform; don't invent |
| MCP tool shape | Invent `Action<I, O>` | `solana-mcp-official` `SolanaTool` | Conform + add capability gating layer |
| Agent identity | Build Registry alone | `SAS` for reputation | AEP Registry keeps internal state; SAS wraps as reputation substrate |
| Vault policy | Build engine alone | `kora` authorization model + `token-acl` indirection | Port kora's plugin validator shape; adopt token-acl's delegation indirection |
| Escrow state machine | Design from scratch | `commerce-kit` Paid→Cleared→Refunded | Port as milestone state machine |
| Payment channels | N/A | `fiber` two-phase finalize→distribute | Decide: build on fiber vs. diverge for milestone/dispute richness |
| Dispute resolution | Design from scratch | `governance-program-library` voter PDA | Port lightweight voter PDA |
| Skills distribution | Publish to sendaifun | `solana-dev-skill` format authority | Publish in both repos |

**Rough estimate**: ~60% of the original ADR-058/059/060 design work collapses to dependency adoption. The remaining ~40% is AEP-unique: capability taxonomy + capability-gating + milestone state machine + dispute flow + cross-program CPI coordination.

---

## Open design decisions (updated)

Original six from the sendaifun analysis **still stand**:
1. Capability taxonomy (typed enum)
2. Unsigned-tx MCP response convention
3. Error shape
4. Idempotency for settlement submits (mutex-per-sig)
5. Preflight granularity (per-action opt-in)
6. ADR-060 capability descriptor scope (off-chain only vs. programs/** follow-up)

**Four new decisions** from this scan:
7. **Fiber vs. custom escrow** — build AEP Settlement on top of `fiber` or build bespoke? Fiber's 42-byte account + Blake3 distribution-hash is elegant; AEP's milestone/dispute semantics may need richer state.
8. **SAS integration depth** — wrap SAS attestations from the Registry (lightest touch) vs. make Registry a SAS client (Registry stores SAS attestation pointers) vs. bypass SAS entirely (heaviest disagreement).
9. **Mosaic TransferHooks gap** — build a TransferHooks wrapper ourselves (adds surface area) vs. use `spl-token-2022` directly (drops Mosaic abstraction benefits) vs. upstream a PR to Mosaic (slow).
10. **mpp-sdk canonical conformance** — does AEP settlement speak HTTP-402 as a wire format (conform to `PaymentChallenge` / `PaymentCredential`) or is AEP purely on-chain (Anchor IX calls only)? If any agent-to-agent flow is HTTP-mediated, must conform.

---

## ADRs to draft (revised scope)

- **ADR-058**: `Action<I, O>` + `CapabilityGatedTool` wrapping + `@solana/keychain-core` adoption + `KeypairSigner` / `PassthroughSigner` adapters + unsigned-tx MCP response convention + capability taxonomy + error shape. **Scope collapsed ~60%.**
- **ADR-059**: `framework-kit` helper adoption + mutex-per-sig (from `solana-mpp`) + per-action preflight flags + optional `fiber` dependency + commerce-kit state machine port. **Scope collapsed ~50%.**
- **ADR-060**: Off-chain hash-pinned / signed / typed-I/O capability manifest; Registry stores pointer. Explicitly rejects sendaifun skills as capability schema. Explicitly rejects `txtx` HCL (different abstraction). **Scope unchanged.**
- **ADR-061 (NEW)**: SAS integration model (reputation substrate vs. bypass) — answers decision #8.
- **ADR-062 (NEW)**: MPP wire-format conformance — answers decision #10.

---

## Per-repo findings

### Foundation — payments / settlement

#### `pay` (Rust)
- **Stack**: Rust edition 2024. Axum + reqwest + tokio; TUI via ratatui; MCP via rmcp; deps on `solana-mpp` + `solana-x402`.
- **Crate layout**: `pay-types` (HTTP 402 challenge/receipt), `pay-core` (policy engine), `pay-keystore` (key mgmt), `pay-mcp` (MCP server), `pay-pdb` (payment DB), `pay-cli`, `pay-integration`.
- **Model**: Off-chain server issues HTTP 402 challenges; client signs + submits proof. **No on-chain program.**
- **Key types**: `PaymentChallenge { resource_url, payment_url, amount, currency, description }`, `PaymentReceipt` (opaque token), `SplitRule` (fixed or percent), `ResolvedSplit { recipient_pubkey, amount, label/memo }`.
- **Splits**: percent-of-original semantics (reordering doesn't change payouts). Query-parameter runtime account resolution (`${VAR}` substitution).
- **AEP verdict**: **REFERENCE** for split semantics. Likely build own escrow.

#### `mpp-sdk` (Rust) — **CRITICAL**
- **Stack**: Rust; deps on `solana-keychain`, `solana-mpp-protocol`, `reqwest`, `sha2`/`blake3`/`hmac`/`ed25519-dalek`.
- **Crate layout**: `protocol::core` (challenge/credential types, base64url-JSON), `protocol::intents::charge`, `protocol::solana` (splits, programs), `client::charge` (tx builder), `server` (verification), `store` (channel state).
- **Dual-mode**: (1) **Pull** (`type="transaction"`) — client signs, server broadcasts. (2) **Push** (`type="signature"`) — client broadcasts, server verifies.
- **Wire format**:
  - Challenge header: `WWW-Authenticate: Payment challenge="<base64url(canonical_json(PaymentChallenge))>"`
  - Credential header: `Authorization: Payment credential="<base64url(canonical_json(PaymentCredential))>"`
  - Canonical JSON via `serde_json_canonicalizer` — deterministic encoding prevents replay via re-serialization.
- **Solana tx**: bincode + base64. Supports splits (≤8 SPL recipients), `fee_payer` flag (relayer funds), `recent_blockhash` override. Compute budget hardcoded (200k units, 1 µ-lamport).
- **Replay protection**: standard Solana blockhash + tx uniqueness (signer + blockhash + timestamp in memo).
- **AEP verdict**: **ADOPT-AS-DEP**. Canonical Solana x402. AEP agents should conform.

#### `mpp` (TS) — ignore
Documentation-only wrapper that references the Rust SDK via npm (`mppx@pkg.pr.new/...`).

#### `moneymq` (Rust) — reference only
Workspace with `core`, `x402-sdk`, `drivers` (Stripe webhook handler), `stream`, `types`, `cli`. Stripe → Solana payment bridge. No new primitives over `mpp-sdk`.

#### `fiber` (Rust) — **reference pattern**
- **On-chain program**: Rust + eBPF/SBF. Deps: `solana-{account,instruction,pubkey,signature,transaction}` v3.x, Blake3.
- **42-byte account**: `{ deposit: u64, settled: u64, close_requested_at: i64, distribution_hash: [u8; 16], status: u8 (Open/Finalized/Closed), bump: u8 }`
- **Instructions**: `open`, `finalize`, `distribute`, `batch_*` variants.
- **Distribution hash**: Blake3-16 commitment to the split tree. On-chain verifies hash membership; off-chain constructs signatures.
- **AEP verdict**: **REFERENCE / OPEN DECISION** (build on top vs. diverge).

#### `kora` (Rust) — **reference pattern**
- **Relayer service**: JSON-RPC server (`jsonrpsee`) exposing `signTransaction`, `signAndSendTransaction`, `signBundle`, `signAndSendBundle`, `estimateFee`, `getConfig`.
- **Signer pool**: Pluggable backends (Memory / Privy / Turnkey / Vault / …), strategy selection (RoundRobin / Weighted / HighestBalance).
- **Validation pipeline**: `UsageTracker` (rate-limit rules per-ix/per-tx/per-bundle), `TransactionPlugin` system (e.g., `GasSwapPlugin`), account + signer validators, config-driven whitelist.
- **AEP verdict**: **REFERENCE for Vault authorization model.**

#### `solana-payments-app` (solana-labs, archived) — ignore
Shopify plugin on `@solana/web3.js` v1. Superseded by `mpp-sdk`.

### Foundation — identity / tokens / ACL

#### `solana-attestation-service` (SAS) — substrate
- **Stack**: Rust (pinocchio-based, `no_std`) + TS SDK. Custom serialization (not Borsh).
- **Schema Registry**: schemas define data layouts (U8–U128, Bool, Char, String, Vec). PDA: `["schema", credential, name, version]`.
- **Credentials**: multi-signer authority. PDA: `["credential", authority, name]`.
- **Attestations**: bind schema + credential + signer + data + expiry. PDA: `["attestation", credential, schema, nonce]`.
- **Tokenization**: optional NFT wrapper per attestation (soulbound credentials).
- **AEP verdict**: **SUBSTRATE** (reputation wrapper; AEP Registry keeps internal state).

#### `solana-record-service` — ignore
Generic record store. Class + Record PDAs, dual ownership (Pubkey or Token). Too broad for AEP's agent-specific needs. Reference dual-ownership pattern only.

#### `token-acl` (Rust) — pattern port
- **`MintConfig` PDA** seeded `["MINT_CONFIG", mint]`, 100 bytes: `{ discriminator, bump, enable_permissionless_thaw: PodBool, enable_permissionless_freeze: PodBool, mint, freeze_authority, gating_program }`.
- **Pattern**: `freeze_authority` points at a pluggable gating program — port as AEP Vault → Policy Program indirection.

#### `token-acl-gate` (Rust) — pattern port
- **`ListConfig` + `WalletEntry` PDAs** seeded `["list_config", seed]`; mode enum `Allow(0) | AllowAllEoas(1) | Block(2)`.
- Designed for Token-2022 transfer hooks.
- **AEP verdict**: port PDA structure for asset-allowlist components.

#### `mosaic` (TS) — adopt-as-dep (selective)
- **Token-2022 SDK** on `@solana/kit`. Wraps: `TokenMetadata`, `PermanentDelegate`, `DefaultAccountState`, `ConfidentialTransfers`, `ConfidentialTransferFee`, `TransferFee`, `ScaledUiAmount`, `InterestBearing` (partial).
- **Missing**: `TransferHooks`, `ImmutableOwner`.
- **Fluent builder**: `new Token().withMetadata(...).withPermanentDelegate(...).withTransferFee(...)`
- **AEP verdict**: **ADOPT** for Vault mint creation. **Build TransferHooks wrapper separately.**

#### `governance-program-library` (solana-labs, archived) — pattern port
- **Programs**: token-voter, realm-voter, nft-voter, quadratic, gateway, bonk-plugin.
- **Voter PDA** (Anchor): `{ voter_authority, registrar, deposits: Vec<DepositEntry>, voter_bump, voter_weight_record_bump }`. DepositEntry: `{ mint, amount, voting_power, deposit_slot_hash (timelock marker) }`.
- **AEP verdict**: port voter PDA shape; don't depend (Anchor-heavyweight).

### Foundation — signing / wallets / frameworks

#### `solana-keychain` (`@solana/keychain-core`) — **CRITICAL ADOPT**
- **Stack**: TypeScript on `@solana/kit`. Peer deps: `@solana/signers`, `@solana/transactions`, `@solana/addresses`.
- **Interface** (verbatim):
  ```ts
  export interface SolanaSigner<TAddress extends string = string>
      extends TransactionPartialSigner<TAddress>, MessagePartialSigner<TAddress> {
      readonly address: Address<TAddress>;
      isAvailable(): Promise<boolean>;
      signMessages(messages: readonly SignableMessage[]): Promise<readonly SignatureDictionary[]>;
      signTransactions(
          transactions: readonly (Transaction & TransactionWithinSizeLimit & TransactionWithLifetime)[]
      ): Promise<readonly SignatureDictionary[]>;
  }
  ```
- **Factory pattern**: every backend exports `createXSigner(config)`.
- **9 backends**: `vault`, `privy`, `turnkey`, `para`, `fireblocks`, `dfns`, `cdp`, `aws-kms`, `gcp-kms`.
- **`SignatureDictionary` return**: address → signature mapping; enables batch multi-wallet signing.
- **AEP verdict**: **ADOPT-AS-DEP for ADR-058**. Replaces the planned BaseWallet trait entirely.

#### `connectorkit` (TS) — substrate
- **Stack**: Wallet-Standard-based (`@wallet-standard/base`). Zero `@solana/kit` coupling. Headless core + optional React hooks.
- **Components**: `ConnectorClient`, `StateManager` (Zustand-style), `EventEmitter`, `ConnectionManager`, `WalletDetector`, `AutoConnector`, `ClusterManager`, `TransactionTracker`.
- **AEP verdict**: **EXTEND** as client-side wallet enumeration (upstream of `keychain-core` signing).

#### `framework-kit` (TS) — adopt-as-dep (selective)
- **Stack**: `@solana/kit` + Zustand. Reactive tx builder with `Subscribable` pattern.
- **`TransactionPrepareRequest`**: supports `authority: TransactionSigner | WalletSession`, `computeUnitLimit`, `computeUnitPrice`, `feePayer`, `instructions`, `lifetime: BlockhashLifetime`, `version: TransactionVersion | 'auto'`, `commitment`.
- **Blockhash cache**: TTL-based `LatestBlockhashCache` with `blockhashMaxAgeMs`, auto-refetch.
- **Compute budget**: auto-inject `ComputeBudgetInstruction.setComputeUnitLimit/Price` (respects overrides).
- **`TransactionPlanExecutor`** for multi-tx batching.
- **AEP verdict**: **ADOPT the blockhash cache + compute-budget helpers**. Skip React hooks (AEP headless).

#### `txtx` (Rust) — diverge
- **Stack**: Rust + HCL2 manifest (Terraform-compatible). Solana addon via `txtx-addon-network-svm-core`.
- **Signers**: `SVM_SECRET_KEY`, `SVM_WEB_WALLET`, `SVM_SQUADS`. **No MPC.**
- **Action-request pattern**: `ProvidePublicKeyRequest → ReviewInputRequest → ActionItemRequest` with construct DIDs.
- **AEP verdict**: **DIVERGE** from ADR-060 (different abstraction). Reference action-request pattern only for multi-sig consent flows.

### Foundation — MCP / skills / commerce

#### `solana-mcp-official` (TS) — **CRITICAL CONFORM**
- **Stack**: TypeScript, Express 5, Redis, Vercel; MCP SDK 1.29.0, `@solana/kit` 6.4.0, Zod 4.
- **Tool shape**: `SolanaTool { title, description, parameters: ZodRawShape, outputSchema?: ZodRawShape, func: (params) => Promise<any> }`. With `outputSchema` → `server.registerTool()`; without → `server.tool()`.
- **Transport**: HTTP/SSE (prod on Vercel) + stdio (dev).
- **Tool set**: `createSolanaTools()` (Solana Expert Ask, Documentation Search via Inkeep RAG) + `solanaEcosystemTools` (reserved).
- **Signing**: **Zero hot keypair. Zero signing capability. Read-only only.** Uses `@solana/kit` for RPC inspection (getAccountInfo, balance, metadata parsing).
- **Auth**: None. Relies on network perimeter (Vercel URL whitelist implicit).
- **Account classifier**: routes SPL Token, Token-2022, BPF upgradeable, vote, stake, nftoken accounts to dedicated parsers.
- **AEP verdict**: **CONFORM to tool shape, DIVERGE on signing** (add capability-gating layer).

#### `solana-dev-mcp` (TS) — ignore
Reference/demo MCP on SDK 1.6.1 (official is on 1.29.0). 5 tools (getAccountInfo, getBalance, getMinimumBalanceForRentExemption, getTransaction, getSPLTokenSupply). Stdio only. Too outdated.

#### `solana-dev-skill` — **CONFORM to skill format**
- **Skills are Markdown + YAML frontmatter**, not code.
- Frontmatter: `name`, `description`, `user-invocable`, `license`, metadata.
- Body sections: "What this Skill is for", "Default stack decisions", "Agent safety guardrails" (immutable rules), "Operating procedure".
- Embedded guardrails: W009 (tx review, no hot keypairs), W011 (untrusted data handling, no prompt injection from account data).
- CLI convention: `NO_DNA=1` env var signals non-human agent (disables TUI prompts).
- Default stack prescribed: `@solana/react-hooks`, `connectorkit`, `framework-kit`, Surfpool + LiteSVM for local testing.
- **AEP verdict**: **PORT format for AEP skills**. Publish `skills/aep/{vault-initialization,settlement-lifecycle,dispute-resolution}.md` in `sendaifun/skills` distribution.

#### `commerce-kit` (Rust) — **pattern port**
- **Stack**: Rust (Pinocchio/Anchor hybrid), Solana SDK 2.2.1.
- **PDA seeds**: `[b"payment", merchant_operator_config, buyer, mint, order_id]`.
- **Payment state**: `{ order_id: u32, amount: u64, created_at: i64, status: Status, bump: u8 }` with Status enum `Paid → Cleared → Refunded`.
- **Settlement delay**: `Payment::validate_can_close(days_to_close)` enforces grace period.
- **Merchant/operator split**: operator receives % fee per merchant config.
- **Event emission**: `process_emit_event` instruction for off-chain indexing.
- **AEP verdict**: **PORT state machine + PDA seed pattern + settlement-delay validation**.

#### `token-helpers` (TS) — **adopt-as-dep**
- **Stack**: `@solana/kit` 5.0, `@solana-program/token` 0.9, `@token-acl/sdk`, `@solana-program/token-2022`.
- Exports: `createAssociatedTokenAccountInstructions()`, `createAssociatedTokenAccount()`, `createAssociatedTokenAccountIdempotent()`.
- Auto-detects Token vs Token-2022; auto-adds thaw instruction for token-acl mints.
- **AEP verdict**: **ADOPT-AS-DEP**. Eliminates hand-rolled ATA derivation.

### solana-labs (archived reference)

#### `solana-labs/perpetuals` (Rust) — reference pattern
- **PDA seeds**: `[b"pool", pool_name]`, `[b"position", owner, pool, custody, collateral_custody, nonce]`.
- **Position state**: `{ owner, pool, custody, collateral_custody, open_time, side, price, size_usd, borrow_size_usd, collateral_usd, unrealized_profit, unrealized_loss, cumulative_interest_snapshot, locked_amount, bump }`.
- **TokenRatios**: `{ target, min, max }` BPS with invariants.
- **AUM calculation modes**: Min / Max / Last / EMA.
- **AEP verdict**: **REFERENCE** for multi-user position PDA pattern + per-asset custody lifecycle. Skip leverage/liquidation.

#### `solana-labs/launchpad` (Rust) — future reference
- Auction lifecycle: presale (WL only) → public → settle → withdraw.
- Pricing: Fixed or DynamicDutchAuction with `reprice_delay`, `reprice_coef`, `reprice_function (Linear/Exponential)`.
- Multi-token with weighted probability (`AuctionToken { ratio, account }`).
- **AEP verdict**: **FUTURE REFERENCE** for phased/tiered milestone settlement if AEP adds vesting or tranched releases.

---

## Recommended execution order (revised)

### Week 1 — ADRs (still the first unblock)
Draft **ADR-058, ADR-059, ADR-060, ADR-061 (SAS integration), ADR-062 (MPP conformance)**. Resolve all ten open design decisions before any P0 PR opens.

### Week 2 — Dependency pins + first PR
- Add deps: `@solana/kit`, `@solana/keychain-core`, `@solana/token-helpers`, `mosaic` (evaluate), `framework-kit` blockhash/compute-budget imports.
- PR: Action + CapabilityGatedTool + `SolanaSigner` adapters (`KeypairSigner`, `PassthroughSigner`) + unsigned-tx MCP response convention.

### Week 3 — Tx pipeline + read-only tools + commerce-kit state machine port
- PR: adopt `framework-kit` blockhash/compute-budget helpers; add mutex-per-sig; port commerce-kit Paid→Cleared→Refunded to AEP milestone state machine.

### Week 4 — Distribution
- PR `@aep/plugin-solana-agent-kit` alpha (D-1 from sendaifun analysis).
- PR `skills/aep/*.md` to both `sendaifun/skills` and reference the `solana-dev-skill` format.
- PR `solana-new` CLI index entry.

### Week 5+ — Protocol alignment stretch
- `mpp-sdk` conformance if AEP speaks x402.
- `fiber` vs. custom-escrow decision materialized.
- SAS integration depth decided.
- TransferHooks wrapper for Mosaic gap.
