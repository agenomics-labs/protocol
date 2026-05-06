#!/usr/bin/env bash
# Verifies every relative markdown link in user-facing docs resolves to a
# file that actually exists. Judges clicking through docs hit immediate
# "this is unfinished" signals when links 404; this gate makes that bug
# class non-recurring on the audited surface.
#
# What this gate checks:
#   - Markdown links of the form `[text](path)` where `path` is relative
#     (not http://, https://, mailto:, or a bare #anchor).
#   - The resolved target (relative to the source file's directory, with
#     any #anchor fragment stripped) must exist on disk.
#
# What it does NOT check:
#   - External URLs (http/https) — would require network access in CI;
#     adversarial enough that even a successful response doesn't prove
#     the linked content matches.
#   - Anchor (#section) validity within a target file — markdown anchor
#     resolution is renderer-specific (GitHub's slugger ≠ vitepress's);
#     out of scope.
#   - Auto-link `<https://...>` form (always external).
#
# Surfaces audited:
#   README, SUBMISSION, SUMMARY, JUDGE_RUNBOOK, CONTRIBUTING, RELEASE,
#   top-level docs/*.md (NOT docs/audits/* or docs/adr/* — historical
#   docs may legitimately link to deleted/renamed paths).
#
# Usage: bash scripts/check-md-links.sh

set -euo pipefail

cd "$(dirname "$0")/.."

declare -a TARGETS=(
  README.md
  SUBMISSION.md
  SUMMARY.md
  JUDGE_RUNBOOK.md
  CONTRIBUTING.md
  RELEASE.md
)
while IFS= read -r f; do TARGETS+=("$f"); done < <(find docs -maxdepth 1 -type f -name '*.md')

FAIL=0
TOTAL_LINKS=0

for src in "${TARGETS[@]}"; do
  [ -f "$src" ] || continue
  src_dir=$(dirname "$src")

  # Extract every `](LINK)` pattern. The `LINK` may contain anything except
  # `(`, `)`, ` `, `\n`. We use `grep -oE` then strip the `](` and `)`.
  # `|| true` — empty result is fine; pipefail otherwise aborts.
  links=$( (grep -oE '\]\([^) ]+\)' "$src" || true) | sed 's/^](//; s/)$//')

  while IFS= read -r link; do
    [ -z "$link" ] && continue
    TOTAL_LINKS=$((TOTAL_LINKS + 1))

    # Skip external URLs and bare anchors.
    case "$link" in
      http://*|https://*|mailto:*|'#'*)
        continue
        ;;
    esac

    # Strip query string and fragment.
    target=$(echo "$link" | sed 's/[?#].*$//')

    # Resolve relative to source file's directory.
    if [[ "$target" == /* ]]; then
      # Absolute path — treat as repo-root-relative.
      resolved="${target#/}"
    else
      resolved="$src_dir/$target"
    fi

    # Normalize ./ and ../ via realpath if available; otherwise simple cleanup.
    if command -v realpath >/dev/null 2>&1; then
      # --relative-to keeps the path repo-relative for the error message.
      resolved=$(realpath --relative-to=. "$resolved" 2>/dev/null || echo "$resolved")
    fi

    if [ ! -e "$resolved" ]; then
      # Find the line number for the error annotation.
      line=$(grep -nF "]($link)" "$src" | head -1 | cut -d: -f1)
      echo "::error file=$src,line=${line:-1}::Broken markdown link: \`]($link)\` resolves to \`$resolved\` which does not exist"
      FAIL=1
    fi
  done <<< "$links"
done

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "Markdown link drift detected. To fix:"
  echo "  - If the target was renamed, update the link to the new path."
  echo "  - If the target was deleted, remove the link or replace with text."
  echo "  - Anchor (#section) validity is NOT enforced by this gate; only file existence."
  exit 1
fi

echo "Markdown link check passed: $TOTAL_LINKS relative links across ${#TARGETS[@]} files all resolve."
