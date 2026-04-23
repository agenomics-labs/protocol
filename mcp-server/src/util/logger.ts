/**
 * Pino-based structured logger (ADR-090).
 *
 * Replaces ad-hoc `console.*` calls across mcp-server, indexer, and
 * x402-relay. Per-package loggers all compose around the same shape:
 *
 *   - Level from `LOG_LEVEL` env (default: "info"; "trace" .. "fatal").
 *   - JSON output in production; pretty-printed in dev (NODE_ENV != "production").
 *   - Redaction list covers `secretKey`, `keypair`, `keypairPath`, JWTs,
 *     and any string ending in `.json` (filesystem keypair paths per
 *     ADR-079 / Finding O-05).
 *   - Correlation ID propagation: every log line carries `req_id` (request
 *     boundary) and `corr_id` (cross-service handle threaded through
 *     MCP → CPI → indexer → x402-relay).
 *
 * Sub-loggers are minted via `logger.child({ component: "x" })` to
 * preserve the redaction policy and base bindings.
 */

import pino, { type Logger, type LoggerOptions } from "pino";
import { randomUUID } from "node:crypto";

/**
 * Fields to scrub from log records. Matches both the literal field name
 * (e.g. `secretKey: <bytes>`) and any nested occurrence
 * (e.g. `wallet.secretKey`, `args.keypair`).
 */
const REDACTION_PATHS: readonly string[] = [
  // Solana key material
  "secretKey",
  "*.secretKey",
  "*.*.secretKey",
  "keypair",
  "*.keypair",
  "keypairPath",
  "*.keypairPath",
  "SOLANA_KEYPAIR_PATH",
  "*.SOLANA_KEYPAIR_PATH",

  // JWT secrets / bearer tokens
  "JWT_SECRET",
  "*.JWT_SECRET",
  "authorization",
  "headers.authorization",
  "req.headers.authorization",
  "accessToken",
  "*.accessToken",
  "token",
  "*.token",

  // Database URLs that may carry credentials
  "AEP_REDIS_URL",
  "*.AEP_REDIS_URL",
  "DATABASE_URL",
  "*.DATABASE_URL",
];

/**
 * Build pino options shared by every package logger. Keeps the redaction
 * policy in one place so that adding a sensitive field once propagates
 * everywhere.
 */
function baseOptions(component: string): LoggerOptions {
  const isProd = process.env.NODE_ENV === "production";
  const level = process.env.LOG_LEVEL ?? (isProd ? "info" : "debug");

  const opts: LoggerOptions = {
    level,
    base: { component },
    redact: {
      paths: [...REDACTION_PATHS],
      censor: "[REDACTED]",
    },
    // ISO timestamps are friendlier in JSON aggregators than pino's
    // default epoch-ms format. Cheap, deterministic, sortable.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // Lowercase the level field for consistency with most JSON loggers.
      level(label): { level: string } {
        return { level: label };
      },
      // Belt-and-braces (ADR-090 §3 / Finding O-05): scrub any string
      // value that ends in `.json` from a log record. Catches stray
      // keypair-path leaks the redaction.paths can't pre-declare.
      log(record): Record<string, unknown> {
        return scrubJsonPaths(record);
      },
    },
  };

  // Pretty transport in dev only — JSON in prod (so log aggregators can
  // parse it). Pino-pretty is a separate transport process; leave
  // production lean.
  if (!isProd && process.env.LOG_PRETTY !== "0") {
    opts.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
        singleLine: false,
      },
    };
  }

  return opts;
}

/**
 * Walk a record and replace any string value that looks like a filesystem
 * `.json` path with `[REDACTED-PATH]`. Catches paths leaked through
 * `process.env` enumeration or stack traces (Finding O-05).
 *
 * Skips known-safe fields (`schema`, `$schema`, `manifest_*`, `version`,
 * `taskId`, `signature`, `address`, `pubkey`, `cid`, `hash`, `data`,
 * `code`, `name`, `level`, `time`, `msg`, `req_id`, `corr_id`,
 * `component`, `error.code`, etc) so we don't accidentally censor
 * legitimate `.json` references in the URL of a manifest.
 */
const SAFE_KEYS = new Set([
  "schema", "$schema", "manifest_cid", "manifest_hash", "manifest_signature",
  "manifest_version", "version", "agent_version", "taskId", "signature",
  "txSignature", "address", "pubkey", "cid", "hash", "data", "code", "name",
  "level", "time", "msg", "req_id", "corr_id", "component", "url", "endpoint",
  "rpcEndpoint", "id", "ordinal", "slot", "ip", "host",
]);

function scrubJsonPaths(record: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(record)) {
    if (SAFE_KEYS.has(key)) continue;
    if (typeof value === "string" && /\.json$/i.test(value) && value.includes("/")) {
      record[key] = "[REDACTED-PATH]";
    }
  }
  return record;
}

// --------------------------------------------------------------------------
// Public surface
// --------------------------------------------------------------------------

/**
 * Mint a top-level package logger. Each off-chain service (mcp-server,
 * indexer, x402-relay) calls this once at module load and re-uses the
 * resulting logger; per-handler loggers are derived via `logger.child`.
 */
export function createLogger(component: string): Logger {
  return pino(baseOptions(component));
}

/**
 * Generate a fresh correlation ID. Cheap UUIDv4 — used at request
 * boundaries (MCP `dispatch`, indexer event ingest, x402 `/pay`).
 */
export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Derive a child logger bound to a specific request / correlation pair.
 * Every log line emitted through the returned logger carries `req_id`
 * (this request's id) and `corr_id` (the upstream / downstream handle
 * threaded across services).
 *
 * If `corrId` is omitted, the request id doubles as the correlation id —
 * common at the very edge of the system where no upstream caller existed.
 */
export function withRequestContext(
  parent: Logger,
  reqId: string,
  corrId?: string,
): Logger {
  return parent.child({ req_id: reqId, corr_id: corrId ?? reqId });
}

/**
 * Default mcp-server logger. Top-level handlers and one-time startup
 * code log through this; request-scoped code derives via
 * `withRequestContext(serverLogger, ...)`.
 */
export const serverLogger: Logger = createLogger("mcp-server");

// Re-export the `Logger` type so consumers don't need to depend on pino directly.
export type { Logger };
