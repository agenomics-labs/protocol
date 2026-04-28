/**
 * MCP-321 — HTTP transport origin / CSRF gate.
 *
 * The MCP server's HTTP transport is bearer-token-authenticated, but the
 * cycle-3 audit flagged a remaining gap: if the operator runs MCP behind
 * a reverse proxy that auto-injects the bearer header (e.g. for
 * organization-internal SSO termination), browser callers from arbitrary
 * origins can hit the surface from any origin and abuse it as a
 * confused-deputy.
 *
 * This module adds an origin allowlist in front of the bearer middleware
 * (and in front of the rate-limiter; see `src/index.ts:startHttpTransport`).
 *
 * Threat model
 * ============
 *   - Browser-origin requests carry an `Origin` header (or
 *     `Sec-Fetch-Site: cross-site` on modern browsers). When `Origin` is
 *     present and not in the allowlist, reject with 403.
 *   - Server-to-server callers (curl, MCP clients, agent runtimes) send
 *     no `Origin` and no `Sec-Fetch-Site` — these pass through to the
 *     auth gate untouched.
 *   - When `Origin` is present and `Sec-Fetch-Site: cross-site|same-site`
 *     is also present, the origin must match the allowlist regardless.
 *     A `Sec-Fetch-Site: none` (top-level navigation, e.g. typed URL)
 *     plus an absent allowlist still rejects since browsers don't make
 *     cross-origin POSTs to internal APIs that way.
 *
 * Configuration
 * =============
 *   - `AEP_MCP_HTTP_ALLOWED_ORIGINS` — comma-separated origin list
 *     (e.g. `https://app.example.com,https://localhost:3000`). Empty/
 *     unset means "no browser origins permitted" — only Origin-less
 *     server-to-server callers pass.
 *
 * The middleware runs BEFORE the rate limiter so that cross-origin
 * probes don't even consume bucket capacity.
 */

import * as http from "http";
import { serverLogger } from "../util/logger.js";

const log = serverLogger.child({ component: "mcp-origin-gate" });

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------

export interface OriginGateConfig {
  /** Allowed origins. Empty array means "reject any present Origin." */
  readonly allowedOrigins: readonly string[];
}

export interface OriginGateConfigEnv {
  AEP_MCP_HTTP_ALLOWED_ORIGINS?: string | undefined;
}

export function readOriginGateConfig(env: OriginGateConfigEnv): OriginGateConfig {
  const raw = env.AEP_MCP_HTTP_ALLOWED_ORIGINS?.trim() ?? "";
  if (raw.length === 0) {
    return { allowedOrigins: [] };
  }
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { allowedOrigins: Object.freeze(list) };
}

// --------------------------------------------------------------------------
// Header inspection
// --------------------------------------------------------------------------

function firstHeaderValue(req: http.IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (v === undefined) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}

/**
 * Decide whether `req` should be allowed past the origin gate.
 *
 * Rules:
 *   - No `Origin` AND no `Sec-Fetch-Site` → server-to-server, pass.
 *   - `Origin` set:
 *       - in allowlist → pass.
 *       - not in allowlist → reject.
 *   - `Origin` absent but `Sec-Fetch-Site` is `cross-site` → reject
 *     (browser cross-origin without an Origin shouldn't happen for our
 *     surfaces; treat as suspicious).
 *   - `Origin` absent and `Sec-Fetch-Site` is `same-origin|same-site|none`
 *     → pass.
 */
export function isOriginAllowed(
  req: http.IncomingMessage,
  config: OriginGateConfig,
): boolean {
  const origin = firstHeaderValue(req, "origin");
  const fetchSite = firstHeaderValue(req, "sec-fetch-site");

  if (origin !== null) {
    return config.allowedOrigins.includes(origin);
  }
  // No Origin header. Browsers omit Origin only on same-origin GETs and
  // top-level navigations. A `cross-site` fetch-site header without
  // Origin is anomalous; reject defensively.
  if (fetchSite === "cross-site") return false;
  return true;
}

// --------------------------------------------------------------------------
// Middleware
// --------------------------------------------------------------------------

export interface OriginGate {
  readonly middleware: (
    downstream: http.RequestListener,
  ) => http.RequestListener;
}

export function makeOriginGate(config: OriginGateConfig): OriginGate {
  const middleware = (downstream: http.RequestListener): http.RequestListener => {
    return (req, res) => {
      if (!isOriginAllowed(req, config)) {
        const origin = firstHeaderValue(req, "origin") ?? "";
        const fetchSite = firstHeaderValue(req, "sec-fetch-site") ?? "";
        log.warn(
          {
            origin,
            sec_fetch_site: fetchSite,
            url: req.url,
            audit: "MCP-321",
          },
          "mcp-origin-gate: rejected (origin not in allowlist)",
        );
        res.statusCode = 403;
        res.setHeader("Content-Type", "text/plain");
        res.end("Forbidden: origin not allowed");
        return;
      }
      downstream(req, res);
    };
  };
  return { middleware };
}
