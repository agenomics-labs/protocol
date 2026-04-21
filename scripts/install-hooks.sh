#!/usr/bin/env bash
#
# Install repo-local git hooks. Run once after cloning:
#
#   ./scripts/install-hooks.sh
#
# Currently installs a pre-commit hook that auto-runs scripts/sync-idl.sh
# whenever any programs/**/*.rs or *.toml file is staged, and fails the
# commit if the regenerated idl/*.json drifts from the staged baseline.
# This prevents the IDL-drift class of CI failures (the ADR-060 regression
# that blocked every PR for ~2h until the baseline was refreshed).

set -euo pipefail

cd "$(dirname "$0")/.."

HOOKS_DIR=".git/hooks"
HOOK_PATH="$HOOKS_DIR/pre-commit"

if [ ! -d .git ]; then
  echo "error: not a git repository (run from repo root)" >&2
  exit 1
fi

mkdir -p "$HOOKS_DIR"

cat > "$HOOK_PATH" << 'HOOK'
#!/usr/bin/env bash
# aeap pre-commit: IDL parity gate.
#
# Runs scripts/sync-idl.sh whenever any programs/**/*.rs or *.toml is
# staged, then fails the commit if the regenerated idl/*.json has drift
# that isn't also staged. CI enforces the same invariant on PRs; this
# hook just catches drift at commit time so the CI loop stays short.
#
# Skips cleanly if `anchor` is not installed locally (CI will catch).

set -euo pipefail

PROG_STAGED=$(git diff --cached --name-only | grep -E '^programs/.+\.(rs|toml)$' || true)
if [ -z "$PROG_STAGED" ]; then
  exit 0
fi

if ! command -v anchor > /dev/null 2>&1; then
  cat >&2 <<WARN
[pre-commit] programs/ changed but 'anchor' CLI is not on PATH — skipping
IDL parity check. CI will enforce. To install locally:
  cargo install --git https://github.com/coral-xyz/anchor --tag v0.31.1 anchor-cli --locked
WARN
  exit 0
fi

# Run the sync and quiet its stdout; surface errors if it fails.
if ! ./scripts/sync-idl.sh > /dev/null; then
  echo "[pre-commit] scripts/sync-idl.sh failed — not a clean Anchor build." >&2
  echo "[pre-commit] Fix the build error before committing." >&2
  exit 1
fi

# Any idl/*.json changes that aren't staged are drift from this commit.
DRIFTED=$(git diff --name-only -- 'idl/*.json' | tr '\n' ' ' | sed 's/ $//')
if [ -n "$DRIFTED" ]; then
  cat >&2 <<DRIFT
[pre-commit] IDL drift detected after regenerating from programs/ changes:
  $DRIFTED

The staged program change(s) affected the IDL. Review the diff and stage
the updated baseline alongside the program change; CI will reject the PR
otherwise.
  git diff $DRIFTED
  git add $DRIFTED
DRIFT
  exit 1
fi

exit 0
HOOK

chmod +x "$HOOK_PATH"

echo "installed: $HOOK_PATH"
echo "hook fires when any programs/**/*.rs or *.toml is staged;"
echo "runs scripts/sync-idl.sh and blocks the commit if idl/*.json drifts."
