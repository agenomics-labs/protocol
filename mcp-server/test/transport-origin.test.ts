/**
 * MCP-321 (ADR-132) — origin-gate middleware unit tests.
 *
 * The HTTP transport's origin allowlist runs in front of the rate
 * limiter and bearer-auth middleware. It must:
 *
 *   1. Pass server-to-server callers (no Origin header, no Sec-Fetch-Site).
 *   2. Pass an Origin that is in the allowlist.
 *   3. Reject 403 when an Origin is set but not in the allowlist.
 *   4. Reject 403 when Origin is absent but Sec-Fetch-Site=cross-site
 *      (anomalous browser shape).
 *   5. Pass when Origin is absent and Sec-Fetch-Site is none/same-origin.
 *
 * Runs under `node --import tsx --test`.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import { EventEmitter } from "node:events";

import {
  isOriginAllowed,
  readOriginGateConfig,
  makeOriginGate,
} from "../src/transport/origin-gate.js";

function fakeReq(headers: Record<string, string | undefined>): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.headers = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) req.headers[k.toLowerCase()] = v;
  }
  req.url = "/";
  return req;
}

function fakeRes(): http.ServerResponse & { _body: string; _headers: Record<string, string> } {
  const res = {
    statusCode: 200,
    _headers: {} as Record<string, string>,
    _body: "",
    setHeader(name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      if (body) this._body += body;
    },
  } as unknown as http.ServerResponse & { _body: string; _headers: Record<string, string> };
  return res;
}

describe("readOriginGateConfig", () => {
  it("empty allowlist when env var unset", () => {
    const cfg = readOriginGateConfig({});
    assert.equal(cfg.allowedOrigins.length, 0);
  });

  it("parses CSV into trimmed list", () => {
    const cfg = readOriginGateConfig({
      AEP_MCP_HTTP_ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com",
    });
    assert.deepEqual([...cfg.allowedOrigins], [
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });
});

describe("isOriginAllowed", () => {
  const allowlist = readOriginGateConfig({
    AEP_MCP_HTTP_ALLOWED_ORIGINS: "https://app.example.com",
  });

  it("passes server-to-server (no Origin, no Sec-Fetch-Site)", () => {
    assert.equal(isOriginAllowed(fakeReq({}), allowlist), true);
  });

  it("passes Origin in allowlist", () => {
    assert.equal(
      isOriginAllowed(
        fakeReq({ Origin: "https://app.example.com" }),
        allowlist,
      ),
      true,
    );
  });

  it("rejects Origin not in allowlist", () => {
    assert.equal(
      isOriginAllowed(
        fakeReq({ Origin: "https://evil.example.com" }),
        allowlist,
      ),
      false,
    );
  });

  it("rejects Origin not in allowlist + Sec-Fetch-Site=cross-site", () => {
    assert.equal(
      isOriginAllowed(
        fakeReq({
          Origin: "https://evil.example.com",
          "Sec-Fetch-Site": "cross-site",
        }),
        allowlist,
      ),
      false,
    );
  });

  it("rejects no Origin + Sec-Fetch-Site=cross-site (anomalous browser shape)", () => {
    assert.equal(
      isOriginAllowed(
        fakeReq({ "Sec-Fetch-Site": "cross-site" }),
        allowlist,
      ),
      false,
    );
  });

  it("passes no Origin + Sec-Fetch-Site=none (top-level navigation, e.g. Postman/curl)", () => {
    assert.equal(
      isOriginAllowed(
        fakeReq({ "Sec-Fetch-Site": "none" }),
        allowlist,
      ),
      true,
    );
  });

  it("rejects all Origins when allowlist empty", () => {
    const empty = readOriginGateConfig({});
    assert.equal(
      isOriginAllowed(
        fakeReq({ Origin: "https://app.example.com" }),
        empty,
      ),
      false,
    );
    // Server-to-server still passes
    assert.equal(isOriginAllowed(fakeReq({}), empty), true);
  });
});

describe("makeOriginGate middleware", () => {
  it("calls downstream when allowed, returns 403 when not", () => {
    const cfg = readOriginGateConfig({
      AEP_MCP_HTTP_ALLOWED_ORIGINS: "https://app.example.com",
    });
    const gate = makeOriginGate(cfg);
    let downstreamCalls = 0;
    const handler = gate.middleware((_req, _res) => {
      downstreamCalls++;
    });

    // Allowed
    const req1 = fakeReq({ Origin: "https://app.example.com" });
    const res1 = fakeRes();
    handler(req1, res1);
    assert.equal(downstreamCalls, 1);
    assert.equal(res1.statusCode, 200);

    // Rejected
    const req2 = fakeReq({ Origin: "https://attacker.example.com" });
    const res2 = fakeRes();
    handler(req2, res2);
    assert.equal(downstreamCalls, 1, "downstream must NOT be called on reject");
    assert.equal(res2.statusCode, 403);
    assert.match(res2._body, /Forbidden/);
  });
});

// ---------------------------------------------------------------------------
// MCP-322 — container-aware default flip
// ---------------------------------------------------------------------------

import {
  detectTransportPosture,
  isContainerizedRuntime,
} from "../src/transport/auth-gate.js";

describe("MCP-322 — container-aware transport default", () => {
  it("isContainerizedRuntime returns true when /.dockerenv exists", () => {
    assert.equal(
      isContainerizedRuntime({
        dockerEnvExists: () => true,
        env: {} as NodeJS.ProcessEnv,
      }),
      true,
    );
  });

  it("isContainerizedRuntime returns true when process.env.container is set", () => {
    assert.equal(
      isContainerizedRuntime({
        dockerEnvExists: () => false,
        env: { container: "podman" } as NodeJS.ProcessEnv,
      }),
      true,
    );
  });

  it("isContainerizedRuntime returns true when AEP_MCP_FORCE_CONTAINER_DEFAULT=1", () => {
    assert.equal(
      isContainerizedRuntime({
        dockerEnvExists: () => false,
        env: { AEP_MCP_FORCE_CONTAINER_DEFAULT: "1" } as NodeJS.ProcessEnv,
      }),
      true,
    );
  });

  it("isContainerizedRuntime returns false on a bare host", () => {
    assert.equal(
      isContainerizedRuntime({
        dockerEnvExists: () => false,
        env: {} as NodeJS.ProcessEnv,
      }),
      false,
    );
  });

  it("detectTransportPosture defaults to unix when container detected and no explicit transport", () => {
    const posture = detectTransportPosture({
      // simulate container by setting `container` env
      container: "podman",
    } as { AEP_MCP_TRANSPORT?: string; container?: string });
    assert.equal(posture.mode, "unix");
    assert.equal(posture.unixPath, "/run/aep-mcp/mcp.sock");
  });

  it("detectTransportPosture honors explicit AEP_MCP_TRANSPORT=stdio even in container", () => {
    const posture = detectTransportPosture({
      AEP_MCP_TRANSPORT: "stdio",
      container: "podman",
    } as { AEP_MCP_TRANSPORT?: string; container?: string });
    assert.equal(posture.mode, "stdio");
  });

  it("detectTransportPosture defaults to stdio on bare host (no container signals)", () => {
    // We can't fully mock /.dockerenv from the test process, but if it
    // really exists on this CI host the auto-flip is the correct outcome.
    if (fs.existsSync("/.dockerenv")) {
      const posture = detectTransportPosture(
        {} as { AEP_MCP_TRANSPORT?: string; container?: string },
      );
      assert.equal(posture.mode, "unix");
    } else {
      const posture = detectTransportPosture(
        {} as { AEP_MCP_TRANSPORT?: string; container?: string },
      );
      assert.equal(posture.mode, "stdio");
    }
  });
});
