# ADR-080: `mainnet-deploy.sh` safety mandates — required gates, real hash verification, signed-tag enforcement, rollback log, shellcheck CI

## Status
Accepted

## Date
2026-04-23

## Context

`scripts/mainnet-deploy.sh` is the single deployment entry point for the three on-chain programs (`agent-registry`, `agent-vault`, `settlement`) on Solana mainnet-beta. It carries the entire human-procedure surface for the program-launch ceremony described in ADR-031, ADR-036, and ADR-078.

The Architecture Audit dated 2026-04-23 (`docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md`, items 1 and 2 in the Blocker punch list) and the Deep Audit dated 2026-04-22 (`docs/adr/DEEP-AUDIT-2026-04-22.md`, Audit 3 gap #4 / GOV-4 and gap #15 / Operational #15) flagged the script as **partly theatre**:

1. **`local`-outside-function bug in the authority-transfer block.** `set -euo pipefail` is in effect for the whole script. The `for pid in …; do … local authority; … done` block at lines ~230–244 uses the `local` keyword outside any function. Bash's `local` builtin returns a non-zero status when invoked outside a function body. Under `set -e` this aborts the script — but the abort happens **after** `solana program set-upgrade-authority` has already run for some subset of the three programs. Result: a partial authority transfer with no rollback path, exactly during the highest-blast-radius minute of the entire ceremony. The bug is silent locally because `set -e` plus a `for` body's last command's non-zero status interacts inconsistently across bash versions, but in CI and on a fresh operator machine running bash 5.x with `set -euo pipefail` the failure is reproducible.

2. **`MULTISIG_ADDRESS` skip-prompt.** When `MULTISIG_ADDRESS` is unset, the script prints a warning and offers a `confirm "Continue WITHOUT multi-sig authority transfer?"` prompt that, on `y`, lets the operator deploy with single-key upgrade authority left in place. This is the *exact* failure that ADR-078 §1 (devnet rehearsal) and ADR-079 §1 (bright-line trigger) are written to prevent. An operator under pressure at 2 AM hitting `y` ships mainnet with `BUdXA1Fi…jTXL` as upgrade authority — i.e., the protocol is single-key-controlled forever after launch.

3. **SHA-256 "audit verification" is informational only.** The script prints binary hashes with the comment `(verify against audit report)` and does nothing with them. There is no committed `AUDIT_REPORT_HASHES` file; no `sha256sum --check` step; no way for the script to refuse to proceed if the deployable binary diverges from the audited binary. This is the failure mode ADR-036 is meant to prevent — the audit report exists, but the deployment pipeline does not consume it.

4. **No source-tree integrity gates.** The script will happily deploy from a dirty working tree, from a commit that is not tagged, or from a tag that is not signed. There is no enforcement that the deployment artifact corresponds to a reviewed, tagged, signed commit. This violates the ADR-031 §3 release-discipline principle that mainnet binaries trace to a named release.

5. **No deploy log.** The "Rollback plan" final echo references "saved in deployment log" placeholders that are never written to disk. Audit 3 gap #15: during incident response, "check the deployment log" returns nothing because no log file exists. The pre-deploy commit SHA, the pre-deploy binary hashes, and the per-step authority states all live in scrollback that is lost the moment the operator's terminal closes.

6. **No CI gate against shell regressions.** The `local`-outside-function bug at the heart of finding (1) would have been caught by a single `shellcheck scripts/mainnet-deploy.sh` invocation. The repository's CI (`.github/workflows/ci.yml`) gates Rust, IDL, anchor integration, secret-scan, and TypeScript surfaces, but has no shell linter. Every `scripts/*.sh` file is unchecked.

The combined risk profile: a single-operator ceremony, on the highest-stakes script in the repository, with no static-analysis gate, a known-broken control-flow path during authority transfer, an opt-out for the entire multisig-protection guarantee, an inert hash-verification step, no integrity binding to a tagged release, and no on-disk audit trail of what actually happened. Items 1 and 2 of the Architecture Audit's Blocker tier exist to close that profile.

This ADR is **scripts + CI + DOCS**: hardening of `scripts/mainnet-deploy.sh`, a new `config/AUDIT_REPORT_HASHES` template, a new `.github/workflows/shellcheck.yml` mandatory gate, and this ADR itself. No on-chain program code changes.

## Decision

### 1. Pre-flight gates (refuse-to-run, not warn-and-continue)

The script enforces, before any side-effecting Solana CLI invocation, the following pre-flight gates. Each gate that fails causes the script to print an actionable error message and exit non-zero. **None of the gates are skippable from inside the script.** Two of them are conditionally bypassed via the `AEP_DEPLOY_DRY_RUN=1` environment variable, used only for devnet rehearsal of the script logic itself (the variable's presence is logged loudly so a stray export cannot accidentally bypass production gates).

Gates, in evaluation order:

1. **Self-test mode (`--self-test`).** If `--self-test` is the only argument, the script runs the gate-evaluation logic against synthetic inputs, reports per-gate pass/fail, and exits without invoking any Solana CLI. This is the smoke test referenced in §6.
2. **Tooling presence.** `solana`, `solana-keygen`, `sha256sum`, `awk`, `bc`, `git` must all be on `PATH`. A missing tool exits 1 with the missing tool name.
3. **Working-tree clean.** `git status --porcelain` must produce empty output. A dirty tree means the build does not reproducibly correspond to any commit; deploying from such a tree is forbidden. Exits 1.
4. **Tagged HEAD.** `git tag --points-at HEAD` must include at least one tag matching the glob `v*-mainnet` (e.g. `v0.1.0-mainnet`, `v0.2.3-mainnet`). The mainnet-suffix discipline is intentional: it keeps the publish-tag namespace (`v0.1.0`) separate from the on-chain-deploy namespace (`v0.1.0-mainnet`), so a pre-publish tightening commit cannot accidentally be deployed. Exits 1 unless `AEP_DEPLOY_DRY_RUN=1`.
5. **Signed tag.** Each `v*-mainnet` tag at HEAD must verify under `git tag -v`. An unsigned mainnet-tag is treated identically to no tag. Exits 1 unless `AEP_DEPLOY_DRY_RUN=1`.
6. **`MULTISIG_ADDRESS` set and non-empty.** Per item 2 of the audit punch list, the variable is no longer optional. Empty or unset exits 1 with a message referencing this ADR. There is **no** `--skip-authority-transfer` flag and no interactive confirmation that bypasses this requirement. The script removes both.
7. **`MULTISIG_ADDRESS` is a valid base58 pubkey.** Validated by `solana-keygen verify` against the pubkey form (or a length+character-set check; both are acceptable, the script uses the second for portability). Exits 1.
8. **Multisig PDA exists on the configured cluster.** `solana account "$MULTISIG_ADDRESS"` succeeds and returns a non-empty owner. A typo'd address that happens to be valid base58 must not silently become the upgrade authority. Exits 1.
9. **Cluster is mainnet.** Existing check, kept verbatim. Skipped under `AEP_DEPLOY_DRY_RUN=1` (devnet rehearsals).
10. **Wallet balance ≥ `MIN_BALANCE`.** Existing check, kept verbatim.
11. **Program binaries present.** Existing check, kept verbatim.
12. **Program-ID/keypair match.** Existing check, kept verbatim.
13. **Audit-report hash verification.** Per §2 below.

The order matters: cheapest checks first, tooling next, integrity (clean+tagged+signed) before any cluster I/O, multisig validation before any deploy. The audit-hash check is last among pre-flight because it is the most expensive in human terms (an out-of-date hash file blocks the operator and forces a re-coordination with the auditor).

### 2. Audit-report hash verification — real, committed, mandatory

A new file `config/AUDIT_REPORT_HASHES` is committed to the repository. Its format is the exact format consumed by `sha256sum --check` (BSD-style would also work; coreutils-style is chosen for parity with the other CI checks):

```
<hex-sha256>  target/deploy/agent_vault.so
<hex-sha256>  target/deploy/agent_registry.so
<hex-sha256>  target/deploy/settlement.so
```

The file lives at `config/AUDIT_REPORT_HASHES`. Its lifecycle:

1. **Audit completion**: the external auditor (per ADR-036) computes SHA-256 over the three `.so` artifacts they audited and produces the hash list as part of the audit deliverable.
2. **Commit**: a maintainer commits the hash file in a dedicated PR, one PR per audit, never amended after merge. The PR title references the audit-report ID.
3. **Mainnet build**: the deployer rebuilds locally from the same tagged commit using the auditor's documented toolchain pin (Solana CLI, Anchor CLI, Rust toolchain — the pins ADR-013 already enforces).
4. **Pre-deploy**: `mainnet-deploy.sh` runs `sha256sum --check --strict config/AUDIT_REPORT_HASHES` from `PROJECT_ROOT`. Any mismatch, missing file, or extra warning aborts with exit 1 and a message naming the divergent artifact.
5. **Subsequent deploys**: a re-audit produces a new commit with new hashes. There is no hash-file mutation outside of an audit cycle.

The script refuses to proceed if `config/AUDIT_REPORT_HASHES` is missing. It does **not** offer a `--skip-hash-check` flag. The `AEP_DEPLOY_DRY_RUN=1` bypass does **not** disable this check — devnet rehearsals against a stale hash file are a useful integration test of the gate itself.

The committed file is a template at the time this ADR lands. The template carries placeholder hashes (literally `0000…`) and a header comment explaining the lifecycle. Devnet rehearsals run with `AEP_DEPLOY_DRY_RUN=1` will hit the hash-check gate, see the template-marker mismatch, and fail loud — which is the intended behavior. Real mainnet deploys cannot run until an auditor populates the file.

### 3. `MULTISIG_ADDRESS` is non-optional

Both the `--skip-authority-transfer` CLI flag and the `confirm "Continue WITHOUT multi-sig authority transfer?"` prompt are **deleted**. The script's entire authority-transfer code path is unconditional: if pre-flight gates pass, the transfer happens.

The variable's source of truth is the operator's environment at invocation time:

```bash
MULTISIG_ADDRESS=<squads-vault-pda> ./scripts/mainnet-deploy.sh
```

There is no in-script default and no Anchor.toml fallback. This is intentional — the address is a per-deploy-cluster value (different on devnet rehearsal vs mainnet) and must be supplied per invocation. The operator who runs the script is the operator who has typed (or pasted from a verified offline note) the address.

### 4. Authority-transfer block wrapped in a function (`local` bug fix)

The block at the original lines ~225-247 — the `for pid in …; do … local authority; … done` loop — is moved into a function `verify_authority()` and a parent `transfer_authority_to_multisig()`:

- `transfer_authority_to_multisig()` runs the for-loop, calls `solana program set-upgrade-authority`, and invokes `verify_authority "$pid"` per program.
- `verify_authority()` is the function inside which `local authority` is a legal declaration. It reads `solana program show "$pid"` once, parses the upgrade authority, and asserts equality with `MULTISIG_ADDRESS`. On mismatch it logs an error and returns non-zero, which propagates through `set -e` to abort the script.

This converts the silent-trap-during-transfer into an early-exit-with-context, eliminates the `local`-outside-function shellcheck violation (SC2168), and makes the unit testable via `--self-test`.

### 5. Signed deploy log to `logs/`

The script `tee`'s its own output (and explicit pre-deploy state) to `logs/mainnet-deploy-$(date -u +%Y%m%dT%H%M%SZ).log`. The log contents:

1. UTC timestamp at start.
2. `git rev-parse HEAD` — commit SHA.
3. `git tag --points-at HEAD` — tag(s) at HEAD.
4. `git describe --dirty --always --tags` — human-readable describe.
5. `solana --version`, `solana-keygen --version`, `anchor --version` (if present).
6. `solana config get` — RPC URL, keypair path, commitment level.
7. `solana address` — deployer wallet pubkey.
8. `solana balance` — pre-deploy balance.
9. The full content of `config/AUDIT_REPORT_HASHES`.
10. The output of `sha256sum target/deploy/*.so` — actually-deployed binary hashes (must match #9 byte-for-byte; verified by the gate).
11. The `MULTISIG_ADDRESS` value.
12. The `solana account "$MULTISIG_ADDRESS"` output — multisig PDA owner + space at deploy time.
13. Each `solana program deploy` invocation's stdout/stderr.
14. The post-transfer `solana program show "$pid"` output for each program.
15. Final balance and elapsed time.

The log directory is created if missing. The log filename uses UTC ISO-8601 with a trailing `Z` so two simultaneous runs cannot collide and so the lexicographic order matches chronological order. The log file pattern is gitignored (`*.log` per existing `.gitignore`); operators are expected to rotate logs to long-term storage out-of-band (Audit 3 gap #28's S3/GCS offload runbook is the canonical destination but is out of scope for this ADR).

### 6. Self-test mode (`--self-test`)

`./scripts/mainnet-deploy.sh --self-test` exits 0 if the script's gate logic is internally consistent and exits non-zero otherwise. It does **not** invoke any Solana CLI command, does not require a wallet, does not require network. What it tests:

- The script parses without bash syntax errors (would have caught the `local`-outside-function bug at script-load, before any side effect).
- All required helper functions exist (`confirm`, `check_balance`, `verify_program_id`, `verify_authority`, `transfer_authority_to_multisig`, `preflight_*`, `write_deploy_log`).
- `config/AUDIT_REPORT_HASHES` exists and is well-formed (three lines, each `<64 hex chars>  target/deploy/<name>.so`).
- The pre-flight gate functions, when called with synthetic inputs simulating each failure mode (dirty tree → fail; missing tag → fail; unset multisig → fail; placeholder hashes → fail when not in `--self-test`'s tolerance mode), produce the expected non-zero exit status.
- The script's `set -euo pipefail` is in effect.
- `shellcheck` (if present on `PATH`) is invoked on the script itself; warnings are reported but do not fail self-test (the CI gate is the authoritative shellcheck enforcement).

`--self-test` runs in CI as part of the shellcheck workflow and is part of the operator pre-flight checklist (a §1 gate, evaluated before tooling presence — running `--self-test` first surfaces script-level breakage before requiring `solana` to be installed).

### 7. `shellcheck` mandatory CI gate

A new file `.github/workflows/shellcheck.yml` runs `shellcheck scripts/*.sh` on every pull request and on every push to `main`. The job:

- Uses the official `ludeeus/action-shellcheck` action pinned to a major version, or installs `shellcheck` from apt (Ubuntu runner) — this ADR specifies the latter for dependency-minimization (no third-party action in the critical path).
- Runs at warning level (`--severity=warning`) — `info` and `style` are noisy and out of scope.
- `--external-sources` enabled so any future `source` directives are followed.
- **`continue-on-error: false`.** This is a blocking gate. A failing shellcheck run blocks merge.
- Fails fast on the first script with violations.

Any intentional violation must be documented in-script with `# shellcheck disable=SC<NNNN>` and a comment explaining why (one per occurrence, not file-wide). The gate refuses globally-disabled rules.

The workflow runs on `pull_request` (any branch → main) and on `push` to `main` (catches direct pushes if any ever happen). Concurrency is set so superseded runs cancel themselves.

### 8. Out of scope for this ADR

- The auditor's actual hash-list deliverable. ADR-036 covers the audit engagement; this ADR consumes its output but does not specify the audit's own deliverables.
- Multisig PDA derivation. The Squads vault PDA is provided as opaque input from `MULTISIG_ADDRESS`; deriving it from `createKey` is ADR-063 / ADR-078 territory.
- Rollback procedure beyond logging. ADR-078 §2 specifies the rollback keypair and §3 the per-program transfer order; this ADR ensures the log file from §5 contains enough state for that rollback to be executed offline.
- Devnet upgrade-authority transfer. ADR-078 §1 covers the rehearsal program. This script is scoped to the three production programs; rehearsals on the throwaway program are scripted separately.
- AEP_VALIDATORS bootstrap. ADR-077 / Audit punch-list item 5; orthogonal to deploy hardening.

## Alternatives Considered

### Alternative A: Keep `MULTISIG_ADDRESS` optional with a louder warning
**Rejected.** The failure mode is operator pressure, not operator information. A louder warning at 2 AM is read as "I see, OK" and answered `y`. The only safe design is "the script cannot proceed without the multisig address." Any prompt-based opt-out reintroduces the failure mode.

### Alternative B: Compute the audit-report hashes at deploy time instead of comparing against a committed file
**Rejected.** That is "verify the binary against itself" — it produces a hash, but the hash has no external referent. The whole point of audit-report hashing is that an *external party* (the auditor) computed the hashes against the binary they reviewed; the script's job is to refuse to deploy a binary that does not match. Self-comparison is the inert version of the check the script already has.

### Alternative C: Put `AUDIT_REPORT_HASHES` in `docs/audit/` instead of `config/`
**Rejected, but close.** `config/` is chosen because (a) it is the canonical "machine-consumed configuration" location consistent with `config/programs.json` (forthcoming per Audit punch-list item 31 / ADR-099); (b) `docs/` carries an implicit "human reads this" connotation that makes operators less likely to update it as part of a deploy. The hash file is a build/deploy input, not documentation.

### Alternative D: Make `AEP_DEPLOY_DRY_RUN=1` skip the hash check too
**Rejected.** Devnet rehearsals are exactly the time to exercise the hash-check gate end-to-end. A rehearsal that bypasses the check teaches the operator a workflow that does not match the production workflow. The placeholder hashes intentionally fail; rehearsals run with a known-mismatching `AUDIT_REPORT_HASHES` and document the failure-mode. The first rehearsal that needs to "succeed past the hash check" is the one with real auditor hashes — i.e., the production deploy.

### Alternative E: Use `gpg --verify` directly instead of `git tag -v`
**Rejected.** `git tag -v` is the canonical wrapper, integrates with git's signing-key configuration, and works whether the maintainer signs with GPG or SSH (per recent git versions). Calling `gpg` directly bypasses git's tag-format awareness and would re-implement the same logic.

### Alternative F: Add a `--force` flag for emergency mainnet deploys
**Rejected categorically.** Every "force" flag in a deployment script is the failure mode the script's safety gates are designed to prevent. If the gates are wrong, fix the gates in code (with PR review), not a runtime override. Emergencies that genuinely require bypassing the gates require human ceremony (a maintainer commits a temporary script that documents the override, in a reviewed PR, with the override's rationale logged) — not a flag.

### Alternative G: Use a third-party shellcheck action (`ludeeus/action-shellcheck`) instead of installing via apt
**Rejected for the production gate.** Third-party actions introduce supply-chain risk; pinning to a hash mitigates but does not eliminate. `shellcheck` is in Ubuntu's archive (and trivially `apt-get install`'d in seconds) — using the system package keeps the critical-path workflow minimal in dependencies. The action is fine for non-blocking jobs; it is not used here.

### Alternative H: Skip signed-tag verification — only require a `v*-mainnet` tag to point at HEAD
**Rejected.** Unsigned tags can be created retroactively or by anyone with push access; they do not bind the deploy to a maintainer's signing key. Signed tags are the protocol-level integrity primitive that connects the on-chain deployment artifact to a named human's GPG/SSH key. Stripping the signature requirement removes the only off-chain non-multisig identity proof in the deploy chain.

### Alternative I: Tee the deploy log to a remote endpoint (S3 / sentry / loki) directly from the script
**Rejected for this ADR.** Out of scope (Audit 3 gap #28). The local log + manual rotation is the floor; remote log shipping is a follow-up. Adding remote shipping inside this script couples the deploy ceremony to a network dependency that, if it fails, produces ambiguous behavior (does the deploy continue? abort?). The local log is unambiguous.

## Consequences

### Positive

- **Closes Architecture Audit blockers 1 and 2 in one PR.** The `local`-outside-function bug, the `MULTISIG_ADDRESS` skip-prompt, and the inert hash check are all addressed by code that lands together; partial fixes are not possible.
- **Closes Deep Audit GOV-4 and Operational #15.** The deploy script is no longer "partly theatre" and the rollback path now has a real artifact (the log file) to refer to.
- **Static analysis blocks regressions in the same class.** Once `shellcheck` is a mandatory CI gate, the next `local`-style bug (or unquoted variable, or array-as-string mistake) is caught at PR time, not at 2 AM during ceremony.
- **Audit deliverables become enforceable.** The auditor's hash list is no longer an out-of-band artifact that maintainers might or might not consult; the script refuses to deploy without it. ADR-036's audit-engagement value materializes in the deploy pipeline.
- **Tagged + signed releases bind the on-chain artifact to a maintainer identity.** Combined with §5's deploy log, the artifact-to-identity trace is intact even after the operator's terminal closes.
- **Self-test mode catches script breakage early.** The script can be exercised in CI and in operator dry-runs without touching mainnet, which raises the operational confidence in the script itself before it is invoked for real.

### Negative

- **More things can go wrong before deploy.** Eight pre-flight gates (vs the previous four) means more legitimate aborts. A maintainer who has not tagged the commit, who is on a dirty tree, or who has not pulled the audit-hash PR will hit the gates. This is the intended behavior — but it does mean the deploy ceremony has more discrete steps that can fail. Each must be addressable inside the ceremony window.
- **`AUDIT_REPORT_HASHES` is a coordination point.** The auditor must produce it on a specific commit; the maintainer must merge it before deploying; the deployer must build from the same commit with the same toolchain. Any drift causes a hash mismatch and aborts. Toolchain pinning per ADR-013 absorbs most of this; the rest is operator discipline.
- **Self-test mode is itself code that must be maintained.** As gate logic evolves, the synthetic-input harness must evolve with it. A self-test that is allowed to drift becomes a false-confidence signal.
- **Devnet rehearsals must run with `AEP_DEPLOY_DRY_RUN=1`.** Without the variable, the cluster check, signed-tag check, and tagged-HEAD check would fire. Operators must understand the variable's exact semantics — the README and the `--help` output document them.
- **Removing `--skip-authority-transfer` is a CLI break.** Anyone who has scripted around the flag (no known consumers — the script has always been operator-invoked) loses that path. The CLI break is intentional and the safer behavior.

### Neutral

- **No on-chain program code change.** The protocol's program binaries are unaffected. This is a script + CI + DOCS change; protocol semantics are unchanged.
- **`config/` directory is created.** Repository now has a top-level `config/` folder. It is committed via the `AUDIT_REPORT_HASHES` template and a README stub. Future per-cluster configuration (programs.json per Audit item 31) lives here.
- **`logs/` directory is created.** Top-level `logs/` folder is committed via a `.gitkeep`. The `*.log` gitignore rule already excludes the produced log files; only the directory marker is tracked.
- **Compatible with future ADRs.** ADR-099 (cluster-keyed `config/programs.json`) extends `config/`; ADR-105 (indexer SQLite backup) is structurally similar (committed config + ignored runtime artifacts). No conflicts foreseen.
- **Compatible with the existing CI surface.** The new shellcheck workflow is a separate file with its own concurrency group; it does not alter `ci.yml`'s job graph.

## References

- `docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md` — Blocker punch-list items **1** and **2** (this ADR is their implementation; the audit's ADR-numbering plan slates this as 080).
- `docs/adr/DEEP-AUDIT-2026-04-22.md` — Audit 3 gap **#4 (GOV-4)** "mainnet-deploy.sh safety gates are partly theatre"; gap **#15** "Rollback plan in mainnet-deploy.sh is pseudocode."
- `docs/adr/ADR-031-mainnet-deployment.md` — original deployment policy that this ADR operationalizes the missing pieces of.
- `docs/adr/ADR-036-external-audit.md` — audit engagement that produces the `AUDIT_REPORT_HASHES` file consumed here.
- `docs/adr/ADR-078-program-upgrade-authority-transfer.md` — devnet rehearsal, sealed rollback, per-program transfer order; this ADR enforces §5's mainnet prerequisites at script-invocation time.
- `docs/adr/ADR-079-operator-key-hygiene.md` — bright-line trigger for KMS/hardware migration; this ADR refuses to proceed without `MULTISIG_ADDRESS` so that the bright-line is not silently crossed.
- `docs/adr/ADR-013-anchor-031-upgrade.md` — toolchain pin (Anchor 0.31.1, Solana platform-tools v1.52) that makes auditor-vs-deployer hash parity reproducible.
- `scripts/mainnet-deploy.sh` — script implementing this ADR.
- `config/AUDIT_REPORT_HASHES` — committed hash file consumed by §2.
- `.github/workflows/shellcheck.yml` — CI gate per §7.
