# Appendix — Off-chain TypeScript Audit (2026-04-25)

**Source**: `code-analyzer` sub-agent run, 2026-04-25
**Scope**: `mcp-server/src`, `sdk/{client,action-runtime,idl}`, `src/indexer`, `src/x402-relay`, `packages/{capability-manifest-validator,sas-resolver}`, `dashboard/src` (light), workspace config
**Method**: full-read of MCP server, SDK, indexer, x402; sample of 6–10 ADRs (016, 017, 027, 058, 059, 060, 061, 064, 099, 104)
**Master IDs**: AUD-003, AUD-011..AUD-016, AUD-025..AUD-031, AUD-037..AUD-043, AUD-073, AUD-074

## Executive summary

The off-chain code is the product of multiple PRs landing on top of one another, mostly in good order — ADR-058 action shape, ADR-059 tx pipeline, ADR-083 transport gate, and ADR-090/104 observability hooks are real and reasonably well-built. Boundary handling, capability-gating, idempotency store, blockhash-expiry retry, and OTel/Prom wiring all exist as documented. SAS resolver and capability-manifest validator are notably mature: typed errors, RFC-8785 hashing, strict-mode owner check, signer history, schema-binding. x402 relay has had real hardening (TTL-bounded redeemed-sig map, JWT alg-pinning, trust-proxy guidance, finalized commitment).

That ends the good news. **The newly published `@agenomics/client` SDK ships three on-chain-incompatible PDA derivations** that nobody has caught because the package's only test asserts shape, not equivalence. There are also three competing `Result<T>` shapes across the very subpackages ADR-103 was supposed to unify, two contradictory tool-count claims in the public docs, and one `tools/index.ts` vs `actions/index.ts` overlap (both call themselves "all 24" while the README/SUMMARY say 23/20). The `mcp-server` itself uses a different `Result` shape than the SDK that ostensibly wraps it. The `ANCHOR_WALLET` env var is not honored anywhere — `loadWallet()` only checks `SOLANA_KEYPAIR_PATH`. There is no `rotate_agent_identity` tool despite ADR-069 being the load-bearing key-hygiene story.

The indexer is a positive standout (idempotency UNIQUE index, finalized commitment, proper backfill resume, tombstones for resurrection, real Borsh decode). The drift between SDK and on-chain is the highest-impact item in this audit.

## Findings table

| # | Sev | File:line | Issue | Recommendation | Master ID |
|---|---|---|---|---|---|
| 1 | CRITICAL | `sdk/client/src/vault.ts:54-58` | `vaultPda` derives `[authority.toBytes(), VAULT_SEED]`. On-chain (`programs/agent-vault/src/contexts.rs:19`) is `[b"vault", authority]`. **Seed order reversed** → wrong PDA. | Match Rust: `[VAULT_SEED, authority.toBytes()]`. | AUD-003 |
| 2 | CRITICAL | `sdk/client/src/settlement.ts:22, 66` | `ESCROW_SEED = "task_escrow"`. On-chain (`programs/settlement/src/contexts.rs:66`, `instructions/escrow.rs:230,341,453`) is `b"escrow"`. **Wrong seed string entirely**. | Change `Buffer.from("task_escrow")` to `Buffer.from("escrow")`. | AUD-003 |
| 3 | HIGH | `sdk/client/src/registry.ts:65`; `sdk/client/src/index.ts:116` | `profilePda` / `deriveAgentProfilePda` use `BigInt64Array` (signed i64) for nonce; on-chain `state.rs:109` and `solana.ts:312-315` use `u64.to_le_bytes()`. Identical bytes for `nonce ≤ 2^63-1`; diverges silently above. | Use `BigUint64Array` to match `OwnerNonce::nonce: u64`. | AUD-011 |
| 4 | HIGH | `sdk/client/test/index.test.ts:76-108` | Only `deriveAgentProfilePda` tests assert base58 shape and that nonces 0/1 differ. Neither would catch a wrong-seed bug. No equivalence test against Rust derivation. | Add test comparing against hard-coded PDA from `solana-test-validator` for fixed `(authority, nonce, programId)`. | AUD-012 |
| 5 | HIGH | `mcp-server/src/types/action.ts:48-53` vs `sdk/action-runtime/src/index.ts:1-11` vs `packages/sas-resolver/src/util/result.ts:12-16` | Three incompatible `Result` shapes coexist: `{ok, data}`, `{ok, value}`, `{ok, value}`. ADR-103 is "Standardized Result shape." | Pick one (recommend ADR-103's `{ok, value}`) and migrate `mcp-server/src/types/action.ts` + every `result.data` callsite. | AUD-013 |
| 6 | HIGH | `README.md:10,54` (23 tools) vs `SUMMARY.md:20,134,291` (20 tools) vs `mcp-server/src/tools/index.ts:74,79` and `actions/index.ts:1` (24 actions, 24 tools) | Tool count contradicts itself in three places. Actual count from code: 24 (`vault:8 + registry:5 + reputation:1 + settlement:10`). | Rewrite README/SUMMARY headers AND `tools/index.ts:74` to say 24 — OR add the missing `rotate_agent_identity` tool to make it 25. | AUD-014 |
| 7 | HIGH | `mcp-server/src/actions/*` | No action exposes ADR-069's `update_agent_identity` (vault key rotation). The IDL ships it (`sdk/idl/src/idl/agent_vault.json:758-768`), the indexer projects `AgentIdentityUpdated` events (`src/indexer/index.ts:574-585`), but operators have no MCP surface to actually call it. | Add `rotate_agent_identity` action covering ADR-069. | AUD-015 |
| 8 | HIGH | `mcp-server/src/solana.ts:155-177`; no use of `ANCHOR_WALLET` anywhere | `loadWallet()` reads `SOLANA_KEYPAIR_PATH`, falls back to `~/.config/solana/id.json`. `ANCHOR_WALLET` (the env var Anchor itself documents) is silently ignored. Operators following Anchor docs will not understand why the wrong wallet loads. | Honor `ANCHOR_WALLET` as precedence above `SOLANA_KEYPAIR_PATH`, or document the deviation. | AUD-016 |
| 9 | MED | `sdk/client/src/{vault,registry,settlement}.ts` | Every fetch uses `(this.program.account as any)[...].fetch(pda)` with `eslint-disable-next-line` and `Promise<Record<string, unknown>>`. ADR-088 ("Typed Anchor program clients") is not actually delivered for the SDK. | Pull IDL types from `@agenomics/idl` and parameterise `Program<AgentVault>` etc. | AUD-025 |
| 10 | MED | `mcp-server/src/handlers/validation.ts:1-57` vs `mcp-server/src/adapters/mcp.ts:55-67` (zod) | Two parallel input-validation regimes: hand-rolled `requireString/requireNumber` and Zod. Action router uses Zod; legacy validators are dead-but-imported in `handlers/vault.ts:22-25`. | Delete `handlers/validation.ts` once all `handlers/*.ts` confirmed unreachable. | AUD-026 |
| 11 | MED | `src/x402-relay/index.ts:9-22` | `JWT_SECRET` length not validated. A 5-character secret produces signing tokens that pass HS256 verification but offer ~25 bits of entropy. No floor check (vs `auth-gate.ts:111` which has `MIN_TOKEN_BYTES=16`). | Mirror `MIN_TOKEN_BYTES` floor: `Buffer.byteLength(JWT_SECRET, 'utf8') >= 32` else hard-fail. | AUD-027 |
| 12 | MED | `src/x402-relay/index.ts:298-309` | Per-signature replay protection is in-memory only. Horizontal-scaled relay (two pods) re-issues JWT for same `txSignature` independently. | Mirror mcp-server pattern: introduce `AEP_REDIS_URL` for cross-instance redeemed-sig + rate-limit. | AUD-028 |
| 13 | MED | `mcp-server/src/observability.ts:55-73` | `startMcpMetricsServer` binds to `0.0.0.0` with no auth. Any reachable peer can scrape live `aep_mcp_tool_calls_total{tool_name,status}`. | Default-bind `127.0.0.1`; allow `METRICS_HOST` override; OR allowlist `/metrics`. | AUD-029 |
| 14 | MED | `mcp-server/src/observability.ts:88-117` | `initTracing()` uses `require()` of OTel modules under ESM. Works only because `createRequire` is implicitly invoked by Node 20; under stricter loaders this throws. | Replace with `await import(...)` (make `initTracing` async), or use `createRequire(import.meta.url)` like `pipeline/idempotency.ts:31` does. | AUD-030 |
| 15 | MED | `mcp-server/src/index.ts:153-159, 165` | `createRpc()` invoked twice in `main()` with no functional purpose for the second. | Delete the redundant call. | AUD-031 |
| 16 | LOW | `mcp-server/src/handlers-v2/vault.ts:236-251, 282` | Five `as any` casts on Kit transaction-message helpers, with TODO citing "ADR-088 follow-up". Only one v2 handler exists; rest of surface still v1. | Migrate to `pipe()` pattern, or update ADR-048 status to reflect reality. | AUD-037 |
| 17 | LOW | `src/indexer/index.ts:459` | `ReputationDeltaProposed.delta` decoded via `r.u16()` and stored as positive even though Rust declares `i16`. Dashboards show 65530 instead of `-6`. | Use a signed-i16 reader (`buf.readInt16LE`); add a method to BorshReader. | AUD-038 |
| 18 | LOW | `src/indexer/index.ts:1132` | WebSocket reconnect detection peeks at `(connection as unknown as { _rpcWebSocket })`. Private API. | Replace with heartbeat ping or migrate to `@solana/kit` rpcSubscriptions. | AUD-039 |
| 19 | LOW | `mcp-server/src/index.ts:74` | `'sign:cross_program:settlement+registry'` capability appears nowhere else. Dead constant. | Delete or wire to settlement→registry CPI actions per ADR-068. | AUD-040 |
| 20 | LOW | repo root | Files violate CLAUDE.md "NEVER save working files…to root folder": `agentdb.rvf`, `agentdb.rvf.lock`, `ruvector.db` (548K SQLite blob), `.swarm/state.json`. | Move under `.local/` or add to `.gitignore`. | AUD-041 |
| 21 | LOW | `src/indexer/package.json:11` | Indexer pins `@coral-xyz/anchor:^0.30.0`. mcp-server pins `^0.31.1`. ADR-013 enforced 0.31.1. | Bump indexer to `^0.31.1`. | AUD-042 |
| 22 | LOW | `src/x402-relay/package.json` and `src/indexer/package.json` | Both have nested `node_modules/`. Workspace declares both as members; nested trees signal hoisting failed (ts-node-dev / better-sqlite3 native conflicts). | Run `npm dedupe`; or add `peerDependencies` so workspace hoist succeeds. | AUD-043 |
| 23 | INFO | `mcp-server/src/index.ts:41` | "all 23 actions" comment + `actions/index.ts:1` "All 24 MCP Actions" disagree. Same root as #6. | Reconcile to 24. | AUD-014 |
| 24 | INFO | `docs/adr/` | `ADR-098-client-sdk.md` AND `ADR-098-sdk-client-package.md` both exist; same for `ADR-099`. ADR-054, 055, 056 mix retraction notes with content. | Run `docs/adr/INDEX.md` check; collapse duplicates. | AUD-047 (governance) |
| 25 | INFO | `mcp-server/src/handlers/` | Whole `handlers/` tree appears parallel to `actions/` and partially superseded by `handlers-v2/`. `index.ts:41` claims it's retired but it's still imported by every action file. | Either retire and delete, or document the role explicitly. | AUD-026 (related) |

## Top architectural concerns (design, not bugs)

1. **Published SDK is not derived from the same source of truth as the MCP server.** Both define PDA helpers; both should use `@agenomics/idl` with one canonical seed table. As-is, every program-id / seed change risks SDK consumers breaking silently. → **AUD-073**
2. **Three Result shapes is one Result shape too many.** ADR-103 declared a standard, but each PR author rolled their own. Migration cost is mechanical but real. Until then, glue layers need adapters at every boundary. → **AUD-013**
3. **`solana-v2.ts` and `solana.ts` co-exist with explicit "PR3 will migrate" comments that have not been honored.** Of the 24 actions, exactly one (`vault_transfer` v2) is opt-in v2. The rest go through Anchor `.rpc()` (web3.js v1) — ADR-012/033/048 migration is at ~4% completion. → **AUD-037**, **AUD-074**
4. **Confirmation strategy is half built.** `pipeline/confirm.ts` has the catch-refresh-retry loop, but only `handlers-v2/vault.ts` invokes it. ADR-059 §4 conformance is one handler, not a pipeline. → **AUD-074**
5. **Observability metrics endpoint is unauthenticated and binds 0.0.0.0.** ADR-104 specifies endpoint exists; ADR-083 specifies MCP transport must be auth-gated. The two ADRs do not cross-reference. → **AUD-029**
6. **No CI-enforced equivalence between SDK PDAs and on-chain PDAs.** ADR-119 (Proposed) calls for a drift detector for IDL JSON; nothing similar for PDA seeds. Findings #1–#3 would have been caught by a single golden-PDA test. → **AUD-012**

## ADR-vs-code drift list

- **ADR-027 (mcp-devnet-npm-packages)** — README says 23, SUMMARY says 20, code ships 24
- **ADR-048 (solana-v2-completion)** — 1 of 24 handlers migrated; ADR title overpromises
- **ADR-058 (action+signer abstraction)** — actions delivered; signer abstraction is `signer: SolanaSigner | unknown | null`. PR3 keychain-core wiring not done.
- **ADR-059 (tx submission pipeline)** — pipeline exists; one handler uses it
- **ADR-069 (vault agent identity rotation)** — on-chain ix exists, indexer detects events, IDL ships it; **no MCP tool exposes it**
- **ADR-088 (typed anchor program clients)** — done in `mcp-server/src/solana.ts`; not done in `sdk/client/*.ts` (`(program.account as any)` everywhere)
- **ADR-098 / ADR-099 (SDK packages)** — published with PDA bugs (#1, #2, #3)
- **ADR-103 (standardized Result shape)** — three Result shapes still in tree
- **ADR-104 (observability)** — `/metrics` lives, but unauthed and bound to all interfaces; OTel `require()` calls fragile under stricter ESM loaders
- **ADR-117 (x402 relay error redaction)** — `verifyPaymentOnChain` returns ``error: `Verification error: ${err}`'' (`src/x402-relay/index.ts:145`), can include stack-trace text
- **ADR-119 (SDK boundary validation)** — Proposed; not implemented; #1–#4 are why it should land before mainnet

## Positive findings

- **Indexer (`src/indexer/index.ts`)** — finalized commitment, real Borsh decode with discriminator table sourced from `sha256("event:...")`, `INSERT OR IGNORE` on `UNIQUE(program, signature, ordinal)`, tombstone table preventing resurrection, monotonic backfill cursor, deferred metrics surface. The drift-guard comment at line 358 (test reads Rust source) is the right shape of defensive engineering.
- **MCP transport gate (`mcp-server/src/transport/auth-gate.ts`)** — constant-time bearer compare via SHA-256 digest pre-image, MIN_TOKEN_BYTES floor, keyfile permissions enforcement, Unix-socket peer-uid check with explicit fail-closed on non-Linux, RFC-6750 WWW-Authenticate header. Documented limitations (same-uid attacker) acknowledged.
- **Capability-manifest validator** — proper RFC-8785, hashes original input not Zod-stripped, demoted unstable canonical helpers to `unstable_` prefix, typed error codes, `KnownX | (string & {})` extensibility.
- **SAS resolver** — strict-init schema-PDA owner check that latches on definitive failure but NOT on transport flake (subtle and correct), per-credential signer/schema scoping (ADR-076/101), `SUBJECT_MISMATCH` as hard error.
- **Pipeline idempotency** — TTL-bounded eviction, `unref()` for short-lived tests, factory selects in-memory vs Redis from env.
- **x402 relay** — alg-pinning to HS256 (algorithm-confusion CVE class), bounded redeemed-sig map with TTL, trust-proxy guidance comment naming the attack class.

## Quality score

Total off-chain TS LOC reviewed: ~12k (mcp-server ~3k, sdk ~1k, indexer ~1.4k, x402 ~400, sas-resolver ~1.5k, capability-validator ~600, plus tests). **Quality score: 6.5/10** — foundations are good, but findings #1, #2, #5, #6, #7, #8 collectively undermine the "production SDK + complete MCP" framing the docs use. Fixing all CRITICAL+HIGH items is ~1–2 engineer-days; the deeper architectural items (#1 deduplicating PDA truth, #2 finishing v2 migration) are weeks.
