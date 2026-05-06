#!/usr/bin/env bash
# Verifies every workspace `package.json` and every on-chain program
# `Cargo.toml` declares `Apache-2.0` as its license, matching the repo-root
# `LICENSE` file (ADR-136, shipped via PR #76 + #79 + #82).
#
# This bug class — workspace package.json silently shipping with
# `"license": "UNLICENSED"` or no license field at all — caused four
# fix-up commits in the 2026-05-06 submission-readiness sweep:
#   - PR #76:  6 publishable workspaces flipped UNLICENSED → Apache-2.0
#   - PR #79:  4 unpublishable workspaces gained the field
#   - PR #82:  3 program Cargo.toml + src/integrations gained the field
#   - PR #88:  3 leaf workspaces (docs, examples, load) gained the field
#
# Every fix in the chain only surfaced when an external-perception audit
# happened to look at the right file. This gate makes it impossible for a
# workspace to ship without a license declaration.
#
# Usage: bash scripts/check-license-parity.sh
#
# Source of truth: LICENSE file at repo root (Apache-2.0).

set -euo pipefail

cd "$(dirname "$0")/.."

EXPECTED_LICENSE="Apache-2.0"
FAIL=0

# --- 1. LICENSE file exists at repo root ---
if [ ! -f LICENSE ]; then
  echo "::error::LICENSE file missing at repo root"
  FAIL=1
fi

# Confirm LICENSE is actually Apache-2.0 (not silently swapped).
if ! head -2 LICENSE | grep -qi "Apache License"; then
  echo "::error::LICENSE file at repo root does not look like Apache-2.0"
  FAIL=1
fi

# --- 2. All package.json files declare Apache-2.0 ---
# `|| true` on the grep: missing field means empty string, which we report as
# the actionable error below. Without this, set -euo pipefail aborts the loop
# on the first file that's missing a license field, hiding subsequent gaps.
echo "Checking package.json files…"
while IFS= read -r f; do
  license=$( (grep -oE '"license":\s*"[^"]+"' "$f" || true) | head -1 | sed -E 's/.*"license":\s*"([^"]+)".*/\1/' )
  if [ -z "$license" ]; then
    echo "::error file=$f::missing \"license\" field (expected \"$EXPECTED_LICENSE\")"
    FAIL=1
  elif [ "$license" != "$EXPECTED_LICENSE" ]; then
    echo "::error file=$f::license is \"$license\" — expected \"$EXPECTED_LICENSE\""
    FAIL=1
  fi
done < <(find . -name package.json -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.git/*" | sort)

# --- 3. On-chain program Cargo.toml files declare Apache-2.0 ---
echo "Checking program Cargo.toml files…"
for f in programs/*/Cargo.toml; do
  # Read the [package] section: from the [package] header until the next
  # bracket-prefixed header (or EOF). Cargo.toml's section grammar guarantees
  # license = "..." (if present) appears inside [package].
  license=$( awk '/^\[package\]/{flag=1; next} /^\[/{flag=0} flag' "$f" | (grep -oE '^license\s*=\s*"[^"]+"' || true) | sed -E 's/^license\s*=\s*"([^"]+)".*/\1/' )
  if [ -z "$license" ]; then
    echo "::error file=$f::missing \`license =\` field in [package] (expected \"$EXPECTED_LICENSE\")"
    FAIL=1
  elif [ "$license" != "$EXPECTED_LICENSE" ]; then
    echo "::error file=$f::license is \"$license\" — expected \"$EXPECTED_LICENSE\""
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "License parity drift detected. To fix:"
  echo "  - Every workspace package.json must declare \"license\": \"$EXPECTED_LICENSE\"."
  echo "  - Every programs/*/Cargo.toml must declare license = \"$EXPECTED_LICENSE\"."
  echo "  - Repo-root LICENSE file must contain canonical Apache-2.0 text."
  echo "  - See ADR-136 + docs/audits/DEPENDABOT-3-UUID-IPADDR-CLOSURE.md."
  exit 1
fi

echo "License parity check passed: all package.json + program Cargo.toml declare $EXPECTED_LICENSE."
