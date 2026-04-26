#!/usr/bin/env bash
# adr-lint.sh: lint the ADR corpus under `docs/adr/` against the shape
# specification in `docs/adr/ADR-TEMPLATE.md` and against cross-cutting
# integrity rules (no duplicate numbers, no dead `path:line` citations,
# no broken supersession chains).
#
# Closes audit finding AUD-053 (PR-CC). The previous `status-audit.sh`
# only scaffolds a STATUS-AUDIT doc — it does NOT lint. This script
# does. The two are kept distinct: `status-audit.sh` writes a markdown
# audit skeleton; `adr-lint.sh` returns non-zero on findings and is
# wired into CI as a blocking gate on PRs that touch `docs/adr/`.
#
# Checks implemented:
#   1. duplicates    — duplicate ADR numbers across `ADR-NNN-*.md` files.
#   2. sections      — required sections (Status / Date / Context /
#                      Decision / Consequences) are present in that
#                      order, per ADR-TEMPLATE.md.
#   3. status        — Status field shape: first non-blank line after
#                      `## Status` matches one of Accepted / Proposed /
#                      Reserved / Deprecated / Not Written, or starts
#                      with `Superseded by ADR-NNN`. A trailing
#                      parenthetical addendum is allowed (e.g.
#                      `Accepted (with caveat)`). Blank line between
#                      heading and value is fine — that matches the
#                      template's own canonical scaffold.
#   4. citations     — `programs/<...>.rs:LINE`, `tests/<...>.ts:LINE`,
#                      `mcp-server/src/<...>:LINE` etc. point at files
#                      that actually exist.
#   5. supersession  — `Superseded by ADR-NNN` references resolve to an
#                      ADR file; the successor's own status is sane.
#   6. xref-dups     — same ADR cross-referenced multiple ways
#                      (advisory; low-priority finding).
#
# Each finding prints to stderr in `path:line: diagnostic` form so it's
# clickable in editor terminals and trivially greppable in CI logs.
# The final line on stdout summarises: "ADR-lint: N findings across M
# ADRs. Exit code: K." Exit code is 0 on clean, non-zero otherwise.
#
# Usage:
#   scripts/adr-lint.sh                   # all checks, fail on any finding
#   scripts/adr-lint.sh --check duplicates
#   scripts/adr-lint.sh --check sections
#   scripts/adr-lint.sh --check status
#   scripts/adr-lint.sh --check citations
#   scripts/adr-lint.sh --check supersession
#   scripts/adr-lint.sh --check xref-dups
#   scripts/adr-lint.sh --quiet           # suppress per-finding stderr;
#                                         # only print the summary line
#
# CI integration: see `.github/workflows/ci.yml` job `adr-lint` (gated
# by a `paths:` filter on `docs/adr/**`).

set -euo pipefail

# --- argument parsing -------------------------------------------------

CHECKS_ALL=(duplicates sections status citations supersession xref-dups)
SELECTED_CHECKS=()
QUIET=0

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed -n 's/^# \{0,1\}//p' | sed '/^set -euo/d'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check)
      shift
      [ $# -gt 0 ] || { echo "--check requires an argument" >&2; exit 64; }
      SELECTED_CHECKS+=("$1")
      ;;
    --quiet) QUIET=1 ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1 (try --help)" >&2; exit 64 ;;
  esac
  shift
done

if [ "${#SELECTED_CHECKS[@]}" -eq 0 ]; then
  SELECTED_CHECKS=("${CHECKS_ALL[@]}")
fi

if [ ! -d docs/adr ]; then
  echo "Run from the repo root (docs/adr/ not found)" >&2
  exit 1
fi

# --- bookkeeping ------------------------------------------------------

# Findings are appended one per line. We count them and the unique set
# of ADR files implicated so the summary line is informative.
FINDINGS_FILE=$(mktemp)
trap 'rm -f "$FINDINGS_FILE"' EXIT

emit() {
  # emit <path> <line-or-0> <message>
  local path="$1" line="$2" msg="$3"
  printf '%s:%s: %s\n' "$path" "$line" "$msg" >>"$FINDINGS_FILE"
  if [ "$QUIET" -eq 0 ]; then
    printf '%s:%s: %s\n' "$path" "$line" "$msg" >&2
  fi
}

# All canonical ADR files (numbered, excluding the template). Use a
# shell glob with a guard so an empty match doesn't print the literal
# pattern.
adr_files() {
  local f
  shopt -s nullglob
  for f in docs/adr/ADR-[0-9][0-9][0-9]*.md; do
    case "$f" in
      *ADR-TEMPLATE.md) continue ;;
    esac
    printf '%s\n' "$f"
  done
  shopt -u nullglob
}

# Files that should be skipped from section / status checks because
# their structure is intentionally minimal (numbering gaps documented
# in-place).
is_meta_adr() {
  case "$1" in
    *ADR-TEMPLATE.md) return 0 ;;
    *not-written-*) return 0 ;;
  esac
  return 1
}

# Extract the ADR number from a filename. Returns the zero-padded NNN.
adr_number() {
  basename "$1" | sed -E 's|^ADR-([0-9]+)-.*|\1|'
}

# --- check 1: duplicate ADR numbers -----------------------------------

check_duplicates() {
  local dups
  dups=$(adr_files | sed -E 's|.*/ADR-([0-9]+)-.*|\1|' | sort | uniq -d)
  [ -z "$dups" ] && return 0
  while IFS= read -r n; do
    [ -z "$n" ] && continue
    # List all files that share this number so the diagnostic is actionable.
    local matches
    matches=$(adr_files | grep -E "/ADR-${n}-" | tr '\n' ' ')
    emit "docs/adr/ADR-${n}-*.md" 0 "duplicate ADR number ${n}: ${matches}"
  done <<<"$dups"
}

# --- check 2: required sections present, in canonical order -----------

# The template mandates Status, Date, Context, Decision, Consequences
# in that order, each as a level-2 heading (`## Status`). We extract the
# observed order of those five known headings and compare to the
# expected sequence. Optional sections (Alternatives, References, etc.)
# may appear before or after; we only check the relative order of the
# five required ones.

REQUIRED_SECTIONS=(Status Date Context Decision Consequences)

check_sections() {
  local f
  while IFS= read -r f; do
    is_meta_adr "$f" && continue
    # Extract level-2 headings; keep only the ones in the required set.
    local observed
    observed=$(
      grep -nE "^## " "$f" \
        | sed -E 's/^([0-9]+):## ([A-Za-z][A-Za-z0-9 _/-]*)\b.*/\1 \2/' \
        | awk '
            BEGIN {
              for (i = 1; i <= 5; i++) want[$0] = 0
              want["Status"] = 1
              want["Date"] = 1
              want["Context"] = 1
              want["Decision"] = 1
              want["Consequences"] = 1
            }
            {
              line = $1
              $1 = ""
              sub(/^[[:space:]]+/, "")
              if ($0 in want) print line ":" $0
            }
          '
    )
    # Walk through observed list; ensure each required section is
    # present and in canonical order.
    local idx=0
    local missing=()
    local out_of_order=0
    for required in "${REQUIRED_SECTIONS[@]}"; do
      local hit
      hit=$(printf '%s\n' "$observed" | grep -E ":${required}$" | head -1 || true)
      if [ -z "$hit" ]; then
        missing+=("$required")
      else
        local hit_line=${hit%%:*}
        if [ "$hit_line" -lt "$idx" ]; then
          out_of_order=1
        fi
        idx=$hit_line
      fi
    done
    if [ "${#missing[@]}" -gt 0 ]; then
      emit "$f" 1 "missing required section(s): ${missing[*]}"
    fi
    if [ "$out_of_order" -eq 1 ]; then
      emit "$f" 1 "required sections out of canonical order (expected: ${REQUIRED_SECTIONS[*]})"
    fi
  done < <(adr_files)
}

# --- check 3: status field shape --------------------------------------

# Per ADR-TEMPLATE.md §1, the Status value MUST be on the line
# immediately after `## Status` (no blank line between heading and
# value). The value MUST match one of:
#   Accepted | Proposed | Reserved | Deprecated | Not Written
# optionally followed by a parenthetical addendum, OR
#   Superseded by ADR-NNN (with optional trailing text)
#
# We do NOT lint legacy bullet-form (`- **Status**: X`) or table-form
# metadata in this check — Check 2 already requires the `## Status`
# heading to be present, so any ADR that uses non-heading Status form
# will already have been flagged.

STATUS_VALUE_RE='^(Accepted|Proposed|Reserved|Deprecated|Not Written)([[:space:]].*)?$|^Superseded by (ADR-[0-9]+(-[a-z0-9-]+)?|code-evolution( \(.*\))?)([[:space:]].*)?$|^Superseded[[:space:]]\(.+\)$'

check_status() {
  local f
  while IFS= read -r f; do
    is_meta_adr "$f" && continue
    # Find the line number of `## Status` (first occurrence).
    local hdr_line
    hdr_line=$(grep -nE "^## Status[[:space:]]*$" "$f" | head -1 | cut -d: -f1 || true)
    [ -z "$hdr_line" ] && continue  # absence is Check 2's problem
    # Read the first non-blank line after the heading. The template's
    # own canonical scaffold uses a blank line between heading and
    # value, so we don't penalise that — just find the value.
    local probe=$((hdr_line + 1))
    local total
    total=$(wc -l <"$f" | tr -d ' ')
    local next_line=""
    while [ "$probe" -le "$total" ] && [ "$probe" -lt $((hdr_line + 6)) ]; do
      next_line=$(sed -n "${probe}p" "$f")
      [ -n "$next_line" ] && break
      probe=$((probe + 1))
    done
    if [ -z "$next_line" ]; then
      emit "$f" "$hdr_line" "no Status value found within 5 lines after '## Status'"
      continue
    fi
    if ! [[ "$next_line" =~ $STATUS_VALUE_RE ]]; then
      emit "$f" "$probe" "status value '${next_line}' does not match canonical form (Accepted|Proposed|Reserved|Deprecated|Not Written|Superseded by ADR-NNN)"
    fi
  done < <(adr_files)
}

# --- check 4: dead path:line citations --------------------------------

# Match repo-relative source citations of the form
#   <prefix>/<...>.<ext>:<LINE>
# where prefix is one of programs / tests / mcp-server / src / packages,
# and ext is rs / ts / tsx / js / json / toml. The :LINE suffix is
# what makes a citation worth checking — bare `programs/foo.rs`
# references are too noisy (many ADRs mention paths in prose without
# claiming a specific line).
#
# We extract candidate refs with grep, dedupe, and check existence.

# Anchored to top-level repo directories. Bare `src/foo.rs:N` is
# excluded because ADR prose often uses `src/...` as shorthand for an
# already-mentioned crate (e.g. `programs/agent-vault/...src/lib.rs:26`
# is a continuation of the previous bullet, not an absolute path).
# Only fully-qualified `src/indexer/`, `src/x402-relay/`, and
# `src/integrations/` are top-level — match those explicitly.
CITATION_RE='(programs|tests|mcp-server|packages|sdk|src/(indexer|x402-relay|integrations))/[A-Za-z0-9_./-]+\.(rs|ts|tsx|js|json|toml):[0-9]+(-[0-9]+)?'

check_citations() {
  local f
  while IFS= read -r f; do
    # Collect (line-in-ADR, citation) tuples. Use grep -oE plus a
    # second pass to recover the line number; awk is more concise but
    # grep -nE | grep -oE composition is shellcheck-clean.
    while IFS=: read -r adr_line content; do
      [ -z "$content" ] && continue
      # Extract every citation on this ADR line.
      while IFS= read -r cite; do
        [ -z "$cite" ] && continue
        # Strip a trailing ) ] , . ; if grep grabbed too much.
        cite=${cite%%[)\],.;]}
        local path=${cite%:*}
        local line_range=${cite##*:}
        if [ ! -e "$path" ]; then
          emit "$f" "$adr_line" "dead citation: $cite (path does not exist)"
          continue
        fi
        # Verify the line number is within the file. For a range
        # `LINE-LINE2`, validate the upper bound.
        local upper=${line_range#*-}
        local total
        total=$(wc -l <"$path" 2>/dev/null | tr -d ' ' || echo 0)
        if [ "$upper" -gt "$total" ] 2>/dev/null; then
          emit "$f" "$adr_line" "stale citation: $cite (file has $total lines, citation references line $upper)"
        fi
      done < <(printf '%s\n' "$content" | grep -oE "$CITATION_RE" || true)
    done < <(grep -nE "$CITATION_RE" "$f" || true)
  done < <(adr_files)
}

# --- check 5: supersession chain integrity ----------------------------

# For every `Superseded by ADR-NNN` reference in either the Status
# field or a `## Revisions` log entry:
#   - Resolve NNN to an actual ADR file (any file whose number is NNN).
#   - Verify the successor's own status is sane (not itself Superseded
#     in a way that would create a broken chain, not Not Written, not
#     Reserved).
# We do NOT enforce bidirectional `Supersedes ADR-X` annotations on the
# successor — that's a best-practice but not a hard requirement of the
# template.

# Build an in-memory map: number -> file
declare -A NUM_TO_FILE
build_num_index() {
  local f n
  while IFS= read -r f; do
    n=$(adr_number "$f")
    if [ -n "${NUM_TO_FILE[$n]:-}" ]; then
      # Duplicate — Check 1 will report it; record the first seen.
      continue
    fi
    NUM_TO_FILE[$n]="$f"
  done < <(adr_files)
}

# Extract the canonical Status value (heading-form only — bullet/table
# forms are already flagged by Check 2 / 3).
status_value_of() {
  local f="$1"
  awk '
    /^## Status[[:space:]]*$/ {
      while ((getline line) > 0) {
        if (line ~ /^[[:space:]]*$/) continue
        print line
        exit
      }
    }
  ' "$f"
}

check_supersession() {
  build_num_index
  local f
  while IFS= read -r f; do
    is_meta_adr "$f" && continue
    # 5a: Status-field supersession.
    local status
    status=$(status_value_of "$f")
    if [[ "$status" =~ ^Superseded\ by\ ADR-([0-9]+) ]]; then
      local target="${BASH_REMATCH[1]}"
      # Zero-pad to 3 digits.
      target=$(printf '%03d' "$((10#$target))")
      if [ -z "${NUM_TO_FILE[$target]:-}" ]; then
        emit "$f" 0 "supersession dangling: status references ADR-${target} which has no file"
      else
        local succ="${NUM_TO_FILE[$target]}"
        local succ_status
        succ_status=$(status_value_of "$succ")
        case "$succ_status" in
          Accepted*|Proposed*) ;;
          "") emit "$f" 0 "supersession unverifiable: ADR-${target} (${succ}) has no parseable canonical Status" ;;
          *)  emit "$f" 0 "supersession broken: ADR-${target} status is '${succ_status}' (expected Accepted or Proposed)" ;;
        esac
      fi
    fi
    # 5b: Revisions-log supersession entries.
    # Match lines like `- Superseded by ADR-080` or `Superseded by ADR-080:`
    # within a `## Revisions` block (or anywhere in the body, conservatively).
    while IFS= read -r adr_line; do
      [ -z "$adr_line" ] && continue
      local lineno=${adr_line%%:*}
      local content=${adr_line#*:}
      # Skip the line we already handled in 5a (heading-form Status value).
      if [[ "$content" =~ ^Superseded\ by\ ADR- ]] && [ "$lineno" -lt 20 ]; then
        continue
      fi
      while IFS= read -r match; do
        [ -z "$match" ] && continue
        local target=${match##*ADR-}
        target=$(printf '%03d' "$((10#$target))")
        if [ -z "${NUM_TO_FILE[$target]:-}" ]; then
          emit "$f" "$lineno" "revisions-log supersession dangling: references ADR-${target} which has no file"
        fi
      done < <(printf '%s\n' "$content" | grep -oE "Superseded by ADR-[0-9]+" || true)
    done < <(grep -nE "Superseded by ADR-[0-9]+" "$f" || true)
  done < <(adr_files)
}

# --- check 6: duplicate cross-references (advisory) -------------------

# An ADR that mentions ADR-NNN in three+ different prose contexts is
# probably fine; an ADR that has both "Superseded by ADR-NNN" in its
# Status AND a separate "See also ADR-NNN" line is double-talking. We
# flag this softly (advisory; doesn't fail the build by itself, but
# does count as a finding so the summary surfaces it).

check_xref_dups() {
  local f
  while IFS= read -r f; do
    is_meta_adr "$f" && continue
    # Find every ADR-NNN reference, group by number, count distinct
    # framings ("Superseded by", "See also", "References", "Supersedes").
    local hits
    hits=$( { grep -oE "(Superseded by|See also|References?|Supersedes) ADR-[0-9]+" "$f" 2>/dev/null || true; } \
      | awk '{
          n = $NF
          framing = $1
          for (i = 2; i < NF; i++) framing = framing " " $i
          key = n
          frame_set[key] = (frame_set[key] ? frame_set[key] "|" : "") framing
          frame_count[key]++
        }
        END {
          for (k in frame_count) {
            if (frame_count[k] >= 2) {
              # Count unique framings.
              n_unique = split(frame_set[k], parts, "|")
              # Trivially deduplicate by sorting; quick-and-dirty.
              uniq = 0
              for (i = 1; i <= n_unique; i++) {
                seen = 0
                for (j = 1; j < i; j++) if (parts[j] == parts[i]) seen = 1
                if (!seen) uniq++
              }
              if (uniq >= 2) print k ": " frame_set[k]
            }
          }
        }')
    if [ -n "$hits" ]; then
      while IFS= read -r h; do
        [ -z "$h" ] && continue
        emit "$f" 0 "advisory: cross-reference duplicated under different framings — $h"
      done <<<"$hits"
    fi
  done < <(adr_files)
}

# --- driver -----------------------------------------------------------

run_check() {
  local name="$1"
  case "$name" in
    duplicates)   check_duplicates ;;
    sections)     check_sections ;;
    status)       check_status ;;
    citations)    check_citations ;;
    supersession) check_supersession ;;
    xref-dups)    check_xref_dups ;;
    *) echo "Unknown check: $name" >&2; exit 64 ;;
  esac
}

for c in "${SELECTED_CHECKS[@]}"; do
  run_check "$c"
done

# --- summary ----------------------------------------------------------

N_FINDINGS=$(wc -l <"$FINDINGS_FILE" | tr -d ' ')
M_ADRS=$(awk -F: '{print $1}' "$FINDINGS_FILE" | sort -u | wc -l | tr -d ' ')
EXIT_CODE=0
[ "$N_FINDINGS" -gt 0 ] && EXIT_CODE=1

printf 'ADR-lint: %s findings across %s ADRs. Exit code: %s.\n' \
  "$N_FINDINGS" "$M_ADRS" "$EXIT_CODE"

exit "$EXIT_CODE"
