#!/usr/bin/env bash
# new-adr.sh: scaffold a new ADR from the canonical shape spec
# (`docs/adr/ADR-TEMPLATE.md`). Picks the next monotonic ADR number,
# slugs the title, fills in today's UTC date, and writes the file.
#
# Usage:
#   scripts/new-adr.sh "Short decision title"
#
# Examples:
#   scripts/new-adr.sh "Indexer concurrency hardening"
#   → docs/adr/ADR-121-indexer-concurrency-hardening.md
#
# The script does not commit — it just creates the file. Edit, review,
# stage, and commit it on a feature branch like any other change.

set -euo pipefail

if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
  echo "Usage: $0 \"Short decision title\"" >&2
  echo >&2
  echo "Picks next ADR number, slugs the title, fills today's date." >&2
  exit 64
fi

TITLE="$1"
ADR_DIR="docs/adr"

if [ ! -d "$ADR_DIR" ]; then
  echo "ADR directory not found: $ADR_DIR" >&2
  echo "Run from the repo root." >&2
  exit 1
fi

# Next ADR number: take max of the numeric prefix across ADR-NNN-*.md
# files and add one. Pure-numeric prefix only (skip the TEMPLATE).
NEXT_NUM=$(
  ls "$ADR_DIR"/ADR-[0-9][0-9][0-9]*.md 2>/dev/null \
    | sed -nE 's|.*/ADR-0*([0-9]+).*|\1|p' \
    | sort -n | tail -1
)
NEXT_NUM=$(( ${NEXT_NUM:-0} + 1 ))
PADDED=$(printf "%03d" "$NEXT_NUM")

# Slug: lowercase, strip non-alphanumerics, collapse to hyphens.
SLUG=$(
  printf '%s' "$TITLE" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g' \
    | sed -E 's/^-+|-+$//g'
)

if [ -z "$SLUG" ]; then
  echo "Could not derive a slug from title: \"$TITLE\"" >&2
  exit 1
fi

DEST="$ADR_DIR/ADR-${PADDED}-${SLUG}.md"
DATE_UTC=$(date -u +%Y-%m-%d)

if [ -e "$DEST" ]; then
  echo "Refusing to overwrite existing file: $DEST" >&2
  exit 1
fi

cat > "$DEST" <<ADR_BODY
# ADR-${PADDED}: ${TITLE}

## Status

Proposed

## Date

${DATE_UTC}

## Context

<what's true today; what constraint forces this decision>

## Decision

<single paragraph; first sentence stands alone as a one-line summary>

## Consequences

- **Positive**: <what improves>
- **Negative**: <what gets harder; new failure modes>
- **Follow-ups**: <explicit follow-on work items>
ADR_BODY

echo "Created: $DEST"
