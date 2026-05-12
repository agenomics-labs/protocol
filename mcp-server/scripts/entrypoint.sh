#!/usr/bin/env sh
# Entrypoint for hosted MCP server deployments (Fly, Railway, Render, etc.).
#
# Responsibilities:
#   1) Materialize a single-line wallet JSON secret into a file at
#      $SOLANA_KEYPAIR_PATH with mode 0600, because the wallet loader
#      (mcp-server/src/solana.ts) refuses to load keyfiles whose mode is
#      more permissive than 0600 — see auth-gate.ts.
#   2) Map the platform-injected $PORT (Railway, Render, Heroku-style) to
#      $AEP_MCP_HTTP_PORT so the transport posture detector picks it up.
#   3) Exec node so signals (SIGTERM from the platform) reach the server
#      directly, not the shell wrapper.

set -eu

WALLET_PATH="${SOLANA_KEYPAIR_PATH:-/secrets/wallet.json}"

if [ -n "${SOLANA_WALLET_JSON:-}" ]; then
  mkdir -p "$(dirname "$WALLET_PATH")"
  # printf %s avoids trailing newlines that would corrupt the JSON parse.
  printf '%s' "$SOLANA_WALLET_JSON" > "$WALLET_PATH"
  chmod 600 "$WALLET_PATH"
  echo "[entrypoint] wallet materialized at $WALLET_PATH (mode 600)"
elif [ ! -f "$WALLET_PATH" ]; then
  echo "[entrypoint] FATAL: no wallet found at $WALLET_PATH and SOLANA_WALLET_JSON is empty" >&2
  echo "[entrypoint] Set SOLANA_WALLET_JSON to the JSON content of a Solana keypair file (single line)." >&2
  exit 1
fi

# Railway / Render / Heroku inject $PORT; map it to the MCP env name.
if [ -n "${PORT:-}" ] && [ -z "${AEP_MCP_HTTP_PORT:-}" ]; then
  export AEP_MCP_HTTP_PORT="$PORT"
  echo "[entrypoint] PORT=$PORT mapped to AEP_MCP_HTTP_PORT"
fi

# Sanity-check the bearer token early so the failure message is more
# obvious than a 401-from-the-server-itself loop on a misconfigured deploy.
if [ "${AEP_MCP_TRANSPORT:-http}" = "http" ]; then
  if [ -z "${AEP_MCP_AUTH_TOKEN:-}" ]; then
    echo "[entrypoint] FATAL: AEP_MCP_AUTH_TOKEN is empty; HTTP transport refuses to start." >&2
    echo "[entrypoint] Generate with: openssl rand -hex 32" >&2
    exit 1
  fi
fi

exec node /app/mcp-server/dist/index.js
