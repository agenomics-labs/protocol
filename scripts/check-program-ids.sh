#!/usr/bin/env bash
# Verifies the 3 on-chain program IDs are consistent across every user-facing
# and operationally-critical surface in the repo. The source of truth is each
# program's `declare_id!` macro in `programs/*/src/lib.rs` — that's what gets
# baked into the BPF binary, so any drift between declare_id! and the
# downstream surfaces means a deployment that doesn't match what the docs
# advertise.
#
# Surfaces checked (must contain ALL 3 declared IDs):
#   - Anchor.toml                     (Anchor build/deploy config)
#   - README.md                       (judges' first read)
#   - SUBMISSION.md                   (Colosseum submission packet)
#   - SUMMARY.md                      (per-program walkthrough)
#   - dashboard/src/data/programs.js  (live at app.agenomics.xyz)
#   - JUDGE_RUNBOOK.md                (verification flow, ≥1 of each)
#
# This bug class hasn't bitten this run (yet), but it is the highest-stakes
# possible drift: a program ID typo that ships into a hackathon submission
# means the demo invocation tries to call a non-existent program. We're
# adding the gate prophylactically before that happens.
#
# Usage: bash scripts/check-program-ids.sh

set -euo pipefail

cd "$(dirname "$0")/.."

# --- 1. Source of truth: declare_id! from each program's lib.rs ---
declare -A DECLARED_IDS
for program in programs/*/src/lib.rs; do
  name=$(echo "$program" | sed -E 's|programs/([^/]+)/src/lib.rs|\1|')
  id=$( (grep -oE 'declare_id!\("[^"]+"\)' "$program" || true) | sed -E 's/declare_id!\("([^"]+)"\)/\1/' | head -1)
  if [ -z "$id" ]; then
    echo "::error file=$program::missing declare_id! macro"
    exit 1
  fi
  DECLARED_IDS["$name"]="$id"
  echo "Source of truth: $name → $id"
done

if [ "${#DECLARED_IDS[@]}" -ne 4 ]; then
  echo "::error::Expected 4 programs in programs/, found ${#DECLARED_IDS[@]}"
  exit 1
fi

# --- 2. Required surfaces — each must contain all 3 declared IDs ---
declare -a REQUIRED_FILES=(
  Anchor.toml
  README.md
  SUBMISSION.md
  SUMMARY.md
  dashboard/src/data/programs.js
  JUDGE_RUNBOOK.md
)

FAIL=0

for f in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "::error::Required file missing: $f"
    FAIL=1
    continue
  fi
  for name in "${!DECLARED_IDS[@]}"; do
    id="${DECLARED_IDS[$name]}"
    if ! grep -qF "$id" "$f"; then
      echo "::error file=$f::Missing program ID for '$name': $id"
      FAIL=1
    fi
  done
done

# --- 3. No "stale" declared IDs anywhere — i.e. no surface contains an ID
#        that resembles a program address (44-char base58) but is NOT one of
#        the three declared IDs. This catches the case where someone copies
#        a stale ID from old docs.
#
# We don't enforce this universally because base58 strings are common in the
# repo (wallets, ATAs, fixtures). Instead, we enforce it only on the surfaces
# above where program-IDs appear in canonical address form, and we narrow
# the search to backtick-wrapped 44-char base58 (the convention).
ALLOWED_IDS=$(printf '%s\n' "${DECLARED_IDS[@]}")

for f in "${REQUIRED_FILES[@]}"; do
  # Find candidate program-ID strings: backtick-wrapped 44-char base58.
  # Escape the regex correctly — base58 alphabet excludes 0OIl.
  candidates=$( (grep -oE '`[1-9A-HJ-NP-Za-km-z]{43,44}`' "$f" 2>/dev/null || true) | tr -d '`' | sort -u)
  if [ -z "$candidates" ]; then
    continue
  fi
  while IFS= read -r candidate; do
    if ! echo "$ALLOWED_IDS" | grep -qx "$candidate"; then
      echo "::warning file=$f::Found 44-char base58 string \`$candidate\` that is not one of the 3 declared program IDs — possible stale reference"
    fi
  done <<< "$candidates"
done

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "Program-ID parity drift detected. To fix:"
  echo "  - Source of truth is declare_id! in programs/*/src/lib.rs"
  echo "  - Anchor.toml [programs.localnet] / [programs.devnet] must match"
  echo "  - Update all surfaces (README, SUBMISSION, SUMMARY, dashboard, JUDGE_RUNBOOK) to match"
  exit 1
fi

echo "Program-ID parity check passed: all 4 IDs consistent across ${#REQUIRED_FILES[@]} surfaces."
