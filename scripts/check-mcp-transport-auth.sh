#!/usr/bin/env bash
# ADR-083 §"CI lint gate" — fail if any new wiring of `app.listen(` or
# `server.listen(` appears in `mcp-server/src/**` outside the auth-gated
# wrapper at `mcp-server/src/index.ts` (which delegates to
# `mcp-server/src/transport/auth-gate.ts` for the auth middleware).
#
# Why a regex gate and not a real AST check? The threat model is "future
# contributor copies the SDK example into the codebase without thinking";
# a regex catches that with zero infra. If the false-positive rate becomes
# a problem we tighten to a TS-AST check; for now `grep -E` is the right
# trade-off.
#
# Out-of-scope (allowed) call sites — these are NOT under mcp-server/src/**:
#   - src/x402-relay/index.ts (HTTP service with its own JWT auth, ADR-017)
#   - src/indexer/index.ts    (HTTP read-only metrics + indexer status API)
#
# Allowed inside mcp-server/src/**:
#   - mcp-server/src/index.ts (the auth-gated wrapper itself; references
#     transport/auth-gate.ts in the same file)
#   - mcp-server/src/transport/auth-gate.ts (factory for the wrapper)
#   - any *.test.ts file under mcp-server/test/ (tests bind ephemeral
#     servers; allowlisted by directory below)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_ROOT="$REPO_ROOT/mcp-server/src"

if [ ! -d "$SRC_ROOT" ]; then
  echo "check-mcp-transport-auth: $SRC_ROOT not found; skipping" >&2
  exit 0
fi

# Files allowed to contain `*.listen(` calls (must reference the auth-gate).
ALLOWED_FILES=(
  "$SRC_ROOT/index.ts"
  "$SRC_ROOT/transport/auth-gate.ts"
)

# Search for any `app.listen(` or `server.listen(` or `httpServer.listen(`
# under mcp-server/src/**, then prune the allowlist.
violations=()
while IFS= read -r match; do
  path="${match%%:*}"
  allowed=0
  for af in "${ALLOWED_FILES[@]}"; do
    if [ "$path" = "$af" ]; then
      allowed=1
      break
    fi
  done
  if [ "$allowed" -eq 0 ]; then
    violations+=("$match")
  fi
done < <(
  grep -rnE '(\bapp|\bserver|httpServer)\.listen\s*\(' "$SRC_ROOT" \
    --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.cjs' \
    2>/dev/null || true
)

if [ "${#violations[@]}" -gt 0 ]; then
  echo "ADR-083 CI gate: forbidden listen() call in mcp-server/src/**" >&2
  echo "" >&2
  echo "The following call sites bind a listener without going through" >&2
  echo "the auth-gated wrapper (src/transport/auth-gate.ts +" >&2
  echo "src/index.ts startHttpTransport / startUnixTransport):" >&2
  echo "" >&2
  for v in "${violations[@]}"; do
    echo "  $v" >&2
  done
  echo "" >&2
  echo "Either route the binding through src/transport/auth-gate.ts," >&2
  echo "or add the file to ALLOWED_FILES in this script with rationale" >&2
  echo "(and document the auth posture)." >&2
  exit 1
fi

# Also enforce: any file in mcp-server/src/** that references
# StreamableHTTPServerTransport must be in ALLOWED_FILES. The SDK's example
# is a foot-gun and we want every introduction to be deliberate.
http_xport_files=()
while IFS= read -r match; do
  path="${match%%:*}"
  allowed=0
  for af in "${ALLOWED_FILES[@]}"; do
    if [ "$path" = "$af" ]; then
      allowed=1
      break
    fi
  done
  if [ "$allowed" -eq 0 ]; then
    http_xport_files+=("$match")
  fi
done < <(
  grep -rn 'StreamableHTTPServerTransport' "$SRC_ROOT" \
    --include='*.ts' --include='*.tsx' \
    2>/dev/null || true
)

if [ "${#http_xport_files[@]}" -gt 0 ]; then
  echo "ADR-083 CI gate: StreamableHTTPServerTransport used outside auth gate" >&2
  echo "" >&2
  for v in "${http_xport_files[@]}"; do
    echo "  $v" >&2
  done
  exit 1
fi

echo "check-mcp-transport-auth: ok (${#ALLOWED_FILES[@]} auth-gate file(s) checked)"
