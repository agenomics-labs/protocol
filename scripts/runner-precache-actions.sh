#!/usr/bin/env bash
# runner-precache-actions.sh: pre-populate a self-hosted GitHub Actions
# runner's `_work/_actions/<owner>/<repo>/<ref>/` cache so that workflow
# runs do not need to fetch action tarballs from `api.github.com` at
# job-start time.
#
# Closes audit finding AUD-406. Mitigates the recurring ~60% CI flake
# rate driven by `actions/setup-node`, `actions/cache`,
# `actions/checkout`, `trufflesecurity/trufflehog`,
# `actions/upload-artifact`, and `actions/download-artifact` timing
# out fetching their tarballs from GitHub.
#
# How GitHub Actions resolves an action `uses: <owner>/<repo>@<ref>`:
#   1. Compute a cache path:
#      <runner>/_work/_actions/<owner>/<repo>/<ref>/
#   2. If that path is missing, download
#      https://api.github.com/repos/<owner>/<repo>/tarball/<ref>
#      and extract.
#   3. Use the on-disk action.yml.
#
# This script does step (2) ahead of time using `curl` against
# `https://github.com/<owner>/<repo>/archive/<ref>.tar.gz` (the public
# tarball endpoint, not api.github.com), then extracts to the runner's
# cache path. Subsequent CI jobs skip the network fetch entirely.
#
# Usage:
#   scripts/runner-precache-actions.sh                # default: scan
#                                                     # workflows in
#                                                     # repo, populate
#                                                     # ~/actions-runner*
#   scripts/runner-precache-actions.sh --runner-dir ~/actions-runner-2
#   scripts/runner-precache-actions.sh --workflows .github/workflows
#   scripts/runner-precache-actions.sh --dry-run
#
# Idempotent: existing cache entries are skipped. Safe to run on a live
# runner; the runner only writes to `_work/_actions/` after a job is
# dispatched, so there is no race with the script.
#
# Operator runbook: see docs/runbooks/CI-runner-maintenance.md.

set -euo pipefail

# --- defaults ---------------------------------------------------------

WORKFLOWS_DIR=".github/workflows"
RUNNER_DIRS=()
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/runner-precache-actions.sh [options]

Options:
  --workflows <dir>     Directory containing .github/workflows/*.yml
                        (default: .github/workflows)
  --runner-dir <dir>    Runner work-dir root (default: every
                        ~/actions-runner* on this host). May be repeated.
  --dry-run             Print what would be downloaded; do not write.
  -h, --help            Show this message.

Examples:
  scripts/runner-precache-actions.sh
  scripts/runner-precache-actions.sh --runner-dir ~/actions-runner-2
  scripts/runner-precache-actions.sh --dry-run
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --workflows)
      shift
      [ $# -gt 0 ] || { echo "--workflows requires an argument" >&2; exit 64; }
      WORKFLOWS_DIR="$1"
      ;;
    --runner-dir)
      shift
      [ $# -gt 0 ] || { echo "--runner-dir requires an argument" >&2; exit 64; }
      RUNNER_DIRS+=("$1")
      ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1 (try --help)" >&2; exit 64 ;;
  esac
  shift
done

if [ ! -d "$WORKFLOWS_DIR" ]; then
  echo "error: workflows dir '$WORKFLOWS_DIR' does not exist" >&2
  exit 1
fi

# Default runner dirs: every ~/actions-runner* on this host (per
# ADR-105 §Runner fleet — currently 4 runners on the `flow` host).
if [ "${#RUNNER_DIRS[@]}" -eq 0 ]; then
  shopt -s nullglob
  for d in "$HOME"/actions-runner "$HOME"/actions-runner-*; do
    [ -d "$d" ] && RUNNER_DIRS+=("$d")
  done
  shopt -u nullglob
fi

if [ "${#RUNNER_DIRS[@]}" -eq 0 ]; then
  echo "error: no runner dirs found (looked for ~/actions-runner*)" >&2
  echo "  pass --runner-dir explicitly, or run on a host with runners" >&2
  exit 1
fi

# --- extract uses-refs from workflows ---------------------------------

# Match `uses: <owner>/<repo>@<ref>` where ref is a SHA, tag, or branch.
# The ref is captured verbatim — GitHub Actions caches by the literal
# string, so `@v4` and `@v4.0.0` are different cache entries.
USES_RE='uses:[[:space:]]*([A-Za-z0-9._-]+)/([A-Za-z0-9._/-]+)@([A-Za-z0-9._/-]+)'

REFS_FILE=$(mktemp)
trap 'rm -f "$REFS_FILE"' EXIT

# shellcheck disable=SC2016
grep -rhE "$USES_RE" "$WORKFLOWS_DIR"/*.yml \
  | sed -E "s|.*uses:[[:space:]]*([A-Za-z0-9._-]+)/([A-Za-z0-9._/-]+)@([A-Za-z0-9._/-]+).*|\1\t\2\t\3|" \
  | sort -u >"$REFS_FILE"

REF_COUNT=$(wc -l <"$REFS_FILE" | tr -d ' ')
printf 'Found %s unique uses-refs across %s workflow file(s)\n' \
  "$REF_COUNT" "$(find "$WORKFLOWS_DIR" -maxdepth 1 -name '*.yml' | wc -l | tr -d ' ')"

# --- fetch + extract per-runner ---------------------------------------

fetch_and_extract() {
  local owner="$1" repo="$2" ref="$3" runner_dir="$4"
  local cache_dir="${runner_dir}/_work/_actions/${owner}/${repo}/${ref}"
  if [ -d "$cache_dir" ] && [ -n "$(ls -A "$cache_dir" 2>/dev/null)" ]; then
    printf '  skip  %s/%s@%s (already cached at %s)\n' \
      "$owner" "$repo" "$ref" "$cache_dir"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  DRY   %s/%s@%s -> %s\n' "$owner" "$repo" "$ref" "$cache_dir"
    return 0
  fi
  printf '  fetch %s/%s@%s\n' "$owner" "$repo" "$ref"
  local tarball_url="https://github.com/${owner}/${repo}/archive/${ref}.tar.gz"
  local tmpdir
  tmpdir=$(mktemp -d)
  # GitHub's archive endpoint emits a tarball whose root dir is
  # `<repo>-<ref>/`. The runner expects the action's `action.yml` at the
  # cache_dir root, so we strip-components=1 on extract.
  if ! curl -fsSL "$tarball_url" -o "$tmpdir/action.tgz"; then
    echo "  error: curl failed for $tarball_url" >&2
    rm -rf "$tmpdir"
    return 1
  fi
  mkdir -p "$cache_dir"
  if ! tar -xzf "$tmpdir/action.tgz" -C "$cache_dir" --strip-components=1; then
    echo "  error: tar extract failed for $tarball_url" >&2
    rm -rf "$tmpdir" "$cache_dir"
    return 1
  fi
  rm -rf "$tmpdir"
}

EXIT_CODE=0
for runner_dir in "${RUNNER_DIRS[@]}"; do
  printf '\nRunner: %s\n' "$runner_dir"
  if [ ! -d "$runner_dir" ]; then
    echo "  warn: runner dir does not exist; skipping" >&2
    continue
  fi
  while IFS=$'\t' read -r owner repo ref; do
    [ -z "$owner" ] && continue
    if ! fetch_and_extract "$owner" "$repo" "$ref" "$runner_dir"; then
      EXIT_CODE=1
    fi
  done <"$REFS_FILE"
done

printf '\nDone. Exit code: %s\n' "$EXIT_CODE"
exit "$EXIT_CODE"
