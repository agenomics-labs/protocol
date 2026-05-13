# Solana v2 Migration Plan — 2026-05-04

**Date**: 2026-05-04  
**Status**: Phase A target #1 shipped 2026-05-04 (x402-relay); Phase A target #2 shipped 2026-05-13 (indexer); Phase A target #3 pending (sdk/client); Phases B–D planned  
**ADRs**: ADR-087 (dual-stack adapter pattern), ADR-012 (web3.js v2 migration commitment)  
**CVE ref**: GHSA-3gc7-fjrx-p6mg (bigint-buffer buffer overflow via `toBigIntLE()`)

---

## 1. Current state (verified 2026-05-04)

### 1.1 npm audit shape

```
13 vulnerabilities (9 moderate, 4 high)

High:
  bigint-buffer * — GHSA-3gc7-fjrx-p6mg
    via @solana/buffer-layout-utils → @solana/spl-token → (dev/test consumers)
    also via @sqds/multisig
  (+ 3 more high via @sqds/multisig → @metaplex-foundation/beet-solana)

Moderate:
  uuid <14.0.0 — GHSA-w5hq-g745-h8pq
    via jayson → @solana/web3.js (workspace-wide v1 dep)
    via rpc-websockets → @solana/web3.js
```

`npm ls bigint-buffer --all` path:
```
aep-anchor-workspace
└── @solana/spl-token@0.4.14
    └── @solana/buffer-layout-utils@0.2.0
        └── bigint-buffer@1.1.5
```

The `bigint-buffer` CVE enters solely through `@solana/spl-token`. The `uuid` moderate
CVE enters via `@solana/web3.js`'s transitive `jayson`/`rpc-websockets` deps.

### 1.2 @coral-xyz/anchor npm state (Phase B blocker)

npm latest: **0.32.1** (verified 2026-05-04). `anchor-lang@1.0.1` is cargo-only;
the npm-side has NOT shipped a v2-internal client. Phase B (mcp-server v1 handler
migration: registry, reputation, settlement, formatters) remains blocked on this.

### 1.3 Web3.js v1 surface (production runtime)

| Package | v1 imports | v2 (@solana/kit) imports | Notes |
|---------|-----------|--------------------------|-------|
| `mcp-server` | `solana.ts`, `handlers/` (4 remaining v1 handlers), some tests | `solana-v2.ts`, `handlers-v2/vault.ts`, `pipeline/` | ADR-087 dual-stack; vault_transfer already on v2 send path |
| `src/indexer` | `index.ts`, `decoder.test.ts`, `heartbeat.test.ts` | none | Phase A target #2 |
| `sdk/client` | `index.ts`, `registry.ts`, `settlement.ts`, `vault.ts`, tests | none | Phase A target #3 |
| `src/x402-relay` | ~~`index.ts`~~ | `index.ts` **(migrated in this PR)** | Phase A target #1 — **DONE** |
| `packages/sas-resolver` | none | `types.ts` (type import only) | Already on v2 |
| `examples/` | `register-agent.ts` | none | dev-surface only; no spl-token |

### 1.4 @solana/spl-token dev-surface files (Phase C scope)

13 files remain on `@solana/spl-token` (down from the 12 originally briefed once
`mcp-server/src/solana.ts`'s comment-only reference is discounted):

**tests/** (3): `tests/agent-vault.ts`, `tests/cpi-failures.test.ts`, `tests/settlement.ts`  
**scripts/** (5): `scripts/demo-e2e.ts`, `scripts/flow-runner.ts`, `scripts/stress-contention.ts`, `scripts/stress-inproc.ts`, `scripts/stress-soak.ts`  
**load/** (4): `load/lib/agent-factory.ts`, `load/lib/agent-pool.ts`, `load/scenarios/full-lifecycle.ts`, `load/scenarios/settlement-only.ts`  
**mcp-server/test/** (1): `mcp-server/test/mcp-handlers.test.ts`

Phase C migrates these to `@solana-program/token` (where the call site is already
on the v2 stack) or raw SPL constant inlining (matching ADR-050's precedent for
mcp-server production code). Multi-day effort; not in this PR.

---

## 2. Phase sequencing

### Phase A — Production runtime RPC migration (unblocked)

Migrate `@solana/web3.js` out of each production runtime package. No Anchor JS
dependency in any of the three targets (x402-relay, indexer, sdk/client), so
these are clean cutovers independent of the Phase B Anchor blocker.

**Target #1 — `src/x402-relay/` (this PR)**  
Rationale: smallest v1 surface (2 usages: `Connection` + `LAMPORTS_PER_SOL`), no
Anchor at all, densest test coverage after cycle-3 hardening (ADR-126/AUD-209/
AUD-208/OFF-211/OFF-216 — 62 tests). Lowest-risk first PR validates the
migration tooling.

**Target #2 — `src/indexer/` — SHIPPED 2026-05-13**  
Surface: `Connection` (WebSocket subscribe pattern for program-account
subscriptions), `PublicKey` (PDA derivation, account key comparisons). The indexer
used the v1 `connection.onLogs` subscription API, which mapped to `@solana/kit`'s
`createSolanaRpcSubscriptions` + `logsNotifications`. Larger surface than x402-relay
but self-contained; no external consumers of its internal types.

Shipped shape: `Connection` split into `createSolanaRpc` (HTTP) and
`createSolanaRpcSubscriptions(resolveWsUrl())` (WS). `onLogs(programId, cb, commitment)`
returning `subId` replaced by `rpcSubs.logsNotifications({mentions:[addr]},{commitment}).subscribe({abortSignal})`
returning an `AsyncIterable`, consumed by a detached async IIFE with an inner
try/catch error boundary. Each program has its own `AbortController` stored
in a `Map<label, AbortController>`; AUD-204's release-before-resubscribe is
preserved by aborting the prior controller before awaiting the new subscribe.
`BorshReader.pubkey()` uses a cached `getAddressDecoder()` matching
`mcp-server/src/solana-v2.ts`. Heartbeat polls `rpc.getSlot({commitment:"confirmed"}).send()`;
bigint→Number coerced at SQLite boundary. Test fixtures swap `Keypair.generate()`
for `crypto.randomBytes(32)` + `getAddressDecoder().decode()`. 125/125 tests pass.

**Target #3 — `sdk/client/` (subsequent PR)**  
Surface: `PublicKey` (PDA derivation, address validation), `Connection` for any
RPC reads. SDK/client is published externally (`@agenomics/client` per
`build(npm)` commit), so its API contract needs a semver-minor bump alongside the
migration to expose `Address` (string) rather than `PublicKey` (class) in the
exported types. Requires a deprecation shim or a deliberate API break.

### Phase B — mcp-server v1 handler migration (blocked)

4 remaining v1 handlers: `handlers/registry.ts`, `handlers/reputation.ts`
(implied), `handlers/settlement.ts`, `handlers/formatters.ts`. These require
`@coral-xyz/anchor` for CPI instruction building. Blocked on npm Anchor shipping
a v2-internal client (no ETA; npm latest 0.32.1 as of 2026-05-04). ADR-087
dual-stack pattern holds until this unblocks.

### Phase C — Dev/test/script surface (multi-day, post-Phase-A)

Migrate the 13 `@solana/spl-token` consumers listed in §1.4. Two strategies:

- **`@solana-program/token`**: use where the call site is already in a v2 context
  (i.e., after the Phase A migration of the surrounding package).
- **Inline constants**: for scripts/tests that only import token account addresses
  and ATA derivation (matching ADR-050's precedent for mcp-server production code).

### Phase D — Remove `@solana/spl-token` workspace root dep

`npm ls @solana/spl-token` shows empty → remove `"@solana/spl-token"` from root
`package.json`. Closes GHSA-3gc7-fjrx-p6mg definitively. Gated on Phase C
completing all 13 consumer migrations.

---

## 3. Phase A target #1 — `src/x402-relay/` implementation

### 3.1 Import rewrite

| v1 (`@solana/web3.js`) | v2 (`@solana/kit`) |
|---|---|
| `import { Connection, LAMPORTS_PER_SOL }` | `import { createSolanaRpc, type Signature }` |
| `new Connection(rpcUrl, commitment)` | `createSolanaRpc(rpcUrl)` (commitment is per-call in v2) |
| `connection.getTransaction(sig, opts)` | `rpc.getTransaction(sig as Signature, { ...opts, encoding: "json" }).send()` |
| `tx.transaction.message.getAccountKeys().staticAccountKeys` | `tx.transaction.message.accountKeys` (`readonly Address[]`) |
| `key.toBase58()` | `key` (Address is already a string-branded type) |
| `tx.meta?.preBalances[i] \|\| 0` | `tx.meta?.preBalances[i] ?? 0n` (Lamports = bigint) |
| `transferredLamports / LAMPORTS_PER_SOL` | `Number(transferredLamports) / 1_000_000_000` |
| `tx.slot` (number) | `Number(tx.slot)` (Slot = bigint in v2) |

### 3.2 Key semantics preserved

- **Finding #16 / "finalized" commitment**: preserved as `commitment: "finalized"`
  on the per-call `getTransaction` config (v2 moves commitment to per-call rather
  than connection-time).
- **AUD-208 in-flight-verify cache**: unchanged — `processPaymentRequest` and
  `inFlightVerify` are unmodified; only the verifier's internal RPC call changes.
- **AUD-209 saturation guard**: unchanged — `redeemedSignatures.size >=
  MAX_REDEEMED_SIGNATURES` path is in `processPaymentRequest`, not in the verifier.
- **ADR-126 Redis dedup**: unchanged — `redisDedup.tryRedeem` / `releaseRedeemed`
  are in `processPaymentRequest`, not in the verifier.
- **B11 admin drain gate**: unchanged — `draining` check is in the route handler.
- **All test hooks** (`__resetRedemptionStateForTests`, etc.): unchanged.

### 3.3 package.json delta

```diff
 "dependencies": {
-  "@solana/web3.js": "^1.95.0",
+  "@solana/kit": "6.8.0",
```

Pin matches mcp-server's exact `"6.8.0"` pin for workspace consistency.

### 3.4 Test result

Pre-migration baseline: **62 tests / 0 failures** (`tsx --test test/*.test.ts`).  
Post-migration: **62 tests / 0 failures** (confirmed — tests inject mock verifiers,
never call the live RPC, so the rewrite is transparent to the test suite).

### 3.5 Build result

`tsc` from `src/x402-relay/` exits 0. `@solana/kit` ships a CJS dist
(`index.node.cjs`) compatible with `"module": "commonjs"` tsconfig.

### 3.6 CVE scope for this PR

`npm ls @solana/web3.js` from `src/x402-relay/`: package no longer appears.
`bigint-buffer` is NOT in x402-relay's subtree post-migration (it entered only
via `@solana/spl-token`, which x402-relay never imported).

Note: `bigint-buffer` still appears at workspace root (via `@solana/spl-token`
hoisted from dev-surface consumers). Full CVE elimination requires Phase C + D.
This PR eliminates the CVE from x402-relay's production subtree specifically.

---

## 4. Known issues / follow-up

None surfaced during Phase A target #1. The `verifyPaymentOnChain` v1→v2 rewrite
has one behavioral note: with `encoding: "json"` and `maxSupportedTransactionVersion: 0`,
`transaction.message.accountKeys` contains ONLY static account keys (not accounts
resolved from address lookup tables). For the x402-relay's SOL-transfer verification
use case, all payment participants (sender, recipient, system program) are static
accounts — no lookup-table resolution is needed or expected.

---

## 5. References

- `docs/adr/ADR-087-solana-kit-dual-stack-adapter.md` — canonical migration ADR
- `docs/adr/ADR-012-web3js-v2-migration.md` — original v1→v2 commitment
- `docs/adr/ADR-050-final-audit-polish.md` — spl-token inline-constants precedent
- `docs/adr/ADR-126-redis-backed-dedup.md` — x402-relay Redis dedup (Phase 2 future work)
- `src/x402-relay/index.ts` — migrated source
- `src/x402-relay/package.json` — updated deps
- GHSA-3gc7-fjrx-p6mg — bigint-buffer CVE advisory
