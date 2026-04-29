/**
 * MCP-320 — HTTP transport rate limiter.
 *
 * The MCP server's HTTP transport (see `src/index.ts:startHttpTransport`)
 * is bearer-token-authenticated but had no rate limiting. An authenticated
 * caller (or a leaked token) could fire unbounded `vault_transfer` calls;
 * the only backpressure was the wallet's SOL balance. Cycle-3 audit flagged
 * this as a Critical asymmetric defense gap relative to the x402-relay,
 * which already had a per-IP rate-limit layer at
 * `src/x402-relay/index.ts:390-432` (`pruneRateLimitMap` + `rateLimit`).
 *
 * This module mirrors that prior art with two adaptations for the MCP
 * threat model:
 *
 *   1. Bucket key precedence is **bearer-token-first, IP-fallback**. Reason:
 *      a leaked token is the audit's main concern; we want the abusive token
 *      to deplete its own bucket without consuming the IP's budget. An
 *      unauthenticated probe (no parseable Bearer header) is bucketed by IP
 *      so token-guessing also gets rate-limited.
 *
 *   2. The bearer token is **SHA-256-hashed before use as a Map key** so the
 *      in-memory rate-limit table never holds plaintext tokens. The relay's
 *      IP-keyed map has no equivalent concern (an IP isn't a secret); ours
 *      does. The same primitive is used by `verifyBearerToken` in
 *      `auth-gate.ts:188-194`.
 *
 * Transport scope:
 *   - HTTP transport ONLY. Stdio is parent-process-trusted (see ADR-083 +
 *     `auth-gate.ts:105-107`); rate-limiting it would be misplaced — the
 *     parent IS the trust boundary. Unix-socket transport with the optional
 *     UID check is similarly trusted (same-uid peers); rate-limiting there
 *     would shed legitimate same-uid load with no security benefit. Both are
 *     intentionally NOT rate-limited.
 *
 * Trust model for IP fallback:
 *   - `X-Forwarded-For` is honored ONLY when `AEP_MCP_TRUST_PROXY=1`. By
 *     default we read `req.socket.remoteAddress` so a non-proxied deployment
 *     cannot be spoofed by an attacker setting `X-Forwarded-For: 1.2.3.4`
 *     to skip past their own bucket.
 *
 * Wiring: see `src/index.ts:startHttpTransport`. The middleware MUST run
 * BEFORE the bearer-auth middleware so unauthenticated probes also hit the
 * IP-bucket (closes the token-guessing axis).
 */

import * as crypto from "crypto";
import * as http from "http";
import { extractBearerToken } from "./auth-gate.js";
import { serverLogger } from "../util/logger.js";

const log = serverLogger.child({ component: "mcp-rate-limit" });

// ==================== CONSTANTS ====================

/** Default sliding-window length (ms). 60s mirrors the relay default. */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Default max requests per window per bucket. 60 ≈ 1 req/sec sustained,
 * sized for agent-bursty MCP usage (a typical orchestration loop fires
 * 5-20 tool calls in a burst, then pauses). Operators with heavier
 * workloads override via `AEP_MCP_RATE_LIMIT_MAX_REQUESTS`.
 */
export const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 60;

/**
 * Memory cap on the rate-limit table. 100k entries × ~80B/entry ≈ 8 MB,
 * matching the relay's MAX_RATE_LIMIT_ENTRIES rationale at
 * `src/x402-relay/index.ts:388`. When the cap is hit, oldest insertion-
 * order entries are evicted; safe because each entry already expires
 * after `windowMs`.
 */
export const MAX_RATE_LIMIT_ENTRIES = 100_000;

// ==================== CONFIG PARSING ====================

export interface RateLimitConfig {
  readonly windowMs: number;
  readonly maxRequests: number;
  /**
   * When true, honor `X-Forwarded-For` first hop for the IP-fallback
   * bucket. False by default; spoofable in non-proxied deployments.
   */
  readonly trustProxy: boolean;
  /**
   * CYCLE4-MCP-001 (Batch H): when true, ALL requests share a single
   * global bucket (`unix:global`) regardless of headers or remote
   * address. Used by the unix-domain-socket transport, where there is
   * no bearer token, no meaningful `req.socket.remoteAddress`, and the
   * trust boundary is filesystem ACL + (optional) peer-uid. The
   * single-bucket throughput cap closes the unbounded-call axis MCP-320
   * already closed at HTTP, with the fall-back-to-global rationale per
   * `docs/audits/CYCLE-4-MCP-PUNCHLIST.md` CYCLE4-MCP-001 §"Suggested
   * closure path". HTTP transport keeps `unixMode: false`.
   */
  readonly unixMode: boolean;
}

export interface RateLimitConfigEnv {
  readonly AEP_MCP_RATE_LIMIT_WINDOW_MS?: string;
  readonly AEP_MCP_RATE_LIMIT_MAX_REQUESTS?: string;
  readonly AEP_MCP_TRUST_PROXY?: string;
}

/**
 * Parse env into a {@link RateLimitConfig}. Throws on garbage so a
 * misconfiguration fails at boot rather than silently disabling the limit.
 *
 * Defaults applied per-field independently — `AEP_MCP_RATE_LIMIT_WINDOW_MS`
 * unset uses {@link DEFAULT_RATE_LIMIT_WINDOW_MS} regardless of whether the
 * other vars are set.
 */
export function readRateLimitConfig(
  env: RateLimitConfigEnv,
  opts: { unixMode?: boolean } = {},
): RateLimitConfig {
  const windowMs = parsePositiveInt(
    env.AEP_MCP_RATE_LIMIT_WINDOW_MS,
    "AEP_MCP_RATE_LIMIT_WINDOW_MS",
    DEFAULT_RATE_LIMIT_WINDOW_MS,
  );
  const maxRequests = parsePositiveInt(
    env.AEP_MCP_RATE_LIMIT_MAX_REQUESTS,
    "AEP_MCP_RATE_LIMIT_MAX_REQUESTS",
    DEFAULT_RATE_LIMIT_MAX_REQUESTS,
  );
  const trustProxy = parseTrustProxyFlag(env.AEP_MCP_TRUST_PROXY);
  return { windowMs, maxRequests, trustProxy, unixMode: opts.unixMode ?? false };
}

function parsePositiveInt(
  raw: string | undefined,
  varName: string,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  // Strict integer regex — `parseInt("1.5")` would silently truncate to 1,
  // which is a misconfiguration we want to surface, not normalize.
  // Same for "12abc" (parseInt yields 12). Require a pure digit string.
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `${varName}="${raw}" must be a positive integer. ` +
        `Default: ${fallback}.`,
    );
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${varName}="${raw}" must be a positive integer. ` +
        `Default: ${fallback}.`,
    );
  }
  return parsed;
}

function parseTrustProxyFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no") return false;
  if (v === "1" || v === "true" || v === "yes") return true;
  throw new Error(
    `AEP_MCP_TRUST_PROXY="${raw}" must be one of: 0,1,true,false,yes,no. ` +
      `Default: 0 (off — X-Forwarded-For is ignored).`,
  );
}

// ==================== RATE LIMITER ====================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitDeniedEvent {
  readonly bucketKind: "token" | "ip" | "unix";
  readonly remoteAddress: string | undefined;
  readonly url: string | undefined;
  readonly retryAfterSec: number;
}

export type RateLimitLogger = (e: RateLimitDeniedEvent) => void;

export interface RateLimiter {
  /**
   * Wraps a downstream `http.RequestListener` with the rate-limit gate.
   * Mirrors the shape of `makeBearerAuthMiddleware` in `auth-gate.ts` so
   * the two compose cleanly: `rateLimit(authMiddleware(downstream))`.
   */
  readonly middleware: (
    downstream: http.RequestListener,
  ) => http.RequestListener;
  /**
   * Stop the periodic pruner and clear in-memory state. Call from the
   * graceful-shutdown path. Idempotent.
   */
  readonly shutdown: () => void;
  /** Test hook — current map size. */
  readonly _size: () => number;
}

export interface RateLimiterOptions {
  /** Defaults to `Date.now`; tests pass a fake clock. */
  readonly now?: () => number;
  /** Defaults to a structured pino warn. Tests inject. */
  readonly onDenied?: RateLimitLogger;
  /**
   * Defaults to `setInterval` / `clearInterval`. Tests override to avoid
   * leaving timers behind in the Node runner.
   */
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
}

/**
 * Build a rate limiter with the given config. The pruner runs on
 * `setInterval(..., windowMs).unref()` so it never blocks process
 * shutdown — but `shutdown()` is still provided for clean teardown
 * (tests, SIGTERM handlers).
 */
export function makeRateLimiter(
  config: RateLimitConfig,
  opts: RateLimiterOptions = {},
): RateLimiter {
  const now = opts.now ?? Date.now;
  const onDenied = opts.onDenied ?? defaultDeniedLogger;
  const setIntervalFn = opts.setInterval ?? setInterval;
  const clearIntervalFn = opts.clearInterval ?? clearInterval;

  const map = new Map<string, RateLimitEntry>();

  const pruner = setIntervalFn(() => {
    pruneMap(map, now());
  }, config.windowMs);
  // Don't keep the event loop alive just for the pruner.
  if (typeof (pruner as { unref?: () => void }).unref === "function") {
    (pruner as { unref: () => void }).unref();
  }

  const middleware = (downstream: http.RequestListener): http.RequestListener => {
    return (req, res) => {
      const key = bucketKeyFor(req, config);
      const t = now();
      const entry = map.get(key.value);

      if (!entry || t >= entry.resetAt) {
        // First request in this window — replace any expired entry.
        map.set(key.value, { count: 1, resetAt: t + config.windowMs });
        // Evict oldest entries if we've blown through the cap. Done on
        // insert (not just in the periodic pruner) so a flood-of-distinct-
        // keys can't grow the map past the cap between prune ticks.
        if (map.size > MAX_RATE_LIMIT_ENTRIES) {
          evictOldest(map, map.size - MAX_RATE_LIMIT_ENTRIES);
        }
        downstream(req, res);
        return;
      }

      if (entry.count >= config.maxRequests) {
        const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
        onDenied({
          bucketKind: key.kind,
          remoteAddress: req.socket.remoteAddress,
          url: req.url,
          retryAfterSec,
        });
        write429(res, retryAfterSec);
        return;
      }

      entry.count += 1;
      downstream(req, res);
    };
  };

  return {
    middleware,
    shutdown: () => {
      clearIntervalFn(pruner as unknown as NodeJS.Timeout);
      map.clear();
    },
    _size: () => map.size,
  };
}

// ==================== INTERNALS ====================

interface BucketKey {
  readonly kind: "token" | "ip" | "unix";
  /**
   * The Map key. For tokens this is a SHA-256 hex digest, never the raw
   * token. For IPs it's `ip:<addr>` so a token whose hex digest happened
   * to collide with `ip:127.0.0.1` (it can't, but defense in depth) is in
   * a separate keyspace. For unix transport (CYCLE4-MCP-001 closure) the
   * single global bucket is `unix:global`.
   */
  readonly value: string;
}

/**
 * Choose the bucket key for a request. Precedence:
 *   1. Bearer token from `Authorization` header → `tok:<sha256>`.
 *   2. `X-Forwarded-For` first hop, only if `trustProxy` → `ip:<addr>`.
 *   3. `req.socket.remoteAddress` → `ip:<addr>`.
 *   4. `ip:unknown` as a last-resort fallback so we never throw.
 *
 * Different bucket kinds for the same caller live in DIFFERENT slots —
 * an unauthenticated probe from IP X uses `ip:X`; a subsequent
 * Bearer-bearing request from IP X uses `tok:<hash>`. That's deliberate:
 * a leaked token shouldn't be able to drain the IP's budget, and the
 * IP shouldn't be able to drain the token's budget.
 */
function bucketKeyFor(
  req: http.IncomingMessage,
  config: RateLimitConfig,
): BucketKey {
  // CYCLE4-MCP-001 (Batch H): unix transport collapses to a single global
  // bucket. No bearer-token / IP precedence — there is no bearer auth on
  // unix and `req.socket.remoteAddress` is empty for AF_UNIX. Per-peer
  // bucketing would require SO_PEERCRED native introspection (deferred to
  // the mTLS upgrade per ADR-083 §"Upgrade path to mTLS"); the global
  // bucket is sufficient defense-in-depth given the filesystem-ACL trust
  // boundary already bounds the caller set to the container.
  if (config.unixMode) {
    return { kind: "unix", value: "unix:global" };
  }

  const authHeader = req.headers["authorization"];
  const headerStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const tok = extractBearerToken(headerStr);
  if (tok !== null) {
    const digest = crypto.createHash("sha256").update(tok, "utf8").digest("hex");
    return { kind: "token", value: `tok:${digest}` };
  }

  if (config.trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const xffStr = Array.isArray(xff) ? xff[0] : xff;
    if (typeof xffStr === "string" && xffStr.length > 0) {
      const firstHop = xffStr.split(",")[0]?.trim();
      if (firstHop) {
        return { kind: "ip", value: `ip:${firstHop}` };
      }
    }
  }

  const peer = req.socket.remoteAddress ?? "unknown";
  return { kind: "ip", value: `ip:${peer}` };
}

function pruneMap(
  map: Map<string, RateLimitEntry>,
  nowMs: number,
): void {
  for (const [key, entry] of map) {
    if (nowMs >= entry.resetAt) {
      map.delete(key);
    }
  }
  if (map.size > MAX_RATE_LIMIT_ENTRIES) {
    evictOldest(map, map.size - MAX_RATE_LIMIT_ENTRIES);
  }
}

function evictOldest(
  map: Map<string, RateLimitEntry>,
  count: number,
): void {
  // Map iteration is insertion-order in JS, so `.keys().next()` gives us
  // the oldest entry. Same idiom as the relay's `pruneRateLimitMap`.
  for (let i = 0; i < count; i++) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function write429(res: http.ServerResponse, retryAfterSec: number): void {
  res.statusCode = 429;
  res.setHeader("Retry-After", String(retryAfterSec));
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      error: "rate_limit_exceeded",
      retryAfter: retryAfterSec,
    }),
  );
}

function defaultDeniedLogger(e: RateLimitDeniedEvent): void {
  log.warn(
    {
      bucket_kind: e.bucketKind,
      remote_address: e.remoteAddress,
      url: e.url,
      retry_after_sec: e.retryAfterSec,
    },
    "mcp-rate-limit: request rejected",
  );
}
