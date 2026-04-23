# Architecture Deep-Dive Audit — 2026-04-23

Five parallel audits run against `main` after the 6 PRs merging yesterday's deep-audit fixes (PRs #28-#33). Source agents: system-architect, security-architect (2nd-layer), code-analyzer, adr-architect, reviewer (operational). This file is the synthesis. Original agent reports live in conversation history — this file is the canonical, code-grep-able punch list.

## Cross-cutting themes

1. **"Three SPOFs that are one SPOF wearing three hats"** — upgrade authority + SAS credential authority + Squads signer-1 all root at `BUdXA1Fi…jTXL`.
2. **Off-chain consumers silently desync from on-chain** — indexer is missing handlers for 4 events including `AgentIdentityUpdated` (yesterday's SEC-2 fix), 44 `as any` casts in mcp-server skip Anchor type checking, no CI gate validates event coverage.
3. **ADRs lag behind shipped code** — 5 Proposed ADRs have shipping enforcement; 3 referenced ADRs (062/066/067) don't exist (8 dangling refs); 4 architecturally significant decisions made without ADRs.
4. **Reputation trust is upside-down** — Settlement owns the policy, Registry is a typed setter trusting one hardcoded program ID.
5. **Composition risks at the seams** — manifest signing lacks domain separation; `submit_milestone` front-runnable; ADR-076 SAS rotation race; MCP server has no auth on its tx-signing surface.
6. **No SDK** — `@agenomics/client`, `@agenomics/idl`, `@agenomics/action-runtime` don't exist; "third-party builders" is fiction.

## Triaged punch list

### 🔴 Blockers (before mainnet attempt)

| # | Item | Source |
|---|------|--------|
| 1 | Fix `local`-outside-function bug in `mainnet-deploy.sh`; add `shellcheck` CI gate | Ops C-01 / C-05 |
| 2 | Make `MULTISIG_ADDRESS` REQUIRED (remove skip-prompt); actually `sha256sum --check` audit-report hashes | Sec 4.1 / 4.4; Ops C-02 |
| 3 | Build `scripts/emergency-suspend-credential.ts` — ADR-063 §6.1 currently fiction | Ops R-01 |
| 4 | Separate signer-1 from upgrade-authority and SAS credential authority (HUMAN CEREMONY) | Sec 4.3 |
| 5 | Add MCP transport authentication / hard-document "do not expose over network without auth" | Sec 5.2 |
| 6 | Add indexer handlers for the 4 missing events (`AgentIdentityUpdated`, `ManifestUpdated`, `ProtocolConfigInitialized`, `ProtocolConfigUpdated`) | Arch 3.3 / 5.2 |
| 7 | CI gate: every `#[event]` in `programs/**/events.rs` must have a discriminator entry in `src/indexer/index.ts` | Arch 5.1 |
| 8 | Devnet upgrade rehearsal with real second human (HUMAN CEREMONY) | Yesterday GOV-6 + GOV-7 |
| 9 | Engage external audit vendor (HUMAN ACTION; 6-9 week lead) | Yesterday GOV-3 |

### 🟠 High (before v0.1.0 publish)

| # | Item | Source |
|---|------|--------|
| 10 | Promote ADRs 068/071/072/074/076 from Proposed to Accepted; drop "(in-flight)" from code comments | ADR F-3 |
| 11 | Create stub ADRs for 062/066/067 with `Status: Reserved` (closes 8 dangling refs) | ADR F-1 |
| 12 | Wire Anchor-generated types in `mcp-server/src/solana.ts`; flip `noImplicitAny: true`; delete 44 `as any` casts | Code §3.1 |
| 13 | Commit npm lockfiles workspace-wide; switch CI to `npm ci` | Ops T-01 / C-04 |
| 14 | `pino` structured logging across mcp-server / indexer / x402-relay; eliminate 39 `console.*` calls | Ops O-01 |
| 15 | Resolve CJS/ESM mismatch in mcp-server (`module: NodeNext`); kill the `dynImport` shim | Code §6 |
| 16 | Backfill 4 missing ADRs: Squads-v4 substrate, `@agenomics/*` rename, AEAP→AEP, Kit dual-stack | ADR F-4 / F-5 / F-6 |
| 17 | Manifest hash domain separation (`SHA256("AEP_CAPABILITY_MANIFEST_V1\x00" || canonical)`) | Sec 6.3 |
| 18 | Eliminate residual self-referential PDA seeds in `ExecuteTransfer`/`ExecuteTokenTransfer` | Arch #4.4 |

### 🟡 Medium (before mainnet but not v0.1.0)

| # | Item | Source |
|---|------|--------|
| 19 | Invert reputation trust hierarchy: Registry owns policy, Settlement proposes deltas Registry validates | Arch #1.1 |
| 20 | Vault read-side coupling to Registry's `Suspended` status (or document explicitly as out-of-band) | Arch #1.2 |
| 21 | Account-resize / migration pattern for `AgentProfile` | Arch #4.2 |
| 22 | `registration_nonce` in `agent_profile` PDA seed — defeats close-then-reopen Sybil reuse | Arch #4.3; Sec 2.1 |
| 23 | Build `@agenomics/client`, `@agenomics/idl`, `@agenomics/action-runtime` SDK packages | Arch #6.2 / 6.6 / 6.3 |
| 24 | Per-credential `SignerHistoryV1` on-chain account, OR hard-fail on `entry.signers === undefined` | Sec 3.1 / 3.2 |
| 25 | `submit_milestone` deadline-grace window to close front-run-the-slash exploit | Sec 2.2 |
| 26 | Standardize TS `Result` shape (`{ok,value}`); deduplicate `wrap()` helper; introduce `defineAction()` builder | Code §1.3 / §3.3 |
| 27 | Prometheus `/metrics` on indexer + relay; OpenTelemetry tracing across MCP→CPI→indexer | Ops O-02 / O-03 |
| 28 | Indexer SQLite backup runbook + cron + S3/GCS offload | Ops P-04 |
| 29 | x402-relay: persist `redeemedSignatures` to Redis + `tx.blockTime` recency check | Sec 5.6; Ops P-03 |
| 30 | x402-relay JWT: switch HS256→Ed25519/EdDSA OR add overlap-rotation (`JWT_SECRET_CURRENT/PREVIOUS`) | Sec 5.5; Ops CFG-04 |
| 31 | Single config layer: `config/programs.json` cluster-keyed, loaded by every TS service | Ops CFG-01 |
| 32 | Indexer non-SQLite story: write to event log (Postgres + CDC, NATS, or append-only S3) | Arch #3.4 |

### 🟢 Lower-priority cleanup

- L1: Split oversized files: `agent-registry/lib.rs` (874→~120), `agent-vault/instructions.rs` (525→~100/file), `sas-resolver/resolver.ts` (729→~450), `mcp-server/test/pipeline.test.ts` (1380→3 files)
- L2: Delete 30+ tautological tests in `agent-registry/lib.rs`
- L3: Wire or delete `mcp-server/test/mcp-handlers.test.ts` (1116 lines, currently not in `npm test`)
- L4: ADR polish: status banner on ADR-053, fix stale ref in ADR-056, add `Alternatives` sections to skinny ADRs
- L5: ADR-060 §3 — name the canonical-JSON spec
- L6: Anchor version pin to `0.31.1` everywhere; web3.js to single minor
- L7: Per-crate `[profile.release]` blocks in Cargo are dead — workspace root governs

## ADR-numbering plan for new decisions

| ADR | Title |
|-----|-------|
| 080 | mainnet-deploy.sh safety mandates (item 1, 2) |
| 081 | Emergency-suspend-credential procedure operationalized (item 3) |
| 082 | Indexer event-coverage CI gate (items 6, 7) |
| 083 | MCP transport security model (item 5) |
| 084 | Squads-v4 multisig substrate choice (item 16) |
| 085 | `@agenomics/*` npm scope rename (item 16) |
| 086 | AEAP→AEP code rename (item 16) |
| 087 | `@solana/kit` v1+v2 dual-stack adapter pattern (item 16) |
| 088 | Typed Anchor program clients in mcp-server (item 12) |
| 089 | Reproducible installs (npm ci + workspace lockfiles) (item 13) |
| 090 | Structured logging across off-chain services (item 14) |
| 091 | Module system: ESM via NodeNext (item 15) |
| 092 | Manifest hash domain separation (item 17) |
| 093 | Eliminate self-referential PDA seeds protocol-wide (item 18) |
| 094 | Reputation trust hierarchy inversion (item 19) |
| 095 | Vault ↔ Registry suspension coupling (item 20) |
| 096 | Account-resize / migration pattern (item 21) |
| 097 | Registration-nonce Sybil resistance (item 22) |
| 098 | `@agenomics/client` SDK (item 23) |
| 099 | `@agenomics/idl` package + cluster-keyed program-ID manifest (item 23, 31) |
| 100 | `@agenomics/action-runtime` extracted from mcp-server (item 23) |
| 101 | Per-credential SignerHistoryV1 on-chain or strict allowlist (item 24) |
| 102 | `submit_milestone` grace window (item 25) |
| 103 | Standardized TS `Result` shape + `defineAction()` builder (item 26) |
| 104 | Observability: Prometheus + OpenTelemetry (item 27) |
| 105 | Indexer SQLite backup + recovery (item 28) |
| 106 | x402-relay payment replay durability (item 29) |
| 107 | x402-relay JWT key rotation (item 30) |
| 108 | Indexer event-log durability (item 32) |
| 109 | File-size discipline + protocol module split (items L1, L2) |

## Constraints (mission-wide)

- **Do NOT cut v0.1.0 tag or publish to npm.** Final release is human-supervised.
- **Branches must open PRs.** Merge after CI green; do NOT push directly to main.
- **Tests required for every code change.**
- **ADR required for every behavioral change.** ADR template: Status / Date / Context / Decision / Alternatives / Consequences / References.
