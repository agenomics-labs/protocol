/**
 * Vercel Functions adapter for the Agenomics MCP server.
 *
 * Vercel Functions are per-request and stateless, so the long-lived
 * `http.createServer().listen()` pattern in `src/index.ts` doesn't apply.
 * Instead this module:
 *
 *   1) Materializes the wallet from `SOLANA_WALLET_JSON` into `/tmp` so the
 *      keyfile-permission check in `src/transport/auth-gate.ts` passes. (The
 *      Vercel filesystem is read-only except `/tmp`.)
 *   2) Imports the wired `server` from `dist/index.js` — the same Server
 *      instance with both `ListToolsRequestSchema` and `CallToolRequestSchema`
 *      handlers registered.
 *   3) Connects it to a stateless `StreamableHTTPServerTransport` once per
 *      cold start, reusing the transport across warm invocations.
 *   4) Wraps the per-request flow with the same origin → rate-limit →
 *      bearer-auth middleware chain `startHttpTransport` uses.
 *
 * The metrics-port bind from `main()` is intentionally skipped — Vercel
 * doesn't allow listening on a secondary port.
 *
 * Required env vars:
 *   AEP_MCP_AUTH_TOKEN          — bearer token (>=16 bytes; openssl rand -hex 32)
 *   SOLANA_WALLET_JSON          — single-line JSON keypair (server-side, devnet-only)
 *   AEP_MCP_HTTP_ALLOWED_ORIGINS — defaults to "https://claude.ai,https://*.claude.ai"
 *
 * Vercel injects nothing else; `SOLANA_RPC_URL` defaults to devnet.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// Materialize the wallet BEFORE importing index.ts, because solana.ts caches
// the loaded keypair after the first lookup. Set the env var so the loader
// reads from /tmp instead of the default home-dir path.
const walletJson = process.env.SOLANA_WALLET_JSON;
if (walletJson && !process.env.SOLANA_KEYPAIR_PATH?.startsWith("/tmp/")) {
  const walletPath = path.join("/tmp", "aep-mcp-wallet.json");
  if (!fs.existsSync(walletPath)) {
    fs.writeFileSync(walletPath, walletJson, { mode: 0o600 });
  }
  process.env.SOLANA_KEYPAIR_PATH = walletPath;
}

// Defaults that match the Dockerfile so behavior is consistent across hosts.
process.env.AEP_MCP_TRANSPORT = process.env.AEP_MCP_TRANSPORT ?? "http";
process.env.AEP_MCP_HTTP_ALLOWED_ORIGINS =
  process.env.AEP_MCP_HTTP_ALLOWED_ORIGINS ??
  "https://claude.ai,https://*.claude.ai";
process.env.SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { server } from "../dist/index.js";
import {
  makeBearerAuthMiddleware,
  MIN_TOKEN_BYTES,
} from "../dist/transport/auth-gate.js";
import {
  makeRateLimiter,
  readRateLimitConfig,
} from "../dist/transport/rate-limit.js";
import {
  makeOriginGate,
  readOriginGateConfig,
} from "../dist/transport/origin-gate.js";

// Module-level singletons. Cold-start runs once; warm invocations reuse.
const expectedToken = process.env.AEP_MCP_AUTH_TOKEN ?? "";
if (Buffer.byteLength(expectedToken, "utf8") < MIN_TOKEN_BYTES) {
  throw new Error(
    `AEP_MCP_AUTH_TOKEN must be set (>=${MIN_TOKEN_BYTES} bytes). ` +
      `Generate with: openssl rand -hex 32`,
  );
}

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});
// Top-level await is allowed in Vercel Node.js runtime (ESM).
await server.connect(transport);

const originGate = makeOriginGate(readOriginGateConfig(process.env));
const rateLimiter = makeRateLimiter(readRateLimitConfig(process.env));
const authMiddleware = makeBearerAuthMiddleware({ expectedToken });

const downstream = (req: IncomingMessage, res: ServerResponse): void => {
  void transport.handleRequest(req, res);
};

// origin → rate-limit → bearer-auth → downstream
const wrapped = originGate.middleware(
  rateLimiter.middleware(authMiddleware(downstream)),
);

export default function handler(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  // Liveness probe — bypass all gates.
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/api/healthz")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ready\n");
    return;
  }
  wrapped(req, res);
}
