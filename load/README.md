# AEP load harness — Phase 1

Devnet (and localnet) load-test harness for the Agent Economy Protocol.
Maps to **B9** of `docs/PRE_MAINNET_ROADMAP.md` §3 (MAINNET_CHECKLIST.md
ADR-022 row).

This directory ships the **Phase 1** scaffold: framework choice,
directory layout, one validated end-to-end scenario, and the metrics
schema operators consume. Phase 2 adds more scenarios; Phase 3 wires
CI for operator-triggered (not per-PR) campaigns.

The harness mirrors the structure of `fuzz/` (B8 Phase 1, commit
`e084713`): standalone subtree at the repo root, lightweight
dependencies, smoke-validated locally, with multi-hour campaigns
explicitly framed as operator-driven events rather than CI gates.

---

## Phase 1 scope (this PR)

- **Framework**: TypeScript, executed via `tsx`. No new heavy
  dependencies — the harness reuses the root workspace's
  `@coral-xyz/anchor`, `@solana/web3.js`, `@solana/spl-token`,
  `@noble/curves` (transitive), and `better-sqlite3` (transitive
  via the indexer workspace). External load tools (k6, artillery,
  autocannon) were considered and rejected: they are HTTP-shaped,
  bring their own DSLs and runtime, and would require a thin shim
  to drive Anchor ix calls — net negative versus a few hundred
  lines of plain TS that talks to web3.js directly. See
  `docs/SUMMARY.md` (or future ADR) for the framework-choice
  rationale if it grows controversial.
- **Layout**: standalone subtree at `load/` with a `package.json`
  carrying NO `dependencies` block — it piggybacks on the root
  workspace's `node_modules` via Node's normal resolution walk.
  Mirrors the `fuzz/Cargo.toml` empty-`[workspace]` pattern: visible
  at the repo root, but does NOT participate in `npm test`,
  `anchor test`, or any per-PR CI gate.
- **One scenario shipped**: `full-lifecycle` — the end-to-end happy
  path through the protocol's primary economic flow. See "Scenario:
  full-lifecycle" below for the exact ix sequence.
- **Metrics captured per run**:
  - Per-ix wall-clock latency: p50 / p95 / p99 / min / max / mean
  - Per-ix compute units (CU): p50 / p95 / p99 / mean (parsed from
    tx-log `meta.computeUnitsConsumed`)
  - RPC error counts, classified into 7 buckets
    (timeout / blockhash_not_found / rate_limited / node_unhealthy
    / slot_skipped / transaction_failed / other)
  - Indexer event-ingest lag at run end (chain head − cursor's
    `last_processed_slot`, per program label)
  - Flow success/failure tally + slot range covered
  - Output: a single JSON file under `load/results/` per run
- **Validation**: smoke-run completes against a local
  `solana-test-validator` with `--concurrency=2 --duration=30s`.
  See the "Smoke validation result" section at the bottom of this
  README for the actual numbers from the Phase 1 implementation
  run.

### Why TypeScript and not Rust?

`stress-inproc.ts`, `stress-soak.ts`, `stress-contention.ts`,
`flow-runner.ts`, and `smoke-test-devnet.ts` are all already TS
under `scripts/`. The protocol's existing operator-facing tooling
is TS-shaped; matching that style minimizes operator cognitive
load. For the truly compute-bound bits of a campaign (parsing
hundreds of tx logs per second), Node is still fast enough — the
RPC round-trip dominates.

### Why a separate `load/` directory and not just more scripts?

Three reasons that line up with the fuzz/ Phase 1 reasoning:

1. **Operator-driven, not test-driven**. The `tests/` and
   `scripts/` directories are coupled to the project's npm/anchor
   test commands. Real load campaigns last hours and produce
   sizeable results files; they don't belong in `npm test`.
2. **Independent versioning surface**. Phase 2 wants its own
   `package.json` evolution (e.g. eventually pulling in t-digest or
   hdr-histogram for percentile compression at scale). Cleaner to
   evolve in a sibling directory than under `scripts/`.
3. **Symmetry with `fuzz/`**. Both `fuzz/` and `load/` capture
   "operator-driven, multi-hour pre-tag verification campaigns" —
   one for adversarial inputs at the policy layer, the other for
   throughput-and-latency at the ix-economic layer. Sibling
   directories signal that symmetry to a future maintainer.

---

## Scenario: `full-lifecycle`

Each "flow" exercises the full happy-path lifecycle:

```
register_agent (client)                — Registry
register_agent (provider)              — Registry
initialize_vault (client)              — Vault   (ADR-124 bind proof)
initialize_vault (provider)            — Vault   (ADR-124 bind proof)
[per-flow SPL token mint + ATAs + initial mint to client]
create_escrow (client funds escrow)    — Settlement
accept_task (provider)                 — Settlement
submit_milestone (provider)            — Settlement
approve_milestone (client) — CPIs into Registry::update_provider_reputation
                                        — Settlement → Registry CPI
```

### Why no direct `propose_reputation_delta` latency?

The user's spec for B9 names `propose_reputation_delta` as the final
step of the lifecycle. **It is not directly callable from a
TypeScript client.** Per cycle-2 AUD-108 closure (commit `738ae88`,
see `tests/agent-registry.ts` ~line 2315), the
`settlement_authority` slot on `ProposeReputationDelta` is
`signer + seeds::program = SETTLEMENT_PROGRAM_ID` — only signable
via Settlement's `invoke_signed`. Direct TS calls fail at the
web3.js client layer with `unknown signer` before reaching the
wire.

The reputation-delta behaviour is exercised in production exclusively
through Settlement's CPIs (`cpi.rs` → `update_provider_reputation` →
the post-AUD-100 implementation of the same policy as
`propose_reputation_delta`). Of the three CPI paths
(reason ∈ {0, 1, 2}), the happy-path scenario fires path 0
(REASON_TASK_COMPLETED) via `approve_milestone`. The metrics file
calls this out explicitly via the ix-class label
`approve_milestone__includes_reputation_cpi` so the operator reads
"this latency includes the cross-program reputation update" rather
than "this is a thinly-wrapped Settlement-only ix."

Phase 2 adds scenarios that fire reason 1 (dispute_loss via
`resolve_dispute`) and reason 2 (expiry_undelivered via
`expire_escrow`), so all three CPI paths get covered under load.

---

## File layout

```
load/
├── README.md                                    # this file
├── .gitignore                                   # results/ + node_modules
├── package.json                                 # standalone, no deps (uses root)
├── tsconfig.json
├── lib/
│   ├── pdas.ts                                  # PDA derivations + program IDs
│   ├── agent-factory.ts                         # provisionAgent + provisionFlowTokens
│   ├── metrics-collector.ts                     # latency / CU / RPC-error capture + JSON flush
│   └── indexer-lag.ts                           # chain head ↔ cursor SQLite read
└── scenarios/
    └── full-lifecycle.ts                        # Phase 1 scenario driver
```

Generated artifacts (gitignored):

```
load/results/<scenario>_<utc-iso>.json           # one per run
```

---

## How to run a campaign

### Prerequisites

1. **Anchor IDL on disk**. `anchor build` once, OR rely on the
   committed `idl/` directory. The harness searches both
   (`target/idl/` first, `idl/` fallback) — same logic as
   `scripts/smoke-test-devnet.ts`.
2. **A funded wallet**. Defaults to `~/.config/solana/id.json`
   (matches `Anchor.toml`'s `[provider] wallet`). Override with
   `--wallet=...` or `ANCHOR_WALLET=...`. The wallet is the harness
   driver, NOT the load agents — load agents are fresh keypairs
   airdropped from cluster faucet.
3. **A reachable RPC**. Defaults to `http://127.0.0.1:8899` (local
   `solana-test-validator`). Override with `--rpc-url=...` or
   `SOLANA_RPC_URL=...`.
4. **`ProtocolConfig` initialized at the target cluster.** This is
   a one-time per-deployment setup (see `tests/settlement.ts`
   before() hook for the test-runner equivalent). On localnet,
   running `anchor test` once seeds it. On devnet, the
   `deploy-devnet.sh` flow handles it. The harness checks for the
   PDA at startup and exits with an actionable error if missing.

### Smoke run (local validator, ~2 minutes)

```bash
# In one shell: bring up the validator with the workspace programs.
# Anchor's `[test] upgradeable = true` is required (AUD-005); the
# easiest way to get a validator with the right setup is:
anchor test --skip-deploy   # or just `anchor test` for a full run
# ... then leave the resulting test-validator running, OR:
solana-test-validator \
  --upgradeable-program 8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh target/deploy/agent_registry.so ~/.config/solana/id.json \
  --upgradeable-program 4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN target/deploy/agent_vault.so ~/.config/solana/id.json \
  --upgradeable-program GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3 target/deploy/settlement.so ~/.config/solana/id.json

# In another shell: run the scenario.
cd load
npx tsx scenarios/full-lifecycle.ts \
  --concurrency=2 \
  --flows=4 \
  --duration=60
```

Expected: each flow completes ~6-12 seconds end-to-end (limited by
the airdrop + register + vault-init setup, not the lifecycle ixes
themselves), `load/results/full-lifecycle_<ts>.json` written at the
end with all four ix-classes populated.

### Devnet run (operator-driven multi-hour campaign)

```bash
cd load
SOLANA_RPC_URL=https://api.devnet.solana.com \
  npx tsx scenarios/full-lifecycle.ts \
    --rpc-url=https://api.devnet.solana.com \
    --wallet=/path/to/funded-devnet-wallet.json \
    --concurrency=10 \
    --flows=10000 \
    --duration=14400 \
    --airdrop-sol=2
```

Notes:

- Devnet airdrop is rate-limited (per-account and per-IP). For
  campaigns over a few hundred flows, the operator should pre-fund
  a faucet wallet and replace `requestAirdrop` with
  `SystemProgram.transfer` from the funded wallet. **Phase 2
  follow-up** — see `lib/agent-factory.ts` `provisionAgent`'s
  airdrop call site.
- Set `--indexer-db=/abs/path/to/aep-events.db` if the indexer DB
  isn't at the repo-root default. Otherwise the lag reading is
  reported as "unavailable" in the JSON output and the campaign
  continues (the ix-level metrics are unaffected).
- The scenario stops at `min(--flows, --duration)` — pick whichever
  bound makes sense. For a 4-hour soak, `--duration=14400 --flows=1000000`.

---

## Output schema (`load/results/*.json`)

```jsonc
{
  "schemaVersion": "1.0",
  "meta": {
    "scenario": "full-lifecycle",
    "rpcUrl": "...",
    "concurrency": 2,
    "durationSec": 30,
    "flows": 4,
    "startedAt": "ISO-8601",
    "endedAt": "ISO-8601",
    "wallSec": 12.34
  },
  "summary": {
    "flowsAttempted": 4,
    "flowsSucceeded": 4,
    "flowsFailed": 0,
    "successRate": 1.0,
    "totalIxObserved": 16,            // 4 flows × 4 lifecycle ixes
    "totalIxAttempts": 16,            // includes RPC errors
    "rpcErrorRate": 0.0,
    "firstSlot": 12345,
    "lastSlot": 12567,
    "slotsSpanned": 222
  },
  "perIx": {
    "create_escrow": {
      "count": 4,
      "latencyMs": { "p50": 412, "p95": 580, "p99": 580, "min": 380, "max": 580, "mean": 449 },
      "computeUnits": { "p50": 18234, "p95": 19012, "p99": 19012, "mean": 18450, "samples": 4 }
    },
    "accept_task": { ... },
    "submit_milestone": { ... },
    "approve_milestone__includes_reputation_cpi": { ... }
  },
  "rpcErrors": {
    "countsByClass": {
      "timeout": 0, "slot_skipped": 0, "rate_limited": 0,
      "blockhash_not_found": 0, "node_unhealthy": 0,
      "transaction_failed": 0, "other": 0
    },
    "sampleMessages": []              // first 50 errors verbatim, for forensic
  },
  "indexerLag": {
    "chainHeadSlot": 12567,
    "perProgram": {
      "agent_registry":  { "cursorSlot": 12565, "lagSlots": 2 },
      "agent_vault":     { "cursorSlot": 12565, "lagSlots": 2 },
      "settlement":      { "cursorSlot": 12565, "lagSlots": 2 }
    },
    "available": true
  }
}
```

The schema is **stable** — Phase 2 additions append new ix-classes
to `perIx`; new aggregate fields are additive on `summary` and
`indexerLag`. Existing fields and shapes do NOT mutate. CI gates in
Phase 3 can rely on the field paths above.

---

## Phase 2 plan

Add scenarios that broaden the on-chain surface coverage:

1. **`settlement-only.ts`** — assumes a pre-provisioned pool of
   registered agents (created once by an init script), then runs
   create_escrow / accept_task / submit_milestone / approve_milestone
   in tight loops without re-registering. This is the realistic
   throughput model for an established protocol; Phase 1's
   per-flow registration dominates the wall clock and isn't
   representative of steady-state.
2. **`dispute-flow.ts`** — exercises the
   `resolve_dispute` path (CPI reason=1) against a population of
   already-active escrows. Latency-shape on dispute resolution is
   different from happy-path approve.
3. **`expiry-flow.ts`** — exercises `expire_escrow` (CPI
   reason=2) for escrows past their deadline. Validates the AUD-105
   deadline-boundary path holds under concurrent expiry pressure.
4. **`vault-spending.ts`** — exercises `execute_transfer` (the
   ADR-095 vault hot-path) with the post-ADR-124 identity binding.
   Different rate-limit shape from the lifecycle ixes; needs its
   own SLO targets.
5. **`reputation-only.ts`** — fires the three CPI reason codes
   (0/1/2) in a configurable mix and measures the per-CPI latency
   distribution against a stable agent-profile population.

Each Phase 2 scenario is a new file under `scenarios/`. Shared
helpers go in `lib/` — `agent-factory.ts` is already factored to
support pre-provisioned agent pools (Phase 2 will add a
`pool.ts` that loads / persists a population to a JSON file so
multiple scenarios can run against the same population).

### Phase 2 dependencies (likely additions)

- **`hdr-histogram-js` or `tdigest`** — when campaigns get long
  enough that storing every latency sample in memory becomes
  unreasonable. Phase 1's allocation-light arrays are fine for
  ≤100k samples; longer campaigns need a streaming digest.
- **`prom-client`** — optionally export live metrics during a
  campaign so an operator's Grafana board can see RPC error rates
  in real time, not just post-flush. Mirrors the indexer's
  `metrics-server.ts` pattern (ADR-104).

---

## Phase 3 plan

CI integration. Per `docs/PRE_MAINNET_ROADMAP.md` §3 B9: the goal is
**operator-triggered** load campaigns, NOT per-PR gates. Real
campaigns run for hours, dwarf the per-PR CI budget, and need
human-driven judgment on the SLO results. Concretely:

1. **Add `.github/workflows/load-pre-tag.yml`** — triggered by
   `workflow_dispatch` (manual) and by `release` events (so a
   pre-release tag automatically queues a multi-hour devnet load
   run before the human goes to push the `v*-mainnet` tag itself).
   - Self-hosted runner (the same fleet used for `fuzz-pre-tag.yml`
     in B8 Phase 3 + ADR-123 cache hardening).
   - Job matrix: one job per scenario.
   - Each job pre-funds a faucet wallet from a CI-managed devnet
     keypair (or refuses to start if balance < threshold), then
     runs the scenario for the configured duration.
   - Uploads the resulting `load/results/*.json` files as a workflow
     artifact named `load-results-<run-id>`.
2. **Define SLO thresholds** — once Phase 1+2 give us ≥10 baseline
   campaigns, fix the per-ix-class latency / CU / RPC-error /
   indexer-lag thresholds the gate checks. Until baselines exist,
   the workflow uploads results for human review without
   pass/fail. Likely shape:
   - `create_escrow` p99 latency < 3000ms (devnet)
   - `approve_milestone__includes_reputation_cpi` p99 CU < 80000
   - RPC error rate < 0.5% across the run
   - Indexer lag < 64 slots at end of run
3. **Add a `load:check-baselines` script** — reads the latest
   results JSON, compares to a baseline JSON committed under
   `load/baselines/<scenario>.json`, fails if any threshold is
   breached. The baseline file is updated only by explicit operator
   PR (no automatic baseline drift).
4. **Wire into `MAINNET_CHECKLIST.md` ADR-022 row** — flip the
   row from `Pending` to `Done` once at least one
   `load-pre-tag.yml` run against devnet has produced a clean
   result with the agreed SLO thresholds.

CI explicitly does NOT add the load harness to per-PR gates — that's
the wrong economic model for multi-hour soak campaigns.

---

## What this harness CANNOT catch

By design (Phase 1 = throughput + latency at the on-chain ix layer):

- **Off-chain stack failures**. The MCP server, x402-relay, SAS
  resolver, manifest validator are out of scope. `smoke-test-devnet.ts`
  covers their happy path; their stress modes are separate work.
- **Long-tail RPC infrastructure issues**. A campaign that runs
  against a saturated public devnet endpoint will hit shared-tenant
  rate limits and surface those as RPC errors — that's the harness
  measuring the endpoint, not the protocol. Phase 2/3 should
  document the recommended dedicated-endpoint setup
  (Helius / Triton / self-hosted RPC) for representative numbers.
- **Cross-region latency**. The harness runs from one Node process;
  it doesn't model agents in different regions hitting different
  RPC endpoints. If multi-region latency becomes load-bearing,
  Phase 3 grows a "distributed mode" where multiple harness
  instances coordinate via a shared results bucket.
- **State-rent eviction**. Long campaigns generate many fresh
  AgentProfile / Vault / Escrow PDAs. Phase 2's pool-of-agents
  model addresses the steady-state realism gap; until then,
  short campaigns are a rent-pressure-free measurement and long
  campaigns include rent-account-creation cost in every flow.

These are explicit Phase 2/3 follow-ups, NOT Phase 1 oversights.

---

## When this finds a real issue

A failing scenario is signal that should be triaged before tag,
not papered over. Triage flow:

1. **Inspect the JSON results file** — start with `summary.successRate`
   and `rpcErrors.countsByClass`. A high `transaction_failed` rate
   typically points at on-chain logic; high `rate_limited` /
   `node_unhealthy` points at RPC endpoint capacity.
2. **Read the `sampleMessages`** array — the first 50 RPC error
   messages verbatim. Look for repeated `Custom program error: <code>` —
   decode against the program's `errors.rs` to identify the gate
   that fired.
3. **Re-run with `--concurrency=1 --flows=1`** — if the failure
   reproduces serially, it's not a concurrency bug; investigate as a
   regular ix-level issue against the relevant `tests/` file.
4. **If the failure is concurrency-correlated** — file a finding
   against the AUD-* track. Concurrency-only failures on devnet
   under load are typically (a) leader-rotation-sensitive blockhash
   retries, (b) account-locking contention on shared singletons
   (`PROTOCOL_CONFIG_PDA`), or (c) account-deserialization races
   where two flows touch the same agent profile. The harness's
   per-flow isolation makes (c) unlikely by construction; (a) and
   (b) are real and worth a Phase 2 investigation.

---

## Smoke validation result (Phase 1)

The harness was smoke-validated locally during the Phase 1
implementation. The validation procedure:

1. `anchor build` — produces `target/idl/*.json` and
   `target/deploy/*.so` for the three workspace programs.
2. Bring up `solana-test-validator` with the upgradeable loader
   (matches `Anchor.toml`'s `[test] upgradeable = true`).
3. Initialise `ProtocolConfig` once via `anchor test --skip-build`
   (which exercises the `tests/settlement.ts` before() hook).
4. Run `npx tsx scenarios/full-lifecycle.ts --concurrency=2
   --flows=4 --duration=60` from the `load/` directory.

Expected behaviour: 4 flows complete, `load/results/*.json` is
written with all four lifecycle ix-classes populated, `summary.flowsSucceeded
== 4`, `rpcErrors.countsByClass` all zero, `indexerLag.available`
either `true` (if the indexer was running locally) or `false` with
a clear `unavailableReason` (the expected default — the indexer is
an opt-in side process for Phase 1 smoke runs).

The harness exits cleanly (no orphan processes, no leaked file
handles); the validator is left running for the next run.

Phase 2 builds on this baseline by adding more scenarios; the smoke
validation procedure stays the same shape (build → validator up →
seed protocol_config → run scenario → inspect JSON).
