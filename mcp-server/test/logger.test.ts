/**
 * Tests for the structured logger (ADR-090). Verifies redaction policy
 * and correlation-id propagation.
 *
 * Captures log output by piping pino through a custom in-memory stream
 * (`captureLogs`) so assertions can inspect the JSON records without
 * touching stdout.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import pino from "pino";
import { Writable } from "node:stream";
import { newCorrelationId, withRequestContext } from "../src/util/logger.js";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

interface Captured {
  records: Array<Record<string, unknown>>;
  stream: Writable;
}

function captureLogs(): Captured {
  const records: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString().trim();
      for (const line of text.split("\n").filter(Boolean)) {
        try {
          records.push(JSON.parse(line));
        } catch {
          // Non-JSON output (pino-pretty in dev). Tests use raw pino so
          // this branch should never fire — error loudly if it does.
          throw new Error(`captureLogs: non-JSON record: ${line}`);
        }
      }
      cb();
    },
  });
  return { records, stream };
}

/**
 * Build a logger configured EXACTLY like `serverLogger` (same redaction
 * + same scrubJsonPaths formatter) but pointed at our capture stream.
 * Mirrors `mcp-server/src/util/logger.ts` baseOptions().
 */
function makeTestLogger(stream: Writable) {
  const REDACTION_PATHS = [
    "secretKey", "*.secretKey", "*.*.secretKey",
    "keypair", "*.keypair",
    "keypairPath", "*.keypairPath",
    "SOLANA_KEYPAIR_PATH", "*.SOLANA_KEYPAIR_PATH",
    "JWT_SECRET", "*.JWT_SECRET",
    "authorization", "headers.authorization", "req.headers.authorization",
    "accessToken", "*.accessToken",
    "token", "*.token",
    "AEP_REDIS_URL", "*.AEP_REDIS_URL",
    "DATABASE_URL", "*.DATABASE_URL",
  ];

  const SAFE_KEYS = new Set([
    "schema", "$schema", "manifest_cid", "manifest_hash",
    "manifest_signature", "manifest_version", "version", "agent_version",
    "taskId", "signature", "txSignature", "address", "pubkey", "cid",
    "hash", "data", "code", "name", "level", "time", "msg", "req_id",
    "corr_id", "component", "url", "endpoint", "rpcEndpoint", "id",
    "ordinal", "slot", "ip", "host",
  ]);

  return pino(
    {
      level: "trace",
      base: { component: "mcp-server" },
      redact: { paths: REDACTION_PATHS, censor: "[REDACTED]" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level(label) { return { level: label }; },
        log(record) {
          for (const [key, value] of Object.entries(record)) {
            if (SAFE_KEYS.has(key)) continue;
            if (typeof value === "string" && /\.json$/i.test(value) && value.includes("/")) {
              record[key] = "[REDACTED-PATH]";
            }
          }
          return record;
        },
      },
    },
    stream,
  );
}

// --------------------------------------------------------------------------
// Redaction
// --------------------------------------------------------------------------

describe("ADR-090 logger: redaction", () => {
  it("scrubs `secretKey` at top level", () => {
    const cap = captureLogs();
    const log = makeTestLogger(cap.stream);
    log.info({ secretKey: "leak-me-pls" }, "test");
    assert.equal(cap.records.length, 1);
    assert.equal(cap.records[0].secretKey, "[REDACTED]");
  });

  it("scrubs `secretKey` nested one level deep", () => {
    const cap = captureLogs();
    const log = makeTestLogger(cap.stream);
    log.info({ wallet: { secretKey: "leak-me-pls" } }, "test");
    const wallet = cap.records[0].wallet as Record<string, unknown>;
    assert.equal(wallet.secretKey, "[REDACTED]");
  });

  it("scrubs `keypair` field", () => {
    const cap = captureLogs();
    const log = makeTestLogger(cap.stream);
    log.info({ keypair: [1, 2, 3, 4] }, "test");
    assert.equal(cap.records[0].keypair, "[REDACTED]");
  });

  it("scrubs `JWT_SECRET`", () => {
    const cap = captureLogs();
    const log = makeTestLogger(cap.stream);
    log.info({ JWT_SECRET: "supersecret123" }, "test");
    assert.equal(cap.records[0].JWT_SECRET, "[REDACTED]");
  });

  it("scrubs `authorization` header (top-level and nested)", () => {
    const cap = captureLogs();
    const log = makeTestLogger(cap.stream);
    log.info(
      {
        authorization: "Bearer eyJ.eyJ.sig",
        headers: { authorization: "Bearer eyJ.eyJ.sig" },
        req: { headers: { authorization: "Bearer eyJ.eyJ.sig" } },
      },
      "test",
    );
    const r = cap.records[0];
    assert.equal(r.authorization, "[REDACTED]");
    assert.equal((r.headers as Record<string, unknown>).authorization, "[REDACTED]");
    const req = r.req as Record<string, unknown>;
    const reqHeaders = req.headers as Record<string, unknown>;
    assert.equal(reqHeaders.authorization, "[REDACTED]");
  });

  it("scrubs `AEP_REDIS_URL` (may carry credentials)", () => {
    const cap = captureLogs();
    const log = makeTestLogger(cap.stream);
    log.info({ AEP_REDIS_URL: "redis://user:pass@host:6379" }, "test");
    assert.equal(cap.records[0].AEP_REDIS_URL, "[REDACTED]");
  });

  it("scrubs filesystem .json paths from arbitrary fields (Finding O-05)", () => {
    const cap = captureLogs();
    const log = makeTestLogger(cap.stream);
    log.info(
      {
        wallet_path: "/home/operator/.config/solana/id.json",
        config_file: "/etc/aep/config.json",
      },
      "test",
    );
    const r = cap.records[0];
    assert.equal(r.wallet_path, "[REDACTED-PATH]");
    assert.equal(r.config_file, "[REDACTED-PATH]");
  });

  it("preserves on-chain identifiers (signature, pubkey, cid)", () => {
    const cap = captureLogs();
    const log = makeTestLogger(cap.stream);
    log.info(
      {
        signature: "5xK8aBcDef...",
        pubkey: "BUdXA1Fi...",
        cid: "QmAbCdEf...",
      },
      "test",
    );
    const r = cap.records[0];
    assert.equal(r.signature, "5xK8aBcDef...");
    assert.equal(r.pubkey, "BUdXA1Fi...");
    assert.equal(r.cid, "QmAbCdEf...");
  });

  it("does NOT redact `.json` URLs in safe-key fields (e.g. manifest schema)", () => {
    const cap = captureLogs();
    const log = makeTestLogger(cap.stream);
    log.info(
      { $schema: "https://aep.example.com/manifest/v1/schema.json" },
      "test",
    );
    assert.equal(
      cap.records[0].$schema,
      "https://aep.example.com/manifest/v1/schema.json",
    );
  });
});

// --------------------------------------------------------------------------
// Correlation IDs
// --------------------------------------------------------------------------

describe("ADR-090 logger: correlation IDs", () => {
  it("newCorrelationId returns a UUIDv4-shaped string", () => {
    const id = newCorrelationId();
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("withRequestContext attaches req_id and corr_id to every emitted record", () => {
    const cap = captureLogs();
    const parent = makeTestLogger(cap.stream);
    const reqId = newCorrelationId();
    const child = withRequestContext(parent, reqId);
    child.info({ tool: "vault_transfer" }, "dispatch begin");
    child.info({ tool: "vault_transfer" }, "dispatch end");
    assert.equal(cap.records.length, 2);
    for (const r of cap.records) {
      assert.equal(r.req_id, reqId);
      assert.equal(r.corr_id, reqId, "corr_id defaults to req_id when no upstream");
    }
  });

  it("withRequestContext distinguishes req_id from corr_id when upstream supplies one", () => {
    const cap = captureLogs();
    const parent = makeTestLogger(cap.stream);
    const upstreamCorr = newCorrelationId();
    const localReq = newCorrelationId();
    assert.notEqual(upstreamCorr, localReq);
    const child = withRequestContext(parent, localReq, upstreamCorr);
    child.info("inside");
    const r = cap.records[0];
    assert.equal(r.req_id, localReq);
    assert.equal(r.corr_id, upstreamCorr);
  });

  it("child loggers preserve the redaction policy", () => {
    const cap = captureLogs();
    const parent = makeTestLogger(cap.stream);
    const child = withRequestContext(parent, newCorrelationId());
    child.info(
      { wallet: { secretKey: "still-leak-me-pls" } },
      "child-redaction",
    );
    const wallet = cap.records[0].wallet as Record<string, unknown>;
    assert.equal(wallet.secretKey, "[REDACTED]");
    // And the request-context bindings still flow through.
    assert.ok(cap.records[0].req_id);
    assert.ok(cap.records[0].corr_id);
  });
});

// --------------------------------------------------------------------------
// Component bindings
// --------------------------------------------------------------------------

describe("ADR-090 logger: component bindings", () => {
  it("every record carries `component` from base bindings", () => {
    const cap = captureLogs();
    const log = makeTestLogger(cap.stream);
    log.info("hello");
    assert.equal(cap.records[0].component, "mcp-server");
  });

  it("level field is the lowercase string name (not numeric)", () => {
    const cap = captureLogs();
    const log = makeTestLogger(cap.stream);
    log.warn("watch out");
    assert.equal(cap.records[0].level, "warn");
  });

  it("timestamp is ISO-8601", () => {
    const cap = captureLogs();
    const log = makeTestLogger(cap.stream);
    log.info("now");
    const time = cap.records[0].time as string;
    // pino's isoTime emits `,"time":"2026-04-23T..."` — sanity check shape.
    assert.match(time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
