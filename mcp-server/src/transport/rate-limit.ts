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
 * Trust model for IP fallback (CYCLE4 hardening):
 *   - `X-Forwarded-For` is read ONLY when `AEP_MCP_TRUSTED_PROXY_HOPS=N`
 *     with N > 0. The integer N counts trusted reverse proxies between the
 *     client and the MCP server. The real client IP is at position
 *     `XFF[len - N]` (Nth from the right), because each trusted proxy
 *     APPENDS the IP it received from. Anything to the left of that
 *     position is attacker-controllable and MUST be ignored. Reading the
 *     leftmost (XFF[0]) — the prior MCP-320 behavior — let an attacker
 *     prepend arbitrary values per request to (a) bypass their own IP
 *     bucket and (b) DoS-deny a victim by exhausting the victim's bucket.
 *     Cycle-4 review caught this; the fix is the hop-count semantic.
 *   - `AEP_MCP_TRUST_PROXY=1` is retained as a deprecated alias mapping to
 *     `AEP_MCP_TRUSTED_PROXY_HOPS=1` so existing deployments behind a
 *     single trusted proxy keep working; a deprecation warning is logged
 *     so operators see it in `git log`-discoverable env-dump runbooks.
 *   - When the XFF header has fewer than N entries, OR the value at
 *     `XFF[len - N]` is not a parseable IP literal, we fall back to
 *     `req.socket.remoteAddress` and emit a `xff_misconfigured` warning.
 *     Fail-safe direction: prefer falling back to the (truthful) socket
 *     peer over honoring an attacker-shaped XFF.
 *   - When `trustedProxyHops === 0` (the default) we read
 *     `req.socket.remoteAddress` directly, so a non-proxied deployment
 *     cannot be spoofed by an attacker setting `X-Forwarded-For:` at all.
 *
 * IPv6 normalization (CYCLE4 hardening):
 *   - All IP-bucket keys pass through `normalizeIp()` which strips the
 *     `::ffff:` IPv4-mapped-IPv6 prefix, strips `[...]` URL brackets, and
 *     lowercases hex digits. Without this, a single client hitting a
 *     dual-stack listener could appear under multiple bucket keys
 *     (`::1`, `::ffff:127.0.0.1`, `127.0.0.1`) and gain a multiplied
 *     budget. Default bind is loopback-only (`auth-gate.ts:127`) so the
 *     real-world exposure was small; operators on `::` / `0.0.0.0` would
 *     have been multiplied 2-3×.
 *
 * Memory cap eviction (CYCLE4 hardening):
 *   - When the bucket map reaches `MAX_RATE_LIMIT_ENTRIES`, we evict ONLY
 *     entries whose window has already expired. If no expired entries
 *     exist, we **fail closed**: reject the new caller with 429 rather
 *     than evict a still-live victim's entry. Prior MCP-320 behavior was
 *     insertion-order eviction, which let an attacker spray distinct
 *     synthetic keys to evict victim entries — when the victim's NEXT
 *     request landed, it created a fresh entry with `count=1`, resetting
 *     the rate-limit progress an attacker had already pushed them
 *     through. Cycle-4 review caught this; fail-closed eviction
 *     preserves victim bucket integrity at the cost of denial-of-
 *     availability for new callers when the map is full of live buckets
 *     — a state that only occurs under active flood, when shedding new
 *     work is the right answer anyway.
 *
 * Wiring: see `src/index.ts:startHttpTransport`. The middleware MUST run
 * BEFORE the bearer-auth middleware so unauthenticated probes also hit the
 * IP-bucket (closes the token-guessing axis).
 */

import * as crypto from "crypto";
import * as http from "http";
import * as net from "net";
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
 * `src/x402-relay/index.ts:388`. When the cap is hit, ONLY expired
 * entries are evicted (CYCLE4 hardening — see file header). If no
 * expired entries exist, new callers fail-closed with 429 rather than
 * having their entry slot stolen from a still-live victim.
 */
export const MAX_RATE_LIMIT_ENTRIES = 100_000;

// ==================== CONFIG PARSING ====================

export interface RateLimitConfig {
  readonly windowMs: number;
  readonly maxRequests: number;
  /**
   * Number of trusted reverse proxies between the client and us. When
   * 0 (the default), `X-Forwarded-For` is ignored entirely. When N > 0,
   * the real client IP is read from `XFF[len - N]`, since each trusted
   * proxy APPENDS the IP it received from (so the rightmost N entries
   * are the trusted proxy chain, and the (N+1)th-from-right is the real
   * client). Reading the leftmost — the prior behavior — was bypassable
   * by attacker-prepended XFF values.
   */
  readonly trustedProxyHops: number;
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
  /**
   * Integer count of trusted reverse proxies between the client and us.
   * Default 0 (XFF ignored). Set to 1 if you have exactly one nginx /
   * Cloudflare / ALB in front; 2 if there's a second layer; etc.
   * Misconfigure too low and you trust attacker-prepended XFF values;
   * too high and the limiter falls back to socket.remoteAddress (safe
   * default).
   */
  readonly AEP_MCP_TRUSTED_PROXY_HOPS?: string;
  /**
   * Deprecated alias for `AEP_MCP_TRUSTED_PROXY_HOPS=1` (or =0 when
   * falsy). Retained for one cycle so existing single-proxy deployments
   * don't break on upgrade. New deployments should set the explicit
   * hop count.
   */
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
  const trustedProxyHops = parseTrustedProxyHops(
    env.AEP_MCP_TRUSTED_PROXY_HOPS,
    env.AEP_MCP_TRUST_PROXY,
  );
  return {
    windowMs,
    maxRequests,
    trustedProxyHops,
    unixMode: opts.unixMode ?? false,
  };
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

/**
 * Parse the trusted-proxy-hops env vars. Returns the integer hop count
 * (0 = no trust). Precedence:
 *   1. `AEP_MCP_TRUSTED_PROXY_HOPS` if set — explicit, preferred.
 *   2. `AEP_MCP_TRUST_PROXY` if set — legacy boolean, mapped: truthy → 1,
 *      falsy → 0. Logs a deprecation warning when truthy.
 *   3. Default 0 (XFF ignored).
 *
 * Throws on garbage in either var so a misconfiguration is loud at boot.
 */
function parseTrustedProxyHops(
  hopsRaw: string | undefined,
  legacyRaw: string | undefined,
): number {
  // 1. Explicit hop count wins.
  if (hopsRaw !== undefined && hopsRaw.trim() !== "") {
    const trimmed = hopsRaw.trim();
    if (!/^[0-9]+$/.test(trimmed)) {
      throw new Error(
        `AEP_MCP_TRUSTED_PROXY_HOPS="${hopsRaw}" must be a non-negative ` +
          `integer (0 disables; 1 = single proxy in front; etc).`,
      );
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        `AEP_MCP_TRUSTED_PROXY_HOPS="${hopsRaw}" must be a non-negative ` +
          `integer (0 disables; 1 = single proxy in front; etc).`,
      );
    }
    if (legacyRaw !== undefined && legacyRaw.trim() !== "") {
      log.warn(
        {
          hops: parsed,
          legacy: legacyRaw,
          adr: "ADR-083",
        },
        "mcp-rate-limit: AEP_MCP_TRUST_PROXY set alongside " +
          "AEP_MCP_TRUSTED_PROXY_HOPS — explicit hop count wins; unset " +
          "the legacy var to silence this warning",
      );
    }
    return parsed;
  }

  // 2. Legacy boolean fallback.
  if (legacyRaw === undefined) return 0;
  const v = legacyRaw.trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no") return 0;
  if (v === "1" || v === "true" || v === "yes") {
    log.warn(
      {
        adr: "ADR-083",
        replace_with: "AEP_MCP_TRUSTED_PROXY_HOPS=1",
      },
      "mcp-rate-limit: AEP_MCP_TRUST_PROXY=1 is deprecated; treating as " +
        "AEP_MCP_TRUSTED_PROXY_HOPS=1. Set the explicit hop count to " +
        "silence this warning and to enable >1-hop topologies.",
    );
    return 1;
  }
  throw new Error(
    `AEP_MCP_TRUST_PROXY="${legacyRaw}" must be one of: ` +
      `0,1,true,false,yes,no. Prefer AEP_MCP_TRUSTED_PROXY_HOPS=N for ` +
      `explicit hop count. Default: 0 (off — X-Forwarded-For is ignored).`,
  );
}

/**
 * Normalize an IP address string to a canonical bucket-key form so a
 * single client doesn't appear under multiple keys.
 *
 *   - Strip `::ffff:` IPv4-mapped-IPv6 prefix → bare IPv4.
 *   - Strip `[...]` URL brackets (some XFF emitters add them).
 *   - Lowercase IPv6 hex digits.
 *
 * Returns the input unchanged if it doesn't parse as an IP — the caller
 * is responsible for deciding whether to use a non-IP value as a key.
 */
export function normalizeIp(addr: string): string {
  let s = addr.trim();
  // Strip surrounding `[...]` brackets (e.g. `[::1]` from URL form).
  if (s.startsWith("[") && s.endsWith("]") && s.length >= 2) {
    s = s.slice(1, -1);
  }
  // IPv4-mapped-IPv6 → bare IPv4. Case-insensitive prefix.
  const lower = s.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const tail = s.slice("::ffff:".length);
    if (net.isIPv4(tail)) return tail;
    // ::ffff: followed by something that isn't a v4 literal — keep
    // lowercased v6 form rather than trust a half-parsed value.
    return lower;
  }
  if (net.isIPv6(s)) return lower;
  return s;
}

// ==================== RATE LIMITER ====================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitDeniedEvent {
  readonly bucketKind: "token" | "ip" | "unix" | "cap";
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
        // First request in this window — or the prior entry has expired.
        // Memory-cap enforcement (CYCLE4 hardening): we're about to add
        // a new entry. If the map is at cap, evict ONLY expired entries
        // first. If none are expired, fail closed: reject this caller
        // with 429 rather than evict a still-live victim.
        if (!entry && map.size >= MAX_RATE_LIMIT_ENTRIES) {
          const reclaimed = pruneExpired(map, t);
          if (reclaimed === 0) {
            // Map is full of live buckets — under flood. Shed.
            onDenied({
              bucketKind: "cap",
              remoteAddress: req.socket.remoteAddress,
              url: req.url,
              retryAfterSec: 1,
            });
            write429(res, 1);
            return;
          }
        }
        map.set(key.value, { count: 1, resetAt: t + config.windowMs });
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
   * token. For IPs it's `ip:<normalized-addr>` so a token whose hex
   * digest happened to collide with `ip:127.0.0.1` (it can't, but defense
   * in depth) is in a separate keyspace. For unix transport (CYCLE4-MCP-001
   * closure) the single global bucket is `unix:global`.
   */
  readonly value: string;
}

/**
 * Choose the bucket key for a request. Precedence:
 *   1. Bearer token from `Authorization` header → `tok:<sha256>`.
 *   2. Trusted XFF position (only if `trustedProxyHops > 0`) → `ip:<addr>`.
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

  // CYCLE4 hardening: read XFF[len - N] when N trusted proxies are in
  // front. The rightmost N entries are the trusted proxy chain (each
  // proxy appended the IP it received from on receipt); position
  // (len - N) is the real client. Anything to the left is attacker-
  // controllable and MUST be ignored.
  if (config.trustedProxyHops > 0) {
    const xff = req.headers["x-forwarded-for"];
    const xffStr = Array.isArray(xff) ? xff[0] : xff;
    if (typeof xffStr === "string" && xffStr.length > 0) {
      const parts = xffStr.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      if (parts.length >= config.trustedProxyHops) {
        const idx = parts.length - config.trustedProxyHops;
        const candidate = parts[idx]!;
        if (net.isIP(candidate) !== 0) {
          return { kind: "ip", value: `ip:${normalizeIp(candidate)}` };
        }
        // Non-IP at the trusted position — fall through to socket peer.
        log.warn(
          {
            xff_len: parts.length,
            hops: config.trustedProxyHops,
            non_ip_value: candidate,
          },
          "mcp-rate-limit: XFF position resolves to non-IP value; " +
            "falling back to socket.remoteAddress (xff_misconfigured)",
        );
      } else {
        // Fewer entries than expected — operator's hop count is too high
        // OR a peer is stripping XFF. Fall back to socket peer.
        log.warn(
          {
            xff_len: parts.length,
            hops: config.trustedProxyHops,
          },
          "mcp-rate-limit: XFF has fewer entries than trustedProxyHops; " +
            "falling back to socket.remoteAddress (xff_misconfigured)",
        );
      }
    }
  }

  const peer = req.socket.remoteAddress;
  if (typeof peer === "string" && peer.length > 0) {
    return { kind: "ip", value: `ip:${normalizeIp(peer)}` };
  }
  return { kind: "ip", value: "ip:unknown" };
}

/**
 * Periodic pruner — sweep expired entries. Called on the `setInterval`
 * tick. Does NOT evict still-live entries: if the map is over cap with
 * no expired entries, that's a flood-or-misconfig signal which we log
 * (so operators alert on it) rather than mask by evicting victims.
 */
function pruneMap(
  map: Map<string, RateLimitEntry>,
  nowMs: number,
): void {
  pruneExpired(map, nowMs);
  if (map.size > MAX_RATE_LIMIT_ENTRIES) {
    log.warn(
      {
        map_size: map.size,
        cap: MAX_RATE_LIMIT_ENTRIES,
      },
      "mcp-rate-limit: bucket map at cap with no expired entries; " +
        "fail-closed eviction is rejecting new callers — investigate flood / sizing",
    );
  }
}

/**
 * Sweep expired entries from the map. Returns the count removed.
 * Inline scan — Map iteration is order-stable and cheap up to ~100k
 * entries, well below the threshold where a heap-backed structure
 * would be worth the complexity.
 */
function pruneExpired(
  map: Map<string, RateLimitEntry>,
  nowMs: number,
): number {
  let removed = 0;
  for (const [key, entry] of map) {
    if (nowMs >= entry.resetAt) {
      map.delete(key);
      removed += 1;
    }
  }
  return removed;
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
