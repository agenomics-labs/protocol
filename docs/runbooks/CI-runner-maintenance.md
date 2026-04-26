# CI runner maintenance — self-hosted runners on `flow`

Operational runbook for the self-hosted GitHub Actions runner fleet
described in [ADR-105](../adr/ADR-105-self-hosted-ci-runners.md).
Covers recurring maintenance tasks the fleet needs to keep CI green.
For one-off setup (adding/removing a runner, systemd unit template,
linger persistence), see ADR-105 §"Adding / removing / replacing a
runner".

## Action-tarball pre-cache (AUD-406)

### Symptom

Workflow jobs fail at `Set up job → Download action repository …` with
errors like:

```
Error: Resource not accessible by integration
Error: read tcp X.X.X.X:443: i/o timeout
Error: connect ETIMEDOUT 140.82.121.6:443
```

`api.github.com` is timing out on the tarball fetch for one of the
core actions: `actions/setup-node`, `actions/cache`,
`actions/checkout`, `trufflesecurity/trufflehog`,
`actions/upload-artifact`, `actions/download-artifact`.

This was a recurring ~60% flake rate on `flow` until the pre-cache was
introduced.

### Mitigation

Run [`scripts/runner-precache-actions.sh`](../../scripts/runner-precache-actions.sh)
to pre-populate every runner's `_work/_actions/<owner>/<repo>/<ref>/`
cache from the public `https://github.com/<owner>/<repo>/archive/<ref>.tar.gz`
endpoint (which historically does not flake on this host). Once an
action's tarball is on disk, the runner skips the network fetch.

### When to run

- After upgrading the runner image (the runner self-upgrade wipes
  `_work/_actions/` on first start of a new version).
- After a `rm -rf ~/actions-runner*/_work/` cache invalidation.
- When CI starts flaking on the actions listed above (the script is
  idempotent — safe to re-run; it skips already-cached entries).

### How to run

```bash
# From the repo root, on the runner host:
cd ~/dev/projects/protocol
scripts/runner-precache-actions.sh

# Dry-run to preview without writing:
scripts/runner-precache-actions.sh --dry-run

# Target a single runner:
scripts/runner-precache-actions.sh --runner-dir ~/actions-runner-2
```

The script:

1. Scans `.github/workflows/*.yml` for every `uses: <owner>/<repo>@<ref>`
   line and dedupes.
2. For each `(owner, repo, ref)` and each `~/actions-runner*` work-dir,
   downloads `https://github.com/<owner>/<repo>/archive/<ref>.tar.gz`
   and extracts to `<runner>/_work/_actions/<owner>/<repo>/<ref>/`
   with `--strip-components=1` (so `action.yml` lands at the cache-dir
   root, the way the runner expects it).
3. Skips any entry that is already cached.

Safe to run on a live runner; the runner only touches
`_work/_actions/` after a job is dispatched, so there is no race.

### Verifying the cache

```bash
# Per-runner: list everything the runner has cached.
for d in ~/actions-runner*/; do
  echo "=== $d ==="
  find "$d/_work/_actions" -mindepth 3 -maxdepth 3 -type d 2>/dev/null \
    | sed "s|$d/_work/_actions/||" \
    | sort -u
done

# Cross-reference with what the workflows ask for:
grep -rhE 'uses:\s*[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+@' .github/workflows/*.yml \
  | sed -E 's|.*uses:\s*||' | sort -u
```

Every entry from the second list should appear in the first.

## Cache invalidation

When a job "succeeded locally but failed on CI" inverts, stale runner
caches are usually the cause. Targeted invalidation:

```bash
# Cargo target/ for the active runner:
rm -rf ~/actions-runner*/_work/<repo>/<repo>/target

# npm node_modules across the fleet:
rm -rf ~/actions-runner*/_work/<repo>/<repo>/node_modules

# Action tarballs (forces re-download next run; pair with
# scripts/runner-precache-actions.sh to repopulate):
rm -rf ~/actions-runner*/_work/_actions
```

## Health checks

```bash
# GitHub view: are all four runners idle and connected?
gh api repos/agenomics-labs/protocol/actions/runners \
  --jq '.runners[] | "\(.name) | \(.status) | busy=\(.busy)"'

# Local view: are systemd units up?
systemctl --user list-units 'gh-runner*.service' --no-pager

# Recent log for a specific runner:
journalctl --user -u gh-runner-2.service -n 100 --no-pager
```

## Related

- [ADR-105](../adr/ADR-105-self-hosted-ci-runners.md) — runner fleet
  decision and one-time setup.
- [`scripts/runner-precache-actions.sh`](../../scripts/runner-precache-actions.sh)
  — the pre-cache implementation.
- [`.github/workflows/*.yml`](../../.github/workflows/) — every
  workflow with `runs-on: [self-hosted, linux]`.
