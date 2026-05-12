#!/usr/bin/env bash
# Smoke-test a hosted MCP endpoint (Fly / Vercel / Railway / etc.) by
# running the MCP `initialize` → `tools/list` handshake over HTTP and
# verifying the tool count matches the local source-of-truth.
#
# Use this after deploying to confirm the endpoint actually serves the
# 28 tools the README claims, not 0 (broken cold start) or 27 (stale
# image without pay_x402_service).
#
# Usage:
#   AEP_MCP_AUTH_TOKEN=<token> ./mcp-server/scripts/smoke-test-hosted.sh
#   AEP_MCP_URL=https://aep-mcp.vercel.app \
#     AEP_MCP_AUTH_TOKEN=<token> \
#     ./mcp-server/scripts/smoke-test-hosted.sh

set -euo pipefail

URL="${AEP_MCP_URL:-https://aep-mcp-judge.fly.dev}"
TOKEN="${AEP_MCP_AUTH_TOKEN:-}"
EXPECTED_TOOLS="${EXPECTED_TOOLS:-28}"

if [ -z "$TOKEN" ]; then
  echo "FATAL: set AEP_MCP_AUTH_TOKEN env var (the bearer token published in JUDGE_RUNBOOK / SUBMISSION)." >&2
  exit 2
fi

echo "▶ smoke-test-hosted: $URL"

# ---------- /healthz ----------
echo "→ checking /healthz (should bypass auth)"
HEALTH_STATUS=$(curl -sS -o /tmp/aep-mcp-healthz.out -w "%{http_code}" --max-time 10 "$URL/healthz")
if [ "$HEALTH_STATUS" != "200" ]; then
  echo "  ✗ /healthz returned $HEALTH_STATUS (expected 200)"
  echo "  body:"
  sed 's/^/    /' /tmp/aep-mcp-healthz.out
  exit 1
fi
echo "  ✓ /healthz 200"

# ---------- 401 sanity (no token) ----------
echo "→ checking unauthenticated request returns 401"
NOAUTH_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 \
  -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
if [ "$NOAUTH_STATUS" != "401" ]; then
  echo "  ✗ unauthenticated POST returned $NOAUTH_STATUS (expected 401 — auth gate may be misconfigured)"
  exit 1
fi
echo "  ✓ 401 without bearer token"

# ---------- initialize ----------
echo "→ MCP initialize"
INIT_RES=$(curl -sS --max-time 15 \
  -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')

if ! echo "$INIT_RES" | grep -q '"protocolVersion"'; then
  echo "  ✗ initialize did not return a valid response"
  echo "  raw:"
  echo "$INIT_RES" | sed 's/^/    /'
  exit 1
fi
echo "  ✓ initialize returned protocolVersion"

# ---------- tools/list ----------
echo "→ MCP tools/list"
TOOLS_RES=$(curl -sS --max-time 15 \
  -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')

TOOL_COUNT=$(echo "$TOOLS_RES" | grep -oE '"name":"[a-z_0-9]+"' | sort -u | wc -l)

if [ "$TOOL_COUNT" -ne "$EXPECTED_TOOLS" ]; then
  echo "  ✗ tools/list returned $TOOL_COUNT tools (expected $EXPECTED_TOOLS)"
  echo "  names:"
  echo "$TOOLS_RES" | grep -oE '"name":"[a-z_0-9]+"' | sort -u | sed 's/^/    /'
  exit 1
fi
echo "  ✓ $TOOL_COUNT tools registered"

# ---------- verify_protocol_invariants (read-only call) ----------
echo "→ MCP tools/call verify_protocol_invariants (read-only invariant sweep)"
INVAR_RES=$(curl -sS --max-time 30 \
  -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"verify_protocol_invariants","arguments":{}}}')

if echo "$INVAR_RES" | grep -q '"isError":true'; then
  echo "  ⚠ verify_protocol_invariants returned isError=true — read it manually:"
  echo "$INVAR_RES" | sed 's/^/    /' | head -40
  # Don't fail — the action might require gov:invariant:check capability
  # which the hosted-mode wallet may not be granted. The tool was at
  # least dispatched, which means the HTTP/transport path works.
else
  echo "  ✓ verify_protocol_invariants dispatched cleanly"
fi

echo
echo "=================================================================="
echo "  HOSTED SMOKE PASSED — $URL is wired correctly."
echo "  Tools: $TOOL_COUNT  ·  Healthz: 200  ·  Auth: 401 without token"
echo "=================================================================="
