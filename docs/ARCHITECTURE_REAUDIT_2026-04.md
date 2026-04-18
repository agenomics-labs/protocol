# Architecture Re-Audit — April 2026 (Post-PR-#12)

**Audit date:** 2026-04-18
**Scope:** Fresh pass over the current codebase after PRs #9 (MCP surfaces),
#10 (defense-in-depth), #11 (architectural drift), #12 (ops/observability)
landed. Baseline: `docs/ARCHITECTURE_DEEP_CRITIQUE.md` (2026-04-17).
**Methodology:** three parallel Explore agents (on-chain programs,
off-chain services, cross-cutting & CI) + manual spot-check of cited
code. Every finding was verified to be distinct from a closed item in the
prior critique.

---

## Executive summary

The four remediation PRs closed every previously-tracked Critical/High
finding. Spot-reads of the cited code confirm C1–C5, Findings #8/#9/#19/
#20, H4/H8/H9/H10, and M4/M5 are genuinely fixed, tagged in-source with
their finding IDs. No regression of a closed critique item was observed.

Re-audit surfaced **19 new/missed findings** that the prior critique did
not cover. None are Critical. The risk profile has shifted from
**on-chain correctness** (the focus of the prior critique) to
**supply-chain / CI hygiene** and **off-chain service hardening**:

- **3 High** — all in off-chain service or CI posture (rate-limit
  spoofing, indexer memory leak, missing integration/IDL/secret-scan CI
  gates).
- **12 Medium** — split across governance-parameter overflow, decoder
  fragility, dependency skew, ADR numbering, and CI gaps.
- **4 Low** — ergonomic gaps (typing, SIGTERM, ESLint, pinned Node
  version).

The on-chain programs themselves are in good shape: only one medium
finding (integer overflow on a governance-controlled timeout) was
identified across all three programs.

---

## Severity matrix

| ID              | Sev    | Location                                                       | Impact                                                  |
|-----------------|--------|----------------------------------------------------------------|---------------------------------------------------------|
| S-offchain-01   | High   | `src/x402-relay/index.ts` (rate limiter)                       | Rate limiter bypass via `X-Forwarded-For` spoofing      |
| S-offchain-02   | High   | `src/x402-relay/index.ts` (`rateLimitMap`)                     | Unbounded memory growth; indefinite retention of IPs    |
| S-xcut-03       | High   | `.github/workflows/ci.yml`                                     | IDL regressions not caught; discriminator drift can ship|
| S-xcut-04       | High   | `.github/workflows/ci.yml`                                     | Handler/program drift only caught post-merge            |
| S-xcut-05       | High   | `.github/workflows/ci.yml`                                     | No secret-scan gate; keys can leak via tests/comments   |
| S-onchain-01    | Medium | `programs/settlement/src/instructions/dispute.rs:152`          | Overflow in `disputed_at + dispute_timeout_seconds`     |
| S-offchain-03   | Medium | `src/x402-relay/index.ts` (JWT verify)                         | No algorithm pinning; `alg: none`/HS/RS confusion risk  |
| S-offchain-04   | Medium | `src/indexer/index.ts` (backfill+live race)                    | AgentDeregistered during backfill re-inserts zombie row |
| S-offchain-05   | Medium | `src/indexer/index.ts` (`AgentStatusUpdated` decoder)          | Positional enum decode drifts with Rust reorder         |
| S-xcut-01       | Medium | `docs/adr/` (missing ADR-045)                                  | Historical record gap; reviewer discipline degraded     |
| S-xcut-02       | Medium | `mcp-server/package.json` (`@solana/web3.js ^1.87`)            | Version skew vs indexer/relay (`^1.95`)                 |
| S-xcut-06       | Medium | `.github/workflows/ci.yml` (floating action versions)          | Supply-chain: tagged action push compromises CI         |
| S-xcut-07       | Medium | `.github/workflows/ci.yml` (no `.so` artifact upload)          | Reproducibility: no bytecode provenance for audit       |
| S-xcut-08       | Medium | `.github/workflows/ci.yml` (clippy/audit advisory)             | Known-CVE crates can land; warnings accumulate          |
| S-xcut-09       | Medium | `.github/` (no `dependabot.yml`/`renovate.json`)               | Dependency drift; security patches surface late         |
| S-offchain-06   | Low    | `mcp-server/src/formatters.ts` (`any` payloads)                | Refactor risk; shape drift not caught by tsc            |
| S-offchain-07   | Low    | `src/indexer/index.ts` (no SIGTERM handler)                    | K8s rollouts lose in-flight events on TERM              |
| S-xcut-10       | Low    | `mcp-server/` (no ESLint)                                      | Style/correctness gaps not caught                       |
| S-xcut-11       | Low    | `.github/workflows/ci.yml` (`node-version: "20"`)              | Reproducibility: floating Node minor version            |

---

## Strategic critique

### 1. Off-chain perimeter is now the weakest link

The on-chain programs are tight — the dispute resolution, escrow, and
registry surfaces have been through C1–C5 and hold up to a fresh read.
The perimeter that has **not** received the same scrutiny is the
off-chain services, specifically `x402-relay`.

**S-offchain-01 (High)** — `src/x402-relay/index.ts` mounts
`express-rate-limit` but never sets `app.set('trust proxy', ...)`. When
deployed behind any L7 proxy (Cloudflare, ALB, fly.io edge), `req.ip`
resolves to the proxy's IP, so **every request shares the same rate
bucket and the limiter is effectively disabled**. An attacker can also
spoof `X-Forwarded-For` when no proxy is configured, shifting their
own requests into arbitrary IP buckets. This defeats the DOS mitigation
added in #16.

**S-offchain-02 (High)** — the relay maintains its replay-prune state
(`rateLimitMap`) without a TTL or size cap. In steady-state traffic, the
map grows unbounded. A hostile scanner rotating source IPs can push the
relay to OOM in hours.

**S-offchain-03 (Medium)** — `jwt.verify(token, secret)` is called
without the `algorithms` option. This is the classic
[algorithm-confusion / alg:none CVE pattern](https://cwe.mitre.org/data/definitions/347.html).
The remediation is a one-line change: `{ algorithms: ["HS256"] }`.

These three are tractable (under a day of work) and collectively
represent the protocol's largest current production-risk surface.

### 2. CI is still courtesy, not a gate

The prior critique flagged M6 ("CI is a courtesy check") but the
remediation in PR #12 added per-service `tsc` checks and advisory
clippy/cargo-audit — it did not close the structural gaps. Five new
high/medium CI findings surfaced:

- **S-xcut-03 (High)** — no `anchor build` job. `cargo check` does not
  exercise Anchor IDL codegen. H1 from the prior critique (fabricated
  discriminators in the indexer) was an IDL-drift failure that a
  mandatory `anchor build` + committed-IDL diff would have prevented.
- **S-xcut-04 (High)** — no integration-test job. The mcp-server has a
  test suite at `mcp-server/test/mcp-handlers.test.ts` but CI never
  invokes it. Handler/program shape drift (the H5/H6/H7 class of bugs)
  can only be caught by a `solana-test-validator` run, which doesn't
  exist in CI.
- **S-xcut-05 (High)** — no secret scan (`trufflehog`/`gitleaks`). The
  protocol's on-chain authorities are high-value; a private key leaked
  through a test fixture or debug log would have meaningful blast radius.
- **S-xcut-08 (Medium)** — clippy and cargo-audit remain
  `continue-on-error: true`. A crate with a published CVE can land in
  main undetected.
- **S-xcut-06 (Medium)** — actions pinned to `@v4` tags rather than SHAs.
  For a protocol that mints on-chain authorities, tag-mutation is a real
  supply-chain risk.

### 3. Governance parameters need bounded inputs

**S-onchain-01 (Medium)** — ADR-053 made `dispute_timeout_seconds` a
governance-owned `u64` on `ProtocolConfig`. `update_protocol_config`
enforces `> 0` but no upper bound. At
`programs/settlement/src/instructions/dispute.rs:152`, the check
`now >= disputed_at + ctx.accounts.protocol_config.dispute_timeout_seconds`
uses native `+`, not `checked_add`. A pathological timeout value
(≥ `i64::MAX - disputed_at`) would panic and brick `resolve_dispute_timeout`
for every escrow simultaneously. This is an authority-abuse trap that
closure on #19 did not cover. Fix is either an upper bound in
`update_protocol_config` (e.g., ≤ 365 days) or a `checked_add` at the
call site.

### 4. Indexer has a quiet class of decoder/race bugs

The PR #12 rewrite added cursors, backfill, and finalized commitment,
but two sub-surface issues remain:

- **S-offchain-04 (Medium)** — the event processing path has no ordering
  guarantee between the live websocket stream and the backfill worker
  on restart. If a backfill run observes an old `AgentRegistered` event
  *after* the live stream has already observed `AgentDeregistered`, the
  agent row is resurrected. There is no tombstone to prevent this.
- **S-offchain-05 (Medium)** — the `AgentStatusUpdated` decoder
  interprets the enum as a positional `u8`. A reorder of the Rust enum
  variants (easy to do in any future PR) silently misinterprets status
  values downstream without a test failure. The decoder should switch
  to a name→value table derived from the IDL.

### 5. Repository governance drift

- **S-xcut-01 (Medium)** — `docs/adr/` skips ADR-045. There is no
  retraction note or redirect. Not a functional bug, but it degrades
  the audit trail that CLAUDE.md + the ADR discipline are meant to
  provide.
- **S-xcut-02 (Medium)** — mcp-server pins
  `@solana/web3.js@^1.87.0` while every other service is at `^1.95.0`.
  This is silent: each service's `package.json` passes tsc in isolation,
  but at the `Connection` API boundary the type surface has drifted
  between these minor versions.
- **S-xcut-09 (Medium)** — no `dependabot.yml` or `renovate.json`.
  Security patches to transitive npm/Cargo dependencies only surface
  when someone looks.

---

## Remediation roadmap

### P0 — must land before next mainnet deploy

1. **S-offchain-01 / -02 / -03** — x402-relay hardening: trust-proxy
   config, `rateLimitMap` TTL/size cap, JWT algorithm pinning. One PR.
2. **S-xcut-05** — add `trufflehog` secret-scan gate to CI.

### P1 — next sprint

3. **S-xcut-03 / -04** — add `anchor build` job (fail on IDL diff) and
   an integration-test job against `solana-test-validator`.
4. **S-onchain-01** — add upper bound to `dispute_timeout_seconds` in
   `update_protocol_config` and switch arithmetic to `checked_add`.
5. **S-offchain-04 / -05** — add a tombstone table for deregistered
   agents so backfill cannot resurrect them; switch enum decoder to a
   name-based lookup.
6. **S-xcut-08** — flip clippy to `-D warnings` after the pre-existing
   warning cleanup (see #xcut-08 remediation note); flip cargo-audit to
   block `CVSS ≥ 7.0`.

### P2 — best-effort

7. **S-xcut-01** — document ADR-045 skip with a one-line note in
   ADR-046.
8. **S-xcut-02** — align `@solana/web3.js` across all services.
9. **S-xcut-06 / -07** — pin actions to SHAs; upload `target/deploy/*.so`
   as 90-day CI artifacts.
10. **S-xcut-09 / -10 / -11** — Dependabot, ESLint on mcp-server, pin
    Node minor version.
11. **S-offchain-06 / -07** — discriminated-union typing for handler
    payloads; SIGTERM handler for indexer graceful shutdown.

---

## Recommended next ADRs (suggested, not drafted)

- **ADR-054: Governance parameter bounds invariants** — standardize the
  upper/lower bound requirements for every numeric field on
  `ProtocolConfig`, with a checklist format other
  parameters (fees, deltas, caps) can follow. Closes S-onchain-01 and
  establishes the pattern for future governance surface.
- **ADR-055: CI quality gates (mandatory vs advisory policy)** — a
  single source of truth for which jobs block merge vs which are
  advisory, including anchor-build-with-IDL-diff and secret-scan as
  mandatory. Closes S-xcut-03, -04, -05, -08.
- **ADR-056: x402-relay operational hardening** — rate-limiter semantics
  under proxies, JWT verification policy, and memory-bounded state.
  Closes S-offchain-01, -02, -03.
- **ADR-057: Dependency pinning and upgrade policy** — npm version
  alignment across services, Cargo CVE threshold, Dependabot cadence,
  action-pinning rule. Closes S-xcut-02, -06, -09, -11.

---

## Verification notes (clean-bill items)

These were re-checked against the current source and remain closed:

- [x] **C1**: `expire_escrow` silence-=-acceptance (`programs/settlement/src/instructions/escrow.rs:368-397`)
- [x] **C2**: `approve_milestone` deadline check (`programs/settlement/src/instructions/escrow.rs:186`)
- [x] **C3**: self-resolver rejection in `create_escrow` (`programs/settlement/src/instructions/escrow.rs:39-45`)
- [x] **C4**: `unstake_reputation` uses `invoke_signed(system_program::transfer)` (`programs/agent-registry/src/lib.rs:213-224`)
- [x] **C5**: `clear_suspension` appeal path present (`programs/agent-registry/src/lib.rs:243-262`)
- [x] **Finding #8**: real rating propagated to `update_provider_reputation` (`programs/settlement/src/instructions/escrow.rs:252`)
- [x] **Finding #9**: `RegisterAgent.vault` has `seeds::program = AGENT_VAULT_PROGRAM_ID` (`programs/agent-registry/src/contexts.rs:29-34`)
- [x] **Finding #19**: governance-owned timeout + delta threaded through dispute paths (`programs/settlement/src/instructions/dispute.rs:119, 152, 193, 199-209`)
- [x] **Finding #20**: `is_resolver` slash gating preserved post has-one hoist (`programs/settlement/src/instructions/dispute.rs:41-44, 116`)
- [x] **H4/H8/H9/H10**: vault per-mint accounting, per-tx limit, rent-exempt, vault_address seed-bound — all confirmed in `programs/agent-vault/src/instructions.rs` and registry context
- [x] **M4/M5**: `has_one` coverage and `CreateEscrow` vault seed validation — confirmed in settlement contexts

All 52 ADRs are marked `Accepted`; no `Proposed`/`Draft` in the approval
queue. Program IDs in `declare_id!` match the TS constants in
`mcp-server/src/solana.ts`.
