/**
 * x402-relay logger (ADR-090).
 *
 * Self-contained pino instance for the @agenomics/x402-relay package.
 * Mirrors the redaction policy of mcp-server's `util/logger.ts`. Critically
 * scrubs `JWT_SECRET` and `authorization` headers — the relay processes
 * Bearer tokens on every protected request and a leak through the log
 * pipeline would defeat the entire payment-gate.
 *
 * Correlation IDs flow IN as the on-chain payment signature (set as
 * corr_id on every log line in the verify→issue→protected pipeline) and
 * OUT as the JWT's `jti` claim (a fresh UUID; downstream services may
 * thread it back through their own correlation chain).
 */

import pino, { type Logger, type LoggerOptions } from "pino";
import { randomUUID } from "node:crypto";

const REDACTION_PATHS: readonly string[] = [
  "JWT_SECRET",
  "*.JWT_SECRET",
  "secretKey",
  "*.secretKey",
  "authorization",
  "headers.authorization",
  "req.headers.authorization",
  "accessToken",
  "*.accessToken",
  "token",
  "*.token",
  "keypair",
  "*.keypair",
  "keypairPath",
  "*.keypairPath",
  "SOLANA_KEYPAIR_PATH",
  "*.SOLANA_KEYPAIR_PATH",
];

const SAFE_KEYS = new Set([
  "schema", "$schema", "version", "agent_version", "taskId", "signature",
  "txSignature", "address", "pubkey", "code", "name", "level", "time", "msg",
  "req_id", "corr_id", "component", "url", "endpoint", "rpcEndpoint", "id",
  "slot", "ip", "host", "recipient", "sender", "amountSol", "remainingSeconds",
  "expiresIn",
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
    base: { component: "x402-relay" },
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
 * Mint a fresh JWT-id / correlation handle. Stamped into every issued
 * access token's `jti` claim and into every log line bound to that
 * token's lifetime.
 */
export function newJwtId(): string {
  return randomUUID();
}

/**
 * Derive a logger pinned to a payment-flow (txSignature, optional jti).
 * `corr_id` is set to txSignature so log lines from /pay → /verify →
 * /protected for the same payment correlate end-to-end.
 */
export function paymentLogger(txSignature: string, jti?: string): Logger {
  return logger.child({ corr_id: txSignature, jti });
}

export type { Logger };
