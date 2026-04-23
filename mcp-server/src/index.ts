import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import * as http from "http";
import * as net from "net";
import * as fs from "fs";
import { allTools } from "./tools/index.js";
import { getConnection, getWalletPublicKey } from "./solana.js";
import { createRpc } from "./solana-v2.js";

import { createActionRouter } from "./adapters/mcp.js";
import { allActions } from "./actions/index.js";
import { activeIdempotencyBackend } from "./pipeline/idempotency.js";
import type { ActionContext } from "./types/action.js";
import type { Capability } from "./types/capability.js";
import {
  detectTransportPosture,
  logTransportPosture,
  makeBearerAuthMiddleware,
  verifyPeerUid,
  type TransportPosture,
} from "./transport/auth-gate.js";
import {
  serverLogger as log,
  newCorrelationId,
  withRequestContext,
} from "./util/logger.js";

/**
 * Agenomics MCP Server — all 23 actions dispatched through the ADR-058
 * capability-gated ActionRouter. Legacy switch-case dispatch retired in PR1.5.
 *
 * Replay-protection backend (ADR-059 §5) is selected by the `AEP_REDIS_URL`
 * environment variable:
 *   - unset  → in-memory store (single-instance, PR5 default)
 *   - set    → Redis-backed store (multi-instance safe; requires ioredis)
 * See `./pipeline/idempotency.ts` and `./pipeline/idempotency-redis.ts`.
 */

const server = new Server(
  { name: "aep-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Wire the v2 Kit RPC into the preflight dispatch path so gates that need
// on-chain state (cluster_health, account_rent_exempt, daily_cap_not_exhausted,
// token_daily_cap_not_exhausted, dispute_window_open) have a working RPC.
// Without this, every gate declared on an action would fail with
// "no RPC configured" before reaching the handler.
export const actionRouter = createActionRouter(allActions, {
  preflightDeps: { rpc: createRpc() },
});

const ALL_CAPABILITIES: Capability[] = [
  "read:settlement",
  "read:registry",
  "read:vault",
  "sign:settlement",
  "sign:registry",
  "sign:vault",
  "sign:cross_program:settlement+registry",
  "admin:settlement",
  "admin:registry",
  "admin:vault",
];

/**
 * PR1.5 runs the server in local-dev mode: single wallet, all capabilities
 * granted, signed mode. Hosted/multi-tenant mode lands in PR3 (per-request
 * JWT → Capability set resolver).
 */
function buildLocalDevContext(): ActionContext {
  return {
    mode: "signed",
    wallet: {
      publicKey: getWalletPublicKey(),
      capabilities: new Set<Capability>(ALL_CAPABILITIES),
    },
    signer: null, // PR3 will wire @solana/keychain-core here
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  // ADR-090: every dispatch boundary mints a correlation id. The id is
  // attached to every log line emitted while this dispatch runs and is
  // available downstream (via context) so indexer rows + x402 JWTs can
  // pin back to the originating MCP call.
  const reqId = newCorrelationId();
  const reqLog = withRequestContext(log, reqId);
  reqLog.debug({ tool: toolName }, "mcp dispatch begin");

  const ctx = buildLocalDevContext();
  const result = await actionRouter.dispatch(toolName, args, ctx);

  if (!result.ok) {
    reqLog.warn(
      { tool: toolName, error_code: result.error.code },
      "mcp dispatch error",
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.error, null, 2),
        } as TextContent,
      ],
      isError: true,
    };
  }

  reqLog.debug({ tool: toolName }, "mcp dispatch ok");
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result.data, null, 2),
      } as TextContent,
    ],
  };
});

async function main() {
  // ADR-083: detect transport posture from env BEFORE we touch the wallet or
  // bind any socket. Misconfigured HTTP/Unix modes hard-fail here with an
  // actionable error message.
  const posture = detectTransportPosture(process.env);
  logTransportPosture(posture);

  if (posture.mode === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else if (posture.mode === "http") {
    await startHttpTransport(posture);
  } else {
    await startUnixTransport(posture);
  }

  // ADR-012 PR2: initialise the @solana/kit (v2) RPC alongside the v1
  // surface. Nothing in the dispatch path reads it yet — handlers still go
  // through Anchor + v1. PR3 will migrate read paths + introduce the
  // tx-pipeline.
  createRpc();

  const idemBackend = activeIdempotencyBackend();
  log.info(
    {
      transport: posture.mode,
      agent_wallet: getWalletPublicKey().toBase58(),
      rpc_v1_endpoint: getConnection().rpcEndpoint,
      rpc_v2_endpoint:
        process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
      actions_count: allActions.length,
      idempotency_backend: idemBackend,
      // Note: AEP_REDIS_URL is on the redaction list so it surfaces as
      // [REDACTED] in JSON output even though we pass it here.
      idempotency_redis_url:
        idemBackend === "redis" ? process.env.AEP_REDIS_URL : undefined,
    },
    "agenomics mcp server started",
  );
}

/**
 * ADR-083: HTTP transport with mandatory bearer-token auth.
 *
 * The token presence + length was already validated by
 * `detectTransportPosture`. Here we wire `StreamableHTTPServerTransport`
 * behind the auth middleware and bind to the configured host/port.
 *
 * Stateless mode (`sessionIdGenerator: undefined`) — every request stands
 * alone and the SDK serializes per-request state internally via
 * `handleRequest`.
 */
async function startHttpTransport(posture: TransportPosture): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);

  const downstream: http.RequestListener = (req, res) => {
    void transport.handleRequest(req, res);
  };

  const middleware = makeBearerAuthMiddleware({
    expectedToken: posture.httpToken!,
  });
  const httpServer = http.createServer(middleware(downstream));

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    // CI lint gate: this is one of two `httpServer.listen(` call sites in
    // mcp-server/src/**, both inside the auth-gated wrapper. See
    // scripts/check-mcp-transport-auth.sh and ADR-083 §"CI lint gate".
    httpServer.listen(posture.httpPort, posture.httpHost, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  console.error(
    `MCP server bound to http://${posture.httpHost}:${posture.httpPort} ` +
      `(bearer-token auth enforced; ADR-083)`,
  );
}

/**
 * ADR-083: Unix-domain-socket transport.
 *
 * Optional `AEP_MCP_ALLOWED_UID` enforces a peer-uid check via
 * `verifyPeerUid` (v0.1.0: process-uid cross-check; the per-connection
 * SO_PEERCRED variant lands with the mTLS upgrade). When unset, the
 * socket-mode-0600 (set below) is the only gate — correct on a single-uid
 * host and explicitly documented in the README SECURITY section.
 */
async function startUnixTransport(posture: TransportPosture): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);

  const downstream: http.RequestListener = (req, res) => {
    void transport.handleRequest(req, res);
  };

  const httpServer = http.createServer(downstream);

  // Optional peer-credential gate. We attach it on `connection` so the check
  // happens before any HTTP framing is parsed.
  if (posture.unixAllowedUid !== undefined) {
    httpServer.on("connection", (sock: net.Socket) => {
      if (!verifyPeerUid(sock, posture.unixAllowedUid!)) {
        sock.destroy();
      }
    });
  }

  // Remove a stale socket file so a restart after an unclean shutdown
  // succeeds. Operator must ensure the parent directory itself is mode 0700.
  if (fs.existsSync(posture.unixPath!)) {
    fs.unlinkSync(posture.unixPath!);
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(posture.unixPath, () => {
      httpServer.removeListener("error", reject);
      // Restrict perms on the socket file itself.
      try {
        fs.chmodSync(posture.unixPath!, 0o600);
      } catch (e) {
        // Non-fatal; the socket exists, perms are best-effort. Operators
        // on filesystems that don't support chmod (rare on Unix) need to
        // rely on parent-directory perms.
        console.error(
          `mcp-auth: chmod 600 on ${posture.unixPath} failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      resolve();
    });
  });

  console.error(
    `MCP server bound to unix:${posture.unixPath} ` +
      (posture.unixAllowedUid !== undefined
        ? `(peer-uid=${posture.unixAllowedUid} enforced; ADR-083)`
        : "(socket mode 0600; no peer-uid check; ADR-083)"),
  );
}

if (require.main === module) {
  main().catch((error) => {
    log.fatal({ err: error }, "fatal error");
    process.exit(1);
  });
}
