#!/usr/bin/env bash
#
# S-xcut-03: verify that committed IDL in idl/*.json matches the fresh
# output of `anchor build`. Intended for CI — fails if any IDL has drifted.
#
# Bootstrap behaviour: if `idl/<name>.json` does not yet exist for a given
# program, that program is reported as "missing baseline" (warning only).
# Once the baseline is committed, drift is hard-fail.
#
# Usage: run after `anchor build` from the workspace root.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d target/idl ]; then
  echo "error: target/idl does not exist — did 'anchor build' run?" >&2
  exit 1
fi

mkdir -p idl

missing=()
drift=()

for f in target/idl/*.json; do
  name=$(basename "$f")
  if [ ! -f "idl/$name" ]; then
    missing+=("$name")
  elif ! diff -q "idl/$name" "$f" > /dev/null 2>&1; then
    drift+=("$name")
  fi
done

# Count existing baseline files so we can tell bootstrap (nothing yet
# committed) from drift (baseline exists but one or more entries missing).
baseline_count=$(find idl -maxdepth 1 -name '*.json' | wc -l)

if [ ${#missing[@]} -gt 0 ] && [ "$baseline_count" -eq 0 ]; then
  echo "::warning::Bootstrap: no baseline IDL yet in idl/. Download the 'anchor-idl' artifact from this CI run, place under idl/, and commit to activate the diff gate."
elif [ ${#missing[@]} -gt 0 ]; then
  echo "::error::Baseline IDL missing for: ${missing[*]}"
  echo "A new program was added or renamed. Run scripts/sync-idl.sh locally and commit idl/*.json."
  exit 1
fi

if [ ${#drift[@]} -gt 0 ]; then
  echo "::error::IDL drift detected in: ${drift[*]}"
  echo "Run scripts/sync-idl.sh locally, review, and commit the updated idl/*.json."
  for name in "${drift[@]}"; do
    echo "--- diff idl/$name target/idl/$name ---"
    diff -u "idl/$name" "target/idl/$name" || true
  done
  exit 1
fi

if [ ${#missing[@]} -gt 0 ]; then
  exit 0
fi

echo "IDL matches committed baseline."
