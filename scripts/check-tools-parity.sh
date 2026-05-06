#!/usr/bin/env bash
# Verifies that the canonical 27-tool set is consistent across three independent
# surfaces. This bug class — drift between mcp-server's allTools[], dashboard's
# MCP_TOOLS array, and the README's tool list — caused multiple PRs of fix-up
# work in the 2026-05-06 submission-readiness sweep (notably PR #80, where the
# dashboard had a stale 25-tool list).
#
# What's enforced:
#   1. All three surfaces report the SAME COUNT (currently 27).
#   2. mcp-server's tool names are EXACTLY the union of dashboard's MCP_TOOLS
#      and README's tool list — no stale or unknown names anywhere.
#
# What's intentionally NOT enforced:
#   - Per-program counts (Vault 9 / Registry 7 / Settlement 10 / Governance 1)
#     are documented in the README header but reading them statically is
#     fragile — the union check below catches the same drift class without
#     coupling to the markdown structure.
#
# Usage: bash scripts/check-tools-parity.sh

set -euo pipefail

cd "$(dirname "$0")/.."

# --- 1. Source-of-truth: mcp-server/src/tools/index.ts allTools[] ---
SERVER_TOOLS_FILE="mcp-server/src/tools/index.ts"

# allTools[] entries look like:    foobarTool,
# Convert FooBarTool → foo_bar (camelCase → snake_case, drop "Tool" suffix).
SERVER_NAMES=$(awk '/^export const allTools/,/^\];/' "$SERVER_TOOLS_FILE" \
  | grep -oE '^\s+[a-zA-Z]+Tool,$' \
  | sed -E 's/^\s+//; s/Tool,$//; s/([a-z0-9])([A-Z])/\1_\2/g; s/([A-Z]+)([A-Z][a-z])/\1_\2/g' \
  | tr 'A-Z' 'a-z' \
  | sort -u)

SERVER_COUNT=$(echo "$SERVER_NAMES" | wc -l)

# --- 2. Dashboard MCP_TOOLS array ---
DASH_FILE="dashboard/src/data/programs.js"

DASH_NAMES=$(awk '/^export const MCP_TOOLS/,/^\];/' "$DASH_FILE" \
  | grep -oE 'name:\s*"[a-z_]+"' \
  | sed -E 's/name:\s*"([a-z_]+)"/\1/' \
  | sort -u)

DASH_COUNT=$(echo "$DASH_NAMES" | wc -l)

# --- 3. README tool inventory ---
# README "## MCP Tools (N)" section lists tool names as backtick-wrapped
# identifiers, grouped by program. Extract everything between the section
# header and the next ## header.
README_FILE="README.md"

README_NAMES=$(awk '/^## MCP Tools/,/^## [^M]/' "$README_FILE" \
  | grep -oE '`[a-z_]+`' \
  | tr -d '`' \
  | sort -u)

README_COUNT=$(echo "$README_NAMES" | wc -l)

# --- 4. Compare ---
echo "Tool counts:"
echo "  mcp-server allTools[]: $SERVER_COUNT"
echo "  dashboard MCP_TOOLS:   $DASH_COUNT"
echo "  README MCP Tools:      $README_COUNT"

FAIL=0

if [ "$SERVER_COUNT" -ne "$DASH_COUNT" ]; then
  echo "::error::Count mismatch — mcp-server has $SERVER_COUNT tools, dashboard has $DASH_COUNT"
  echo "Tools in mcp-server but not dashboard:"
  comm -23 <(echo "$SERVER_NAMES") <(echo "$DASH_NAMES") | sed 's/^/  /'
  echo "Tools in dashboard but not mcp-server (likely stale):"
  comm -13 <(echo "$SERVER_NAMES") <(echo "$DASH_NAMES") | sed 's/^/  /'
  FAIL=1
fi

if [ "$SERVER_COUNT" -ne "$README_COUNT" ]; then
  echo "::error::Count mismatch — mcp-server has $SERVER_COUNT tools, README lists $README_COUNT"
  echo "Tools in mcp-server but not README:"
  comm -23 <(echo "$SERVER_NAMES") <(echo "$README_NAMES") | sed 's/^/  /'
  echo "Tools in README but not mcp-server (likely stale):"
  comm -13 <(echo "$SERVER_NAMES") <(echo "$README_NAMES") | sed 's/^/  /'
  FAIL=1
fi

# Even if counts match, name-set must be identical.
if ! diff -q <(echo "$SERVER_NAMES") <(echo "$DASH_NAMES") >/dev/null 2>&1; then
  echo "::error::Tool name set mismatch between mcp-server and dashboard"
  diff <(echo "$SERVER_NAMES") <(echo "$DASH_NAMES")
  FAIL=1
fi

if ! diff -q <(echo "$SERVER_NAMES") <(echo "$README_NAMES") >/dev/null 2>&1; then
  echo "::error::Tool name set mismatch between mcp-server and README"
  diff <(echo "$SERVER_NAMES") <(echo "$README_NAMES")
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "Tool parity drift detected. To fix:"
  echo "  - Source of truth is mcp-server/src/tools/index.ts allTools[]."
  echo "  - Update dashboard/src/data/programs.js MCP_TOOLS to match."
  echo "  - Update README.md '## MCP Tools (N)' section to match."
  exit 1
fi

echo "Tool parity check passed: $SERVER_COUNT tools consistent across all three surfaces."
