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

| Track | Theme | Blocks tag? | Status as of 2026-04-27 | Owner |
|-------|-------|-------------|------------------------|-------|
| **A. Hard gates** | What `mainnet-readiness.yml` rejects without | YES | A4 + A5 done; A1/A2/A3 external/operational | Lead Dev + Security |
| **B. Code/test gaps** | Cycle-3 follow-ups identified in cycle-2 audit | NO (but recommended) | **11/11 launch-blocker items done**; B12 EVO design landed (post-launch impl); B9 + B12 are Phase-1-shipped with Phase-2/3 plans | Core eng |
| **C. Operational readiness** | What you'll regret skipping in week 1 | NO (procedural) | C1 + C2 + C4 done (with ADR-126 + ADR-127); C3 gated on A2; C5 in flight (ADR-127/128); C6 design landed (ADR-126) | DevOps + Lead Dev |
| **D. Soak** | Devnet evidence the cycle-2 changes hold under load | NO (but checklist row) | Open — runs continuously when started | DevOps |

A1/A2/A3 + D start in operator hands. The B-track is essentially
closed; the C-track is on its second pass with most documentation
landed and the remaining items waiting on either operator decisions
(C3) or implementation PRs against landed designs (C5/C6).

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

**Status as of 2026-04-26**: Schema-level gap closed by A5 (this
section). Workflow gate exists and fires; the allowlist it consults
is now the source-controlled `.github/allowed-signers` file, not
runner-host state. Deliverables (a) Option α chosen, (c) workflow +
script consult the in-repo file are landed; (b) populating the file
with real maintainer keys is gated on the A2 multisig provisioning
ceremony, and (d) the fork dry-run can run against the post-A5
workflow once a maintainer key is on the allowlist (the post-A5
gate now fails closed against the placeholder lines, so the
dry-run with a sentinel allowlist exercises the rejection path —
exactly the test ADR-080 §H Alt-D advocates for the hash gate).

### A5. Source-controlled SSH allowed-signers (closes A4 schema gap)

**Why it matters**: A4 surfaced that the `git tag -v` step at
`.github/workflows/mainnet-readiness.yml:41-52` consulted the
self-hosted runner's GPG keyring rather than any source-controlled
allowlist — the de-facto allowlist was operator state, not a
reviewable PR diff. Same gap script-side at
`scripts/mainnet-deploy.sh`'s `preflight_signed_tag`. A5 turns the
allowlist into a real file in the repo so adding or removing a
maintainer signing key is a reviewable PR change.

**Mechanism (Option α from A4)**: SSH-signed tags via git's native
`gpg.format=ssh` + `gpg.ssh.allowedSignersFile=…` pair. Chosen over
Option β (committed GPG `*.asc` keyrings) because (i) A4 explicitly
recommends α, (ii) the SSH allowed-signers format is plain text,
diff-reviewable, and human-auditable in PR; (iii) git ≥ 2.34
verifies SSH-signed tags natively — no extra `gpg --import` step,
no transient `$GNUPGHOME`, no runner-keyring side effects;
(iv) ADR-080 §H Alternative E confirms `git tag -v` works with
either signing flavor, so the choice is operational rather than
mandate-altering. ADR-080 §1's signed-tag mandate is unchanged.

**Where the file lives**: `.github/allowed-signers`. Path matches
A4's literal recommendation, colocates the allowlist with the
workflow that consumes it (per the `.github/` convention for
repo-policy/CI metadata), and parallels `config/AUDIT_REPORT_HASHES`'s
role-based location: machine-consumed `sha256sum --check` payload
lives under `config/`, machine-consumed CI/policy artifacts live
under `.github/`.

**File format**: Standard `ssh-keygen` allowed-signers format
(`man 1 ssh-keygen`, "ALLOWED SIGNERS" section). One entry per line:

```
<principal> [namespaces="git"] <ssh-key-type> <base64-pubkey> [comment]
```

Lines beginning with `#` and blank lines are ignored. The
`namespaces="git"` qualifier is recommended (least-privilege —
restricts the key to git signatures only).

**Workflow change** (`.github/workflows/mainnet-readiness.yml`): two
sequential steps replace the pre-A5 single "Verify tag is GPG-signed"
step.

1. **Verify allowed-signers file is populated** — mirrors the
   `AUDIT_REPORT_HASHES` placeholder-rejection gate. The file is
   refused if absent, empty, or carrying any line whose principal
   begins with `TODO_PLACEHOLDER_`.
2. **Verify tag signature against in-repo allowlist** — runs
   `git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$GITHUB_WORKSPACE/.github/allowed-signers" tag -v "$TAG"`.
   Tags signed by a key not on the in-repo allowlist fail this gate
   even if the runner happens to have the key in its keyring.

**Script change** (`scripts/mainnet-deploy.sh`): a new
`preflight_allowed_signers` gate (placeholder-rejection, identical
semantics to `preflight_audit_hashes`) runs before the existing
`preflight_signed_tag` gate, which now invokes
`git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=…` so the
script and the workflow consult the same file via the same
mechanism. The `--self-test` surface is extended to assert the
allowlist file exists and that every non-comment line parses as a
well-formed SSH allowed-signers entry; non-placeholder content is
NOT required at self-test time, exactly as `AUDIT_REPORT_HASHES`
shape-vs-content is split between self-test and preflight.

**Lifecycle (mirrors `AUDIT_REPORT_HASHES`)**:

1. The file ships with two `TODO_PLACEHOLDER_maintainer_*` sentinel
   lines using an all-zeros base64 SSH-Ed25519 blob (the SSH-key
   analogue of the all-zero SHA-256 sentinel in
   `AUDIT_REPORT_HASHES`). Workflow + script both fail closed
   against any line whose principal begins with `TODO_PLACEHOLDER_`,
   so the `v*-mainnet` gate is unsatisfiable until real keys are
   populated. Devnet rehearsals (`AEP_DEPLOY_DRY_RUN=1`) skip
   `preflight_signed_tag` itself but still run
   `preflight_allowed_signers`, so the placeholder-rejection path is
   exercised on every rehearsal — exactly the property ADR-080 §H
   Alt-D defends for the hash gate.
2. The A2 multisig provisioning ceremony decides which maintainers
   are entitled to sign mainnet tags (note A4 Q2: the maintainer
   set entitled to *sign code* need not be identical to the multisig
   membership entitled to *hold upgrade authority* — they are two
   separate authorization surfaces).
3. Each entitled maintainer generates an Ed25519 SSH signing key
   locally:

   ```bash
   ssh-keygen -t ed25519 -C "<principal>" -f ~/.ssh/<name>_signing_ed25519
   git config --global gpg.format ssh
   git config --global user.signingkey ~/.ssh/<name>_signing_ed25519.pub
   ```

   …and uploads the public key to GitHub at
   Settings → SSH and GPG keys → "New SSH key" with key type
   "Signing Key" so the github.com `Verified` badge surface stays in
   lockstep with the workflow gate (closes A4 Q4).
4. A maintainer opens a PR adding one line per new key to
   `.github/allowed-signers`, removing the corresponding
   `TODO_PLACEHOLDER_` line in the same PR. PR title format:
   `feat(security): A5 enroll <key-holder> SSH signing key`. One
   key per PR, never amended after merge.
5. Rotation/revocation is a PR that removes the matching line. The
   next `v*-mainnet` tag push verifies against the post-removal
   allowlist; tags signed by the removed key fail closed at the
   workflow gate even if previously valid.

**Operator runbook for adding a maintainer key**:

```bash
# 1. Maintainer generates the SSH signing key locally.
ssh-keygen -t ed25519 -C "alice@agenomics-labs.maintainer" \
  -f ~/.ssh/alice_signing_ed25519

# 2. Maintainer configures git to sign with it (per-machine; do NOT
#    commit ~/.gitconfig).
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/alice_signing_ed25519.pub

# 3. Maintainer uploads the .pub to GitHub as a Signing Key
#    (Settings → SSH and GPG keys → New SSH key → key type = Signing Key).
#    Required so the github.com `Verified` badge matches the workflow gate.

# 4. Maintainer (or designate) opens a PR adding the public-key line to
#    .github/allowed-signers and removing one TODO_PLACEHOLDER_ line:
#       alice@agenomics-labs.maintainer namespaces="git" ssh-ed25519 AAAAC3...real-blob... alice
#    PR is reviewed by another maintainer (two-eyes principle).

# 5. Local sanity check before pushing the next v*-mainnet tag:
git -c gpg.format=ssh \
    -c gpg.ssh.allowedSignersFile=.github/allowed-signers \
    tag -v <some-test-tag-signed-by-alice>
```

**Operator runbook for revoking a key**: open a PR removing the
matching line from `.github/allowed-signers`. The next
`v*-mainnet` tag push is verified against the post-removal file;
tags signed under the revoked key fail closed at the workflow gate
even if the github.com `Verified` badge still appears for older
historical tags.

**Status**: Schema + enforcement landed. Real-key population is
gated on A2 (multisig provisioning + maintainer-set decision per
A4 Q2). Once A2 names the entitled signers and they each generate
their key per the runbook above, the `TODO_PLACEHOLDER_*` lines
are replaced by a sequence of one-key-per-PR enrollments and the
gate begins passing for tags signed by enrolled maintainers.

**Files touched**:

- `.github/allowed-signers` (new) — the source-controlled allowlist
  itself, shipped with `TODO_PLACEHOLDER_*` sentinels and a
  lifecycle header comment.
- `.github/workflows/mainnet-readiness.yml` — replaces the single
  `git tag -v` step with the two-step allowlist-then-verify pair
  described above.
- `scripts/mainnet-deploy.sh` — new `preflight_allowed_signers`
  gate; `preflight_signed_tag` rebound to the in-repo allowlist;
  self-test extended to verify the allowlist file's shape.

---

## 3. Track B — Code/test gaps (parallelizable)

Each B-item is a discrete PR. They can be worked in parallel sessions
or worktrees. The numbering is roughly priority order, not dependency
order — every B-item is independent.

### B1. ADR-124 implementation — vault `agent_identity` proof-of-control (AUD-116 path-a)

**Status**: **Done** (2026-04-26). ADR-124 status moved to `Accepted`
with the cycle-3 implementation note appended; on-chain helper +
off-chain SDK / mcp-server callers + 37 new tests across 4 surfaces all
landed in a single commit. `anchor test` 156 ✓ / 3 pending.

**Why**: Cycle-2 closed AUD-116 via the audit's path-(b) (threat-model
documentation). Path-(a) is an Ed25519 sig-at-init flow that closes the
init-mis-bind seam at the protocol level. Concrete code-level design is
already written in `docs/adr/ADR-124-vault-agent-identity-proof-of-control.md`.

**Scope** (as shipped):
- New `identity_bind::verify_ed25519_precompile` module in
  `programs/agent-vault/src/lib.rs` (byte-for-byte vendored from
  `agent-registry::manifest::verify_ed25519_precompile`; raises vault-side
  errors).
- New `VAULT_IDENTITY_BIND_DOMAIN = b"AEP_VAULT_IDENTITY_BIND_V1\x00"`
  constant + `vault_identity_bind_message(authority, agent_identity)`
  helper. Domain explicitly differs from the registry's
  `MANIFEST_HASH_DOMAIN` (cross-protocol replay defense pinned by unit
  test).
- New `instructions_sysvar` field on `InitializeVault` context
  (address-pinned to `sysvar::instructions::ID`).
- New `agent_identity_signature: [u8; 64]` parameter on
  `initialize_vault`.
- 2 new error variants: `MissingAgentIdentityBindSignature`,
  `AgentIdentityBindSignatureMismatch`.
- 11 `initializeVault` call-sites in `tests/agent-vault.ts` updated via
  a new `initVaultWithBindProof()` helper; 4 net-new on-chain tests
  (happy + 3 negatives).
- `mcp-server` handler / action / tool wiring (self-bind + operator-
  managed flows) + 17 new schema/capability tests.
- `sdk/client` `vaultIdentityBindMessage` /
  `buildVaultIdentityBindInstruction` helpers + 12 new SDK tests.

**Closing artifact**: see `docs/adr/ADR-124-vault-agent-identity-proof-of-control.md` §"Implementation Notes (cycle-3 closure)".

**Why now**: If any launch agents will hold meaningful balances day-1,
the init-mis-bind window is real. Ship while the audit context is fresh.

### B2. AUD-206 — `verify_protocol_invariants` MCP-tool wrapper

**Status**: **Done** (2026-04-26, commit `e9de93e`). New
`mcp-server/src/actions/governance.ts` + `tools/governance.ts` with
`gov:invariant:check` capability gate; schema-level enforcement of the
AUD-106 16-account batch cap. 18 unit tests, 202 → 203 mcp-server suite
passing (later 214/0 after AUD-211 follow-up).

**Why**: Cycle-2 closed it as a deferred governance-tooling gap. Today
the only way to invoke `verify_protocol_invariants` is raw Anchor RPC
by the upgrade-authority signer. Operators will want a typed tool.

**Scope** (as shipped): new `actions/governance.ts` action handler +
tool definition + capability gate (`gov:invariant:check`). Bounded by
the AUD-106 16-account batch cap (enforced at the zod schema layer +
mirrored on the JSON schema for MCP clients).

### B3. `migrate_agent_profile` end-to-end integration test

**Status**: **Done** (2026-04-26, commit `7704fa7`). 7 reachable paths
covered: regression sentinel, idempotency, backward-target no-op,
post-mig ≡ fresh-register equivalence, cross-account-reuse rejection,
authority gate, AgentMigrated event emission. Two normalization branches
(reputation_score clamp on legacy out-of-range state; Suspended →
slash_count = 3 invariant restoration) remain TS-uncovered — the
`solana-test-validator` harness has no `setAccount` to seed legacy state;
covered by Rust unit tests in `programs/agent-registry/src/lib.rs::tests`.
Bankrun harness adoption tracked separately (scheduled investigation
`trig_01NokXSDGAb7ECabM5n9ULR3` to fire 2026-05-10).

**Why**: AUD-101 fixed the seeds bug (Critical) but the integration
test surface is thin. The migration choreography in DESIGN-DECISIONS
§ "Ship sequence" item 4 is load-bearing for legacy-profile cleanup.

**Scope**: One TS test at `tests/agent-registry.ts`. Set up a legacy
profile (skip `init` and write the pre-AUD-007 layout directly), call
`migrate_agent_profile`, verify post-state matches a freshly-registered
profile.

### B4. AUD-117 seeds integration test

**Status**: **Done** (2026-04-26, commit `e4b3213`). 4 active negative
tests + 1 documented `it.skip` (ResolveDisputeTimeout — gated by 7-day
governance-controlled `dispute_timeout_seconds`, no test override; same
bankrun blocker as B3). Boundary discrimination via Anchor invoke-depth
log scan (asserts depth-1 Settlement invoke present, depth-2 Registry
invoke absent — pre-AUD-117 the failure was at depth 2).

**Why**: AUD-117 layered seeds-program defense-in-depth at the
Settlement boundary across 4 contexts. Today only the build verifies
the constraints; no integration test exercises a wrong-account
substitution attack against `provider_profile` or
`provider_owner_nonce`.

**Scope**: Add 2-4 negative tests to `tests/cpi-failures.test.ts`
asserting `ConstraintSeeds` fires at the Settlement boundary (not the
Registry boundary).

### B5. AUD-108 reason-rejection end-to-end test

**Status**: **Done** (2026-04-26, commit `738ae88`). Pivot during
implementation: AUD-108's `require!(reason ≤ 2)` sits behind
`settlement_authority`'s `signer + seeds::program = SETTLEMENT_PROGRAM_ID`
constraint. From a TS direct call, `invoke_signed` is cryptographically
infeasible, so calls fail at web3.js's "unknown signer" client layer
before reaching the wire. Settlement's CPI helper hardcodes
`reason ∈ {0,1,2}` (AUD-109/113), so no Settlement-driven attack vector
either. Tests pin (a) IDL contract code 6028 + canonical message,
(b) boundary refusal of `reason=200`, (c) signer-constraint elimination
(same call shape with valid `reason=0` ALSO fails identically — proves
AUD-108 isn't the firing gate from TS). Same shape as
`tests/cpi-failures.test.ts` Case 4 (spoofed settlement_authority).

**Why**: The Rust unit test pins the predicate, but no integration
test sends `reason=200` through the full CPI to confirm the
`InvalidReputationReason` revert lands at the Registry.

**Scope**: One TS test calling `propose_reputation_delta` directly
with reason 200, asserting the typed error.

### B6. AUD-209 saturation regression test

**Status**: **Done** (2026-04-26, commit `b59ef6c`). One unit test pins
`processPaymentRequest` returning `kind: "saturated"` at cap. HTTP-level
test intentionally omitted: saturation is checked POST-RPC, and the
relay does not expose a verifier-injection seam — adding one purely for
test mocking would expand the production surface beyond AUD-209's
contract. Three small production-code touches required for in-process
testing (documented inline): `.unref()` on two cleanup intervals + new
`__fillRedemptionStateForTests` hook mirroring the existing AUD-208
`__resetRedemptionStateForTests` pattern. 7/7 suite green.

**Why**: x402-relay now returns 503 on saturation; no test pins this.

**Scope**: One node:test case in `src/x402-relay/test/`. Mock 100k
unique signatures, attempt one more, assert 503.

### B7. AUD-105 deadline-boundary TS integration test

**Status**: **Done** (2026-04-26, commit `81cb8f4`). `getBlockTime`
polling strategy with 3s deadline headroom — `Clock::get()?.unix_timestamp`
is in seconds while slots tick every ~400ms, so each integer second
spans 2-3 slots (~800-1200ms window) of high-probability landing on
literal `now == deadline`. Both validation runs hit literal equality
(`pre-tx == post-tx == deadline`); test logs the equality-case
diagnostic so future runs can detect "boundary still reachable" drift.
Non-flaky by design: even on the slip case (`T+1`), the strict-`<`
guard still rejects with `DeadlinePassed`. Bankrun adoption (with
`warp_to_slot`) would yield a cleaner fixture; tracked as a separate
investigation.

**Why**: Rust unit test pins the boundary; existing TS test at
`tests/settlement.ts:2350` polls until `now > deadline` and so still
triggers under the new strict guard, but doesn't exercise the
*equality* boundary specifically.

**Scope**: Add one case that polls until `now == deadline` and asserts
`accept_task` rejects with `DeadlinePassed`.

### B8. Fuzz harness (MAINNET_CHECKLIST.md ADR-021 row)

**Status**: **Phase 1 Done** (2026-04-27, commit `e084713`). New `fuzz/`
crate with honggfuzz-rs harness + first target:
`propose_reputation_delta`. Pivoted from trident (CLI requires
`pkg-config + libssl-dev` system packages, not installable without
root); Anchor-0.31.1 compat itself was fine. Smoke validation: 1M
deterministic-sweep iterations through the handler model + full
property contract, 0 crashes. fuzz/ is a standalone Cargo workspace
excluded from the on-chain workspace so `anchor build` / `cargo test
-p agent-registry` are unaffected. README documents Phase 2 (more
targets — `update_status` accept-list AUD-120, Settlement CPI seam,
seeds-validating contexts AUD-117, `clear_suspension` AUD-004) and
Phase 3 (`.github/workflows/fuzz-pre-tag.yml` 4-hour campaigns on
tag-creation events). Trident retry checklist captured for the
operator-with-sudo flow.

**Why**: Currently `Pending`. Solana program fuzzing via `trident` or
`honggfuzz`. Cheap insurance against the seam classes cycle-2 surfaced
(reason codes, status transitions, deadline boundary, reputation
deltas).

**Scope**: One-time setup ~1 day; ongoing CI integration ~half-day.
Target: 4-hour fuzz run pre-tag.

### B9. Load tests (MAINNET_CHECKLIST.md ADR-022 row)

**Status**: **Phase 1 Done** (2026-04-27, commit `4b7f2b2`). New `load/`
crate at repo root (standalone tsx harness, no heavy external deps —
no k6/artillery/autocannon). Phase 1 ships:
- 9-ix full-lifecycle scenario: register × 2 → vault init × 2 (with
  ADR-124 ed25519 precompile sibling ix consumed from B1) → SPL mint
  setup → create_escrow → accept_task → submit_milestone →
  approve_milestone (CPI Registry::update_provider_reputation)
- Per-ix latency (p50/p95/p99) + CU samples + 7-class RPC error
  taxonomy + indexer-lag query against `src/indexer/`'s cursor table
- JSON results schema documented in `load/README.md`
- Smoke validation: 4/4 flows green in 12.5s on local validator,
  all 7 error buckets at 0

`propose_reputation_delta` not exercised directly — its
`settlement_authority` slot is `invoke_signed`-gated, so direct TS
calls fail at the web3.js client layer (cycle-2 AUD-108 boundary;
same finding as B5). Settlement CPI path gives the more representative
load shape anyway.

Phase 2: more scenarios (settlement-only, dispute-flow, expiry-flow,
vault-spending, reputation-only) + library expansion
(hdr-histogram-js for streaming percentile compression at long-campaign
scale, prom-client for live export). Phase 3: `.github/workflows/load-pre-tag.yml`
self-hosted-runner workflow with baseline-comparison; flips
MAINNET_CHECKLIST ADR-022 row Pending → Done. Operator-triggered,
not per-PR.

**B8 sibling note**: B8 fuzz harness is on the same Phase-2-incremental
path. As of 2026-04-27, three Phase 2 targets shipped:
- `update_status` AUD-120 accept-list (commit `1cfe779`) — 131,072-iter
  exhaustive sweep, 0 crashes
- `clear_suspension` AUD-004 escalation ladder (commit `9ea7385`) —
  2,359,296-iter sweep across `(status × cleared × slash × score)`,
  0 crashes; pinned the 4 lockstep ladder sites + AUD-118 saturating-
  add at u8::MAX path
Two remaining Phase 2 targets: `update_provider_reputation` Settlement
CPI seam, AUD-117 seeds.

**B9 sibling note**: B9 settlement-only steady-state scenario landed
(commit `0b7a69f`). New `AgentPool` with single-writer-per-pair
nonce tracking + just-in-time top-ups; pool-reuse density gain ~2.4x
vs Phase 1 per-flow provisioning. Stresses post-AUD-117 seeds +
AUD-209 saturation simultaneously. Four Phase 2 scenarios remaining:
dispute-flow, expiry-flow, vault-spending, reputation-only.

**Why**: Currently `Pending`. Discovery + settlement under expected
launch throughput.

**Scope**: Devnet harness that fans out N concurrent register →
escrow → settle flows. Measure CU consumption, RPC error rate,
indexer event-ingest lag.

### B10. SDK-side reputation-score clamp helper (AUD-112 reciprocal)

**Status**: **Done** (2026-04-26, commit `946d3bb`). Clamp range is
`[0, 100]` (sourced from on-chain `MAX_REPUTATION_SCORE: u8 = 100`,
not the `0..1000` originally guessed). 10 unit assertions including
edge cases (`u64::MAX` precision-safety clamp, `Number.MAX_SAFE_INTEGER + 1`,
exact-bound assertions). 21 → 29 SDK suite passing.

**Why**: Cycle-2 AUD-112 documented the transitional read window
inline at `propose_reputation_delta`. The reciprocal — an SDK-side
clamp helper — is doc-only today; turn it into a real export from
`sdk/client`.

**Scope**: ~10 LoC. `export function clampReputationScore(raw: bigint): number`.

### B12. EVO as agent-memory backbone (Phase 1 + Phase 2 shipped)

**Status**: **Phase 1 + Phase 2 shipped** (2026-04-27, commits
`ef6c7b9` design + `db52117` Phase 1 read-path + `908bc58` Phase 2
write-path learn loop).

**Phase 2 (commit `908bc58`)**: write-path `learn` call wired into
three settlement handlers — `handleApproveMilestone` (kind
`task_completed`, score 1.0), `handleResolveDispute` (`dispute_won`
or `dispute_lost` based on provider payout, score 0.7/0.0),
`handleResolveDisputeTimeout` (`dispute_lost`, score 0.0). Each
wrapped in best-effort try/catch so EVO failures NEVER mutate parent
ix success — same posture as Phase 1's observe wiring.
`AgentMemoryFacade.recordOutcome` does observe-then-learn (rich
metadata via `evo_observe` + strict `{task_id, score, success}` via
`evo_learn` matching EVO's `additionalProperties: false` schema).
On-chain reason mapping mirrors AUD-109/113 (0/1/1/2). 21 new tests
across 7 suites; full mcp-server suite 287/287 green. The
`write:agent-memory` capability declared in Phase 1 is correctly NOT
consumed directly — settlement actions inherit auth from existing
`sign:settlement + sign:cross_program:settlement+registry` caps; EVO
learn is a side effect of the parent ix.
ADR-129 (`docs/adr/ADR-129-evo-agent-memory-integration.md`,
634 lines, Status: Proposed) scopes the integration concretely:

- **Phase 1 first integration** (shipped 2026-04-27, commit `db52117`):
  new read-only `find_similar_agents` MCP action backed by EVO L1
  HNSW retrieval (capability-gated by `read:agent-memory`) +
  fire-and-forget `observe` post-`handleRegisterAgent` success.
  Subprocess transport via `child_process.spawn(binary, ['--json',
  '--db', dbPath])` — no NAPI surface in EVO's package.json today;
  lazy spawn on first call. `AEP_EVO_ENABLED` kill-switch defaults
  to OFF (`DisabledEvoClient` no-op); when ON, misconfig throws
  `EvoBridgeMisconfigError` at module load (AUD-027 fail-fast
  precedent). `find_similar_agents` returns `{ skipped: true,
  reason: "evo-disabled" }` when bridge disabled — degraded-feature,
  not error. 35 new tests in 9 suites; full mcp-server suite 266/0.
  Failure modes bounded to "no similarity results returned," NEVER
  "register_agent fails" — observe is wrapped in try/catch, errors
  swallowed at WARN level. The retrieval-result parser is
  intentionally tolerant (accepts `result.results | result.hits |
  bare array`; tolerates `score|similarity` and `content|text`)
  so future EVO schema reconciliation doesn't break the bridge.
- **Phase 2** (after EVO sustained-load observation): write-path
  `learn` loop on milestone outcomes; reputation-trajectory recall.
- **Phase 3**: operator-query MCP tools for cross-session agent
  history.
- **EVO maturity**: Phase 1 viable now per EVO's `CLAUDE.md`
  §"EVO Development Status" — 657 tests green, built release binary,
  8 production MCP tools at `EVO/src/mcp/tools.ts`. No EVO changes
  required.
- **Runner-up**: pgvector on ADR-128's PG instance. Loses on
  three counts (no surprise-gate / economics / L2 Bayesian
  reliability — would re-implement everything; load co-location
  with OLTP that ADR-128 §C5 explicitly avoided; no L2 strategy
  layer for Phase 2's reasoning-bank value). Documented as the
  degraded fallback if EVO adoption is later judged operationally
  untenable.

**Why deferred from launch**: not a tag-blocker. The indexer's
queryable-state contract is satisfied by ADR-128. EVO adoption is
about expanding agent-side capability, not closing a security or
correctness gap. Implementation PR is a post-launch cycle-3+ task.

**Companion ADR (future)**: EVO as a *semantic-search layer over*
the PostgreSQL indexer — PG stays as system-of-record; EVO ingests
a derived embedding projection for "find similar disputes" / "rank
reputation trajectories by similarity" queries. Out of scope for
ADR-129 (which is agent-memory, not indexer companion); separate
future ADR.

### B11. x402-relay `/admin/drain` endpoint (cycle-3 follow-up surfaced by C2)

**Status**: **Done** (2026-04-27, commit `bdfceea`). Bearer-auth admin
surface (`POST /admin/drain`, `POST /admin/undrain`, `GET /admin/status`)
with a new `RELAY_ADMIN_TOKEN` env var (32-byte floor, mirrors AUD-027
`JWT_SECRET` pattern; throws at module load if set-but-too-short).
`crypto.timingSafeEqual` for constant-time bearer compare. Fail-closed
default: missing `RELAY_ADMIN_TOKEN` returns 503 `ADMIN_TOKEN_NOT_CONFIGURED`
on drain/undrain (relay still serves /pay normally). Drain gate inserted
BEFORE AUD-209 saturation check + RPC verify; in-flight /pay completes
gracefully. 9 new node:test subtests covering auth, lifecycle,
idempotency, in-flight-pay completion. Single-instance scope explicit;
cross-instance drain orchestration tracked under ADR-126.

**Why**: Surfaced by the C2 incident-response playbook agent (commit
`bbeb240`): operators previously had no in-app way to gracefully stop
accepting new /pay requests during incident response and had to fall
back to coarse network-edge blocking that was asymmetric across
instances.

**Scope** (as shipped): `src/x402-relay/index.ts` admin surface +
`test/admin-drain-endpoint.test.ts`; new env var + startup-log entry
for `admin_token_configured` so operators see misconfig at boot.

---

## 4. Track C — Operational readiness

### C1. `MAINNET_DEPLOY_RUNBOOK.md`

**Status**: **Done** (2026-04-27, commit `8aa0d37`). 685-line operator
runbook covering all six required sections. Pulls in C4 (auth
entanglement, 7 cross-refs), C2 (incident response, 7 cross-refs),
ADR-080 (deploy mandates, 8 cross-refs), ADR-122 (CI gate), B2 MCP
governance wrapper for the `verify_protocol_invariants` step. Surfaces
6 operator-pre-conditions: AUD-207 program-ID split must land before
deploy day; ADR-127 / ADR-126 implementations are not pre-deploy
prerequisites but constrain Day-1 monitoring posture; ADR-125 deferral
makes wrong-key-bound init a redeploy-only recovery; placeholder gates
in `.github/allowed-signers` + `config/AUDIT_REPORT_HASHES` block the
deploy until A1 + A2 land. 10 `<TODO: operator team to fill in>`
placeholders for operator-specific config (signer rotation, comms
channel, indexer SLO, etc).

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

**Status**: **Done** (2026-04-27, commit `bbeb240`). 567-line
operator-focused playbook (`docs/INCIDENT_RESPONSE.md`) with 4 incident
classes per spec + cross-cutting post-mortem section. Format: triggers
→ decision tree → procedure → post-incident per the C4 precedent.
Surfaced 5 real gaps (4 fixed in the same wave): no `/admin/drain`
endpoint (closed by B11), no mainnet smoke harness (open follow-up),
indexer backup cadence undefined until C5/ADR-127 land, ADR-117
filename mismatch (closed by ADR-126 introduction + 6-reference
disambiguation in commit `783a810`), and `rotate_protocol_config_authority`
deferral correctly handled per ADR-125.

- On-chain incident triage (program upgrade vs `update_protocol_config`
  vs operator runbook step).
- Multisig emergency rotation.
- Indexer DB recovery from cold backup.
- x402-relay saturation response (manual scale-out, ADR-126).

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

**Status**: Done — landed as standalone doc
`docs/PROTOCOL_AUTHORITY_OPERATIONS.md`. Chose the standalone path
because C1 has not started (no commit history for
`docs/MAINNET_DEPLOY_RUNBOOK.md`); the future C1 runbook should
reference this doc rather than duplicating it.

### C5. Indexer redundancy + backfill plan

**Status**: **Phase 1 scaffolding shipped** (2026-04-27, commit
`606a4f1`); design via ADR-128 (commit `7886554`) supersedes ADR-127
(commit `7de9253`).
Two ADRs:

- **ADR-128** (Proposed; **current target**) — PostgreSQL with
  streaming replication to a hot standby + WAL archiving for
  transaction-granular PITR. Sub-2-minute RTO. License: PostgreSQL
  License (BSD/MIT-style permissive, OSI-approved). Selected after
  the user lifted the "what's already in stack" constraint that
  bounded ADR-127 — wider option space made Postgres the clear
  winner on R4 (replication maturity), R5 (real PITR), R3 (native
  SQL fit), and R6 (mature polyglot drivers). Cycle-3 implementation
  cost ≈ 5-8 single-engineer days.
- **ADR-127** (Superseded by ADR-128) — original constrained-scope
  cold-spare design with SQLite snapshot + cursor-anchored replay.
  Preserved as fallback if Postgres adoption is later judged too
  operationally expensive (10-25 minute RTO; no real PITR).

**Phase 1 scaffolding (commit `606a4f1`)**: pg 8.20.0 (MIT) + pg-mem
3.0.14 devDep (no testcontainers); idempotent SQL migration mirroring
all 7 SQLite tables 1:1 (no schema-mismatch surfaced); 12 dual-write
sites in `src/indexer/index.ts` (cursor + events + 5 history tables
+ agents + tombstones); `LivePostgresStore` with `pg.Pool` connection
pooling; `DisabledPostgresStore` no-op when `INDEXER_PG_URL` unset;
fail-closed at module load on malformed URL (AUD-027 precedent). 24
new tests across 6 suites (schema parity, idempotency primitive,
cursor upsert, disabled-store, fail-closed validation, dual-write
integration); 51/51 indexer tests green. Reads stay SQLite-only;
Postgres is shadow-write only. Phase 2 (separate PR): flip reads to
PG + deprecate SQLite write + remove dual-write.

The runner-up (SQLite + Litestream, Apache-2.0) is also documented
in ADR-128 as the lowest-delta-from-current alternative with the
tradeoff of no automatic failover.

Original spec retained for reference:

- Two-instance indexer with leader election OR cold-spare.
- Backup cadence for the indexer DB.
- Drill: kill primary, confirm secondary catches up from slot N.

### C6. x402-relay scale plan (ADR-126)

**Status**: **Phase 1 scaffolding shipped** (2026-04-27, commit
`4064b20`); design via ADR-126 (commit `7886554`).

The current single-instance design tops out at ~30 sigs/sec sustained
(per AUD-209's bound). If launch throughput could exceed that, ship
the Redis-backed dedup BEFORE first paying customer. Design captured
in `docs/adr/ADR-126-x402-relay-horizontal-scale.md` (Status: Proposed).

**Phase 1 scaffolding (commit `4064b20`)**: ioredis 5.10.1 + ioredis-
mock 8.9.0 (no testcontainers); new `redis-dedup.ts` module with
`LiveRedisDedup` (`SET aep:redeemed:<sig> <instanceId> NX PX <ttl>`)
+ `DisabledRedisDedup` no-op + `createRedisDedup` factory; three
dual-write sites in `processPaymentRequest` (top of function before
in-memory check; verify-failed `releaseRedeemed`; happy-path commit);
maintained counter key (`aep:redeemed:count`) for O(1) saturation
check rather than O(N) SCAN MATCH; AUD-027 fail-closed on malformed
`RELAY_REDIS_URL`; AUD-208 in-flight-verify collapsing semantics
preserved. 22 new subtests; 38/38 x402-relay suite green. In-memory
map remains authoritative when Redis disabled (byte-identical to
pre-ADR-126 behavior). Phase 2 (separate PR): flip reads to Redis +
remove in-memory map + close the counter-drift via Redis 7.4
hash-field TTL or keyspace-notification subscriber.

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

These need owners before kicking off. As of 2026-04-26, A4's GPG
signed-tag allowlist gap (originally surfaced as a sixth open question
during the cycle-2 → cycle-3 hand-off) is **closed** by A5 above —
`.github/allowed-signers` is the source-controlled allowlist and the
workflow + script consult it via `gpg.ssh.allowedSignersFile`. The
remaining open questions are:

1. **Audit firm**: who, by when. Negotiate scope to include the cycle-2
   diffs (last ~30 commits to `programs/`).
2. **Multisig membership + threshold**: who, what threshold.
3. **Launch throughput estimate**: drives whether C6 (x402-relay scale)
   is week-1 work or week-3 work.
4. **Initial agents at launch**: drives whether B1 (ADR-124) is week-1
   work or week-3 work — high-balance launch agents make it week-1.
   B1 itself is **Done** (2026-04-26); this question still drives the
   answer to #6 below by quantifying the blast-radius cost of an
   `initialize_protocol_config` mis-bind on launch day.
5. **Indexer SLO**: drives C5 (single-instance vs HA pair).
6. **Ship `rotate_protocol_config_authority` pre-mainnet?** —
   **Resolved by ADR-125**: defer the on-chain rotation instruction
   to the first post-launch governance cycle (Option δ for the launch
   window). The C4 runbook (`docs/PROTOCOL_AUTHORITY_OPERATIONS.md`)
   is the operator-facing closure of AUD-115; ADR-125 is the
   architectural deferral record. When rotation eventually ships, the
   ADR commits to Option β (2-step propose-then-accept). This question
   stays in §8 as a status pointer, not as a live decision: the
   resolution is in the ADR and the C4 runbook §6 will be updated to
   reference ADR-125 in a separate small PR. **No new Track-B item is
   added** — the deferral is the decision, not a code task.

Resolve questions 1-5 in the Week-0 kickoff before spawning parallel
sessions. Question 6 is resolved; revisit only if A2's multisig
membership decision (#2) materially changes the threat model the ADR
rests on.
