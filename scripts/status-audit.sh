#!/usr/bin/env bash
# status-audit.sh: scaffold a STATUS-AUDIT-YYYY-MM-DD.md per the
# shape specification in `docs/adr/STATUS-AUDIT-TEMPLATE.md`.
#
# NOTE: this script is a doc-scaffolder, NOT a linter. For the actual
# ADR shape/integrity lint (duplicate numbers, dead path:line citations,
# broken supersession chains, missing required sections), see
# `scripts/adr-lint.sh` (added under PR-CC / AUD-053).
#
# By default this writes a dry-run skeleton to stdout so you can
# inspect it. Use `--write` to land it at
# `docs/adr/STATUS-AUDIT-<UTC-DATE>.md` (refuses to overwrite).
#
# The script auto-fills the mechanical sections (git state, ADR
# counts, crate list). Narrative sections — test totals, code
# hygiene commentary, papers/on-chain-artifacts headlines, runtime
# state, benchmark headlines, known gaps, recommended next moves,
# one-line verdict — must be filled in by an agent before commit.
#
# Usage:
#   scripts/status-audit.sh           # dry-run skeleton to stdout
#   scripts/status-audit.sh --write   # write to docs/adr/STATUS-AUDIT-<DATE>.md

set -euo pipefail

WRITE=0
case "${1:-}" in
  --write) WRITE=1 ;;
  -h|--help)
    sed -n '2,/^set -euo/p' "$0" | sed -n 's/^# \{0,1\}//p' | sed '/^set -euo/d'
    exit 0
    ;;
  "") ;;
  *) echo "Unknown arg: $1 (try --help)" >&2; exit 64 ;;
esac

if [ ! -d docs/adr ]; then
  echo "Run from the repo root (docs/adr/ not found)" >&2
  exit 1
fi

DATE_UTC=$(date -u +%Y-%m-%d)
DEST="docs/adr/STATUS-AUDIT-${DATE_UTC}.md"

if [ "$WRITE" -eq 1 ] && [ -e "$DEST" ]; then
  echo "Refusing to overwrite: $DEST" >&2
  echo "Audits are write-once; if today already has one, edit it by hand or pick a different date." >&2
  exit 1
fi

# --- mechanical data --------------------------------------------------

HEAD_SHORT=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
UPSTREAM="origin/${BRANCH}"
AHEAD="?"
BEHIND="?"
if git rev-parse --verify --quiet "$UPSTREAM" >/dev/null 2>&1; then
  AHEAD=$(git rev-list --count "${UPSTREAM}..HEAD" 2>/dev/null || echo "?")
  BEHIND=$(git rev-list --count "HEAD..${UPSTREAM}" 2>/dev/null || echo "?")
fi

# Today's landings: merge commits and squash-merges since 00:00 UTC.
TODAY_LANDINGS=$(
  git log --since="${DATE_UTC} 00:00:00 +0000" --no-merges \
    --format='- `%h` %s' 2>/dev/null \
    || true
)
[ -z "$TODAY_LANDINGS" ] && TODAY_LANDINGS="- (no landings yet today)"

# ADR totals — count by canonical Status heading.
TOTAL_ADRS=$(ls docs/adr/ADR-[0-9][0-9][0-9]*.md 2>/dev/null | wc -l)
ACCEPTED=0; PROPOSED=0; SUPERSEDED=0; RESERVED=0; NOT_WRITTEN=0; DEPRECATED=0; OTHER=0
for f in docs/adr/ADR-[0-9][0-9][0-9]*.md; do
  [ -f "$f" ] || continue
  status=$(awk '
    # Form 1: "## Status\n\n<value>"
    /^##[[:space:]]+Status[[:space:]]*$/ {
      while ((getline line) > 0 && line ~ /^[[:space:]]*$/) {}
      print line
      exit
    }
    # Form 2: "**Status:** X" or "- **Status**: X" or "**Status**: X"
    # Match any line containing **Status (optionally inside a list item),
    # capture text after the last bold-close + any colons.
    /\*\*Status/ {
      if (match($0, /\*\*Status[^*]*\*\*/)) {
        rest = substr($0, RSTART + RLENGTH)
        sub(/^[[:space:]:*]+/, "", rest)
        sub(/[[:space:]]+$/, "", rest)
        if (rest != "") { print rest; exit }
      }
    }
    # Form 3: "| Status | X |" markdown table
    /^\|[[:space:]]*Status[[:space:]]*\|/ {
      n = split($0, parts, "|")
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", parts[3])
      print parts[3]
      exit
    }
  ' "$f")
  case "$status" in
    Accepted*) ACCEPTED=$((ACCEPTED + 1)) ;;
    Proposed*) PROPOSED=$((PROPOSED + 1)) ;;
    Superseded*) SUPERSEDED=$((SUPERSEDED + 1)) ;;
    Reserved*) RESERVED=$((RESERVED + 1)) ;;
    "Not Written"*) NOT_WRITTEN=$((NOT_WRITTEN + 1)) ;;
    Deprecated*) DEPRECATED=$((DEPRECATED + 1)) ;;
    *) OTHER=$((OTHER + 1)) ;;
  esac
done

# Crate list (Rust workspaces under programs/).
CRATES=$(
  find programs -maxdepth 2 -name Cargo.toml 2>/dev/null \
    | sed -E 's|programs/([^/]+)/Cargo.toml|- `\1`|' \
    | sort
)
[ -z "$CRATES" ] && CRATES="- (no crates detected under programs/)"

# Working tree dirtiness.
DIRTY="clean"
git diff --quiet || DIRTY="dirty (unstaged changes)"
if ! git diff --cached --quiet 2>/dev/null; then DIRTY="dirty (staged changes)"; fi
UNTRACKED=$(git ls-files --others --exclude-standard | wc -l)

# --- skeleton ---------------------------------------------------------

skeleton() {
  cat <<HEADER
# Protocol — Status Audit ${DATE_UTC}

- **Date**: ${DATE_UTC}
- **HEAD**: \`${HEAD_SHORT}\`
- **Branch**: \`${BRANCH}\` · upstream \`${UPSTREAM}\` · ahead ${AHEAD} · behind ${BEHIND}
- **Working tree**: ${DIRTY}; ${UNTRACKED} untracked
- **Template**: see \`docs/adr/STATUS-AUDIT-TEMPLATE.md\`

> **Note**: machine-filled sections below are marked _(auto)_; replace
> agent-filled placeholders \`[…]\` with narrative before committing.

---

## 1. Git state _(auto)_

- **HEAD**: \`${HEAD_SHORT}\`
- **Branch**: \`${BRANCH}\` · upstream \`${UPSTREAM}\` · ahead ${AHEAD} · behind ${BEHIND}
- **Today's landings** (${DATE_UTC}, chronological):

${TODAY_LANDINGS}

## 2. Workspace layout _(auto for crates, agent for narrative)_

[narrative — describe bounded contexts and what changed at the macro level]

Crates detected under \`programs/\`:

${CRATES}

## 3. ADRs _(auto)_

**Totals** (${TOTAL_ADRS} ADR files under \`docs/adr/\`, plus templates):

| Status | Count |
|---|---:|
| Accepted | ${ACCEPTED} |
| Proposed | ${PROPOSED} |
| Reserved | ${RESERVED} |
| Superseded | ${SUPERSEDED} |
| Not Written | ${NOT_WRITTEN} |
| Deprecated | ${DEPRECATED} |
| (other / unparseable) | ${OTHER} |

[narrative — call out new Accepted/Proposed since the previous audit]

## 4. Test totals _(agent)_

[fill in: \`cargo test\`, \`anchor test\`, \`npm test\` totals across workspaces]

## 5. Code hygiene _(agent)_

[fill in: \`cargo clippy\`, \`cargo audit\`, \`npm audit\`, lockfile check]

## 6. On-chain artifacts _(agent)_

[fill in: deployed program IDs, IDL drift status, wallet/keypair posture]

## 7. Runtime state — devnet/mainnet _(agent)_

[fill in: indexer, mcp-server, x402-relay observed state]

## 8. Benchmark headlines _(agent)_

[fill in: latency, throughput, regression deltas vs prior audit]

## 9. Known gaps _(agent)_

[fill in: open issues, accepted-but-unimplemented ADRs, blocking findings]

### Things the audit found clean

[fill in: invariants verified during this audit]

## 10. Recommended next moves _(agent)_

[fill in: ranked list of next actions, ideally with effort estimates]

## One-line verdict

[fill in: a single sentence — what state is the repo in?]
HEADER
}

if [ "$WRITE" -eq 1 ]; then
  skeleton > "$DEST"
  echo "Created: $DEST"
  echo
  echo "Next steps:"
  echo "  1. Fill in agent sections (4–10 + verdict)."
  echo "  2. \`git add ${DEST} && git commit -m \"docs(adr): STATUS-AUDIT ${DATE_UTC}\"\`"
else
  skeleton
fi
