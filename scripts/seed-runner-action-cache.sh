#!/usr/bin/env bash
# scripts/seed-runner-action-cache.sh — AUD-406 mitigation.
#
# Pre-populates each self-hosted GitHub Actions runner's `_work/_actions`
# cache with the action tarballs referenced from .github/workflows/, so
# CI jobs do not need to fetch them from api.github.com mid-run.
# Without this, first-fetch of an uncached `uses:` reference times out
# at the runner agent's 100s HTTP deadline and the entire job fails —
# documented as ~60% of CI failure volume in the cycle-2 audit.
#
# When to run:
#   - After bumping any `uses:` ref (Dependabot PR or manual change).
#   - After provisioning a new self-hosted runner under
#     `${RUNNER_BASE_GLOB}`.
#   - One-off, after this script first ships, to seed every existing
#     runner.
#
# Idempotent: refs already cached on a runner are skipped.
#
# Requirements: gh CLI (authenticated), tar, find, GNU coreutils.
#
# Usage:
#   scripts/seed-runner-action-cache.sh [--runner-base GLOB] [--dry-run]
#
# Options:
#   --runner-base GLOB   Glob expanding to runner home dirs.
#                        Default: /home/neo/actions-runner*
#   --dry-run            Print actions without modifying anything.

set -euo pipefail

RUNNER_BASE_GLOB="/home/neo/actions-runner*"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --runner-base) RUNNER_BASE_GLOB="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

WORKFLOWS_DIR="$(git rev-parse --show-toplevel)/.github/workflows"
[ -d "$WORKFLOWS_DIR" ] || { echo "no .github/workflows/ at $WORKFLOWS_DIR" >&2; exit 1; }

# shellcheck disable=SC2206  # word splitting is intended for the glob
RUNNERS=( $RUNNER_BASE_GLOB )
[ -d "${RUNNERS[0]:-/dev/null}" ] || { echo "no runners matched $RUNNER_BASE_GLOB" >&2; exit 1; }

# Extract every `uses: owner/repo@ref` from the workflow files. Excludes
# path-based refs (`uses: ./...`) which require no caching. Strips any
# trailing inline comment (`# pin v5 (AUD-406)` etc.) that the SHA-pin
# convention adds after the ref.
mapfile -t REFS < <(
  grep -rhE '^\s*-?\s*uses:\s*[^.]\S+@\S+' "$WORKFLOWS_DIR" \
    | sed -E 's/.*uses:\s*//; s/[[:space:]]+#.*$//; s/[[:space:]]+$//' \
    | sort -u
)

[ ${#REFS[@]} -gt 0 ] || { echo "no external uses: refs found in $WORKFLOWS_DIR" >&2; exit 0; }

echo "Workflows: $WORKFLOWS_DIR"
echo "Runners:   ${RUNNERS[*]}"
echo "Refs:      ${#REFS[@]}"
[ "$DRY_RUN" = 1 ] && echo "(dry-run)"
echo ""

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

seed_count=0
skip_count=0

for ref in "${REFS[@]}"; do
  owner_repo="${ref%@*}"
  rev="${ref##*@}"
  owner="${owner_repo%/*}"
  repo="${owner_repo#*/}"

  staged=""

  for runner in "${RUNNERS[@]}"; do
    target="$runner/_work/_actions/$owner/$repo/$rev"
    if [ -d "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
      skip_count=$((skip_count + 1))
      continue
    fi

    # Lazy-fetch: only pull the tarball if at least one runner needs it.
    if [ -z "$staged" ]; then
      staged="$TMPDIR/${owner}_${repo}_${rev//[^A-Za-z0-9]/_}"
      if [ "$DRY_RUN" = 1 ]; then
        echo "[fetch] $ref (dry-run, skipping download)"
      else
        echo "[fetch] $ref"
        mkdir -p "$staged"
        gh api "repos/$owner_repo/tarball/$rev" > "$TMPDIR/$repo.tgz"
        tar -xzf "$TMPDIR/$repo.tgz" -C "$staged" --strip-components=1
        rm "$TMPDIR/$repo.tgz"
      fi
    fi

    if [ "$DRY_RUN" = 1 ]; then
      echo "  [seed] $target (dry-run)"
    else
      mkdir -p "$target"
      cp -a "$staged/." "$target/"
      echo "  [seed] $target"
    fi
    seed_count=$((seed_count + 1))
  done
done

echo ""
echo "Seeded: $seed_count   Skipped (already cached): $skip_count"
