/**
 * ADR-083 — MCP transport security gate.
 *
 * The MCP server in `src/index.ts` exposes 23 capability-gated actions, a
 * subset of which sign Solana transactions with the operator's keypair via
 * `loadWallet()` (see `src/solana.ts:loadWallet`). The original wiring binds
 * unconditionally to `StdioServerTransport`; that is correct for local
 * subprocess deployment but provides no defense if a contributor wires up
 * `StreamableHTTPServerTransport` from the MCP SDK and binds to a network
 * interface — there is no protocol-level auth.
 *
 * This module is the **single chokepoint** through which any non-stdio
 * transport must be created. Three modes are supported:
 *
 *   stdio   — default; no auth (parent process is the trust boundary)
 *   http    — Bearer-token auth, hard-fails if `AEP_MCP_AUTH_TOKEN` is unset
 *   unix    — Unix domain socket, optional `SO_PEERCRED` UID check
 *
 * Token comparison uses `crypto.timingSafeEqual` over SHA-256 digests of
 * (expected, presented) so the comparison is constant-time and equal-length
 * irrespective of presented-token length.
 *
 * The CI gate at `scripts/check-mcp-transport-auth.sh` rejects any new
 * `app.listen(` or `server.listen(` call site under `mcp-server/src/**` that
 * is not inside this file or `src/index.ts` (which calls into this module
 * to build the auth-gated wrapper). That is the reason this module exists.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import { serverLogger } from "../util/logger.js";

const log = serverLogger.child({ component: "mcp-auth" });

// ==================== TRANSPORT POSTURE DETECTION ====================

export type TransportMode = "stdio" | "http" | "unix";

export interface TransportPosture {
  readonly mode: TransportMode;
  /** HTTP-only: bind host (default `127.0.0.1`). */
  readonly httpHost?: string;
  /** HTTP-only: bind port (default `7037`). */
  readonly httpPort?: number;
  /** HTTP-only: shared bearer token, base64/hex/etc; >=16 bytes. */
  readonly httpToken?: string;
  /** Unix-only: socket path. */
  readonly unixPath?: string;
  /** Unix-only: optional allowed peer UID. */
  readonly unixAllowedUid?: number;
}

export interface TransportPostureEnv {
  readonly AEP_MCP_TRANSPORT?: string;
  readonly AEP_MCP_AUTH_TOKEN?: string;
  readonly AEP_MCP_HTTP_HOST?: string;
  readonly AEP_MCP_HTTP_PORT?: string;
  readonly AEP_MCP_UNIX_PATH?: string;
  readonly AEP_MCP_ALLOWED_UID?: string;
  /**
   * MCP-322 (ADR-132). Set to a truthy value (`1`/`true`) when running in a
   * containerized context so the default transport flips from `stdio` to
   * `unix`. Detected automatically when `/.dockerenv` exists or
   * `process.env.container` is set; this env can also force the flip in
   * other container runtimes.
   */
  readonly container?: string;
}

/**
 * MCP-322 — Detect a containerized runtime so the default transport can
 * flip from `stdio` (parent-process trust) to `unix` (UID-bounded). In
 * containers like Docker / podman / nerdctl, the parent of the MCP
 * process is `tini`/`dumb-init`/PID 1, NOT a single trusted user; any
 * other process that can `exec` into the container would inherit stdio
 * trust. The unix transport's optional UID check is the safer default.
 *
 * Detection signals:
 *   - `/.dockerenv` exists (Docker, podman with `--init`)
 *   - `process.env.container` set (systemd-nspawn / podman default)
 *   - `AEP_MCP_FORCE_CONTAINER_DEFAULT=1` (operator override)
 */
export interface ContainerEnv {
  /** Sync filesystem check, default `node:fs.existsSync('/.dockerenv')`. */
  readonly dockerEnvExists?: () => boolean;
  /** Direct env-var read; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

export function isContainerizedRuntime(opts: ContainerEnv = {}): boolean {
  const env = opts.env ?? process.env;
  if (env.AEP_MCP_FORCE_CONTAINER_DEFAULT?.trim() === "1") return true;
  if (env.container && env.container.trim().length > 0) return true;
  const exists =
    opts.dockerEnvExists ??
    ((): boolean => {
      try {
        // Lazy fs require to keep the module load-time graph identical to
        // pre-Batch-F when not running in a container test scenario.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("node:fs") as typeof import("node:fs");
        return fs.existsSync("/.dockerenv");
      } catch {
        return false;
      }
    });
  return exists();
}

/**
 * Minimum bearer-token length in bytes after UTF-8 encoding. 16 bytes (128
 * bits) is the floor for a token that is to be compared in constant time
 * against an attacker who can issue an unbounded number of guesses across
 * sessions. Operators are pointed at `openssl rand -hex 32` (32 bytes hex =>
 * 64 chars => 64 bytes UTF-8) which comfortably clears this floor.
 */
export const MIN_TOKEN_BYTES = 16;

/**
 * Default HTTP bind host. Loopback only — operators who want LAN/internet
 * exposure must set `AEP_MCP_HTTP_HOST` explicitly so that the choice is
 * discoverable in `git log` and `env`-dump runbooks.
 */
export const DEFAULT_HTTP_HOST = "127.0.0.1";

/**
 * Default HTTP port. 7037 chosen as a non-collision-prone arbitrary port in
 * the user range; operators override via `AEP_MCP_HTTP_PORT`.
 */
export const DEFAULT_HTTP_PORT = 7037;

/**
 * Parse env vars into a {@link TransportPosture}, throwing actionable errors
 * for misconfigurations. Pure function — no side effects, no network, no fs.
 *
 * Every error message includes the exact env var to set and an example value
 * so an operator can act without consulting docs.
 */
export function detectTransportPosture(env: TransportPostureEnv): TransportPosture {
  // MCP-322 (ADR-132): when AEP_MCP_TRANSPORT is unset and the runtime
  // appears containerized, default to `unix` rather than `stdio`. The
  // operator can still pin `AEP_MCP_TRANSPORT=stdio` explicitly to opt
  // back in. When `AEP_MCP_UNIX_PATH` is unset in container mode, fall
  // back to a sensible default at `/run/aep-mcp/mcp.sock`.
  const explicit = env.AEP_MCP_TRANSPORT?.trim().toLowerCase();
  let raw: string;
  let autoFlippedToUnix = false;
  if (explicit && explicit.length > 0) {
    raw = explicit;
  } else if (isContainerizedRuntime({ env: env as NodeJS.ProcessEnv })) {
    log.warn(
      {
        adr: "ADR-132",
        audit: "MCP-322",
        signal: env.container ? "process.env.container" : "/.dockerenv",
      },
      "mcp-auth: containerized runtime detected; defaulting AEP_MCP_TRANSPORT=unix " +
        "(set AEP_MCP_TRANSPORT=stdio to override)",
    );
    raw = "unix";
    autoFlippedToUnix = true;
  } else {
    raw = "stdio";
  }

  if (raw !== "stdio" && raw !== "http" && raw !== "unix") {
    throw new Error(
      `AEP_MCP_TRANSPORT="${raw}" is not recognized. ` +
        `Valid modes: "stdio" (default outside containers), "http", "unix" (default in containers). ` +
        `See docs/adr/ADR-083-mcp-transport-security-model.md and ADR-132.`,
    );
  }

  if (raw === "stdio") {
    return { mode: "stdio" };
  }

  if (raw === "http") {
    const token = env.AEP_MCP_AUTH_TOKEN ?? "";
    if (Buffer.byteLength(token, "utf8") < MIN_TOKEN_BYTES) {
      throw new Error(
        `AEP_MCP_TRANSPORT=http requires AEP_MCP_AUTH_TOKEN to be set ` +
          `(>=${MIN_TOKEN_BYTES} bytes). Generate one with: openssl rand -hex 32. ` +
          `Refusing to start: serving an unauthenticated tx-signing surface ` +
          `over HTTP would expose the operator wallet to any reachable peer.`,
      );
    }
    const host = env.AEP_MCP_HTTP_HOST?.trim() || DEFAULT_HTTP_HOST;
    const portStr = env.AEP_MCP_HTTP_PORT?.trim();
    let port = DEFAULT_HTTP_PORT;
    if (portStr) {
      const parsed = Number.parseInt(portStr, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(
          `AEP_MCP_HTTP_PORT="${portStr}" is not a valid TCP port. ` +
            `Provide an integer in [1, 65535] (default ${DEFAULT_HTTP_PORT}).`,
        );
      }
      port = parsed;
    }
    return {
      mode: "http",
      httpHost: host,
      httpPort: port,
      httpToken: token,
    };
  }

  // raw === "unix"
  // MCP-322: in container-auto-flip mode, default the socket path so the
  // operator doesn't need to set AEP_MCP_UNIX_PATH for the auto-flip to
  // be a drop-in replacement for stdio. Outside auto-flip we keep the
  // explicit-required behavior (operators choosing unix transport
  // intentionally set the path to live where their orchestrator expects).
  const sockPath =
    env.AEP_MCP_UNIX_PATH?.trim() ||
    (autoFlippedToUnix ? "/run/aep-mcp/mcp.sock" : "");
  if (!sockPath) {
    throw new Error(
      `AEP_MCP_TRANSPORT=unix requires AEP_MCP_UNIX_PATH to be set ` +
        `(absolute path to the socket file, e.g. /run/aep-mcp/mcp.sock).`,
    );
  }
  if (!path.isAbsolute(sockPath)) {
    throw new Error(
      `AEP_MCP_UNIX_PATH="${sockPath}" must be an absolute path.`,
    );
  }
  let allowedUid: number | undefined;
  const uidStr = env.AEP_MCP_ALLOWED_UID?.trim();
  if (uidStr !== undefined && uidStr !== "") {
    const parsed = Number.parseInt(uidStr, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        `AEP_MCP_ALLOWED_UID="${uidStr}" must be a non-negative integer ` +
          `(typically the output of "id -u").`,
      );
    }
    allowedUid = parsed;
  }
  return {
    mode: "unix",
    unixPath: sockPath,
    unixAllowedUid: allowedUid,
  };
}

// ==================== BEARER TOKEN VERIFICATION ====================

/**
 * Constant-time bearer-token comparison.
 *
 * Both inputs are SHA-256-digested before comparison so:
 *   - the inputs to `crypto.timingSafeEqual` are always 32 bytes (equal-length
 *     is a precondition of the API);
 *   - the comparison time is independent of the *length* of the presented
 *     header value.
 *
 * Best-effort under V8's optimization model — `crypto.timingSafeEqual` is the
 * strongest primitive Node ships for this purpose.
 *
 * Returns `true` iff the two strings are byte-identical UTF-8.
 */
export function verifyBearerToken(expected: string, presented: string): boolean {
  const expectedDigest = crypto.createHash("sha256").update(expected, "utf8").digest();
  const presentedDigest = crypto.createHash("sha256").update(presented, "utf8").digest();
  // Both digests are 32 bytes by SHA-256 spec.
  return crypto.timingSafeEqual(expectedDigest, presentedDigest);
}

/**
 * Extract a Bearer token from an `Authorization` header value.
 *
 * Returns the token (the part after `Bearer `) or `null` if the header is
 * missing or does not match the `Bearer <token>` shape. Trailing whitespace is
 * trimmed; leading whitespace inside the token is preserved literally so the
 * comparison can still detect a malformed token rather than silently accept
 * a normalized form.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (typeof authHeader !== "string" || authHeader.length === 0) return null;
  const m = /^Bearer\s+(.+?)\s*$/i.exec(authHeader);
  return m ? m[1] : null;
}

// ==================== HTTP AUTH MIDDLEWARE ====================

export interface HttpAuthDeniedEvent {
  readonly reason: "missing_header" | "wrong_token";
  readonly remoteAddress: string | undefined;
  readonly url: string | undefined;
}

export type HttpAuthLogger = (e: HttpAuthDeniedEvent) => void;

export interface HttpAuthMiddlewareOptions {
  readonly expectedToken: string;
  /**
   * Called whenever a request is rejected. Defaults to a one-line
   * `console.error`. Tests inject their own to assert.
   */
  readonly onDenied?: HttpAuthLogger;
}

/**
 * Returns a middleware factory that wraps a downstream `http.RequestListener`.
 *
 * The middleware:
 *   1. Reads `Authorization: Bearer <token>` from the request.
 *   2. Returns 401 if the header is missing, malformed, or does not match the
 *      expected token (constant-time compare via {@link verifyBearerToken}).
 *   3. Otherwise invokes the downstream handler verbatim.
 *
 * The 401 response sets `WWW-Authenticate: Bearer realm="aep-mcp"` per RFC
 * 6750 and emits a single-line JSON body so a CLI client gets a parseable
 * error.
 */
export function makeBearerAuthMiddleware(
  opts: HttpAuthMiddlewareOptions,
): (downstream: http.RequestListener) => http.RequestListener {
  const log: HttpAuthLogger = opts.onDenied ?? defaultDeniedLogger;

  return (downstream: http.RequestListener): http.RequestListener => {
    return (req, res) => {
      const authHeader = req.headers["authorization"];
      const headerStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      const presented = extractBearerToken(headerStr);

      if (presented === null) {
        log({
          reason: "missing_header",
          remoteAddress: req.socket.remoteAddress,
          url: req.url,
        });
        write401(res, "missing_or_malformed_authorization_header");
        return;
      }

      if (!verifyBearerToken(opts.expectedToken, presented)) {
        log({
          reason: "wrong_token",
          remoteAddress: req.socket.remoteAddress,
          url: req.url,
        });
        write401(res, "invalid_bearer_token");
        return;
      }

      // Auth passed — hand off to the MCP transport listener.
      downstream(req, res);
    };
  };
}

function defaultDeniedLogger(e: HttpAuthDeniedEvent): void {
  // ADR-090 structured log — stderr-bound JSON, redaction-policy-aware.
  log.warn(
    {
      reason: e.reason,
      remote_address: e.remoteAddress,
      url: e.url,
    },
    "mcp-auth: request rejected",
  );
}

function write401(res: http.ServerResponse, code: string): void {
  res.statusCode = 401;
  res.setHeader("WWW-Authenticate", 'Bearer realm="aep-mcp"');
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: code }));
}

// ==================== UNIX SOCKET PEER-CREDENTIAL CHECK ====================

/**
 * Verify a Unix-socket peer's UID matches `expectedUid`.
 *
 * v0.1.0 implementation: compares `process.geteuid()` against `expectedUid`.
 * Rationale: if the MCP server is running as UID X and the socket is at mode
 * 0600 owned by UID X, then the only peer that can `connect(2)` to it is also
 * running as UID X (same owner) OR is root (which is already inside the trust
 * boundary). The `AEP_MCP_ALLOWED_UID` env var lets the operator declare who
 * they expect that UID to be and we cross-check against the running uid.
 *
 * The full SO_PEERCRED-per-connection check requires a native addon
 * (`unix-dgram` or `node-getpeercred`) which is out of scope for v0.1.0.
 * That arrives with the mTLS upgrade per ADR-083 §"Upgrade path to mTLS".
 *
 * On non-Linux platforms the check returns `false` (fail-closed) — if we
 * cannot prove who is on the other end of the socket, we do not accept.
 *
 * `socket` is accepted for API symmetry with the future per-connection check;
 * v0.1.0 does not inspect it.
 */
export function verifyPeerUid(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  socket: net.Socket,
  expectedUid: number,
): boolean {
  if (process.platform !== "linux") return false;
  const runningUid = typeof process.geteuid === "function" ? process.geteuid() : -1;
  return runningUid === expectedUid;
}

// ==================== KEYPAIR PERMISSION CHECK ====================

/**
 * Throws if `keyPath` exists with any group/other permission bit set.
 *
 * This is the Finding 5.1 fix called for by ADR-083. It is a defense-in-depth
 * measure: a same-uid attacker can read the key regardless, but the silent-
 * permissions-regression class of incidents (a `chmod 644` from a backup
 * tool, a misconfigured Ansible play) is caught at process startup.
 *
 * No-op on platforms where mode bits are not meaningful (Windows). On Unix
 * the check is `(mode & 0o077) === 0`.
 */
export function assertKeyfilePermissions(keyPath: string): void {
  if (process.platform === "win32") return;
  let st: fs.Stats;
  try {
    st = fs.statSync(keyPath);
  } catch {
    // Don't shadow the file-not-found error path; the caller's existsSync
    // check will surface a clear message.
    return;
  }
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `Refusing to load wallet keyfile ${keyPath}: permission mode ` +
        `${mode.toString(8).padStart(3, "0")} is too permissive ` +
        `(group or other bits set). Run: chmod 600 ${keyPath}`,
    );
  }
}

// ==================== STARTUP LOG ====================

/**
 * Emit a single-line startup banner describing the active transport posture.
 * Routed through the ADR-090 logger — stderr-bound JSON, structured fields.
 */
export function logTransportPosture(posture: TransportPosture): void {
  const line = renderPostureLine(posture);
  log.info({ posture_summary: line, mode: posture.mode }, "MCP transport posture");
}

export function renderPostureLine(posture: TransportPosture): string {
  switch (posture.mode) {
    case "stdio":
      return "stdio (local subprocess; trust boundary = parent process)";
    case "http":
      return (
        `http http://${posture.httpHost}:${posture.httpPort} ` +
        `(bearer-token required; ADR-083)`
      );
    case "unix": {
      const uidPart =
        posture.unixAllowedUid !== undefined
          ? ` allowed-uid=${posture.unixAllowedUid}`
          : " peer-credential-check=off";
      return `unix ${posture.unixPath}${uidPart} (ADR-083)`;
    }
  }
}
