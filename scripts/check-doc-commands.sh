#!/usr/bin/env bash
# Lints user-facing documentation for executable shell commands that look
# legitimate but actually fail. This bug class caused at least four fix-up
# PRs in the 2026-05-06 submission-readiness sweep:
#
#   PR #79: getting-started.md said `npm install @agenomics/mcp-server`
#           — the @agenomics/* npm scope is empty (source-only release per
#           ADR-136 deferred clause); a judge typing this would 404
#   PR #80: docs/integration-guide.md repeated the same npm install path
#           five times across the file
#   PR #82: SUBMISSION.md "Solo builder" claim explicitly tells judges the
#           scope is source-only — but the install commands still 404'd
#   PR #85: JUDGE_RUNBOOK.md, getting-started.md, SMOKE_TESTING.md (×2),
#           smoke-test-devnet.ts header, load-test-discovery.ts header
#           all said `npx ts-node` — `ts-node` is not a workspace
#           dependency, `tsx` is
#
# Each fix only landed when an audit happened to look at the right file.
# This gate makes those bug classes non-recurring on the user-facing surface
# (README, SUBMISSION, JUDGE_RUNBOOK, CONTRIBUTING, docs/*.md outside
# audits/ and adr/, and executable scripts under scripts/).
#
# Allowlisted (deliberately excluded):
#   docs/audits/*  — audit history may reference broken commands as evidence
#   docs/adr/*     — historical record; ADR text is locked once Accepted
#   This script itself — contains the patterns it's looking for
#
# Usage: bash scripts/check-doc-commands.sh

set -euo pipefail

cd "$(dirname "$0")/.."

# Patterns that indicate a broken executable instruction in user docs.
# Each pattern is paired with a one-line "why this is broken" message.
declare -a PATTERNS=(
  'npm install @agenomics/'
  'npm i @agenomics/'
  'npx @agenomics/'
  'npx ts-node '
)
declare -a REASONS=(
  '@agenomics/* is a source-only release (ADR-136 deferred clause); npm install 404s. Use git-clone + npm install at workspace root.'
  '@agenomics/* is a source-only release (ADR-136 deferred clause); npm install 404s. Use git-clone + npm install at workspace root.'
  '@agenomics/* is a source-only release (ADR-136 deferred clause); npx 404s. Run `node mcp-server/dist/index.js` directly.'
  '`ts-node` is not a workspace dependency; `tsx` is. Use `npx tsx` instead.'
)

# Files / globs to LINT.
declare -a TARGETS=(
  README.md
  SUBMISSION.md
  CONTRIBUTING.md
  JUDGE_RUNBOOK.md
  RELEASE.md
)
# Add docs/*.md (top-level, not the audit / ADR subdirs).
while IFS= read -r f; do TARGETS+=("$f"); done < <(find docs -maxdepth 1 -type f -name '*.md')
# Add scripts/*.sh and scripts/*.ts (header comments are user-facing).
while IFS= read -r f; do TARGETS+=("$f"); done < <(find scripts -maxdepth 1 -type f \( -name '*.sh' -o -name '*.ts' \) | grep -v "scripts/check-doc-commands.sh")

FAIL=0
for i in "${!PATTERNS[@]}"; do
  pattern="${PATTERNS[$i]}"
  reason="${REASONS[$i]}"
  # `|| true` — empty grep result is fine, exits 1 under pipefail otherwise.
  hits=$( (grep -nF "$pattern" "${TARGETS[@]}" 2>/dev/null || true) | grep -v ':#' || true )
  if [ -n "$hits" ]; then
    echo "::error::Doc-commands lint: forbidden pattern \"$pattern\""
    echo "  Reason: $reason"
    echo "$hits" | sed 's/^/    /'
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "Doc-commands drift detected. To fix, replace each broken command with the working invocation."
  echo "Allowlist (deliberately excluded from this gate): docs/audits/*, docs/adr/*, this script."
  exit 1
fi

echo "Doc-commands lint passed: no broken executable instructions found in user-facing surfaces."
