# MEMORY.md — Protocol Codebase Notes for Future Sessions

Cross-session facts that are non-obvious from reading the code. Append; do not delete. Date-stamp each entry.

---

## 2026-05-10 — LiteSVM harness investigation

**`solana-bankrun` and `anchor-bankrun` are deprecated.** Do not adopt them. The correct test harness upgrade target is `litesvm` (npm: `litesvm`) + `anchor-litesvm`. Investigation report: `docs/audits/HARNESS-BANKRUN-INVESTIGATION-2026-05-10.md`. Roadmap item: PRE_MAINNET_ROADMAP.md §B14.

**Ed25519 precompile is broken under `solana-bankrun`.** bankrun Issue #27 (unfixed; package archived). ADR-124 added `instructions_sysvar` + Ed25519 precompile verification to `initialize_vault` (`agent-vault.ts`); the vault suite would fail spuriously under bankrun. LiteSVM handles this correctly.

**`anchor-bankrun` v0.5.0 does not support Anchor 0.31 IDL format.** This repo uses `@coral-xyz/anchor ^0.31.1`. Adopting `anchor-bankrun` would likely break IDL deserialization silently.

**Four `it.skip` tests await LiteSVM unblocking:**
- `tests/cpi-failures.test.ts:1298` — AUD-117 ResolveDisputeTimeout (BANKRUN-TODO `trig_01NokXSDGAb7ECabM5n9ULR3`)
- `tests/agent-registry.ts:1668` — AUD-101 `reputation_score` clamp (commented, not it.skip)
- `tests/agent-registry.ts:1675` — AUD-101 Suspended → slash_count invariant (commented)
- `tests/settlement.ts:2632` — AUD-105 positive-path deadline timeout (TODO comment)

Case 5 (forged `settlement_authority` via `invoke_signed`, `cpi-failures.test.ts:715`) stays blocked permanently from TS — requires a purpose-built spoofer Rust program; this is a cycle-4 workstream.

**CI topology note:** `anchor-integration` job uses `concurrency: group: anchor-integration-host` because `solana-test-validator` binds port 8899. LiteSVM is in-process (no port binding), so a separate `bankrun-tests` CI job can run in parallel with `anchor-integration` — no serialization needed.

**Next free ADR number as of 2026-05-10:** ADR-137 (ADR-136 is the last issued; ADR-135 was not written — same gap pattern as ADR-045/054/055/056).

---

## 2026-05-10 — Test suite state

Current validator test corpus: 5 on-chain suites in `Anchor.toml [scripts] test` (settlement.ts, agent-registry.ts, agent-vault.ts, cpi-failures.test.ts, cctp-hook.ts). Total: 10 843 LOC, 156 passing tests (last confirmed count from ADR-124 implementation notes). Do not modify these files as part of harness migration.

Off-chain suites (`*.test.ts`) run via their own workspace `npm test` scripts, NOT via `anchor test`. They do not need LiteSVM.
