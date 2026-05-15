/**
 * ADR-138 — `query_execution_history` MCP tool.
 *
 * Unit-level: pins the tool schema (name, input fields, enum membership
 * of action_kind, tool_id regex). The handler-level behaviour (HTTP
 * fan-out to the indexer, filter passthrough, error propagation) is
 * exercised by a hermetic local-fetch fixture so the test stays runnable
 * without a live indexer.
 *
 * Same harness as `handlers-v2-vault.test.ts`: `node --import tsx --test`.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";

import { queryExecutionHistoryTool } from "../../src/tools/vault.js";
import { handleQueryExecutionHistory } from "../../src/handlers/vault.js";

describe("ADR-138 — query_execution_history MCP tool schema", () => {
  it("exposes the expected name + action_kind enum", () => {
    assert.equal(queryExecutionHistoryTool.name, "query_execution_history");
    const schema = queryExecutionHistoryTool.inputSchema as Record<
      string,
      unknown
    >;
    assert.equal(schema.type, "object");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.ok(props.agentIdentity);
    assert.ok(props.vault);
    assert.ok(props.actionKind);
    assert.deepEqual(props.actionKind.enum, [
      "Transfer",
      "TokenTransfer",
      "PolicyUpdate",
      "AllowlistManage",
      "IdentityRotation",
      "PauseToggle",
      "GrantTransfer",
      "GrantTokenTransfer",
    ]);
    assert.ok(props.toolId);
    assert.ok(props.since);
    assert.ok(props.limit);
  });
});

describe("ADR-138 — query_execution_history handler", () => {
  /**
   * Spin up a transient HTTP server that records every incoming request,
   * point `AEP_INDEXER_URL` at it, fire the handler, and inspect the URL
   * + query-string the handler emitted. This is the load-bearing
   * filter-passthrough check.
   */
  async function withMockIndexer<T>(
    fn: (baseUrl: string, recorded: string[]) => Promise<T>,
    response?: object,
  ): Promise<T> {
    const recorded: string[] = [];
    const server = http.createServer((req, res) => {
      recorded.push(req.url ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response ?? { ok: true, attestations: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) {
      server.close();
      throw new Error("could not bind mock indexer");
    }
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const prevUrl = process.env.AEP_INDEXER_URL;
    process.env.AEP_INDEXER_URL = baseUrl;
    try {
      return await fn(baseUrl, recorded);
    } finally {
      if (prevUrl === undefined) {
        delete process.env.AEP_INDEXER_URL;
      } else {
        process.env.AEP_INDEXER_URL = prevUrl;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("routes agentIdentity input to /execution/agent/:key", async () => {
    await withMockIndexer(async (_baseUrl, recorded) => {
      await handleQueryExecutionHistory({
        agentIdentity: "AGENTPUBKEY",
      });
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0], "/execution/agent/AGENTPUBKEY");
    });
  });

  it("routes vault input to /execution/vault/:key", async () => {
    await withMockIndexer(async (_baseUrl, recorded) => {
      await handleQueryExecutionHistory({ vault: "VAULTPUBKEY" });
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0], "/execution/vault/VAULTPUBKEY");
    });
  });

  it("passes filters through as query-string params", async () => {
    await withMockIndexer(async (_baseUrl, recorded) => {
      await handleQueryExecutionHistory({
        agentIdentity: "AGENT",
        actionKind: "Transfer",
        toolId: "ab".repeat(32),
        since: 12345,
        limit: 10,
      });
      assert.equal(recorded.length, 1);
      // URL is path?action_kind=Transfer&tool_id=...&since=12345&limit=10
      const url = recorded[0];
      assert.match(url, /^\/execution\/agent\/AGENT\?/);
      assert.match(url, /action_kind=Transfer/);
      assert.match(url, new RegExp(`tool_id=${"ab".repeat(32)}`));
      assert.match(url, /since=12345/);
      assert.match(url, /limit=10/);
    });
  });

  it("rejects calls that pass both agentIdentity AND vault", async () => {
    await assert.rejects(
      () =>
        handleQueryExecutionHistory({
          agentIdentity: "A",
          vault: "V",
        }),
      /exactly one/,
    );
  });

  it("rejects calls that pass neither agentIdentity NOR vault", async () => {
    await assert.rejects(
      () => handleQueryExecutionHistory({}),
      /exactly one/,
    );
  });

  it("returns the indexer's JSON body verbatim on a 200", async () => {
    const body = {
      dim: "agent",
      key: "AGENT",
      count: 2,
      attestations: [{ slot: 99 }, { slot: 100 }],
    };
    await withMockIndexer(async () => {
      const result = await handleQueryExecutionHistory({
        agentIdentity: "AGENT",
      });
      assert.deepEqual(result, body);
    }, body);
  });
});
