# ADR-105: Self-hosted GitHub Actions runners

## Status

Accepted

## Date

2026-04-23

## Context

The org account's GitHub Actions hosted-runner budget is blocked:

> The job was not started because recent account payments have failed or
> your spending limit needs to be increased.

Every workflow run ends in `~2s` with that annotation; no real CI signal
is produced on any PR. This blocks:

- PR #56 (ADR-094/095/096/097 client-side alignment — the fix for the
  66 failing anchor tests on `main`)
- PR #57 (chore: untrack local tooling config)
- PRs #50, #51, #54, #55 (observability, SDK, IDL package, manifest
  hash domain separation — all DRAFT, all blocked from leaving draft
  by the CI block)

Private repositories on GitHub get 2,000 hosted-runner minutes / month
on the free tier; beyond that is paid. Self-hosted runner minutes are
unmetered — GitHub only provides the orchestration.

## Decision

Run all workflows on a fleet of self-hosted runners registered to
`agenomics-labs/protocol`, managed as user-level systemd services on
the primary development host. `ubuntu-latest` is replaced by
`[self-hosted, linux]` in every workflow's `runs-on`.

### Runner fleet

Four runners on the `flow` host, each an independent systemd user unit:

| Runner name | Work dir | Service unit |
|---|---|---|
| `flow-self-hosted` | `~/actions-runner/` | `gh-runner.service` |
| `flow-self-hosted-2` | `~/actions-runner-2/` | `gh-runner-2.service` |
| `flow-self-hosted-3` | `~/actions-runner-3/` | `gh-runner-3.service` |
| `flow-self-hosted-4` | `~/actions-runner-4/` | `gh-runner-4.service` |

All share the label set `self-hosted, Linux, X64, solana, anchor, rust,
node`. Four runners is the pragmatic answer to the `ci.yml` job count
(~12 parallelizable jobs) on a single host — the queue drains in a
single wall-clock window rather than serially.

### Runner host — pre-installed toolchain

Workflows assume the runner host has these already installed (they are
on the `PATH` the systemd unit exports):

- Rust + `cargo` (`~/.cargo/bin`)
- Node.js ≥ 20 via Volta (`~/.volta/bin`)
- Anchor `v0.31.1` (`cargo install --git https://github.com/coral-xyz/anchor --tag v0.31.1 anchor-cli --locked`)
- Solana CLI (`~/.local/share/solana/install/active_release/bin`)
- `shellcheck` `v0.10.0` static binary at `~/.local/bin/shellcheck`

The shellcheck install step in `.github/workflows/shellcheck.yml` is
idempotent and re-seeds a missing/wrong-version binary without
requiring `sudo apt-get`.

### Systemd service template

```ini
[Unit]
Description=GitHub Actions self-hosted runner (agenomics-labs/protocol)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/actions-runner
ExecStart=%h/actions-runner/run.sh
Restart=always
RestartSec=5
Environment=PATH=%h/.cargo/bin:%h/.volta/bin:%h/.local/share/solana/install/active_release/bin:%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=HOME=%h

[Install]
WantedBy=default.target
```

Lives at `~/.config/systemd/user/gh-runner.service` (per-runner
numbered variants at `gh-runner-2.service` etc.). Enabled via
`systemctl --user enable --now gh-runner.service` — no sudo.

### Reboot persistence (one-time)

User-level systemd services stop when the user logs out (including on
reboot) unless lingering is enabled:

```bash
sudo loginctl enable-linger neo
```

This is the **only** sudo-required step in the whole runner lifecycle.
Run it once on the host; services then auto-start at boot without a
login.

## Alternatives considered

- **Pay the bill / raise the spending limit.** The correct long-term
  fix but "free" is the constraint today. The self-hosted setup is
  additive — hosted runners can be re-enabled the moment billing is
  resolved, by reverting the `runs-on:` changes in a single commit.
- **Make the repo public.** Unlimited free hosted minutes, but the
  repo contains pre-launch protocol source and security-audit ADRs;
  public is not a "save money on CI" decision.
- **Hybrid: self-host only the expensive jobs (Rust + Anchor),
  keep cheap jobs on hosted.** Doesn't help — hosted jobs are all
  refusing to start, not just the expensive ones.
- **`nektos/act` only (local runs).** Useful for dev-loop validation
  but doesn't produce the `status_check` signal GitHub needs to gate
  merges on branch-protection rules. Still worth adopting as a
  pre-push check; not a replacement for runner-backed CI.
- **Ephemeral runners (one-job-then-exit per runner).** Stricter
  isolation, recommended for public repos or untrusted collaborator
  sets. For a private repo with three collaborators at time of this
  ADR, the cost (image rebuild on every job) outweighs the benefit.
  Revisit if collaborator set grows or repo goes public.

## Consequences

### Operational

- CI is free, compute-wise. Marginal cost is power + wear on the dev
  box.
- A down host = red CI. Cheap mitigation: register at least one runner
  on a second host when a second host exists.
- Job caches (cargo target/, npm `node_modules/`) persist across runs
  in each runner's work dir. Incremental Rust builds are fast; stale
  artifacts are the usual suspect when a job "succeeded locally but
  failed on CI" inverts. Deliberate cache invalidation: `rm -rf
  ~/actions-runner*/\_work/_actions/*/target` when needed.

### Security

- Self-hosted runners execute any code a workflow run contains. For a
  **private** repo restricted to trusted collaborators (current state),
  that's acceptable. If the repo ever becomes public, every fork's PR
  would be able to run arbitrary code on the host — switch to
  ephemeral runners and/or require approval for fork-PRs before
  public-repo CI runs.
- The runner registration token is single-use and short-lived (~1h).
  Compromise scope is "register one runner under this repo"; minimal.
- The runner process runs as the `neo` user with that user's full
  filesystem access. Not sandboxed. If this matters for a given
  workflow (e.g. a release pipeline), pin that workflow to a
  different label (`runs-on: release-runner`) and register a
  dedicated, constrained runner for it.

### CI semantics

- `runs-on: [self-hosted, linux]` is stricter than `ubuntu-latest`:
  it requires both labels to match. Adding a non-Linux runner later
  (e.g. `macos`) won't accidentally pick up Linux jobs. Adding a
  second Linux runner does — that's the intended scaling path.
- No more "ubuntu package X is preinstalled" assumptions. If a
  workflow step needs a binary the runner host doesn't have, install
  it explicitly into `~/.local/bin` without sudo (see the shellcheck
  step for the pattern).

## Adding / removing / replacing a runner

### Add a new runner on this host

```bash
# 1. Request a registration token (requires repo admin gh auth)
TOKEN=$(gh api repos/agenomics-labs/protocol/actions/runners/registration-token \
          -X POST --jq .token)

# 2. Create a work dir and configure
N=5   # next free index
mkdir -p "$HOME/actions-runner-$N" && cd "$HOME/actions-runner-$N"
cp -r "$HOME/actions-runner/." .
rm -rf _work _diag .credentials* .runner
./config.sh --unattended \
  --url https://github.com/agenomics-labs/protocol \
  --token "$TOKEN" \
  --name "flow-self-hosted-$N" \
  --labels self-hosted,linux,x64,solana,anchor,rust,node \
  --work _work

# 3. Install + start as a user service (template in this ADR §Systemd)
cat > "$HOME/.config/systemd/user/gh-runner-$N.service" <<EOF
# ... template with WorkingDirectory=%h/actions-runner-$N ...
EOF
systemctl --user daemon-reload
systemctl --user enable --now "gh-runner-$N.service"
```

### Remove a runner

```bash
N=4
systemctl --user disable --now "gh-runner-$N.service"
rm "$HOME/.config/systemd/user/gh-runner-$N.service"
systemctl --user daemon-reload

# Unregister from GitHub (requires the runner's own remove-token)
cd "$HOME/actions-runner-$N"
REMOVE_TOKEN=$(gh api repos/agenomics-labs/protocol/actions/runners/remove-token \
                 -X POST --jq .token)
./config.sh remove --token "$REMOVE_TOKEN"
cd .. && rm -rf "$HOME/actions-runner-$N"
```

### Runner self-upgrade

Each runner checks for and installs updates on startup; normally no
manual action is needed. To force an upgrade:

```bash
systemctl --user restart gh-runner-*.service
```

If GitHub deprecates the running version (shows a warning banner in
the Actions settings UI), rebuild the runner work dir from the latest
release tarball and reconfigure (see `§Add a new runner`).

## Verifying the fleet

```bash
# GitHub view
gh api repos/agenomics-labs/protocol/actions/runners \
  --jq '.runners[] | "\(.name) | \(.status) | busy=\(.busy)"'

# Local view
systemctl --user list-units 'gh-runner*.service' --no-pager
journalctl --user -u gh-runner.service -n 50 --no-pager
```

## References

- `.github/workflows/*.yml` — `runs-on: [self-hosted, linux]` (all 16
  jobs)
- `.github/workflows/shellcheck.yml` — pattern for installing a missing
  binary on the runner without sudo
- `docs/runbooks/CI-runner-maintenance.md` — recurring maintenance
  tasks (action-tarball pre-cache, cache invalidation, health checks)
- `scripts/runner-precache-actions.sh` — pre-populates the runner's
  `_work/_actions/` cache from `github.com/<owner>/<repo>/archive/<ref>.tar.gz`
  to mitigate `api.github.com` flakes (AUD-406)
- GitHub Actions docs: <https://docs.github.com/en/actions/hosting-your-own-runners>
- Security model for self-hosted runners:
  <https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners#self-hosted-runner-security>

## Revisions

- 2026-04-25 — AUD-406: added `scripts/runner-precache-actions.sh` and
  `docs/runbooks/CI-runner-maintenance.md` to mitigate the recurring
  ~60% `api.github.com` tarball-fetch flake rate. Operators run the
  pre-cache after every runner image upgrade and after any
  `_work/_actions/` cache invalidation.
