# AEP fuzz harness — Phase 1

Source-level fuzz harness for the Agent Economy Protocol's highest-value
on-chain seams. Maps to **B8** of `docs/PRE_MAINNET_ROADMAP.md` §3
(MAINNET_CHECKLIST.md ADR-021 row).

This directory ships the **Phase 1** scaffold: framework selection,
workspace integration, and one validated fuzz target. Phase 2 adds
targets; Phase 3 wires CI.

---

## Phase 1 scope (this PR)

- Framework chosen: **honggfuzz-rs 0.5.60**.
- Workspace layout: standalone Cargo workspace (`fuzz/Cargo.toml`'s
  empty `[workspace]` table) — does NOT participate in the on-chain
  workspace at the repo root, so `anchor build`, `cargo test -p
  agent-registry`, and `solana-verify` are unaffected.
- One target shipped: `propose_reputation_delta` — the AUD-108 +
  ADR-094 + AUD-100 + AUD-001/002 policy logic of the Registry's
  reputation-mutation surface.
- Validation: harness compiles cleanly under `cargo check`, and the
  in-tree `#[cfg(test)]` deterministic 1M-iteration sweep exercises
  the exact same model the honggfuzz binary fuzzes (so the harness
  is operator-runnable AND continuously regression-tested by `cargo
  test`).

### Framework choice rationale

| | Trident 0.12.0 | Honggfuzz-rs 0.5.60 (chosen) |
|---|---|---|
| Anchor 0.31.1 compat | Yes (cpi example pins anchor-lang 0.31.1) | N/A — pure-Rust harness |
| Install on this dev box | **Blocked** — `pkg-config + libssl-dev` missing, sudo unavailable | Cargo crate, no install needed for `cargo check` |
| Operator install cost | `cargo install trident-cli` + system pkgs | `apt install binutils-dev libunwind-dev` for `cargo hfuzz` |
| Generates fuzz boilerplate from IDL | Yes (`trident init`) | No — manual targets |
| Scope of fuzz | Full on-chain ix execution via TridentSVM | Pure-state policy logic |
| Phase 1 fit | High-overhead first install | Lightweight, ships today |

The roadmap names `trident or honggfuzz`; the user spec for B8 strongly
prefers trident as the default and names honggfuzz as the explicit
fallback. We pivoted because trident-cli could not be installed on the
Phase 1 implementation host without root (openssl-sys → pkg-config →
libssl-dev), and trident's IDL-generated `types.rs` boilerplate cannot
be produced without `trident-cli`. **Trident remains the preferred
direction for Phase 2** once an operator with sudo on a CI runner can
land it; this Phase 1 honggfuzz target is complementary (pure-state
policy) rather than competitive (full ix-level coverage) with what
trident would add.

---

## Running the harness

### One-time operator setup

```bash
# System packages honggfuzz's C runtime needs.
sudo apt update
sudo apt install -y binutils-dev libunwind-dev

# Cargo subcommand. Pin to 0.5.60 to match the workspace dep.
cargo install honggfuzz --version 0.5.60 --locked
```

### Smoke validation (anywhere — no honggfuzz binary needed)

```bash
cd fuzz
cargo check                                          # ~30s; exercises
                                                     # the trait surface
                                                     # of the target.
cargo test                                           # ~10s; runs the
                                                     # 1M-iteration
                                                     # deterministic
                                                     # sweep + the
                                                     # boundary unit
                                                     # tests.
```

The `cargo test` path covers the same property contract as the
honggfuzz binary, so a regression in the policy gates or invariants
trips a unit test long before the operator runs an actual fuzz
campaign.

### 30-second smoke fuzz (operator)

```bash
cd fuzz
cargo hfuzz run propose_reputation_delta -- --max_total_time=30
```

Expected: iteration counter into the millions, **0 crashes**. A crash
indicates a regression in the policy logic — investigate against the
saved reproducer in `hfuzz_workspace/propose_reputation_delta/`.

### 4-hour pre-tag campaign (operator, gated to Phase 3 once CI lands)

```bash
cd fuzz
cargo hfuzz run propose_reputation_delta -- --max_total_time=14400
```

Expected: ~10⁹ iterations, **0 crashes**. Save artifacts to
`hfuzz_workspace/` for post-tag forensic.

---

## Phase 2 plan

Add targets that cover the next-most-attack-surface-dense seams
identified in cycle-2:

1. **`update_status` accept-list** (AUD-120) — fuzz the
   `Active → {Active, Paused, Retired, Suspended}` /
   `Paused → {Active, Paused, Retired, Suspended}` /
   `Suspended → {Retired}` exhaustive transition matrix. The recent
   PR-Q matchexpansion turned an open-ended range into a closed
   accept-list; fuzz proves no path leaks past the new gate.
2. **`update_provider_reputation` Settlement CPI seam** — fuzz the
   `(reason, delta)` pair *as Settlement would emit it*, including
   adversarial reasons that could trick the slash branch.
3. **Seeds-validating contexts** (AUD-117) — fuzz the cross-account
   PDA derivation: feed adversarial `(authority, owner_nonce,
   agent_profile)` triples and assert Anchor's seeds constraint
   rejects every misdirection.
4. **`clear_suspension` cleared_count escalation** (AUD-004) — fuzz
   the cost-ladder boundaries (1 → halve, 2 → zero, 3 → terminal
   Retired).

Each Phase 2 target is a new `[[bin]]` entry under
`fuzz/Cargo.toml` with its own file under `fuzz_targets/`. The
honggfuzz `cargo hfuzz` subcommand picks the bin name from the CLI
arg.

### Phase 2 trident retry checklist

If/when an operator with sudo on a CI runner is available, retry
trident as a complementary harness for **ix-level execution
coverage** (which honggfuzz's pure-state targets cannot reach):

1. `apt install pkg-config libssl-dev` on the runner.
2. `cargo install trident-cli --version 0.12.0`.
3. `cd <repo> && trident init --skip-build`.
4. Move the generated `trident-tests/` under `fuzz/trident-tests/`
   to keep the on-chain workspace clean.
5. Wire one trident `flow` per Phase 2 honggfuzz target.

---

## Phase 3 plan

CI integration. Per the roadmap §3 B8: **4-hour fuzz run pre-tag**.

1. Add `.github/workflows/fuzz-pre-tag.yml`:
   - Triggered by tag-creation events and a manual `workflow_dispatch`.
   - Self-hosted runner with `binutils-dev + libunwind-dev` preinstalled
     (per ADR-105 the runners ship dev pkgs already; verify before this
     workflow lands).
   - Job matrix: one job per fuzz target; each runs
     `cargo hfuzz run <target> -- --max_total_time=14400`.
   - On any crash: upload the `hfuzz_workspace/` reproducer as a
     workflow artifact and fail the tag.
2. Add `cargo check --manifest-path fuzz/Cargo.toml` and
   `cargo test --manifest-path fuzz/Cargo.toml` to the existing
   `ci.yml` rust-check job — gates that the harness *itself* keeps
   compiling on every PR. Cheap: ~30s.
3. (Optional) nightly fuzz at lower duration (`--max_total_time=900`)
   to catch regressions between tags. Tradeoff: runner-hours.

---

## File layout

```
fuzz/
├── Cargo.toml                                      # standalone workspace
├── README.md                                       # this file
├── .gitignore                                      # ignore hfuzz_target/
└── fuzz_targets/
    └── propose_reputation_delta.rs                 # Phase 1 target
```

Generated artifacts (gitignored):

```
fuzz/hfuzz_target/                                  # cargo build output
fuzz/hfuzz_workspace/                               # campaign state +
                                                    # crash reproducers
```

---

## What this harness CANNOT catch

By design (Phase 1 = pure-state policy fuzz):

- Account-handle bugs (`signer`, `seeds`, `has_one`) — those need
  Anchor's account machinery in scope; trident or
  `solana-program-test` covers them.
- Sysvar / `Clock` race conditions — Solana runtime fuzzing only.
- CPI-boundary marshaling (Settlement → Registry) — covered by
  the existing `tests/cpi-failures.test.ts` integration suite.
- Compute-unit budget exhaustion — operator-driven CU profiling
  (devnet) is the right tool.

These are explicit Phase 2/3 follow-ups, NOT Phase 1 oversights.

---

## When this finds a real bug

A honggfuzz crash is a real finding. The reproducer lives at:

```
fuzz/hfuzz_workspace/propose_reputation_delta/SIGABRT.PC.<...>.fuzz
```

1. Decode the input bytes back to the `Input` struct using the
   `Arbitrary` derive (round-trip via
   `Input::arbitrary(&mut Unstructured::new(&bytes))`).
2. Add a `#[test]` to `fuzz_targets/propose_reputation_delta.rs`'s
   `mod tests` block that reproduces the crash deterministically.
3. File the bug via the AUD-* track. Do NOT modify the harness model
   to mask the failure — that would silently desynchronize the harness
   from the on-chain handler.
4. Land the program-side fix; re-run the harness; confirm the
   reproducer now passes.

The harness is intentionally a *mirror* of the on-chain handler; any
gap between the two is the bug.
