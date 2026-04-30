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
import { pathToFileURL } from "node:url";
import { allTools } from "./tools/index.js";
import { getConnection, getWalletPublicKey } from "./solana.js";
import { createRpc } from "./solana-v2.js";

import { createActionRouter } from "./adapters/mcp.js";
import { allActions } from "./actions/index.js";
import { activeIdempotencyBackend } from "./pipeline/idempotency.js";
import { assertVaultLayoutMatchesIdl } from "./pipeline/vault-layout-drift.js";
import { getEvoClient, resolveEvoBridgeConfig } from "./adapters/evo-bridge.js";
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
  makeRateLimiter,
  readRateLimitConfig,
} from "./transport/rate-limit.js";
import {
  makeOriginGate,
  readOriginGateConfig,
} from "./transport/origin-gate.js";
import {
  serverLogger as log,
  newCorrelationId,
  withRequestContext,
} from "./util/logger.js";
import {
  initTracing,
  startMcpMetricsServer,
  tracedToolCall,
} from "./observability.js";

/**
 * Agenomics MCP Server — all 25 actions dispatched through the ADR-058
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
  // AUD-206 (cycle-3, roadmap §3 B2): protocol-governance claim required
  // to invoke `verify_protocol_invariants` through the MCP surface. The
  // on-chain ix is already gated by `ProtocolConfig.authority`; this
  // claim is the default-deny wall at the MCP boundary (ADR-058 §4).
  "gov:invariant:check",
  // ADR-129 Phase 1 (cycle-3): agent-memory claims. `read:agent-memory`
  // gates `find_similar_agents`. `write:agent-memory` is declared for
  // forward-compatibility with Phase 2's learn-loop and is granted to
  // the local-dev wallet so future enabling of Phase 2 in dev doesn't
  // require a separate cap rotation.
  "read:agent-memory",
  "write:agent-memory",
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

  // ADR-090: mint a correlation id for every dispatch boundary.
  const reqId = newCorrelationId();
  const reqLog = withRequestContext(log, reqId);
  reqLog.debug({ tool: toolName }, "mcp dispatch begin");

  return tracedToolCall(toolName, async () => {
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
          text: JSON.stringify(result.value, null, 2),
        } as TextContent,
      ],
    };
  });
});

async function main() {
  // ADR-104: initialise OTel tracing (opt-in via OTEL_EXPORTER_OTLP_ENDPOINT)
  // and start the Prometheus scrape endpoint on METRICS_PORT (default 9101).
  initTracing();
  const metricsPort = Number(process.env.METRICS_PORT ?? 9101);
  startMcpMetricsServer(metricsPort);

  // ADR-083: detect transport posture from env BEFORE we touch the wallet or
  // bind any socket. Misconfigured HTTP/Unix modes hard-fail here with an
  // actionable error message.
  const posture = detectTransportPosture(process.env);
  logTransportPosture(posture);

  // ADR-129 Phase 1: eagerly resolve the EVO client at boot so that a
  // misconfigured `AEP_EVO_ENABLED=true` (missing AEP_EVO_MODEL_DIR,
  // bogus AEP_EVO_BINARY) fails loudly here rather than on the first
  // MCP call. When the kill-switch is OFF (default), this resolves to a
  // no-op DisabledEvoClient — no subprocess is spawned and observe /
  // retrieve return void / empty-results respectively.
  const evoClient = getEvoClient();
  const evoConfig = resolveEvoBridgeConfig(process.env);

  // MCP-311 (ADR-119, Batch D): runtime IDL-drift defense for the
  // generated `vault-layout.generated.ts` artifact. Build-time CI gate is
  // the primary guard; this catches the case where the operator deployed
  // a stale generated artifact against a newer IDL. Best-effort — when
  // the IDL is not present in the runtime image (e.g. tarball-only
  // install), the check no-ops with a debug log.
  try {
    assertVaultLayoutMatchesIdl();
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), audit: "MCP-311" },
      "vault-layout drift detected at boot; refusing to serve",
    );
    throw err;
  }

  if (posture.mode === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else if (posture.mode === "http") {
    await startHttpTransport(posture);
  } else {
    await startUnixTransport(posture);
  }

  // AUD-031: the v2 RPC was already constructed once at module load (passed
  // into `createActionRouter` as `preflightDeps.rpc`). The previous second
  // call here discarded its return value and existed only as a placeholder
  // comment for the ADR-012 PR3 migration.

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
      // ADR-129 Phase 1: surface the EVO kill-switch state in the boot
      // log so operators can confirm at a glance whether agent-memory
      // is live. `evo_binary` / `evo_db` are only meaningful when enabled.
      evo_enabled: evoClient.enabled,
      evo_binary: evoClient.enabled ? evoConfig.binaryPath : undefined,
      evo_db: evoClient.enabled ? evoConfig.dbPath : undefined,
      // ADR-129 §"Resilience primitives" (MCP-300/301/302/305) — surface
      // the live policy so operators see what they tuned.
      evo_call_timeout_ms: evoClient.enabled ? evoConfig.resilience.callTimeoutMs : undefined,
      evo_max_queue_depth: evoClient.enabled ? evoConfig.resilience.maxQueueDepth : undefined,
      evo_breaker_threshold: evoClient.enabled ? evoConfig.resilience.failureThreshold : undefined,
      evo_max_restarts: evoClient.enabled ? evoConfig.resilience.maxRestarts : undefined,
      evo_protocol_major: evoClient.enabled ? evoConfig.resilience.protocolMajor : undefined,
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

  // MCP-321 (ADR-132): origin allowlist runs FIRST so cross-origin probes
  // don't even consume rate-limit bucket capacity. Server-to-server callers
  // (no Origin header) pass through; browser cross-origin requests must
  // match `AEP_MCP_HTTP_ALLOWED_ORIGINS`.
  const originGateConfig = readOriginGateConfig(process.env);
  const originGate = makeOriginGate(originGateConfig);

  // MCP-320: Per-bucket rate limit in front of the auth gate. Bucketing is
  // bearer-token-first, IP-fallback (see `transport/rate-limit.ts` header
  // for full rationale). The limiter runs BEFORE auth so unauthenticated
  // probes also hit the IP bucket — this closes the token-guessing axis.
  // Mirrors the relay pattern at `src/x402-relay/index.ts:390-432`.
  const rateLimitConfig = readRateLimitConfig(process.env);
  const rateLimiter = makeRateLimiter(rateLimitConfig);

  const authMiddleware = makeBearerAuthMiddleware({
    expectedToken: posture.httpToken!,
  });
  // Order: origin → rate-limit → bearer-auth → downstream
  const wrapped = originGate.middleware(
    rateLimiter.middleware(authMiddleware(downstream)),
  );
  const httpServer = http.createServer(wrapped);

  // Best-effort graceful shutdown: drop the pruner interval and clear the
  // bucket map. The interval is already `.unref()`d so process exit isn't
  // blocked, but releasing it on SIGTERM keeps tests (and tools that watch
  // the active-handle table) clean. Listeners are deduplicated implicitly
  // by node — re-binding under nodemon won't pile them up.
  const onShutdown = (): void => {
    rateLimiter.shutdown();
  };
  process.once("SIGTERM", onShutdown);
  process.once("SIGINT", onShutdown);

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

  log.info(
    {
      transport: "http",
      host: posture.httpHost,
      port: posture.httpPort,
      auth: "bearer-token",
      rate_limit_window_ms: rateLimitConfig.windowMs,
      rate_limit_max_requests: rateLimitConfig.maxRequests,
      rate_limit_trusted_proxy_hops: rateLimitConfig.trustedProxyHops,
      origin_allowlist_count: originGateConfig.allowedOrigins.length,
      origin_allowlist: originGateConfig.allowedOrigins,
      adr: "ADR-083 + ADR-132",
      audit: "MCP-320 + MCP-321",
    },
    "MCP server bound (HTTP + bearer-token auth + rate limit + origin gate enforced)",
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

  // CYCLE4-MCP-001 (Batch H): unix transport now wraps the same origin-gate
  // + rate-limit middleware chain HTTP transport uses. Closes the
  // asymmetric-defense gap that opened when MCP-322 / ADR-132 made `unix`
  // the new container default — without these, an in-container peer with
  // socket reachability could fire unbounded `vault_transfer` calls (the
  // exact axis MCP-320 closed at HTTP). Bucket key collapses to a single
  // global bucket (`unix:global`) — no bearer / IP precedence on AF_UNIX.
  // Per-peer bucketing requires SO_PEERCRED introspection deferred to the
  // mTLS upgrade per ADR-083 §"Upgrade path to mTLS".
  const originGateConfig = readOriginGateConfig(process.env);
  const originGate = makeOriginGate(originGateConfig);
  const rateLimitConfig = readRateLimitConfig(process.env, { unixMode: true });
  const rateLimiter = makeRateLimiter(rateLimitConfig);
  const wrapped = originGate.middleware(rateLimiter.middleware(downstream));

  const onShutdown = (): void => {
    rateLimiter.shutdown();
  };
  process.once("SIGTERM", onShutdown);
  process.once("SIGINT", onShutdown);

  const httpServer = http.createServer(wrapped);

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
        log.warn(
          {
            unix_path: posture.unixPath,
            err: e instanceof Error ? e.message : String(e),
          },
          "mcp-auth: chmod 600 on unix socket failed (best-effort)",
        );
      }
      resolve();
    });
  });

  log.info(
    {
      transport: "unix",
      unix_path: posture.unixPath,
      peer_uid_enforced: posture.unixAllowedUid !== undefined,
      peer_uid: posture.unixAllowedUid,
      rate_limit_window_ms: rateLimitConfig.windowMs,
      rate_limit_max_requests: rateLimitConfig.maxRequests,
      rate_limit_unix_mode: true,
      origin_allowlist_count: originGateConfig.allowedOrigins.length,
      adr: "ADR-083 + ADR-132",
      audit: "MCP-320 + MCP-321 + CYCLE4-MCP-001",
    },
    "MCP server bound (Unix-domain socket + origin gate + rate limit enforced)",
  );
}

// ADR-091 (ESM): replaces the CJS `require.main === module` entrypoint
// guard. Compare `import.meta.url` to `argv[1]` resolved to a file:// URL —
// true only when this module is invoked directly (e.g. `node dist/index.js`),
// false when imported for tests.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    log.fatal({ err: error }, "fatal error");
    process.exit(1);
  });
}
