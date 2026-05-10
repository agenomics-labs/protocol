#!/usr/bin/env bash
#
# cost-report.sh: estimate engineering effort + labor cost for this repo
# from git history. Three estimators are reported so the reader can see
# the convergence (or disagreement) instead of trusting a single number:
#
#   1. hour-buckets       lower-bound on focused hours = unique
#                         (date, hour) pairs across all commits.
#   2. active-day model   active_days * HOURS_PER_ACTIVE_DAY.
#   3. line-volume        approx (net source LOC) / LOC_PER_DEV_DAY * HPAD.
#                         This is an UPPER bound: it estimates what the
#                         codebase would have cost to write by hand at
#                         classic solo-human throughput, with no AI
#                         assistance. AI-assisted output compresses real
#                         wall-clock to roughly 0.3-0.5x of this number.
#
# Non-labor costs (audits, mainnet rent, RPC/indexer hosting, AI tooling)
# are NOT included — they dominate for protocol work and need their own
# line items. See docs/PRE_MAINNET_ROADMAP.md for those.
#
# Usage:
#   bash scripts/cost-report.sh
#   RATE=250 HPAD=8 bash scripts/cost-report.sh
#
# Env:
#   RATE              loaded $/hour for the engineer (default: 200)
#   HPAD              hours per active day (default: 10)
#   LOC_PER_DAY       LOC throughput per dev-day for the volume model
#                     (default: 250; halve it if you want to credit AI
#                      assistance, double it for boilerplate-heavy work)
#   SINCE             optional git --since= filter, e.g. "2026-04-01"

set -euo pipefail

RATE=${RATE:-200}
HPAD=${HPAD:-10}
LOC_PER_DAY=${LOC_PER_DAY:-250}
SINCE_ARG=()
if [[ -n "${SINCE:-}" ]]; then
  SINCE_ARG=(--since="$SINCE")
fi

cd "$(git rev-parse --show-toplevel)"

commits=$(git log --all "${SINCE_ARG[@]}" --oneline | wc -l | tr -d ' ')
active_days=$(git log --all "${SINCE_ARG[@]}" --pretty=format:'%ad' --date=short | sort -u | wc -l | tr -d ' ')
hour_buckets=$(git log --all "${SINCE_ARG[@]}" --pretty=format:'%ad' --date=iso \
                 | awk '{print $1, substr($2,1,2)}' | sort -u | wc -l | tr -d ' ')
first_commit=$(git log --all "${SINCE_ARG[@]}" --reverse --pretty=format:'%ad' --date=short | awk 'NR==1')
last_commit=$(git log --all "${SINCE_ARG[@]}" --pretty=format:'%ad' --date=short | awk 'NR==1')

read -r added deleted files <<<"$(git log --all "${SINCE_ARG[@]}" --shortstat --pretty=tformat: \
  | awk '/file/ { f+=$1; a+=$4; d+=$6 } END { printf "%d %d %d", a+0, d+0, f+0 }')"

# For the line-volume estimator, exclude lockfiles and other vendored/
# generated noise — those inflate diff size without representing effort.
read -r src_added src_deleted <<<"$(git log --all "${SINCE_ARG[@]}" --shortstat --pretty=tformat: -- \
  ':!**/package-lock.json' ':!**/yarn.lock' ':!**/pnpm-lock.yaml' \
  ':!**/Cargo.lock' ':!**/*.min.js' ':!**/*.min.css' \
  ':!idl/*.json' ':!sdk/idl/src/idl/*.json' ':!target/**' \
  | awk '/file/ { a+=$4; d+=$6 } END { printf "%d %d", a+0, d+0 }')"

# active-day model
hours_active_day=$(( active_days * HPAD ))
# volume model: net source lines (excluding lockfiles) / LOC_PER_DAY * HPAD
net_src=$(( src_added - src_deleted ))
if (( net_src < 0 )); then net_src=0; fi
hours_volume=$(awk -v n="$net_src" -v d="$LOC_PER_DAY" -v h="$HPAD" 'BEGIN { printf "%d", (n/d)*h }')

cost_lb=$(( hour_buckets * RATE ))
cost_ad=$(( hours_active_day * RATE ))
cost_vol=$(( hours_volume * RATE ))

printf '\n=== Agenomics Protocol — engineering effort report ===\n'
printf 'window:           %s -> %s\n' "$first_commit" "$last_commit"
printf 'commits:          %d   (across all branches)\n' "$commits"
printf 'active days:      %d\n' "$active_days"
printf 'lines added:      %d   (incl. lockfiles)\n' "$added"
printf 'lines deleted:    %d   (across %d files)\n' "$deleted" "$files"
printf 'source lines:     +%d / -%d   (lockfiles excluded; net +%d)\n' \
  "$src_added" "$src_deleted" "$net_src"
printf '\n--- estimators (rate=$%d/h, HPAD=%d, LOC_PER_DAY=%d) ---\n' "$RATE" "$HPAD" "$LOC_PER_DAY"
printf '  hour-buckets    %4d h  ~ $%d   (lower bound)\n' "$hour_buckets" "$cost_lb"
printf '  active-day      %4d h  ~ $%d\n'                  "$hours_active_day" "$cost_ad"
printf '  line-volume     %4d h  ~ $%d\n'                  "$hours_volume" "$cost_vol"
printf '\nNote: excludes audits, mainnet deploy rent, RPC/indexer/MCP hosting,\n'
printf 'and AI tooling. See docs/PRE_MAINNET_ROADMAP.md for those line items.\n'
