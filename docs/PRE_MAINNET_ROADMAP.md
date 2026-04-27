# Pre-Mainnet Readiness Roadmap

**Date**: 2026-04-26 EOD
**Status**: Active
**Ownership**: agenomics-labs/core

This roadmap is the strategic plan for everything between "cycle-2 audit
corpus closed" (HEAD `9340852`) and "first `v*-mainnet` tag pushed
without the gate failing." It is **distinct from** `MAINNET_CHECKLIST.md`,
which is the per-item operational checklist the `mainnet-readiness.yml`
workflow gates on. This doc focuses on:

1. **Dependencies** — what blocks what.
2. **Parallelizable tracks** — what can run concurrently.
3. **Ownership** — who needs to drive each track.
4. **Cycle-2 → cycle-3 hand-off** — exactly what the audit corpus left
   open and where to start each item.

When this roadmap closes, every line in `MAINNET_CHECKLIST.md` should be
green and the only remaining gate is the GPG-signed tag itself.

---

## 1. Tracks at a glance

| Track | Theme | Blocks tag? | Can start now? | Owner |
|-------|-------|-------------|----------------|-------|
| **A. Hard gates** | What `mainnet-readiness.yml` rejects without | YES | A1 yes; A2 yes; A3 needs A1 | Lead Dev + Security |
| **B. Code/test gaps** | Cycle-3 follow-ups identified in cycle-2 audit | NO (but recommended) | All items yes | Core eng |
| **C. Operational readiness** | What you'll regret skipping in week 1 | NO (procedural) | All items yes | DevOps + Lead Dev |
| **D. Soak** | Devnet evidence the cycle-2 changes hold under load | NO (but checklist row) | Yes — runs continuously | DevOps |

A and D start immediately. B can run in parallel sessions / worktrees.
C is mostly people-coordination and documentation.

---

## 2. Track A — Hard gates (block tag)

### A1. External audit firm engagement → AUDIT_REPORT_HASHES

**Why it blocks**: `config/AUDIT_REPORT_HASHES` ships with all-zero
placeholders per ADR-080 §2. `scripts/mainnet-deploy.sh --self-test`
verifies the file is populated with non-zero SHA-256s before the deploy
script exits 0; the `mainnet-readiness.yml` workflow runs the self-test
on every `v*-mainnet` tag push.

**Concrete steps**:
1. Engage external audit firm (multi-week external blocker — start ASAP).
2. Audit firm produces signed report + artifact hashes for each program
   binary.
3. Populate `config/AUDIT_REPORT_HASHES` with `sha256(program.so)` per
   program, attributed to the auditor's signing key.
4. Run `scripts/mainnet-deploy.sh --self-test` locally and confirm
   exit 0.

**Status as of 2026-04-26**: Not started. Hashes are placeholder zeros.

**Cycle-3 entry**: Open the engagement contract. Track in
`docs/audits/AUDIT-STATUS-*.md` as it lands.

### A2. Squads multisig for the upgrade authority

**Why it matters**: A single-key upgrade authority is mainnet-disqualifying
for any non-trivial program. Per cycle-2 AUD-115, the upgrade authority
operationally equals `ProtocolConfig.authority` post-init, so the
multisig's *first* job is to sign `initialize_protocol_config`.

**Concrete steps**:
1. Decide multisig members and threshold (e.g., 3-of-5 of named
   maintainers).
2. Provision Squads (or Realms) with the chosen membership.
3. Each member generates their own keypair locally — **never share
   keys**.
4. Test the ceremony on devnet first: deploy a throwaway program,
   transfer upgrade authority to the multisig, run a no-op upgrade.
5. Document the ceremony script in `docs/MAINNET_DEPLOY_RUNBOOK.md`
   (see C1).

**Status**: Not started.

### A3. MAINNET_CHECKLIST.md walkthrough

**Why it blocks**: `mainnet-readiness.yml` (now hardened by AUD-309 +
AUD-400) fails any tag push if any row in `docs/MAINNET_CHECKLIST.md`
shows status `Pending|TBD|Partial|In Progress|InProgress|Blocked|WIP`
or any unchecked `- [ ]` task item.

**Concrete steps**:
1. Walk the 21 `| Pending |` rows + 14 unchecked task items with
   operators.
2. For each row: either mark `Done` with the closing artifact's link,
   or move to a separate `MAINNET_DEFERRED.md` with explicit rationale
   (the checklist gate enforces every row, so deferrals must be
   removed from the gated file).
3. Most rows depend on A1, A2, B-track, or C-track items. The
   walk-through is the **integration step** that ties this roadmap
   back to the gated checklist.

**Status**: Not started.

### A4. GPG signed-tag allowlist verification + dry-run procedure

**Why it blocks**: `mainnet-readiness.yml` step "Verify tag is GPG-signed"
(`.github/workflows/mainnet-readiness.yml:41-52`) is the very first
gate; if a maintainer pushes `v1.0.0-mainnet` and `git tag -v` returns
non-zero on the runner, no later gate (checklist parse, hash payload,
self-test) is even attempted. ADR-080 §1 + §H Alternative call out
"signed tag" as the protocol-level integrity primitive that binds the
on-chain artifact to a named human's signing key. Week-4's "signed
`v*-rc` tag against the workflow on a fork" item (§6) presupposes
that the maintainer's key is **already** accepted by the workflow.
That presupposition has not been verified.

**Finding (surface up-front)**: There is **no in-repo allowlist**.
Searches for `allowed-signers`, `ALLOWED_SIGNERS`, `*signers*`,
`*.gpg`, `gpg.ssh.allowedSignersFile`, and key-fingerprint constants
across `.github/`, `scripts/`, `config/` return zero results other
than the ADR-080 §1 comment in the workflow itself. The workflow
verification step is literally:

```yaml
# .github/workflows/mainnet-readiness.yml:41-52
- name: Verify tag is GPG-signed
  # Per ADR-080 §1: every mainnet-bound tag must be signed by a
  # maintainer key in the project's allowlist. `git tag -v`
  # exits non-zero if the signature is missing or invalid.
  run: |
    set -euo pipefail
    TAG="${GITHUB_REF#refs/tags/}"
    echo "Verifying tag: $TAG"
    if ! git tag -v "$TAG" 2>&1; then
      echo "::error::Tag $TAG ..."
      exit 1
    fi
```

`git tag -v` consults the runner's GPG keyring (or, for SSH-signed
tags, `gpg.ssh.allowedSignersFile`). The "allowlist" is therefore
**implicit** and equals "whichever keys happen to live in
`$GNUPGHOME` (or the runner's SSH allowed-signers file) on the
self-hosted Linux runner at the moment the job runs." There is no
fingerprint constant in the workflow YAML, no `.github/allowed-signers`
file, no separate config, no external action. The comment at line 43
("the project's allowlist") describes intended behavior, not
implemented behavior.

This is the classic "verify *some* signature exists" failure mode
the constraints flag. Specifically, today the gate is satisfied by:

1. Any GPG public key the runner-host operator has imported into the
   runner-account's keyring (`gpg --import`); **or**
2. Any SSH public key listed in the file referenced by
   `gpg.ssh.allowedSignersFile` in the runner's git config — note
   this is **not** set in any committed config (`.gitconfig`,
   `.git/config` are not in-repo); **or**
3. Nothing — `git tag -v` against a key the runner has never seen
   prints `gpg: Can't check signature: No public key` and exits
   non-zero. That is the de-facto allowlist mechanism: enrolment
   into the runner's keyring **is** the allowlist.

The runner-side keyring is operator state, not source-controlled,
not reviewable in a PR, and not auditable from the repo. It can be
mutated by anyone with shell access to the self-hosted runner host.

**Concrete steps** (verification + dry-run; do all before the §6
week-4 attempt):

1. **Make the allowlist explicit and source-controlled**. Two options;
   pick one as part of A4 closure:

   - **Option α (recommended)**: commit `.github/allowed-signers` (SSH
     allowed-signers format: `<principal> <ssh-key-type> <pubkey>`
     per line, one per maintainer) and amend the workflow's
     verification step to run
     `git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=.github/allowed-signers tag -v "$TAG"`.
     SSH-signed tags work natively with `git tag -s` since git 2.34
     and avoid the GPG-keyring-on-runner footgun. Membership changes
     go through PR review.
   - **Option β**: commit `.github/maintainer-gpg-keys/` containing
     ASCII-armored `*.asc` public keys, and amend the workflow with
     a pre-`git tag -v` step:
     `for k in .github/maintainer-gpg-keys/*.asc; do gpg --import "$k"; done`
     (then `git tag -v` consults a freshly-populated, ephemeral
     `$GNUPGHOME`). Membership changes go through PR review.

   Both options keep the allowlist in the repo, reviewable, and
   independent of runner-host state. Until one ships, items 2-4
   below are the best a maintainer can do.

2. **Maintainer key existence** (local). Confirm the key the
   maintainer intends to sign with actually exists and can sign:

   ```bash
   # Show the key git would use to sign tags right now.
   git config --get user.signingkey || echo "(unset — git falls back to user.email match)"

   # GPG path:
   gpg --list-secret-keys --keyid-format=long
   # Pick the long key ID (after `sec   rsa4096/`) and confirm it can sign:
   gpg --list-keys --with-fingerprint <KEYID>
   echo test | gpg --clearsign --local-user <KEYID> >/dev/null && echo OK

   # SSH path (git ≥ 2.34, gpg.format=ssh):
   git config --get gpg.format            # should be `ssh` if SSH-signing
   ssh-keygen -Y find-principals -s <(echo "test" | ssh-keygen -Y sign \
     -n git -f ~/.ssh/id_ed25519 /dev/stdin) \
     -f .github/allowed-signers   # only meaningful AFTER step 1 lands
   ```

3. **Key uploaded to GitHub for vigilant-mode**. Vigilant mode is
   what makes the `Verified` badge appear on github.com next to
   tags/commits; it does **not** affect the CI gate, but operators
   should expect both surfaces to be consistent.

   ```bash
   # Confirm the key is in the GitHub account's signing-keys list.
   gh api /user/gpg_keys --jq '.[] | {key_id, emails: [.emails[].email]}'
   # SSH-signing keys live separately:
   gh api /user/ssh_signing_keys --jq '.[] | {id, key, title}'
   # Vigilant-mode toggle is profile-level; check it via the web UI
   # at https://github.com/settings/security under "Vigilant mode".
   ```

4. **Key appears in the workflow allowlist exactly as the workflow
   checks it**. Until step 1 ships, this reduces to "the runner-host
   has imported the maintainer's public key." The maintainer (or a
   runner-host operator on their behalf) must:

   ```bash
   # On the self-hosted runner host, as the runner user
   # (typically `runner` or `actions`):
   sudo -u <runner-user> gpg --list-keys --with-fingerprint
   # Expected: the maintainer's key is listed. If not:
   sudo -u <runner-user> gpg --recv-keys <KEYID>     # if keyserver-published
   # OR
   gpg --export --armor <KEYID> | sudo -u <runner-user> gpg --import
   # Then trust:
   sudo -u <runner-user> gpg --edit-key <KEYID> trust quit  # set trust to 4 (full)
   ```

   After step 1 lands, this collapses to "the maintainer's pubkey
   appears in `.github/allowed-signers` (or
   `.github/maintainer-gpg-keys/`) on the tagged commit."

**Failure modes** — what the gate output looks like and how to
diagnose each:

| Symptom in workflow log | Root cause | Fix |
|-------------------------|------------|-----|
| `gpg: Can't check signature: No public key` then `error: could not verify the tag '<tag>'` | Maintainer's pubkey is not in the runner's keyring (or not in `.github/allowed-signers` post-Option-α). | Re-import on the runner host (step 4) **or** add the key to the in-repo allowlist via PR. |
| `gpg: Good signature from "<name>" [unknown]` then `error: could not verify the tag '<tag>'` | Key is imported but trust level is 0 or 1; `git tag -v` requires `[full]` or `[ultimate]` trust. | `gpg --edit-key <KEYID> trust` and set to 4 (full) on the runner. |
| `gpg: Good signature from "<name>" [full]` then **also** `gpg: WARNING: This key is not certified with a trusted signature!` then a non-zero exit | Tag was signed by a **subkey** whose master is in the keyring but the subkey itself is unknown. | Re-export the master key with all subkeys: `gpg --export --armor <MASTER-KEYID>` and re-import on the runner; do **not** re-export only the subkey. |
| `error: gpg failed to sign the data` (in a maintainer's local `git tag -s`, before push) | Local signing is broken; the tag never got created with a signature in the first place. | Fix `gpg-agent` / `pinentry` locally; redo `git tag -s -f`. (Note `-f` rewrites the local tag; re-push with `git push --tags --force` to the **fork**, never to the canonical repo.) |
| `error: object <sha> is a commit, not a tag` | Maintainer pushed a `lightweight` (commit-pointing) tag, not an `annotated+signed` tag. `git tag -v` only verifies annotated tags. | Always use `git tag -s -m "..." <name>` (signed implies annotated). Never `git tag <name>` alone. |
| `Verified` badge present on github.com but workflow still fails | Vigilant-mode and runner-keyring are independent. GitHub validated the signature against the account's uploaded keys; the runner has not. | Either Option-α/β from step 1, or import the same key on the runner (step 4). |

Note especially the third row (subkey vs master): GitHub vigilant-mode
typically validates against the master (because the master is what
the user uploaded), but `git tag -v` on a runner with only the master
imported will warn-then-fail when the tag is signed by a subkey the
runner has never seen. This is the most common "key on GitHub but
commit attestation mismatch" mode.

**Dry-run procedure for `v*-rc` tag against a fork**:

The workflow uses `runs-on: [self-hosted, linux]` (line 32) and
fires on `push` of any tag matching `v*-mainnet` (lines 21-23 — note
the suffix is `-mainnet`, **not** `-rc`). On a vanilla fork:

- Self-hosted runners attached to `agenomics-labs/protocol` are
  **not** available to a fork; the job will queue forever (no
  runner). A fork must either (a) attach its own self-hosted
  runner, or (b) re-target the workflow to `ubuntu-latest`.
- The tag glob is `v*-mainnet`. A `v*-rc` tag (as §6 week-4
  proposes) **will not trigger the workflow**. Either rename the
  glob temporarily on the fork, or push `v0.0.0-rc-mainnet` (which
  matches the glob).

Step-by-step, doing the minimum-mutation dry-run:

1. **Fork**: `gh repo fork agenomics-labs/protocol --clone --remote`.
   Push from a feature branch, never to the fork's `main`.
2. **Re-target the workflow on the fork**. In a branch on the fork:
   - `runs-on: [self-hosted, linux]` → `runs-on: ubuntu-latest`
     (single-line edit in `.github/workflows/mainnet-readiness.yml`).
   - The tag glob (`v*-mainnet`) can stay; we will name the dry-run
     tag accordingly.
   - Commit + push the branch to the fork. **Do not open a PR back
     to the canonical repo with these edits.**
3. **Pre-populate the runner's gate inputs** so we test the *signed-tag*
   gate, not a downstream gate:
   - Make sure `docs/MAINNET_CHECKLIST.md` on the fork branch has
     all rows resolved (or, for dry-run only, replace the file with
     a single-row checklist marked `Done`).
   - Replace `config/AUDIT_REPORT_HASHES` placeholder zeros with
     three syntactically valid (but fake) SHA-256s — three lines of
     `<64 random hex>  target/deploy/<name>.so`. This passes the
     payload check; the binaries will not exist, but the workflow
     does not run `sha256sum --check` (only the script's own
     `--self-test` does, and that bypasses the binary check —
     `mainnet-deploy.sh` self-test only verifies file shape, not
     binary contents).
4. **Sign and push the dry-run tag on the fork**:
   ```bash
   # On the fork branch, with the maintainer's signing key configured:
   git tag -s v0.0.0-dryrun-mainnet -m "A4 dry-run; do not deploy"
   git tag -v v0.0.0-dryrun-mainnet   # local sanity check first
   git push origin v0.0.0-dryrun-mainnet
   ```
5. **Observe the workflow run**:
   `gh run watch --repo <fork-org>/protocol`. Step "Verify tag is
   GPG-signed" should pass iff the runner has the maintainer's key.
   If it fails, the failure-modes table above is the diagnostic
   reference.
6. **Roll back on the fork**:
   ```bash
   git push origin :refs/tags/v0.0.0-dryrun-mainnet   # delete remote tag
   git tag -d v0.0.0-dryrun-mainnet                    # delete local tag
   gh run delete <run-id> --repo <fork-org>/protocol   # optional: clean run history
   ```
   The canonical repo's tag namespace is untouched at every step:
   the dry-run tag was only ever pushed to the fork's `origin`.

**Alternatives if the fork has no self-hosted runner and re-targeting
is undesirable**:

- `act` locally: `act push -W .github/workflows/mainnet-readiness.yml -e <event.json>`.
  Caveat: `act` runs in a container without the maintainer's GPG
  keyring by default; you must mount `~/.gnupg` and re-import.
- A throwaway repo (not a fork) with the workflow copied verbatim
  and `runs-on: ubuntu-latest`. Loses the "exact same workflow file
  as canonical" guarantee, but avoids touching the fork.

**Open questions** (block A4 closure):

- **Q1**: Adopt Option α (SSH allowed-signers) or Option β (GPG
  pubkeys in `.github/`)? Recommendation is α; SSH-signed tags
  are simpler to operate and the allowed-signers file is reviewable
  as plain text. Decision blocks the workflow amendment PR.
- **Q2**: Who are the maintainers entitled to sign? Cross-reference
  with A2's multisig membership decision — they may be the same
  set, but they need **not** be (a maintainer can sign code without
  holding a multisig seat, and vice-versa).
- **Q3**: Until Option α/β ships, who is the runner-host operator
  responsible for the `gpg --import` step on the self-hosted
  runner? Today this is undocumented operator state.
- **Q4**: Does the GitHub-Verified-badge surface need to be kept
  in lockstep with the workflow allowlist? Recommendation: yes, so
  that "Verified on github.com" implies "would pass the gate." The
  procedure above (step 3 + Option α) achieves this if the same
  pubkey is uploaded to GitHub and committed to the in-repo
  allowed-signers.

**Status as of 2026-04-26**: Not started. Workflow gate exists and
fires; the allowlist it consults is implicit runner-host state. The
A4 closure deliverable is (a) a chosen Option α/β, (b) the in-repo
allowlist file populated with the agreed maintainer keys, (c) a
PR amending `mainnet-readiness.yml` to consult it, (d) a successful
dry-run on a fork per the procedure above.

---

## 3. Track B — Code/test gaps (parallelizable)

Each B-item is a discrete PR. They can be worked in parallel sessions
or worktrees. The numbering is roughly priority order, not dependency
order — every B-item is independent.

### B1. ADR-124 implementation — vault `agent_identity` proof-of-control (AUD-116 path-a)

**Why**: Cycle-2 closed AUD-116 via the audit's path-(b) (threat-model
documentation). Path-(a) is an Ed25519 sig-at-init flow that closes the
init-mis-bind seam at the protocol level. Concrete code-level design is
already written in `docs/adr/ADR-124-vault-agent-identity-proof-of-control.md`.

**Scope**: ~half-day focused work.
- New `verify_ed25519_precompile` helper in `agent-vault/src/lib.rs`
  (byte-for-byte mirror of `agent-registry::manifest`).
- New `VAULT_IDENTITY_BIND_DOMAIN` constant + message-construction helper.
- New `instructions_sysvar` field in `InitializeVault` context.
- New `agent_identity_signature: [u8; 64]` parameter on
  `initialize_vault`.
- 2 new error variants.
- ~9 test call-site updates in `tests/agent-vault.ts` + mcp-server
  handler updates + SDK helper.

**Why now**: If any launch agents will hold meaningful balances day-1,
the init-mis-bind window is real. Ship while the audit context is fresh.

### B2. AUD-206 — `verify_protocol_invariants` MCP-tool wrapper

**Why**: Cycle-2 closed it as a deferred governance-tooling gap. Today
the only way to invoke `verify_protocol_invariants` is raw Anchor RPC
by the upgrade-authority signer. Operators will want a typed tool.

**Scope**: New `actions/governance.ts` action handler + tool definition
+ capability gate (`gov:invariant:check` or similar). Bounded by the
AUD-106 16-account batch cap.

### B3. `migrate_agent_profile` end-to-end integration test

**Why**: AUD-101 fixed the seeds bug (Critical) but the integration
test surface is thin. The migration choreography in DESIGN-DECISIONS
§ "Ship sequence" item 4 is load-bearing for legacy-profile cleanup.

**Scope**: One TS test at `tests/agent-registry.ts`. Set up a legacy
profile (skip `init` and write the pre-AUD-007 layout directly), call
`migrate_agent_profile`, verify post-state matches a freshly-registered
profile.

### B4. AUD-117 seeds integration test

**Why**: AUD-117 layered seeds-program defense-in-depth at the
Settlement boundary across 4 contexts. Today only the build verifies
the constraints; no integration test exercises a wrong-account
substitution attack against `provider_profile` or
`provider_owner_nonce`.

**Scope**: Add 2-4 negative tests to `tests/cpi-failures.test.ts`
asserting `ConstraintSeeds` fires at the Settlement boundary (not the
Registry boundary).

### B5. AUD-108 reason-rejection end-to-end test

**Why**: The Rust unit test pins the predicate, but no integration
test sends `reason=200` through the full CPI to confirm the
`InvalidReputationReason` revert lands at the Registry.

**Scope**: One TS test calling `propose_reputation_delta` directly
with reason 200, asserting the typed error.

### B6. AUD-209 saturation regression test

**Why**: x402-relay now returns 503 on saturation; no test pins this.

**Scope**: One node:test case in `src/x402-relay/test/`. Mock 100k
unique signatures, attempt one more, assert 503.

### B7. AUD-105 deadline-boundary TS integration test

**Why**: Rust unit test pins the boundary; existing TS test at
`tests/settlement.ts:2350` polls until `now > deadline` and so still
triggers under the new strict guard, but doesn't exercise the
*equality* boundary specifically.

**Scope**: Add one case that polls until `now == deadline` and asserts
`accept_task` rejects with `DeadlinePassed`.

### B8. Fuzz harness (MAINNET_CHECKLIST.md ADR-021 row)

**Why**: Currently `Pending`. Solana program fuzzing via `trident` or
`honggfuzz`. Cheap insurance against the seam classes cycle-2 surfaced
(reason codes, status transitions, deadline boundary, reputation
deltas).

**Scope**: One-time setup ~1 day; ongoing CI integration ~half-day.
Target: 4-hour fuzz run pre-tag.

### B9. Load tests (MAINNET_CHECKLIST.md ADR-022 row)

**Why**: Currently `Pending`. Discovery + settlement under expected
launch throughput.

**Scope**: Devnet harness that fans out N concurrent register →
escrow → settle flows. Measure CU consumption, RPC error rate,
indexer event-ingest lag.

### B10. SDK-side reputation-score clamp helper (AUD-112 reciprocal)

**Why**: Cycle-2 AUD-112 documented the transitional read window
inline at `propose_reputation_delta`. The reciprocal — an SDK-side
clamp helper — is doc-only today; turn it into a real export from
`sdk/client`.

**Scope**: ~10 LoC. `export function clampReputationScore(raw: bigint): number`.

---

## 4. Track C — Operational readiness

### C1. `MAINNET_DEPLOY_RUNBOOK.md`

Single source-of-truth for the deploy ceremony. Sections:
- Pre-deploy checks (lockfile clean, IDL diff clean, audit hashes
  populated, multisig signers online).
- Per-program deploy order (registry → vault → settlement, given
  CPI dependencies).
- `initialize_protocol_config` ceremony (multisig signs, captures
  ProtocolConfig.authority).
- `verify_protocol_invariants` smoke run (16-account sample, confirm
  multisig flow).
- Rollback procedure.
- Day-1 monitoring checklist.

**Pulls in**: AUD-115 operational note, ADR-080 mainnet-deploy safety
mandates, ADR-122 mainnet-readiness CI gate.

### C2. Incident response playbook

- On-chain incident triage (program upgrade vs `update_protocol_config`
  vs operator runbook step).
- Multisig emergency rotation.
- Indexer DB recovery from cold backup.
- x402-relay saturation response (manual scale-out, ADR-117).

### C3. AUD-207 — split program IDs across clusters

**Scope**: Trivial code change (`sdk/idl/src/index.ts:9-25`); the work
is in **generating real mainnet keypairs** and getting them into Squads
ceremony as part of A2.

**Concrete**:
1. After A2 completes, Squads holds the keypairs.
2. Update IDL with the real mainnet pubkeys.
3. Snapshot per-cluster IDs in the SDK + dashboard.
4. Add a regression test: `assert MAINNET !== DEVNET !== LOCALNET` for
   every program ID.

### C4. Operator runbook for ProtocolConfig.authority entanglement (AUD-115)

The inline doc-comment lives at `verify_protocol_invariants`'s body.
Operators need it surfaced in a checked-by-them runbook before the
first invariant-sweep call. Either fold into C1 or its own doc.

### C5. Indexer redundancy + backfill plan

- Two-instance indexer with leader election OR cold-spare.
- Backup cadence for the indexer DB.
- Drill: kill primary, confirm secondary catches up from slot N.

### C6. x402-relay scale plan (ADR-117)

The current single-instance design tops out at ~30 sigs/sec sustained
(per AUD-209's bound). If launch throughput could exceed that, ship
the Redis-backed dedup BEFORE first paying customer.

---

## 5. Track D — Soak

### D1. Devnet smoke harness running continuously

`scripts/smoke-test-devnet.ts` running on a cron (every N minutes)
through the full lifecycle: register → vault init → escrow create →
submit → approve → propose_reputation_delta → expire/dispute. Pin
metrics:
- Time-to-finality per ix.
- RPC error rate.
- Indexer event-ingest lag.

**Recommended duration**: 2 weeks before first `v*-mainnet` tag.
Anything that drifts in 2 weeks of devnet would also drift in 2 weeks
of mainnet — better to find it now.

### D2. Migration-choreography rehearsal

Run `migrate_agent_profile` against a population of legacy-state
profiles on devnet. Confirm B3's E2E test holds at scale (16 accounts
per `verify_protocol_invariants` batch, multiple batches).

---

## 6. Recommended ordering

If you've got 2-4 weeks before tag:

**Week 1**:
- A1 starts (audit firm engagement) — multi-week external
- A2 starts (multisig provisioning) — multi-week internal
- D1 starts running on devnet
- B1 (ADR-124) PR opened
- C1 doc starts (deploy runbook)

**Week 2**:
- A2 completes; C3 (real mainnet IDs) lands
- B3, B4, B5, B6, B7 ship in parallel sessions/worktrees
- B8 (fuzz) starts
- C5 (indexer redundancy) drilled

**Week 3**:
- A1 completes; A3 walkthrough fills in the checklist
- B9 (load tests) runs
- C2, C4 docs land
- D2 (migration rehearsal)

**Week 4**:
- Final dry-run: signed `v*-rc` tag against the workflow on a fork.
  Confirm `mainnet-readiness.yml` passes end-to-end.
- Squads ceremony walk-through on devnet.
- First `v*-mainnet` tag.

---

## 7. Cycle-2 closure pointers (where each item came from)

This roadmap consumes the cycle-2 audit corpus. Closure-status sections
are authoritative for any "what's already done?" question:

- `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-onchain.md` §"Closure status"
  — 24/24 closed (AUD-100..AUD-122 + AUD-044). AUD-116 path-(b) closed;
  path-(a) tracked in ADR-124 (Track B1 above).
- `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-offchain.md` §6 "Closure
  status" — 13/14 closed. AUD-207 is Track C3 above.
- `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-tests-ci.md` §6/§7 — 100%.
- `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-adr.md` — 100%.
- `docs/audits/ARCHITECTURE-AUDIT-2026-04-25.md` — closure-status pointer
  to `AUDIT-STATUS-2026-04-25.md` as canonical.

ADRs landed during cycle-2 (referenced by tracks):
- ADR-114 — Dependabot dependency hygiene (covers github-actions
  ecosystem; auto-bumps the SHAs from AUD-406 weekly).
- ADR-115 — CI blocking-security-gates (the blocking surface this
  roadmap delivers against).
- ADR-122 — Mainnet readiness CI gate (the workflow A1/A3 must satisfy).
- ADR-123 — Self-hosted runner action-cache hardening (AUD-406; CI
  flake mitigation).
- ADR-124 — Vault `agent_identity` proof-of-control (AUD-116 path-(a)).

---

## 8. Open questions to resolve before Week 1

These need owners before kicking off:

1. **Audit firm**: who, by when. Negotiate scope to include the cycle-2
   diffs (last ~30 commits to `programs/`).
2. **Multisig membership + threshold**: who, what threshold.
3. **Launch throughput estimate**: drives whether C6 (x402-relay scale)
   is week-1 work or week-3 work.
4. **Initial agents at launch**: drives whether B1 (ADR-124) is week-1
   work or week-3 work — high-balance launch agents make it week-1.
5. **Indexer SLO**: drives C5 (single-instance vs HA pair).

Resolve these in the Week-0 kickoff before spawning parallel sessions.
