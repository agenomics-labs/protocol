/**
 * Indexer logger (ADR-090).
 *
 * Self-contained pino instance for the @agenomics/indexer package. Mirrors
 * the redaction policy of mcp-server's `util/logger.ts` but is duplicated
 * (rather than shared via package import) because:
 *
 *   - indexer is a separate package with no `file:` link to mcp-server;
 *   - the redaction list is short and stable;
 *   - keeping it in-package avoids a circular workspace dep.
 *
 * Correlation IDs flow IN as the `signature` (the on-chain tx signature
 * that produced the event) — that becomes `corr_id` on every persisted
 * row and every log line bound to the event's processing path. Indexer
 * does not initiate correlations; it inherits them from MCP→CPI.
 */

import pino, { type Logger, type LoggerOptions } from "pino";

const REDACTION_PATHS: readonly string[] = [
  "secretKey",
  "*.secretKey",
  "keypair",
  "*.keypair",
  "keypairPath",
  "*.keypairPath",
  "SOLANA_KEYPAIR_PATH",
  "*.SOLANA_KEYPAIR_PATH",
  "DATABASE_URL",
  "*.DATABASE_URL",
  // OFF-209 (cycle-3 off-chain audit): the indexer's Postgres shadow
  // connection URL is a credential — `postgres://user:pass@host/db`
  // embeds the operator password in plaintext. Pre-fix a log line that
  // accidentally included `INDEXER_PG_URL` (e.g. a structured boot-error
  // record dumping `process.env`, or a future debug log mirroring the
  // dual-write config) leaked the password to stdout. The variable is
  // listed alongside `DATABASE_URL` because both share the same shape
  // and the same blast radius. `INDEXER_PG_TEST_URL` is the test-suite
  // counterpart (OFF-217) and gets the same treatment so a CI log
  // capturing the test env doesn't leak the test DB password.
  "INDEXER_PG_URL",
  "*.INDEXER_PG_URL",
  "INDEXER_PG_TEST_URL",
  "*.INDEXER_PG_TEST_URL",
];

const SAFE_KEYS = new Set([
  "schema", "$schema", "manifest_cid", "manifest_hash", "manifest_signature",
  "manifest_version", "version", "agent_version", "taskId", "signature",
  "txSignature", "address", "pubkey", "cid", "hash", "data", "code", "name",
  "level", "time", "msg", "req_id", "corr_id", "component", "url", "endpoint",
  "rpcEndpoint", "id", "ordinal", "slot", "ip", "host", "program", "label",
  "event_name",
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

function buildOptions(): LoggerOptions {
  const isProd = process.env.NODE_ENV === "production";
  const level = process.env.LOG_LEVEL ?? (isProd ? "info" : "debug");

  const opts: LoggerOptions = {
    level,
    base: { component: "indexer" },
    redact: { paths: [...REDACTION_PATHS], censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label): { level: string } { return { level: label }; },
      log(record): Record<string, unknown> { return scrubJsonPaths(record); },
    },
  };

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

export const logger: Logger = pino(buildOptions());

/**
 * Derive a logger bound to a specific subscription / program. Used as the
 * `[program]` prefix the original code emitted via console.log.
 */
export function programLogger(label: string): Logger {
  return logger.child({ program: label });
}

/**
 * Derive a logger pinned to the on-chain transaction signature that
 * produced an event. The signature doubles as the indexer's correlation
 * id (corr_id) — every row persisted from this signature carries it.
 */
export function eventLogger(label: string, signature: string): Logger {
  return logger.child({ program: label, corr_id: signature });
}

export type { Logger };
