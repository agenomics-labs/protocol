#!/usr/bin/env bash
# Provision deploy-time secrets across Fly, Vercel, and Railway in one shot.
#
# Generates a fresh AEP_MCP_AUTH_TOKEN, reads the devnet wallet from
# .keys/smoke-test-devnet.json, and pushes both to whichever provider CLIs
# are present + logged in. Prints the token at the end so the operator can
# paste it into the Colosseum submission text + JUDGE_RUNBOOK.
#
# Idempotent: run as many times as you like. Each run rotates the token.
# That's good practice — judge-mode tokens should rotate at least per
# judging cycle.
#
# Usage:
#   ./mcp-server/scripts/deploy-set-secrets.sh           # all detected providers
#   FLY=1 VERCEL=0 RAILWAY=0 ./mcp-server/scripts/deploy-set-secrets.sh
#
# Required:
#   - .keys/smoke-test-devnet.json (committed nowhere; see root .gitignore)
#   - For each provider, the CLI must be installed and authed:
#       fly auth whoami        / curl -L https://fly.io/install.sh | sh
#       vercel whoami          / npm i -g vercel
#       railway whoami         / npm i -g @railway/cli

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WALLET_FILE="${REPO_ROOT}/.keys/smoke-test-devnet.json"

if [ ! -f "$WALLET_FILE" ]; then
  echo "FATAL: wallet file not found at $WALLET_FILE" >&2
  echo "Generate or symlink a funded devnet keypair there first." >&2
  exit 1
fi

# Read the wallet JSON as a single line (no trailing newline).
WALLET_JSON="$(tr -d '\n' < "$WALLET_FILE")"

# Generate a fresh bearer token (64 hex chars = 32 bytes, well above the
# 16-byte minimum enforced by transport/auth-gate.ts).
TOKEN="$(openssl rand -hex 32)"

# Track outcomes for the summary at the end.
DEPLOYED=()

# ---------- Fly.io ----------
if [ "${FLY:-1}" = "1" ] && command -v fly >/dev/null 2>&1; then
  if fly auth whoami >/dev/null 2>&1; then
    echo "[fly] Setting secrets on app aep-mcp-judge..."
    (cd "${REPO_ROOT}/mcp-server" && fly secrets set \
      "AEP_MCP_AUTH_TOKEN=${TOKEN}" \
      "SOLANA_WALLET_JSON=${WALLET_JSON}" \
      --stage)
    DEPLOYED+=("fly: secrets staged; run 'fly deploy' from mcp-server/")
  else
    echo "[fly] CLI present but not logged in — skipping. Run 'fly auth login' first." >&2
  fi
fi

# ---------- Vercel ----------
if [ "${VERCEL:-1}" = "1" ] && command -v vercel >/dev/null 2>&1; then
  if vercel whoami >/dev/null 2>&1; then
    echo "[vercel] Setting env vars on production..."
    cd "${REPO_ROOT}/mcp-server"
    # Vercel env add reads from stdin and requires an environment name.
    # `--force` overwrites without prompting.
    printf '%s' "$TOKEN" | vercel env add AEP_MCP_AUTH_TOKEN production --force >/dev/null
    printf '%s' "$WALLET_JSON" | vercel env add SOLANA_WALLET_JSON production --force >/dev/null
    DEPLOYED+=("vercel: env vars set; next push to main triggers redeploy")
  else
    echo "[vercel] CLI present but not logged in — skipping. Run 'vercel login' first." >&2
  fi
fi

# ---------- Railway ----------
if [ "${RAILWAY:-1}" = "1" ] && command -v railway >/dev/null 2>&1; then
  if railway whoami >/dev/null 2>&1; then
    echo "[railway] Setting variables on linked project..."
    (cd "${REPO_ROOT}/mcp-server" && railway variables \
      --set "AEP_MCP_AUTH_TOKEN=${TOKEN}" \
      --set "SOLANA_WALLET_JSON=${WALLET_JSON}")
    DEPLOYED+=("railway: variables set; redeploy with 'railway up'")
  else
    echo "[railway] CLI present but not logged in — skipping. Run 'railway login' first." >&2
  fi
fi

echo
echo "=================================================================="
echo "  AEP_MCP_AUTH_TOKEN (rotate per judging cycle)"
echo "  ${TOKEN}"
echo "=================================================================="
echo
echo "Paste the token above into:"
echo "  1) Colosseum submission text (judges copy from there)"
echo "  2) JUDGE_RUNBOOK.md ONLY at submission time, NEVER commit"
echo
if [ "${#DEPLOYED[@]}" -eq 0 ]; then
  echo "WARN: no provider CLIs were authenticated. Re-run after installing + logging in." >&2
  exit 2
fi
echo "Providers updated:"
printf '  - %s\n' "${DEPLOYED[@]}"
