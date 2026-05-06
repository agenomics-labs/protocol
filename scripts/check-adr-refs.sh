#!/usr/bin/env bash
# Verifies every `ADR-NNN` cross-reference in the repo's ADR + user-facing
# docs points to an actual file in `docs/adr/`. With 134+ ADRs and heavy
# cross-referencing, a typo'd reference (e.g. `ADR-094` mis-cited as
# `ADR-049`) silently misdirects readers; a reference to a not-yet-written
# ADR (e.g. proposed in a draft PR but never merged) silently breaks once
# the doc lands on main.
#
# This bug class hasn't yet caused a production incident, but the 2026-05-06
# parity-gate cluster (PRs #87..#90) revealed multiple real broken refs
# during the build of this script — see the "Known intentional gaps"
# allowlist below for the full audit trail.
#
# Source of truth: filenames in `docs/adr/ADR-*.md` (excluding TEMPLATE).
#
# Allowlist policy: a small explicit allowlist for ADR numbers that exist as
# concepts but not as files. Each entry must carry a one-line comment
# explaining WHY it's allowlisted. New entries should be rare; the default
# expectation is that every ADR-NNN reference resolves to a real file.
#
# Usage: bash scripts/check-adr-refs.sh

set -euo pipefail

cd "$(dirname "$0")/.."

# --- 1. Source of truth: which ADR numbers exist as files ---
ls docs/adr/ADR-*.md 2>/dev/null \
  | grep -oE 'ADR-[0-9]+' \
  | sort -u > /tmp/adr-existing.$$.txt
trap 'rm -f /tmp/adr-existing.$$.txt /tmp/adr-refs.$$.txt /tmp/adr-broken.$$.txt' EXIT

EXISTING_COUNT=$(wc -l < /tmp/adr-existing.$$.txt)
echo "Existing ADR files: $EXISTING_COUNT"

# --- 2. Known-intentional gaps (allowlist) ---
# Each line: `ADR-NNN  why-allowlisted`. Ignored references that match an
# allowlisted number do not fail the gate.
cat > /tmp/adr-allowlist.$$.txt <<'EOF'
ADR-057   intentionally-skipped per docs/STATUS.md "001–060 (except 057)"; referenced in ADR-120/129 as historical context
ADR-135   proposed in PR #68's DX-overhaul wave (ADR-134..140); ADR-135 covers Zod schema mirroring and is held pending PR #68 merge
ADR-138   proposed in PR #68 (@agenomics/react component library); referenced in ADR-136's Decision/Consequences blocks
ADR-139   proposed in PR #68 (create-agenomics-app scaffold); referenced in ADR-136
ADR-140   proposed in PR #68 (sample-app gallery); referenced in ADR-136
EOF
trap 'rm -f /tmp/adr-existing.$$.txt /tmp/adr-refs.$$.txt /tmp/adr-broken.$$.txt /tmp/adr-allowlist.$$.txt' EXIT
ALLOWLIST_NUMS=$( (grep -oE '^ADR-[0-9]+' /tmp/adr-allowlist.$$.txt || true) | sort -u)

# --- 3. Find every ADR-NNN reference in the searched surfaces ---
# Surfaces: ADR docs themselves (the heaviest cross-referencing surface) +
# top-level user-facing docs. Excludes audit history (intentionally references
# old/wrong things as evidence) and the lint script itself.
declare -a TARGETS=(
  README.md
  SUBMISSION.md
  SUMMARY.md
  JUDGE_RUNBOOK.md
  CONTRIBUTING.md
  RELEASE.md
)
while IFS= read -r f; do TARGETS+=("$f"); done < <(find docs/adr -name 'ADR-*.md' -not -name 'ADR-TEMPLATE.md')
while IFS= read -r f; do TARGETS+=("$f"); done < <(find docs -maxdepth 1 -type f -name '*.md')

# Extract ADR-NNN tokens. Strategy:
#   - Match `ADR-` followed by exactly 3 digits (the canonical zero-padded form).
#   - Filter out trailing `[A-Z]` placeholders (e.g. `ADR-13X`) via awk post-filter.
#   - The 3-digit constraint already excludes `ADR-0` (1 digit) and `ADR-13` (2 digits).
# Use grep -E (POSIX) for portability; do the placeholder-suffix exclusion in
# the calling context (regex-quoted strings like `"ADR-0[0-9]*"` from
# DEEP-AUDIT-2026-04-22.md are eliminated naturally because the trailing
# `[0-9]*` makes the ADR number have <3 digits when extracted).
grep -hoE '\bADR-[0-9]{3}' "${TARGETS[@]}" 2>/dev/null \
  | sort -u > /tmp/adr-refs.$$.txt || true

# Filter out any reference where the immediate next character in the
# original text is [A-Z] — that's the `ADR-13X` placeholder pattern. We do
# this with a second grep pass on the sources.
declare -a confirmed_refs=()
while IFS= read -r ref; do
  # Search for the ref where it's NOT followed by an uppercase letter.
  # `grep -E "${ref}([^A-Z]|$)"` confirms the ref appears as a real reference
  # at least once.
  if grep -hE "${ref}([^A-Z0-9]|$)" "${TARGETS[@]}" >/dev/null 2>&1; then
    confirmed_refs+=("$ref")
  fi
done < /tmp/adr-refs.$$.txt
printf '%s\n' "${confirmed_refs[@]}" | sort -u > /tmp/adr-refs.$$.txt

REF_COUNT=$(wc -l < /tmp/adr-refs.$$.txt)
echo "Distinct ADR-NNN references found: $REF_COUNT"

# --- 4. Compute broken refs: in refs but not in (existing ∪ allowlist) ---
ALLOWED_AND_EXISTING=$(cat /tmp/adr-existing.$$.txt <(echo "$ALLOWLIST_NUMS") | sort -u)
echo "$ALLOWED_AND_EXISTING" > /tmp/adr-allowed.$$.txt
trap 'rm -f /tmp/adr-existing.$$.txt /tmp/adr-refs.$$.txt /tmp/adr-broken.$$.txt /tmp/adr-allowlist.$$.txt /tmp/adr-allowed.$$.txt' EXIT

comm -23 /tmp/adr-refs.$$.txt /tmp/adr-allowed.$$.txt > /tmp/adr-broken.$$.txt
BROKEN_COUNT=$(wc -l < /tmp/adr-broken.$$.txt)

if [ "$BROKEN_COUNT" -gt 0 ]; then
  echo
  echo "::error::Broken ADR cross-references detected ($BROKEN_COUNT distinct ADR numbers):"
  while IFS= read -r missing; do
    echo "  $missing — referenced but no docs/adr/$missing-*.md file exists"
    # Surface where each broken ref appears, so the fix is mechanical.
    grep -nF "$missing" "${TARGETS[@]}" 2>/dev/null \
      | grep -E "^[^:]+:[0-9]+:" \
      | head -3 \
      | sed 's/^/    /'
  done < /tmp/adr-broken.$$.txt
  echo
  echo "To fix:"
  echo "  - If the reference is a typo, correct the ADR number."
  echo "  - If the ADR was renamed/superseded, point at the new ADR."
  echo "  - If the reference is to a deliberately-skipped or proposed-but-unmerged"
  echo "    ADR, add it to the allowlist in scripts/check-adr-refs.sh with a"
  echo "    one-line justification."
  exit 1
fi

echo "ADR cross-reference check passed: all $REF_COUNT distinct references resolve to existing files or known-intentional gaps."
