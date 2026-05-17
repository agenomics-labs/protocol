# Cycle-4 Security Audit — WEB + SUPPLY-CHAIN

- **Scope**: `dashboard/`, `packages/*`, repo-wide dependency/supply-chain
- **Baseline**: branch `audit-baseline`, origin/main `b8fe80b`
- **Mode**: READ-ONLY (no code edits, no commits)
- **Auditor pass**: web boundary + supply-chain + secret-scanning gaps

Severity legend: CRITICAL / HIGH / MEDIUM / LOW / INFO.

---

## Severity Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 2 |
| MEDIUM   | 4 |
| LOW      | 3 |
| INFO     | 2 |

---

## Findings

### W-01 (HIGH) — Dashboard ships with zero security headers (no CSP/HSTS/XFO)

- **Where**: `dashboard/` — no `dashboard/vercel.json` exists. Deployed to
  production `app.agenomics.xyz` via `.github/workflows/vercel-deploy-dashboard.yml`
  (`vercel build --prod`, lines 55–60).
- **Evidence**: `site/vercel.json:4-25` ships a full header set
  (`Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options`, COOP/CORP). `mcp-server/vercel.json:15-24` ships HSTS +
  nosniff. The dashboard — a wallet-adjacent SPA that reads on-chain program
  accounts and renders indexer JSON — has **no equivalent**. `dashboard/.gitignore`
  only ignores `.vercel`; there is no headers config at all.
- **Scenario**: With no CSP, any reflected/stored XSS (see W-02) or a compromised
  npm build dep executes with full origin privileges. No `frame-ancestors`/XFO
  means the dashboard is clickjackable (overlay a fake "connect wallet"). No HSTS
  means a first-visit SSL-strip MITM can pin victims to plaintext and rewrite
  `RPC_URL`/`INDEXER_URL` responses.
- **Fix**: Add `dashboard/vercel.json` mirroring `site/vercel.json`'s header block.
  CSP `connect-src` must additionally allow the configured RPC/indexer/metrics
  origins (devnet Solana RPC, indexer API, metrics-server) — `'self'` alone will
  break the app, so this is a copy-and-widen, not a verbatim copy.
- **ADR-needed?**: No — operational config gap; cite ADR-115 (CI security gates)
  as the home for a "deployed-surface header parity" check so this cannot regress
  silently across the three+ Vercel projects.

### W-02 (MEDIUM) — Unvalidated indexer/metrics JSON rendered without schema check

- **Where**: `dashboard/src/hooks/useProtocolData.js:34-42`
  (`agentsJson.agents`, `eventsJson.events`, `statsJson` passed straight to React
  state); `dashboard/src/hooks/useTriggerMetrics.js:43-51`
  (`sybil`, `escrow` JSON spread into state with no shape validation).
- **Scenario**: The indexer/metrics-server are separately-deployed services
  reachable over a `VITE_*` URL (W-04). A compromised or spoofed indexer (or a
  MITM enabled by the missing HSTS in W-01) returns attacker-shaped JSON; it is
  trusted verbatim and rendered. Combined with the absent CSP (W-01), a
  string-typed field rendered into the DOM via a component is an XSS sink with no
  containment. There is no `try/catch`-wrapped `.json()`, no Zod/shape guard, and
  no allowlist of expected fields — contrast `packages/sas-resolver` which Zod-
  validates every boundary (`resolver.ts:128-136,400-405`).
- **Fix**: Validate every fetched payload with a minimal schema (the repo already
  depends on `zod` in `packages/*`) before it reaches React state; reject/`absent`
  on mismatch the way the resolver does. Escape/whitelist any rendered string.
- **ADR-needed?**: No — apply the existing "input validation at system boundaries"
  project rule to the web tier.

### W-03 (MEDIUM) — `fetch()` calls have no timeout / abort

- **Where**: `dashboard/src/hooks/useProtocolData.js:26-30,102`
  (3× `fetch` + `connection.getProgramAccounts` in `Promise.all`, no
  `AbortController`); `dashboard/src/hooks/useTriggerMetrics.js:29-32`
  (2× `fetch`, no signal).
- **Scenario**: A slow/hung indexer or RPC endpoint (or a MITM that holds the
  socket open) stalls the 30 s poll loop indefinitely; `setInterval` then stacks
  overlapping in-flight requests, degrading the tab and masking the
  "Backend offline" state the UI is designed to surface.
- **Fix**: Wrap each `fetch` with an `AbortController` + `setTimeout` (e.g. 8 s);
  abort on unmount. `@solana/web3.js` `Connection` accepts a
  `confirmTransactionInitialTimeout`/`fetch` override for the RPC leg.
- **ADR-needed?**: No.

### W-04 (MEDIUM) — `VITE_RPC_URL` / `VITE_INDEXER_URL` / `VITE_METRICS_API_URL` consumed with no scheme/host validation

- **Where**: `dashboard/src/config.js:3,4,9,12`. Env values flow directly into
  `fetch()` (W-02 hooks) and `new Connection(RPC_URL, ...)`. No `new URL()`
  parse, no `https:` enforcement, no host allowlist (`grep` for URL validation
  across `dashboard/src` returns only the raw assignments).
- **Scenario**: This is a build-time SSRF-adjacent / config-integrity gap. A
  misconfigured or attacker-influenced deploy env (or a Vercel preview with a
  poisoned env var) silently points the production dashboard at an arbitrary
  origin — including `http://` (downgrade) or an exfiltration host that now
  receives every viewer's traffic and can feed W-02. The default for
  `INDEXER_URL`/`METRICS_API_URL` is hardcoded `http://localhost:...`, so a
  missing env var ships a plaintext-scheme string into production fetches.
- **Fix**: Validate at module load: `new URL()` parse, require `https:` for any
  non-localhost host, optionally pin to an allowlist of known origins; fail
  loud (throw at boot) rather than silently fetching. Pair with W-01's CSP
  `connect-src` so the browser also enforces the allowlist.
- **ADR-needed?**: Yes — a short ADR on "dashboard runtime-config trust boundary"
  (which env vars are trusted, scheme/host policy, fail-closed behavior); this is
  the symmetric web analogue of the ADR-076 resolver-init trust boundary.

### S-01 (HIGH) — `bigint-buffer` buffer-overflow chain remains unpatched (no upstream fix)

- **Where**: `package-lock.json:11232-11234` (`bigint-buffer@1.1.5`).
  Chain (verified via `npm ls bigint-buffer`):
  `@solana/spl-token@0.4.14 → @solana/buffer-layout-utils@0.2.0 →
  bigint-buffer@1.1.5`. Also under `@sqds/multisig` per Dependabot.
- **Advisory**: GHSA-3gc7-fjrx-p6mg — buffer overflow via `toBigIntLE()`.
  Dependabot alert **#1**, severity **high**, **dismissed `tolerable_risk`**,
  `first_patched_version: none`. `npm audit` confirms 4 high-severity findings,
  all rooting to this single transitive `bigint-buffer`.
- **Scenario**: `toBigIntLE()` on attacker-controlled byte lengths can over-read.
  Blast radius is bounded because `@solana/spl-token` is a workspace-root **dev**
  dependency (not shipped to the dashboard bundle — dashboard depends on
  `@solana/web3.js` only, `dashboard/package.json:13`). Risk is to local dev /
  CI tooling that decodes untrusted SPL account data, not production users.
- **Fix / status**: No upstream patch exists. Per ADR-115 §Stage 3b
  (`docs/adr/ADR-115-ci-blocking-security-gates.md:71-74,116-118`), the accepted
  remediation is to **remove the workspace-root `@solana/spl-token` dev dep**
  (gated on ADR-087 Phase D), which eliminates the chain entirely and unblocks
  making `npm audit` a blocking CI gate. Until then the `tolerable_risk`
  dismissal is justified *only* by the dev-only scope — re-verify that scope on
  every `@sqds/multisig`/`spl-token` bump.
- **ADR-needed?**: No — already governed by ADR-115 Stage 3b + ADR-087 Phase D.
  Recommend the cycle-4 punchlist track Stage 3b explicitly so it does not drift.

### S-02 (LOW) — `rand` crate unsoundness, two Cargo lockfiles, unpatched

- **Where**: Dependabot alert **#6** (`Cargo.lock`) and **#7**
  (`fuzz/Cargo.lock`), pkg `rand`, GHSA-cq8v-f236-94qc, severity **low**, state
  **open**. Vulnerable range `>=0.7.0,<0.8.6`; first patched `0.8.6`.
- **Scenario**: "Rand is unsound with a custom logger using `rand::rng()`" —
  a soundness (UB) issue, not a direct exploit primitive. The protocol does not
  appear to install a custom global logger that would trigger the unsound path;
  exposure is theoretical. `fuzz/` is test-only.
- **Fix**: Bump `rand` to `>=0.8.6` in both lockfiles (`cargo update -p rand`).
  Low urgency; batch with the next Rust dependency hygiene pass.
- **ADR-needed?**: No.

### S-03 (LOW) — Dashboard build deps span a wide major-version float

- **Where**: `dashboard/package.json:13-24` — all deps use caret ranges:
  `vite@^8.0.10`, `@vitejs/plugin-react@^6.0.1`, `@solana/web3.js@^1.98.4`,
  `react@^18.3.1`, `tailwindcss@^3.4.19`. There is **no `dashboard/package-lock.json`**
  committed (only the workspace-root lock); the Vercel build runs
  `vercel build` which resolves caret ranges fresh at deploy time.
- **Scenario**: A compromised patch/minor release of any build-time dep
  (`vite`, `@vitejs/plugin-react`, `tailwindcss`, `postcss`, `autoprefixer`)
  executes in the production build and can inject into the shipped bundle —
  classic build-tool supply-chain vector, amplified by the absent CSP (W-01)
  which provides zero runtime containment.
- **Fix**: Commit a `dashboard/package-lock.json` (or confirm the workspace-root
  lock fully pins the dashboard subtree) and have the deploy workflow use
  `npm ci` against it before `vercel build`. Verify lockfile integrity hashes.
- **ADR-needed?**: No — dependency-pinning hygiene; reference ADR-089
  (unified lockfile) for consistency.

### S-04 (INFO) — Dependabot alert inventory (full enumeration)

Total alerts: 31. **Currently unresolved/deferred: 3** (not 5 — the memory note
of "5 deferred" is stale; the axios/hono/fast-uri/uuid/ip-address/serialize-
javascript/diff clusters, alerts #2–#5 and #8–#31, are all state `fixed`):

| # | Pkg | Severity | State | GHSA | Manifest | Patched |
|---|-----|----------|-------|------|----------|---------|
| 1 | bigint-buffer | high | dismissed (tolerable_risk) | GHSA-3gc7-fjrx-p6mg | package-lock.json | none |
| 6 | rand | low | open | GHSA-cq8v-f236-94qc | Cargo.lock | 0.8.6 |
| 7 | rand | low | open | GHSA-cq8v-f236-94qc | fuzz/Cargo.lock | 0.8.6 |

All other 28 alerts (axios ×17, hono ×5, fast-uri ×2, serialize-javascript ×2,
uuid, ip-address, diff) are state `fixed`. **No deferred MEDIUM/HIGH npm alerts
remain beyond #1.** Recommend updating the audit-corpus memory note to reflect
3, not 5.

### P-01 (INFO) — `capability-manifest-validator` soundness review: PASS (one DoS note)

- **Where**: `packages/capability-manifest-validator/src/validate.ts`,
  `schema.ts`, `canonical.ts`.
- **Assessment**: The validator is cryptographically sound. Stage ordering is
  correct (input-shape → Zod schema → hash → Ed25519 over the **tagged** hash,
  `validate.ts:92-161`). It hashes the **original** untrusted bytes (not the
  Zod-stripped output) so forward-compat fields cannot be used to forge a
  hash-match (`validate.ts:120-124`). Byte comparison is constant-time
  (`bytesEqual`, `validate.ts:171-176`). Domain separation is applied per
  ADR-092 (`canonical.ts:56-64,94-103`). Ed25519 exceptions are caught and
  mapped to `SIGNATURE_MISMATCH` rather than throwing. **No soundness defect
  found** — capability gating in mcp-server is not undermined by this validator.
- **Minor note (LOW, not separately numbered)**: `manifestHash(manifest)` runs
  `canonicalize()` (RFC-8785) on attacker-controlled JSON **before** any
  size/depth bound. A pathologically large or deeply-nested manifest body could
  cause CPU/stack DoS in the indexer/mcp-server that calls this. Schema
  validation (`safeParse`) runs *first* (`validate.ts:113`) and rejects most
  garbage, but the hash on line 124 re-processes the original `manifest` object,
  not `parsed.data`. Recommend the caller (indexer fetch layer) enforce a byte-
  size cap on the fetched manifest body before invoking `validateManifest`.
- **ADR-needed?**: No — caller-side input-size cap, document in the indexer
  fetch-layer ADR if one exists.

### P-02 (INFO) — `sas-resolver` trust-boundary review: PASS

- **Where**: `packages/sas-resolver/src/resolver.ts`, `allowlist.ts`.
- **Assessment**: Strong. Strict-init schema-PDA owner check defaults ON
  (`resolver.ts:241,327-369`); definitive owner-mismatch latches and is not
  re-queried (anti-flip-back). Per-credential signer scoping hard-fails on a
  missing signer list (`SignerHistoryMissingError`, `resolver.ts:111-119,484-486`,
  ADR-101). Per-credential schema binding enforced (`resolver.ts:501-511`).
  Subject-mismatch is a HARD error checked before expiry (`resolver.ts:516-526`).
  Allowlist builder validates every base58 pubkey synchronously and rejects
  duplicate authorities (`allowlist.ts:59-73,201-207`). No SSRF in the resolver
  (it takes an injected `ResolverRpc`, does not fetch arbitrary URLs). No defect
  found.

---

## Recommendations (priority order)

1. **W-01** — add `dashboard/vercel.json` with CSP + HSTS + XFO mirroring
   `site/vercel.json` (HIGH; smallest fix, largest blast-radius reduction).
2. **S-01 / ADR-115 Stage 3b** — track removal of workspace-root
   `@solana/spl-token` dev dep on the cycle-4 punchlist; it is the only
   deferred HIGH and gates a blocking `npm audit` CI gate.
3. **W-04 + W-02 + W-03** — harden the dashboard data tier: validate env URLs
   (fail-closed, https-only), schema-validate fetched JSON, add fetch timeouts.
   These compound: W-04 enables the MITM that W-02 then trusts, with W-01
   removing all containment.
4. **S-04** — correct the audit-corpus memory note ("5 deferred" → 3).
5. **S-02 / S-03** — low-priority dependency hygiene (`rand` bump, dashboard
   lockfile pinning).
