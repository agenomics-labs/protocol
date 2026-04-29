# ADR Inventory — 2026-04-25

**Phase 2 of architecture audit.** One row per ADR across the entire corpus (121 numbered ADRs + 2 duplicates). Produced by 4 parallel `researcher` agents, each covering a 30-ADR slice and spot-checking 4–5 against current code.

- **Implementation evidence**: `file:line` / `PR#` cited by ADR; "verified" if spot-checked; "drifted" if code disagrees; "none cited" / "Unverifiable" if absent.
- **Drift verdict**: Implemented / Partial / Drifted / Aspirational / Unverifiable.
- **Supersession**: explicit forward link if Superseded; flagged if de-facto unannotated.
- **Overlap cluster**: domain tag (e.g. `cpi-pattern`, `web3js-v2`, `mainnet-deploy`, `sas-integration`, `vault-allowlist`, `audit-findings`).

For cross-cuts (duplicate detection, supersession-chain integrity, overlap clusters, status-vs-code mismatches), see `ADR-DRIFT-MATRIX.md`.

---

## Batch 1 — ADR-001 through ADR-030

| ADR | Title | Status | Date | Decision (≤15 words) | Implementation evidence | Drift verdict | Supersession | Overlap cluster |
|---|---|---|---|---|---|---|---|---|
| 001 | Fix CPI Caller Verification in Registry UpdateReputation | Accepted | 2026-04-15 | Replace executable-check with PDA-signed CPI from settlement_authority PDA | `programs/agent-registry/src/lib.rs:213` settlement_authority signer; verified | Implemented | — | cpi-pattern |
| 002 | Add Anchor-Level Constraints to Settlement Contexts | Accepted | 2026-04-15 | Add has_one / constraint to AcceptTask, SubmitMilestone, RejectMilestone, RaiseDispute | `programs/settlement/src/lib.rs` cited; not line-checked | Implemented | — | anchor-constraints |
| 003 | Implement SPL Token Transfers in Vault | Accepted | 2026-04-15 | Add execute_token_transfer with allowlist + rate-limit + PDA-signed CPI | `programs/agent-vault/src/lib.rs:135` confirmed | Implemented | — | vault-allowlist, spl |
| 004 | Add memcmp Filters to discover_agents | Accepted | 2026-04-15 | Push status filter to RPC via memcmp at byte offset 998 | `mcp-server/src/index.ts` cited; offset removed by ADR-042 | Drifted | de-facto by ADR-042 (unannotated) | discovery, memcmp |
| 005 | Validate All MCP Handler Inputs Consistently | Accepted | 2026-04-15 | Apply requireString/requirePositiveNumber/requireStringArray across all 20 handlers | `mcp-server/src/index.ts` cited; not line-checked | Implemented | — | mcp-validation |
| 006 | Cap Allowlist Sizes with On-Chain Validation | Accepted | 2026-04-15 | Cap token+program allowlists at 10 entries; runtime require! | `programs/agent-vault/src/state.rs:5` MAX=10; `instructions.rs:129`; verified | Implemented | — | vault-allowlist |
| 007 | Improve Settlement-to-Registry CPI Pattern | Accepted | 2026-04-15 | Use invoke_signed with settlement_authority PDA; keep manual discriminator | `cpi.rs:74` now uses Anchor CPI helper, NOT manual discriminator | **Drifted** | de-facto by later refactor (no ADR cited) | cpi-pattern |
| 008 | Add Rust Unit Tests for All Programs | Accepted | 2026-04-15 | Add #[cfg(test)] modules to all three programs covering pure logic | proptest at agent-vault:466, registry:694; verified | Implemented | — | testing |
| 009 | Add Negative and Edge-Case Integration Tests | Accepted | 2026-04-15 | Extend mcp-handlers.test.ts with unauthorized-caller / limit / wrong-status cases | `mcp-server/test/mcp-handlers.test.ts` cited | Unverifiable | — | testing |
| 010 | Remove Stray Build Artifacts and Clean Repository | Accepted | 2026-04-15 | Delete libprobe.rlib, gitignore *.rlib, switch toolchain to stable | `.gitignore`, `rust-toolchain.toml` | Implemented | partly by ADR-013 (unannotated) | repo-hygiene |
| 011 | Devnet Deployment and End-to-End Smoke Test | Accepted | 2026-04-15 | Provide deploy-devnet.sh and smoke-test-devnet.ts | scripts cited; not opened | Unverifiable | precursor to ADR-031 | devnet-deploy |
| 012 | Migrate to @solana/web3.js v2 and Fix bigint-buffer CVE | Accepted | 2026-04-15 | Phase 1 compat layer at solana-v2.ts; phased handler migration | `mcp-server/src/solana-v2.ts` cited | Partial | overlaps ADR-033 same-day; de-facto canonicalized by ADR-033 + ADR-048 | web3js-v2 |
| 013 | Upgrade to Anchor 0.31+ | Accepted | 2026-04-15 | Bump anchor-lang/spl to 0.31.1 across three programs | All three Cargo.toml + mcp-server/package.json cited | Unverifiable (no line) | — | toolchain |
| 014 | Verify CPI Discriminator with Automated Test | Accepted | 2026-04-15 | Add cargo test that hardcoded discriminator equals sha256(name) | grep finds NO `test_cpi_discriminator_matches_anchor_convention` | **Drifted** (test removed when CPI switched) | de-facto by ADR-007 refactor (unannotated) | cpi-pattern |
| 015 | Per-Token Daily Spending Limits for Vault | Accepted | 2026-04-15 | Add TokenSpendRecord vec; enforce per-mint daily cap | `programs/agent-vault/src/lib.rs:240` confirmed | Implemented | possibly touched by ADR-044 | vault-allowlist, spend-limits |
| 016 | Off-chain Event Indexer | Accepted | 2026-04-15 | Build TypeScript SQLite indexer subscribing to onLogs | `src/indexer/index.ts` confirmed present | Implemented | — | offchain-services |
| 017 | x402 HTTP Payment Relay | Accepted | 2026-04-15 | Express relay verifying on-chain SOL transfer and issuing JWT | `src/x402-relay/index.ts` confirmed | Implemented | extended by ADR-090 | offchain-services, x402 |
| 018 | Framework Integration Plugins | Accepted | 2026-04-15 | Wrap 20 MCP tools as ElizaOS plugin and SAK plugin | `src/integrations/elizaos-plugin.ts` confirmed | Implemented | path conflict with ADR-027 | integrations |
| 019 | Security Audit Preparation and Threat Model | Accepted | 2026-04-15 | Produce docs/SECURITY_AUDIT.md with STRIDE threat model | doc-only deliverable | Aspirational (doc-only) | — | audit-prep |
| 020 | Reputation Staking and Slashing | Accepted | 2026-04-15 | Add ReputationStake, Suspended status, stake_reputation, 3-strike auto-suspend | `programs/agent-registry/src/lib.rs:77,191,257` verified | Implemented | extended by ADR-039 | staking, sybil |
| 021 | Fuzz Testing with Property-Based Tests | Accepted | 2026-04-15 | Add proptest dev-dep; mod fuzz to each program | `programs/agent-vault/src/lib.rs:466` proptest confirmed | Implemented | — | testing |
| 022 | Load Test for Agent Discovery | Accepted | 2026-04-15 | Add scripts/load-test-discovery.ts benchmarking memcmp vs full scan | script cited; not opened | Unverifiable | partly invalidated by ADR-042 | discovery, testing |
| 023 | Devnet Escrow Lifecycle Testing | Accepted | 2026-04-15 | End-to-end devnet test of create→accept→submit→approve→release | `tests/devnet/...` cited; not opened | Unverifiable | — | devnet-deploy |
| 024 | Scoped CPI Restrictions (V-A5 Fix) | Accepted | 2026-04-15 | Add pre/post lamport snapshot in execute_program_call | Cites `programs/vault/src/...` — **DEAD PATH**; instruction REMOVED by ADR-050 | **Drifted (instruction deleted)** | de-facto by ADR-050 (unannotated) | vault-allowlist, audit-fix |
| 025 | Expire Escrow with Approved Milestone Handling (S-A6) | Accepted | 2026-04-15 | Iterate milestones in expire_escrow and split payout | Cites `expire_escrow.rs` — file does not exist; code at `escrow.rs:376` | Implemented (path drift) | — | escrow, audit-fix |
| 026 | Resolve Dispute Bookkeeping Fix (S-A7) | Accepted | 2026-04-15 | Update released_amount after dispute payouts; assert invariant | Cites `resolve_dispute.rs` — file does not exist; code at `dispute.rs:27` | Implemented (path drift) | — | escrow, audit-fix |
| 027 | MCP Devnet Wiring and npm Package Configuration | Accepted | 2026-04-15 | Add .env.devnet, name three packages under @agenomics/*, publish script | path inconsistency with ADR-018 (`integrations/...` vs `src/integrations/...`) | Partial | overlaps ADR-032 | npm-packages, devnet-deploy |
| 028 | Anti-Sybil Defense for Reputation Farming | Accepted | 2026-04-15 | Min-escrow 10,000 base units; reject self-dealing; pair with ADR-020 | `programs/settlement/src/instructions/escrow.rs:31` self-deal + `lib.rs:296` MIN verified | Implemented | — | sybil, escrow |
| 029 | Remove Vestigial vault_account from ExecuteTransfer | Accepted | 2026-04-15 | Drop unchecked vault_account; vault PDA is sole holder | `programs/agent-vault/src/lib.rs:118` confirmed | Implemented | — | vault-allowlist |
| 030 | Multi-Sig Dispute Resolution with Timeout | Accepted | 2026-04-15 | Add disputed_at, 7-day DISPUTE_TIMEOUT_SECONDS, permissionless resolve_dispute_timeout | `lib.rs:89,297,615` + `dispute.rs:152` verified | Implemented | — | escrow, dispute |

---

## Batch 2 — ADR-031 through ADR-060

| ADR | Title | Status | Date | Decision (≤15 words) | Implementation evidence | Drift verdict | Supersession | Overlap cluster |
|---|---|---|---|---|---|---|---|---|
| 031 | Mainnet Deployment Preparation | Accepted | 2026-04-15 | Mainnet checklist + deploy script + multisig upgrade authority + Helius monitoring | `scripts/mainnet-deploy.sh`, `docs/MAINNET_CHECKLIST.md` verified | Implemented | **De-facto superseded by ADR-080 — UNANNOTATED** | mainnet-deploy |
| 032 | npm Package Preparation | Accepted | 2026-04-15 | Publish @agenomics/mcp-server and @agenomics/integrations scoped packages | none cited | Partial | de-facto evolved by ADR-085 (unannotated) | npm-packaging |
| 033 | Web3.js v2 Migration Plan | Accepted | 2026-04-15 | Three-phase v1→v2 with dual-module + feature flag | `docs/WEB3_V2_MIGRATION.md`, `solana-v2.ts` present | Aspirational | **Duplicates ADR-012 — neither cross-references the other** | web3js-v2 |
| 034 | Documentation Site | Accepted | 2026-04-15 | Use VitePress under /docs for landing, API ref, guides, ADRs | `docs/.vitepress/config.ts` verified | Implemented | — | docs-site |
| 035 | Wire Dashboard to Devnet | Accepted | 2026-04-15 | Connect AEPDashboard.jsx to devnet RPC for live program data | Cited file does NOT exist; actual `dashboard/src/App.jsx` + components live | Drifted (file path) | — | dashboard-devnet |
| 036 | External Audit Engagement | Accepted | 2026-04-15 | Formal audit scope doc + auditor selection + remediation gating | `docs/AUDIT_SCOPE.md` verified | Implemented | — | audit-prep |
| 037 | Architecture Deep Audit | Accepted | 2026-04-16 | Document 14 findings (C1-C2, H1-H4, M1-M5, L1-L4) with priority matrix | spawned ADR-038→050 chain | Implemented | drives 038-050 | audit-findings (mega-ADR) |
| 038 | Fix C1 — Sandbox execute_program_call | Accepted | 2026-04-16 | Remove vault PDA signing; use invoke not invoke_signed | `instructions.rs:346` — entirely removed in ADR-050 | Implemented (then removed) | **Effectively superseded by ADR-050/L1 (UNANNOTATED)** | audit-findings |
| 039 | Fix C2/H2/H3 — Wire slashing, remove AuditEntry, add unstake | Accepted | 2026-04-16 | Parameterize reputation CPI + slash on dispute + unstake instruction | `programs/agent-registry/src/lib.rs:283` unstake_reputation; `state.rs:76` AuditEntry removal | Implemented | — | audit-findings |
| 040 | Account Space Calculation | Accepted | 2026-04-16 | Replace mem::size_of with explicit 1243-byte field-by-field sum for AgentProfile | Cites `programs/aep/src/...` — **PATH DOES NOT EXIST**; fix substantively present | Drifted (file path) | — | audit-findings, account-space |
| 041 | Vault has_one = authority Constraint | Accepted | 2026-04-16 | Add has_one = authority to 5 vault contexts; remove redundant require! | `programs/agent-vault/src/contexts.rs:35,48,75,88,119,171,239` verified | Implemented | — | audit-findings, vault-auth |
| 042 | Remove Fragile memcmp Offset | Accepted | 2026-04-16 | Drop memcmp(998) filter in discover_agents; do client-side filtering | `mcp-server/src/handlers/registry.ts:211,349` confirms O(N) path | Implemented | — | audit-findings, discovery |
| 043 | Category Length Validation | Accepted | 2026-04-16 | require!(category.len() <= 50, CategoryTooLong) | `programs/agent-registry/src/errors.rs:26` + `lib.rs:55,126` verified; ADR cites wrong path | Drifted (file path) | — | audit-findings, validation |
| 044 | Clean Spend Records on Allowlist Removal | Accepted | 2026-04-16 | vault.token_spend_records.retain(...) on remove_token_allowlist | none cited beyond `programs/aep/...` (path drift) | Unverifiable | — | audit-findings, vault-state |
| 045 | Numbering gap — no decision recorded | Not Written | 2026-04-22 | Editorial gap; preserve monotonic numbering | n/a placeholder | Implemented (placeholder) | — | meta-numbering |
| 046 | Add Missing MCP Tools (vault_token_transfer, stake_reputation, resolve_dispute_timeout) | Accepted | 2026-04-16 | Add 3 MCP tools wrapping on-chain instructions; tools 20→23 | `mcp-server/src/tools/{vault,registry,settlement}.ts` all 3 verified | Implemented | — | audit-findings, mcp-coverage |
| 047 | disputed_at Option + avg_rating Rounding | Accepted | 2026-04-16 | Make disputed_at: Option<i64>; add + n/2 rounding to avg | `programs/settlement/src/state.rs:98` verified; ADR cites wrong path | Drifted (file path) | — | audit-findings, semantics |
| 048 | Complete solana-v2.ts Compatibility Layer | Accepted | 2026-04-16 | Add PDA derivation, connection helper, keypair loading to v2 layer | compat module 282 lines; only `handlers-v2/vault.ts` migrated; comment "ONE action"; `AEP_USE_V2_VAULT_TRANSFER=1` | **Partial — title overpromises** | de-facto continued by ADR-058/059/087 | web3js-v2 |
| 049 | Split Programs into Modules | Accepted | 2026-04-16 | Split each program into 5-6 files (state, errors, events, contexts, instructions, lib) | `programs/{agent-vault,settlement}/src/` 6 files; `agent-registry` 5 (matches ADR note) | Implemented | — | refactor-modules |
| 050 | Final Audit Polish | Accepted | 2026-04-16 | Nine fixes (M1-M5 + L1-L4) — vault space, dead code, slashing on timeout/expire | **Confirmed: 9 sub-decisions in one file**; execute_program_call removal verified | Implemented | Partial-supersedes ADR-038 (UNANNOTATED) | mega-ADR, audit-findings |
| 051 | One Vault/Agent per Authority — Limitation | Accepted | 2026-04-17 | Accept 1:1 PDA mapping as v1; defer multi-vault to v2 | implicit in PDA seed structure | Implemented (documented) | — | known-limitations |
| 052 | Escrow PDA task_id Collision — Limitation | Accepted | 2026-04-17 | Accept per-pair task_id uniqueness; CloseEscrow enables PDA reuse | references "PR #1" — opaque/dead PR citation | Implemented (documented) | — | known-limitations |
| 053 | Compile-Time Protocol Parameters | Accepted (with forward-link) | 2026-04-17 | v1 keeps Rust constants; v2 sketch deferred — now realized as ADR-075 | Self-references ADR-075 in status; verified | Implemented | **GOLD STANDARD** for forward-supersession annotation | governance, protocol-config |
| 054 | Superseded — merged into ADR-025 + ADR-075 | **Superseded** | 2026-04-22 | Disposition stub | `escrow.rs:385-389` | Implemented (placeholder) | **Only explicit Superseded status in 031-060 range** | meta-supersession, governance |
| 055 | Not Written — CI gates + staking-PDA ownership absorbed elsewhere | Not Written | 2026-04-22 | Both proposals subsumed by ADR-020/039 | Cites `.github/workflows/`, ADR-020/039 | Implemented (placeholder) | — | meta-numbering |
| 056 | Not Written — x402 hardening + GlobalConfig absorbed by ADR-053/017 | Not Written | 2026-04-22 | Operational PRs + ADR-053/017 cover the gap | Cites ADR-053, ADR-017 | Implemented (placeholder) | — | meta-numbering |
| 057 | (intentionally absent) | n/a | n/a | Numbering gap, see ADR-045 | n/a | n/a | n/a | meta-numbering |
| 058 | Action shape + CapabilityGatedTool + @solana/keychain-core | Accepted | 2026-04-21 | Adopt SolanaSigner, define Action<I,O>, capability taxonomy, passthrough signer | scaffolding present; full migration ongoing | **Partial (mega-ADR — 9 numbered sub-decisions incl. §2.1)** | paired with ADR-059, ADR-060 | mcp-architecture |
| 059 | Tx Submission Pipeline (framework-kit, replay protection, preflight) | Accepted | 2026-04-21 | Adopt @solana/kit, simulate-then-size CU, mutex-per-key idempotency | `mcp-server/src/pipeline/` exists; only 1 of 24 handlers uses it | Partial | paired with ADR-058 | mcp-architecture, web3js-v2 |
| 060 | Capability Descriptor Format | Accepted | 2026-04-21 | Off-chain JSON manifest with on-chain CID + hash + signature | manifest_cid/hash/signature fields not observed in `state.rs` | **Aspirational — proposes Registry fields not yet present (mega-ADR — 7 sub-decisions)** | paired with ADR-058 | mcp-architecture |

---

## Batch 3 — ADR-061 through ADR-090

| ADR | Title | Status | Date | Decision (≤15 words) | Implementation evidence | Drift verdict | Supersession | Overlap cluster |
|---|---|---|---|---|---|---|---|---|
| 061 | sas-integration | Accepted | 2026-04-21 | Manifest-references-SAS (option B); Registry stays authoritative; off-chain resolver dereferences | docs-only; PR #3 manifest field; ADR-064 resolver verified | Implemented (docs decision) | — | sas-integration |
| 062 | mpp-canonical-conformance | Reserved | 2026-04-23 | Placeholder; defer until AEP commits to MPP HTTP-402 wire format | none cited (placeholder) | Aspirational | — | sas-integration (placeholder) |
| 063 | sas-credential-authority-governance | Proposed | 2026-04-21 | 3-of-5 AEP_PROTOCOL + 5-of-9 AEP_VALIDATORS multisigs; off-chain proposals + on-chain exec | Devnet 2-of-3 PDA in scripts/.sas-devnet.json; 6 pending blockers | Partial | — | sas-integration |
| 064 | sas-resolver-package | Accepted | 2026-04-22 | Off-chain TS resolver implementing ADR-061 §4 flow with allowlist | `packages/sas-resolver/src/resolver.ts` (PR #12, #14, #15) | Implemented | — | sas-integration |
| 065 | caching-strategy | Accepted | 2026-04-21 | Per-layer TTLs (30s/24h/5m/1h/1h); in-memory L1 + Redis L2 | `packages/sas-resolver/src/{cache,cache-redis}.ts` (PR #15) | Implemented | — | sas-integration |
| 066 | on-chain-governance-migration | Reserved | 2026-04-23 | Placeholder; defer until off-chain governance outgrows multisig | placeholder | Aspirational | — | sas-integration (placeholder) |
| 067 | cross-protocol-credential-trust | Reserved | 2026-04-23 | Placeholder for cross-protocol SAS credential allowlist policy | placeholder | Aspirational | — | sas-integration (placeholder) |
| 068 | registry-reputation-cpi-trust-boundary | Accepted | 2026-04-22 | Bind agent_profile to escrow.provider via has_one + provider_authority | `cpi.rs:57-66`, `registry/contexts.rs:83,151` (PR #32) | Implemented | **partially superseded by ADR-094 — UNANNOTATED**; cpi.rs:43 TODO | cpi-trust |
| 069 | vault-agent-identity-rotation | Proposed | 2026-04-22 | Add update_agent_identity ix gated by has_one=authority; document hot-key | `agent-vault/lib.rs:76-80`, `instructions.rs:91-105`; `AgentIdentityUpdated` event | **Drifted — NO MCP tool exposes this rotation** | — | key-hygiene |
| 070 | deregister-stake-cleanup | Proposed | 2026-04-22 | Block deregister while stake>0; close reputation_stake PDA atomically | none cited | Unverifiable (Proposed) | — | key-hygiene / anti-sybil |
| 071 | token-rate-limit-ordering | Accepted | 2026-04-22 | Validate before increment; flip allowlist to default-deny with wildcard | Part 1 ordering verified `instructions.rs:404+`; **Part 2 default-deny NOT shipped — `state.rs:117` still allow-all** | **Partial (drifted on default-deny)** | — | vault-security |
| 072 | token-recipient-guards | Accepted | 2026-04-22 | Reject self-transfer + recipient.owner==vault constraint | `contexts.rs:154-159` (PR #29) | Implemented | — | vault-security |
| 073 | dispute-none-resolver-path | Proposed | 2026-04-22 | None-resolver disputes route through symmetric-split timeout-only | `settlement/contexts.rs:249-251` enforces resolver.is_some(); `dispute.rs:121,215` | **Implemented despite "Proposed" status — HEADER LIES** | de-facto Accepted | mainnet-safety |
| 074 | settlement-authority-address-assertion | Accepted | 2026-04-22 | Pin settlement_authority via seeds + bump on all four CPI contexts | PR #32 commit 5ce5e8a; uses seeds::program (deviates from proposed `address = ...`) | **Implemented (deviation undocumented in ADR)** | — | cpi-trust |
| 075 | protocol-config-delta-bounds | Proposed | 2026-04-22 | Bound deltas to ±1M; use checked_neg() at cast site | `protocol_config.rs:84-99` enforces bounds; `lib.rs:170` checked_neg() | **Implemented despite "Proposed" status — HEADER LIES** | partially obsoleted by ADR-094 (unannotated) | cpi-trust |
| 076 | sas-resolver-schema-credential-binding | Accepted | 2026-04-22 | Per-credential signer allowlist + schema↔credential binding + strict-init owner check | `resolver.ts:451,464,171,233,290,355` (PR #31) | Implemented | — | sas-integration |
| 077 | aep-validators-credential-bootstrap | Proposed | 2026-04-22 | Defer AEP_VALIDATORS to T+90 post-mainnet; ship devnet skeleton script | `scripts/bootstrap-aep-validators-devnet.ts` present | Partial (script exists; ceremony deferred) | — | sas-integration |
| 078 | program-upgrade-authority-transfer | Proposed | 2026-04-22 | Devnet rehearsal first; sealed offline rollback key; Vault→Registry→Settlement order | none cited (procedure-only) | Aspirational | — | mainnet-safety |
| 079 | operator-key-hygiene | Proposed | 2026-04-22 | Bright-line: multisig touches authority ⇒ all signers on hardware/KMS | docs-only; signers.md not yet authored | Aspirational | — | key-hygiene / mainnet-safety |
| 080 | mainnet-deploy-safety-mandates | Accepted | 2026-04-23 | Refuse-to-run gates; required AUDIT_REPORT_HASHES; signed-tag; --self-test; shellcheck CI | `scripts/mainnet-deploy.sh:443-456,555`; **`--self-test` IS invoked by `.github/workflows/shellcheck.yml:67`**; AUDIT_REPORT_HASHES template present (zeros) | Implemented | de-facto supersedes ADR-031 (UNANNOTATED) | mainnet-safety |
| 081 | emergency-suspend-credential | Accepted | 2026-04-23 | Operationalize ADR-063 §6.1 T+2h suspend via change_authorized_signers | `scripts/emergency-suspend-credential.ts`; rotate + audit stubs as TODO | Partial (suspend done; rotate/audit stubs only) | — | sas-integration / mainnet-safety |
| 082 | indexer-event-coverage-ci-gate | Accepted | 2026-04-23 | Backfill 4 missing event decoders + CI gate parsing #[event] decls | `scripts/check-event-coverage.ts` + `.github/workflows/event-coverage.yml` | Implemented | — | mainnet-safety / observability |
| 083 | mcp-transport-security-model | Accepted | 2026-04-23 | Three modes: stdio (default), HTTP+bearer-token, Unix socket; loadWallet() perm check | `mcp-server/src/transport/*` present; `scripts/check-mcp-transport-auth.sh` | Implemented | — | mainnet-safety / mcp-security |
| 084 | squads-v4-multisig-substrate | Accepted | 2026-04-23 | Squads v4 chosen as multisig substrate for AEP governance | `scripts/.squads-devnet.json` + bootstrap script (PR #24, #26) | Implemented (backfill) | — | mainnet-safety |
| 085 | agenomics-npm-scope-rename | Accepted | 2026-04-23 | Rename @aep/* → @agenomics/* npm scope; keep AEP code identifiers | PR #19 commit 840e60e | Implemented (backfill) | — | naming/branding |
| 086 | aeap-to-aep-rename | Accepted | 2026-04-23 | Rename AEAP → AEP across code, configs, docs (case-preserving) | PR #18 commit 0903670 (110 files) | Implemented (backfill) | — | naming/branding |
| 087 | solana-kit-dual-stack-adapter | Accepted | 2026-04-23 | Coexist v1 (web3.js) + v2 (@solana/kit) per-handler in mcp-server | `mcp-server/src/{solana.ts,solana-v2.ts,handlers/,handlers-v2/}` verified | Implemented (backfill, in-progress migration) | — | sdk-migration |
| 088 | typed-anchor-program-clients | Accepted | 2026-04-23 | Use Anchor-generated target/types/*.ts; flip noImplicitAny:true; remove `as any` | mcp-server applied; **SDK at `sdk/client/src/` DRIFTED** (`(program.account as any)` at vault:83, registry:108,124, settlement:118,135) | **Drifted (mcp-server done; SDK not migrated)** | — | sdk-migration |
| 089 | reproducible-installs | Accepted | 2026-04-23 | npm workspaces + committed root lockfile + npm ci everywhere | `package.json` workspaces; `package-lock.json` committed; `ci.yml` uses `npm ci` | Implemented | — | build-hygiene |
| 090 | structured-logging | Accepted | 2026-04-23 | pino + redaction policy + correlation IDs across mcp-server, indexer, x402-relay | All three loggers present with pino + isoTime + redact | Implemented | — | observability |

---

## Batch 4 — ADR-091 through ADR-120 (with duplicates)

| ADR | Title | Status | Date | Decision (≤15 words) | Implementation evidence | Drift verdict | Supersession | Overlap cluster |
|---|---|---|---|---|---|---|---|---|
| 091 | Module system: mcp-server NodeNext + workspace policy | Accepted | 2026-04-23 | mcp-server flips CJS→ESM/NodeNext; deletes dynImport shim | `mcp-server/tsconfig.json`, `package.json#type=module`, `reputation.ts` (no shim) | Implemented | supersedes dynImport jsdoc | mcp-server-modernization |
| 092 | Capability manifest hash domain separation | Accepted | 2026-04-23 | Tag manifest hash with `AEP_CAPABILITY_MANIFEST_V1\0` prefix before sha256 | `MANIFEST_HASH_DOMAIN`, `tagged_manifest_hash` | Implemented | — | onchain-security |
| 093 | Eliminate self-referential PDA seeds | Accepted | 2026-04-23 | Vault Execute*Transfer takes explicit authority account; seeds derive from it | Vault contexts uniformly use `[b"vault", authority.key()]`; has_one = authority | Implemented | — | onchain-pda-hygiene |
| 094 | Reputation trust hierarchy inversion | Accepted | 2026-04-23 | Registry exposes propose_reputation_delta with [0,100] clamp; Settlement deprecates direct setter | Instruction in registry `lib.rs:220`, but **Settlement `cpi.rs:74` STILL calls legacy** | **Partial — live policy enforcement absent** | — | reputation-policy |
| 095 | Vault ↔ Registry suspension coupling | Accepted | 2026-04-23 | Vault transfers must include agent_profile; reject if Suspended | ADR text references `require_not_suspended`; needs runtime-grep | Partial | — | onchain-security |
| 096 | Account-resize / migration pattern | Accepted | 2026-04-23 | Add version: u8, MIGRATION_HEADROOM=64, migrate_agent_profile ix | `state.rs:21,80`, `lib.rs:498` verified; tests at lib.rs:998-1042 | Implemented | — | onchain-migration |
| 097 | Registration nonce for Sybil resistance | Accepted | 2026-04-23 | Add OwnerNonce account; profile PDA seed includes nonce; bumped on deregister | `state.rs:108` OwnerNonce; **but `contexts.rs:301-325` ProposeReputationDelta omits nonce seed** | **Partial — drifts in ProposeReputationDelta context** | — | onchain-sybil |
| 098-client-sdk | @agenomics/client TypeScript SDK (verbose) | Accepted | 2026-04-23 | Three client classes + PDA helpers + fetch methods; **no @agenomics/idl dep** | `sdk/client/package.json` DOES depend on @agenomics/idl (contradicts ADR §1.5) | **Drifted — should be Superseded** | should be marked `Superseded by ADR-098-sdk-client-package` | sdk-packaging |
| 098-sdk-client-package | @agenomics/client SDK Package (brief) | Accepted | 2026-04-23 | Create sdk/client/ publishing @agenomics/client; re-exports @agenomics/idl IDs | `sdk/client/package.json` matches | **Implemented (canonical-by-implementation)** | (canonical) | sdk-packaging |
| 099-idl-package | @agenomics/idl IDL JSON+TS package (verbose) | Accepted | 2026-04-23 | Extend sdk/idl to ship vendored idl/*.json via ES2022 import attributes | `sdk/idl/src/idl/` exists; index.ts re-exports IDL consts | **Implemented (canonical, verbose superset)** | (canonical) | sdk-packaging |
| 099-sdk-idl-package | @agenomics/idl SDK Package (brief) | Accepted | 2026-04-23 | Cluster-keyed program-ID manifest + getProgramIds(cluster) helper | `sdk/idl/src/index.ts` exports PROGRAM_IDS/getProgramIds | **Partial — should be Superseded** | should be marked `Superseded by ADR-099-idl-package` | sdk-packaging |
| 100 | @agenomics/action-runtime SDK package | Accepted | 2026-04-23 | Extract Result/ok/err/defineAction/wrap from mcp-server into reusable package | `sdk/action-runtime/src/index.ts` exports Result/ok/err/wrap/defineAction | Implemented | — | sdk-packaging |
| 101 | Per-credential SignerHistoryV1 hard-fail | Accepted | 2026-04-23 | SAS resolver throws SignerHistoryMissingError when entry.signers undefined/empty | `packages/sas-resolver/src/resolver.ts` per ADR text | Implemented | — | sas-security |
| 102 | submit_milestone grace window | Accepted | 2026-04-23 | Add grace_period_slots to milestone; slash returns MilestoneInGracePeriod while active | needs grep on MilestoneInGracePeriod and grace_ends_at | Unverifiable | — | onchain-anti-mev |
| 103 | Standardized TypeScript Result shape | Accepted | 2026-04-23 | Canonical Result type lives in @agenomics/action-runtime; all services import | **Three DIFFERENT shapes still exist**: mcp-server uses `data`/AepError; sas-resolver uses `value`/Error; action-runtime uses `value`/Error | **Drifted — package created (ADR-100) but consumers not refactored** | — | typescript-hygiene |
| 104 | Prometheus + OpenTelemetry observability | Accepted | 2026-04-23 | Indexer/MCP expose /metrics; OTel tracer opt-in via env | `metrics-server.ts:53` and `observability.ts:68` BOTH bind 0.0.0.0; no auth | **Partial — security-relevant binding gap** | — | observability |
| 105 | Self-hosted GitHub Actions runners | Accepted | 2026-04-23 | Replace ubuntu-latest with [self-hosted, linux]; 4 systemd-user runners | `.github/workflows/*.yml` runs-on confirms; CI history shows self-hosted | Implemented | — | ci-infra |
| 106 | TraceRank payment-weighted reputation | Proposed | 2026-04-23 | Off-chain TraceRank score in indexer; expose via mcp-server; on-chain config knobs | No code; cites Shi 2510.27554; has decision criteria | Aspirational | — | research-driven |
| 107 | Reputation decay (MeritRank) | Proposed | 2026-04-23 | Apply absolute/transitivity/connectivity decay to off-chain TraceRank | No code; depends on ADR-106 | Aspirational | — | research-driven |
| 108 | Stake-backed peer discovery | Proposed | 2026-04-23 | Indexer/discovery filter by min_discovery_stake_lamports; log10-stake-weighted ranking | No code; default 0 (gate disabled) | Aspirational | — | research-driven |
| 109 | aep: URI scheme for agent identity | Proposed | 2026-04-23 | aep:<authority>[@<manifest-hash-12>][?endpoint=] parse/format/resolve helpers | No code | Aspirational | — | research-driven |
| 110 | Versioned Capability Vectors (VCV) | Proposed | 2026-04-23 | Manifest carries embedding+version; indexer HNSW; discover_agents adds similar_to | No code; canonical model `all-MiniLM-L6-v2`, 384-dim | Aspirational | — | research-driven |
| 111 | Vault delegation grants | Proposed | 2026-04-23 | New DelegationGrant PDA child of Vault: bounded, revocable, auditable sub-authority | No code | Aspirational | — | research-driven |
| 112 | Peer-ranked dispute consensus | Proposed | 2026-04-23 | Bradley-Terry pairwise ranking off-chain; opt-in DisputeMode::PeerConsensus | No code; on-chain verifies O(V) ranking proof | Aspirational | — | research-driven |
| 113 | Progressive decentralization governance | Proposed | 2026-04-23 | Stage-gated governance 0→3 via GovernanceStage PDA; one-way ratchet | No code; touches ADR-063/075/081 | Aspirational | — | research-driven |
| 114 | Dependabot dependency hygiene | Proposed | 2026-04-24 | Add .github/dependabot.yml for cargo/npm/actions; weekly cadence | unverified | Unverifiable | — | ci-gates |
| 115 | CI-blocking security gates | Proposed | 2026-04-24 | Three-stage flip of clippy/cargo-audit/npm-audit/eslint from advisory to blocking | Stage 1 baselines proposed; ci.yml advisory state still status quo | Aspirational | — | ci-gates |
| 116 | ProposeReputationDelta nonce-seed alignment | Proposed | 2026-04-24 | Add owner_nonce account + nonce in seed to ProposeReputationDelta context | **DRIFT CONFIRMED**: `contexts.rs:301-325` STILL omits owner_nonce | Aspirational | — | onchain-sybil |
| 117 | x402-relay error redaction | Proposed | 2026-04-24 | Two-surface error model: pino logs raw; client gets {code,message,correlationId} | No code | Aspirational | — | offchain-hardening |
| 118 | Indexer concurrency hardening | Proposed | 2026-04-24 | synchronous=FULL, async-mutex per program, SIGTERM handler with batch flush | No code | Aspirational | — | offchain-hardening |
| 119 | SDK boundary validation + mcp-server vault-layout drift gate | Accepted | 2026-04-24 (Proposed); 2026-04-28 (Accepted, scope-expanded) | SDK input validation + PDA derivation; codegen vault-layout from IDL + boot-time drift assertion (Batch D, MCP-311/313) | `sdk/client/src/index.ts` deriveAgentProfilePda + isValidPublicKey; `mcp-server/scripts/gen-vault-layout.ts`; `vault-layout.generated.ts`; `vault-layout-drift.ts:assertVaultLayoutMatchesIdl`; 5 tests at `mcp-server/test/vault-layout-drift.test.ts` | Implemented | — | sdk-packaging, mcp-idl-drift |
| 120 | Off-chain service unit-test mandate | Proposed | 2026-04-24 | Every src/* and packages/* MUST ship test script + smoke suite | `src/{indexer,x402-relay}/package.json` lacked test per ADR | Aspirational | — | offchain-hardening |

---

## Batch 5 — ADR-121 through ADR-133 (cycle-3 closeout — partial; only deltas added in 2026-04-28 refresh)

Only the ADRs landed in the cycle-3 closeout that the prior inventory snapshot did not yet reference are populated below. ADRs 121–129 will be backfilled by the next full inventory pass; the rows for 130–133 are added now because cycle-3 commits (`f0efc00..37f0acc`) reference them as in-force decisions.

| ADR | Title | Status | Date | Decision (≤15 words) | Implementation evidence | Drift verdict | Supersession | Overlap cluster |
|---|---|---|---|---|---|---|---|---|
| 130 | Sigstore-style artifact provenance for the program `.so` | Reserved | 2026-04-28 | Number reserved for cosign sign-blob layered on ADR-080 if SLSA / regulatory / multi-team triggers fire | doc-only; no code expected until trigger | Aspirational (Reserved-by-design) | — | mainnet-safety, supply-chain |
| 131 | Sybil-cost calibration — current bounds and threat-model boundary | Accepted | 2026-04-28 | Hold MAX_DELTA=10, SUSPEND_AT=3, no-min-stake; pin AUD-205 inequality `E > 3R + 3L`; name re-cal triggers | doc-only governance pin; cites `agent-registry/lib.rs:17,21,322-325,358-359`; `state.rs:197-201`; `settlement/state.rs:28,117` | Implemented (governance decision) | — | sybil, calibration, governance |
| 132 | MCP HTTP origin gate + container-aware transport default | Accepted | 2026-04-28 | Add origin allowlist middleware (MCP-321) + container auto-detect flips stdio→unix default (MCP-322) | `mcp-server/src/transport/origin-gate.ts` (~115 LOC); `auth-gate.ts:isContainerizedRuntime`/`detectTransportPosture`; 17 tests at `transport-origin.test.ts`; mcp-server suite 347/347 | Implemented | extends ADR-083 | mcp-security, transport |
| 133 | Handlers-v2 wave deferral — keep dual-path as living reference until Anchor v2 ships | Accepted | 2026-04-29 | Option (c) hybrid: defer wave, keep `handlers-v2/vault.ts` reference impl + dual-path; pin 5 re-eval triggers | `actions/vault.ts:171-189,223-241` env-gated dispatcher; `handlers-v2/vault.ts` (441 LOC) + `keypair-signer.ts` (114 LOC); test `handlers-v2-vault.test.ts` (503 LOC); scheduled trig_01GkKKZQd39rY2Z7w7tmmYou (2026-06-03) | Implemented (deferral pin) | governance overlay on ADR-012/033/087 | web3js-v2, governance |

---

## Roll-up by status

| Status | Count |
|---|---:|
| Accepted | 96 |
| Proposed | 23 |
| Reserved | 4 |
| Not Written | 3 |
| Superseded (explicit) | 1 |
| **Total numbered files** | **127** (incl. 2 duplicates; ADRs 121–129 not yet inventoried) |

## Roll-up by drift verdict

| Verdict | Count | Notable examples |
|---|---:|---|
| Implemented | 71 | 001, 003, 020, 049, 080, 089, 090, 119, 131, 132, 133 |
| Partial | 17 | 012, 048, 058, 059, 071, 080→partial-supersession ADRs, 094, 095, 097, 104 |
| Drifted | 12 | 004, 007, 014, 024, 035, 040, 043, 047, 088, 098-client-sdk, 103 |
| Aspirational | 21 | 060, 062, 066, 067, 078, 079, 106-118, 120, 130 |
| Unverifiable | 9 | 009, 011, 013, 022, 023, 070, 102, 114 |
| Placeholder (Not Written / Reserved) | 7 | 045, 055, 056, 062, 066, 067, 130 |

## Notes

- This inventory captures status **as of 2026-04-25 03:00 UTC**.
- Future audits should produce a new inventory rather than edit this one (per ADR-TEMPLATE.md immutability principle).
- Cross-cuts and remediation prioritisation are in `ADR-DRIFT-MATRIX.md`.
