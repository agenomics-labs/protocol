/**
 * ADR-083 — MCP transport auth gate tests.
 *
 * Coverage:
 *   §1. detectTransportPosture — env parsing, hard-fail paths, defaults
 *   §2. extractBearerToken / verifyBearerToken — header parsing + constant-time
 *   §3. makeBearerAuthMiddleware — 401 paths and pass-through
 *   §4. End-to-end http server with the middleware in front (no MCP transport
 *       behind it; the auth gate is what we're testing)
 *
 * Runs under `node --import tsx --test` alongside the existing harness.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "http";
import * as crypto from "crypto";

import {
  detectTransportPosture,
  extractBearerToken,
  verifyBearerToken,
  makeBearerAuthMiddleware,
  renderPostureLine,
  MIN_TOKEN_BYTES,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  type HttpAuthDeniedEvent,
} from "../src/transport/auth-gate.js";

// ==========================================================================
// §1. detectTransportPosture
// ==========================================================================

describe("ADR-083 detectTransportPosture", () => {
  it("defaults to stdio when env is empty", () => {
    const p = detectTransportPosture({});
    assert.equal(p.mode, "stdio");
  });

  it("explicit AEP_MCP_TRANSPORT=stdio also resolves to stdio", () => {
    const p = detectTransportPosture({ AEP_MCP_TRANSPORT: "stdio" });
    assert.equal(p.mode, "stdio");
  });

  it("rejects unknown transport modes with actionable error", () => {
    assert.throws(
      () => detectTransportPosture({ AEP_MCP_TRANSPORT: "websocket" }),
      /AEP_MCP_TRANSPORT="websocket" is not recognized/,
    );
  });

  it("HTTP mode hard-fails when AEP_MCP_AUTH_TOKEN is unset", () => {
    assert.throws(
      () => detectTransportPosture({ AEP_MCP_TRANSPORT: "http" }),
      /AEP_MCP_TRANSPORT=http requires AEP_MCP_AUTH_TOKEN/,
    );
  });

  it("HTTP mode hard-fails on a too-short token", () => {
    assert.throws(
      () =>
        detectTransportPosture({
          AEP_MCP_TRANSPORT: "http",
          AEP_MCP_AUTH_TOKEN: "abc", // 3 bytes — well under MIN_TOKEN_BYTES
        }),
      new RegExp(`>=${MIN_TOKEN_BYTES} bytes`),
    );
  });

  it("HTTP mode error message tells operator how to generate a token", () => {
    try {
      detectTransportPosture({ AEP_MCP_TRANSPORT: "http" });
      assert.fail("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      assert.match(msg, /openssl rand -hex 32/);
      assert.match(msg, /Refusing to start/);
    }
  });

  it("HTTP mode accepts a sufficient-length token and uses defaults for host/port", () => {
    const tok = "x".repeat(MIN_TOKEN_BYTES);
    const p = detectTransportPosture({
      AEP_MCP_TRANSPORT: "http",
      AEP_MCP_AUTH_TOKEN: tok,
    });
    assert.equal(p.mode, "http");
    assert.equal(p.httpHost, DEFAULT_HTTP_HOST);
    assert.equal(p.httpPort, DEFAULT_HTTP_PORT);
    assert.equal(p.httpToken, tok);
  });

  it("HTTP mode honors custom host/port", () => {
    const tok = "y".repeat(64);
    const p = detectTransportPosture({
      AEP_MCP_TRANSPORT: "http",
      AEP_MCP_AUTH_TOKEN: tok,
      AEP_MCP_HTTP_HOST: "0.0.0.0",
      AEP_MCP_HTTP_PORT: "9999",
    });
    assert.equal(p.httpHost, "0.0.0.0");
    assert.equal(p.httpPort, 9999);
  });

  it("HTTP mode rejects bogus port values", () => {
    const tok = "y".repeat(64);
    assert.throws(
      () =>
        detectTransportPosture({
          AEP_MCP_TRANSPORT: "http",
          AEP_MCP_AUTH_TOKEN: tok,
          AEP_MCP_HTTP_PORT: "70000",
        }),
      /not a valid TCP port/,
    );
    assert.throws(
      () =>
        detectTransportPosture({
          AEP_MCP_TRANSPORT: "http",
          AEP_MCP_AUTH_TOKEN: tok,
          AEP_MCP_HTTP_PORT: "abc",
        }),
      /not a valid TCP port/,
    );
  });

  it("Unix mode requires AEP_MCP_UNIX_PATH", () => {
    assert.throws(
      () => detectTransportPosture({ AEP_MCP_TRANSPORT: "unix" }),
      /AEP_MCP_UNIX_PATH/,
    );
  });

  it("Unix mode requires an absolute path", () => {
    assert.throws(
      () =>
        detectTransportPosture({
          AEP_MCP_TRANSPORT: "unix",
          AEP_MCP_UNIX_PATH: "relative/sock",
        }),
      /must be an absolute path/,
    );
  });

  it("Unix mode parses a valid posture without UID check", () => {
    const p = detectTransportPosture({
      AEP_MCP_TRANSPORT: "unix",
      AEP_MCP_UNIX_PATH: "/tmp/aep.sock",
    });
    assert.equal(p.mode, "unix");
    assert.equal(p.unixPath, "/tmp/aep.sock");
    assert.equal(p.unixAllowedUid, undefined);
  });

  it("Unix mode parses AEP_MCP_ALLOWED_UID", () => {
    const p = detectTransportPosture({
      AEP_MCP_TRANSPORT: "unix",
      AEP_MCP_UNIX_PATH: "/tmp/aep.sock",
      AEP_MCP_ALLOWED_UID: "1000",
    });
    assert.equal(p.unixAllowedUid, 1000);
  });

  it("Unix mode rejects negative or non-integer UIDs", () => {
    assert.throws(
      () =>
        detectTransportPosture({
          AEP_MCP_TRANSPORT: "unix",
          AEP_MCP_UNIX_PATH: "/tmp/x.sock",
          AEP_MCP_ALLOWED_UID: "-1",
        }),
      /must be a non-negative integer/,
    );
    assert.throws(
      () =>
        detectTransportPosture({
          AEP_MCP_TRANSPORT: "unix",
          AEP_MCP_UNIX_PATH: "/tmp/x.sock",
          AEP_MCP_ALLOWED_UID: "alice",
        }),
      /must be a non-negative integer/,
    );
  });
});

// ==========================================================================
// §1.b — renderPostureLine (used in startup banner)
// ==========================================================================

describe("ADR-083 renderPostureLine", () => {
  it("stdio banner names the trust boundary", () => {
    const line = renderPostureLine({ mode: "stdio" });
    assert.match(line, /stdio/);
    assert.match(line, /trust boundary = parent process/);
  });

  it("http banner names the bind URL", () => {
    const line = renderPostureLine({
      mode: "http",
      httpHost: "127.0.0.1",
      httpPort: 7037,
      httpToken: "x".repeat(32),
    });
    assert.match(line, /http:\/\/127\.0\.0\.1:7037/);
    assert.match(line, /bearer-token required/);
  });

  it("unix banner shows uid-check state", () => {
    const off = renderPostureLine({
      mode: "unix",
      unixPath: "/tmp/aep.sock",
    });
    assert.match(off, /peer-credential-check=off/);
    const on = renderPostureLine({
      mode: "unix",
      unixPath: "/tmp/aep.sock",
      unixAllowedUid: 1000,
    });
    assert.match(on, /allowed-uid=1000/);
  });
});

// ==========================================================================
// §2. extractBearerToken
// ==========================================================================

describe("ADR-083 extractBearerToken", () => {
  it("returns null on missing header", () => {
    assert.equal(extractBearerToken(undefined), null);
    assert.equal(extractBearerToken(""), null);
  });

  it("returns null on a non-Bearer scheme", () => {
    assert.equal(extractBearerToken("Basic dXNlcjpwYXNz"), null);
    assert.equal(extractBearerToken("Token abc"), null);
  });

  it("returns the token when present", () => {
    assert.equal(extractBearerToken("Bearer abc123"), "abc123");
  });

  it("is case-insensitive on the scheme", () => {
    assert.equal(extractBearerToken("bearer abc"), "abc");
    assert.equal(extractBearerToken("BEARER abc"), "abc");
  });

  it("trims trailing whitespace but preserves embedded slashes/equals", () => {
    assert.equal(extractBearerToken("Bearer abc/def=  "), "abc/def=");
  });
});

// ==========================================================================
// §3. verifyBearerToken — constant-time semantics
// ==========================================================================

describe("ADR-083 verifyBearerToken", () => {
  it("accepts byte-identical tokens", () => {
    const tok = crypto.randomBytes(32).toString("hex");
    assert.equal(verifyBearerToken(tok, tok), true);
  });

  it("rejects different tokens", () => {
    const a = crypto.randomBytes(32).toString("hex");
    const b = crypto.randomBytes(32).toString("hex");
    assert.equal(verifyBearerToken(a, b), false);
  });

  it("rejects different-length presented tokens (no length-leak via mismatched-length error)", () => {
    // The implementation hashes both sides via SHA-256 first, so the
    // crypto.timingSafeEqual call always sees equal-length 32-byte inputs.
    // We assert the API does NOT throw on length mismatch — i.e., we don't
    // leak the expected length via an exception.
    const expected = "x".repeat(32);
    const presented = "y".repeat(8); // dramatically different length
    assert.doesNotThrow(() => verifyBearerToken(expected, presented));
    assert.equal(verifyBearerToken(expected, presented), false);
  });

  it("rejects empty presented token", () => {
    const tok = "x".repeat(32);
    assert.equal(verifyBearerToken(tok, ""), false);
  });

  it("uses crypto.timingSafeEqual semantics — proven by digest equality on identical inputs", () => {
    // Indirect proof: if both digests are equal, timingSafeEqual returns true;
    // if not, false. We don't time-measure (V8 makes that flaky); we assert
    // the digest-comparison contract holds on a few representative inputs.
    const cases = [
      ["", ""],
      ["a", "a"],
      ["x".repeat(64), "x".repeat(64)],
      [crypto.randomBytes(32).toString("hex"), crypto.randomBytes(32).toString("hex")],
    ] as const;
    for (const [a, b] of cases) {
      const expected = a === b;
      assert.equal(verifyBearerToken(a, b), expected, `mismatch for ${JSON.stringify({ a, b })}`);
    }
  });
});

// ==========================================================================
// §4. End-to-end HTTP middleware
// ==========================================================================

/**
 * Spin up an ephemeral HTTP server on 127.0.0.1:0 with the bearer-auth
 * middleware in front of a tiny downstream that returns 200 + the body
 * "OK". Returns `{ url, close }` to the caller.
 */
async function startTestServer(opts: {
  expectedToken: string;
  onDenied?: (e: HttpAuthDeniedEvent) => void;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const middleware = makeBearerAuthMiddleware({
    expectedToken: opts.expectedToken,
    onDenied: opts.onDenied,
  });
  const downstream: http.RequestListener = (_req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("OK");
  };
  const server = http.createServer(middleware(downstream));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const url = `http://127.0.0.1:${addr.port}/`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function fetchStatus(url: string, headers: Record<string, string> = {}): Promise<{
  status: number;
  body: string;
  wwwAuth: string | undefined;
}> {
  const res = await fetch(url, { method: "POST", headers });
  const body = await res.text();
  return {
    status: res.status,
    body,
    wwwAuth: res.headers.get("www-authenticate") ?? undefined,
  };
}

describe("ADR-083 HTTP bearer-auth middleware (end-to-end)", () => {
  const TOKEN = "test-token-" + crypto.randomBytes(16).toString("hex"); // ~43 bytes

  it("rejects requests with no Authorization header → 401 + WWW-Authenticate", async () => {
    const denials: HttpAuthDeniedEvent[] = [];
    const srv = await startTestServer({
      expectedToken: TOKEN,
      onDenied: (e) => denials.push(e),
    });
    try {
      const r = await fetchStatus(srv.url);
      assert.equal(r.status, 401);
      assert.match(r.wwwAuth ?? "", /Bearer realm="aep-mcp"/);
      assert.match(r.body, /missing_or_malformed_authorization_header/);
      assert.equal(denials.length, 1);
      assert.equal(denials[0].reason, "missing_header");
    } finally {
      await srv.close();
    }
  });

  it("rejects requests with a wrong token → 401 invalid_bearer_token", async () => {
    const denials: HttpAuthDeniedEvent[] = [];
    const srv = await startTestServer({
      expectedToken: TOKEN,
      onDenied: (e) => denials.push(e),
    });
    try {
      const r = await fetchStatus(srv.url, {
        Authorization: "Bearer wrong-token-here",
      });
      assert.equal(r.status, 401);
      assert.match(r.body, /invalid_bearer_token/);
      assert.equal(denials.length, 1);
      assert.equal(denials[0].reason, "wrong_token");
    } finally {
      await srv.close();
    }
  });

  it("rejects malformed Authorization header (Basic, missing token) → 401 missing", async () => {
    const denials: HttpAuthDeniedEvent[] = [];
    const srv = await startTestServer({
      expectedToken: TOKEN,
      onDenied: (e) => denials.push(e),
    });
    try {
      const r1 = await fetchStatus(srv.url, { Authorization: "Basic abc" });
      assert.equal(r1.status, 401);
      assert.match(r1.body, /missing_or_malformed_authorization_header/);
      const r2 = await fetchStatus(srv.url, { Authorization: "Bearer" });
      assert.equal(r2.status, 401);
      assert.match(r2.body, /missing_or_malformed_authorization_header/);
      assert.equal(denials.length, 2);
    } finally {
      await srv.close();
    }
  });

  it("accepts a valid Bearer token → 200 OK from downstream", async () => {
    const denials: HttpAuthDeniedEvent[] = [];
    const srv = await startTestServer({
      expectedToken: TOKEN,
      onDenied: (e) => denials.push(e),
    });
    try {
      const r = await fetchStatus(srv.url, {
        Authorization: `Bearer ${TOKEN}`,
      });
      assert.equal(r.status, 200);
      assert.equal(r.body, "OK");
      assert.equal(denials.length, 0);
    } finally {
      await srv.close();
    }
  });

  it("passes 'Bearer  <token>' with extra whitespace (regex tolerates)", async () => {
    const srv = await startTestServer({ expectedToken: TOKEN });
    try {
      const r = await fetchStatus(srv.url, {
        Authorization: `Bearer   ${TOKEN}  `,
      });
      assert.equal(r.status, 200);
    } finally {
      await srv.close();
    }
  });

  it("token comparison is constant-time-ish — tokens of vastly different length both reject without throwing", async () => {
    // The internal SHA-256 step normalizes lengths before timingSafeEqual,
    // so any presented length is accepted at the API surface and rejected
    // logically. We assert no exception path leaks the expected length.
    const srv = await startTestServer({ expectedToken: TOKEN });
    try {
      for (const tooShort of ["a", "xx", "a".repeat(8), "z".repeat(1024)]) {
        const r = await fetchStatus(srv.url, {
          Authorization: `Bearer ${tooShort}`,
        });
        assert.equal(r.status, 401, `length ${tooShort.length} should 401`);
        assert.match(r.body, /invalid_bearer_token/);
      }
    } finally {
      await srv.close();
    }
  });
});
