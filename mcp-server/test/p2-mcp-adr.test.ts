/**
 * P2 — cycle-4 security: ADR-143 + ADR-144 + CC-5.
 *
 * ADR-143 (CC-3) — capability enforcement decoupled from `readOnly`:
 *   1. capabilityGated gates a readOnly:true action that declares caps
 *      (the pre-ADR-143 gate would have skipped it).
 *   2. capabilityGated allows the same action when the wallet holds caps.
 *   3. Registration-time assertion rejects sensitiveRead:true + empty caps.
 *   4. A readOnly:true action with empty caps + no sensitiveRead still
 *      passes registration (public read) and is ungated.
 *   5. `readOnly` still governs signer semantics (requiresSigner honoured).
 *
 * ADR-144 (C4-MCPEVO-001) — bounded-fetch helper:
 *   6. Oversize body (streamed, no Content-Length) aborts with `oversize`.
 *   7. Slow body aborts with `timeout`.
 *   8. Content-type mismatch throws `content-type`.
 *   9. Happy path returns bytes under the cap.
 *
 * CC-5 (C4-MCPEVO-002) — solanaAddress zod helper:
 *  10. Accepts a valid base58 pubkey.
 *  11. Rejects garbage / wrong-length / non-base58.
 *  12. solanaWalletAddress rejects an off-curve PDA.
 *
 * Runs under `node --import tsx --test`.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { PublicKey } from "@solana/web3.js";

import { capabilityGated } from "../src/adapters/capability-gated-tool.js";
import { ok } from "../src/types/action.js";
import type { Action, ActionContext } from "../src/types/action.js";
import type { Capability } from "../src/types/capability.js";
import {
  boundedFetchBytes,
  BoundedFetchError,
} from "../src/util/bounded-fetch.js";
import {
  solanaAddress,
  solanaWalletAddress,
} from "../src/schema/solana-address.js";
import { deriveProtocolConfigPDA } from "../src/solana.js";

function ctxWith(caps: Capability[]): ActionContext {
  return {
    mode: "signed",
    wallet: {
      publicKey: new PublicKey("11111111111111111111111111111111"),
      capabilities: new Set(caps),
    },
    signer: {},
  } as ActionContext;
}

function baseAction(over: Partial<Action> = {}): Action {
  return {
    name: "test_action",
    title: "t",
    description: "d",
    inputSchema: {} as never,
    outputSchema: {} as never,
    similes: [],
    examples: [],
    readOnly: true,
    capabilities: [],
    handler: async () => ok({ done: true }),
    ...over,
  } as Action;
}

describe("ADR-143 — capability enforcement decoupled from readOnly", () => {
  it("gates a readOnly:true action that declares caps (CC-3)", async () => {
    const action = capabilityGated(
      baseAction({
        name: "sensitive_read",
        readOnly: true,
        sensitiveRead: true,
        capabilities: ["read:agent-memory"],
      }),
    );
    const r = await action.handler(ctxWith([]), {});
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "CAPABILITY_MISSING");
  });

  it("allows the readOnly:true action when the wallet holds the cap", async () => {
    const action = capabilityGated(
      baseAction({
        readOnly: true,
        sensitiveRead: true,
        capabilities: ["read:agent-memory"],
      }),
    );
    const r = await action.handler(ctxWith(["read:agent-memory"]), {});
    assert.equal(r.ok, true);
  });

  it("registration rejects sensitiveRead:true with empty caps", () => {
    assert.throws(
      () =>
        capabilityGated(
          baseAction({ readOnly: true, sensitiveRead: true, capabilities: [] }),
        ),
      /ADR-143/,
    );
  });

  it("a plain public readOnly action (no caps, no sensitiveRead) is ungated", async () => {
    const action = capabilityGated(
      baseAction({ readOnly: true, capabilities: [] }),
    );
    const r = await action.handler(ctxWith([]), {});
    assert.equal(r.ok, true);
  });

  it("readOnly still governs signer semantics (requiresSigner honoured)", async () => {
    const action = capabilityGated(
      baseAction({
        readOnly: false,
        capabilities: ["sign:vault"],
        requiresSigner: true,
      }),
    );
    const passthroughCtx = {
      ...ctxWith(["sign:vault"]),
      mode: "passthrough",
      signer: null,
    } as ActionContext;
    const r = await action.handler(passthroughCtx, {});
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "SIGNER_UNAVAILABLE");
  });
});

function listen(
  handler: http.RequestListener,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res) => srv.close(() => res())),
      });
    });
  });
}

describe("ADR-144 — bounded-fetch helper", () => {
  it("aborts an oversize streamed body (no Content-Length) with `oversize`", async () => {
    const srv = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      // Stream past the cap without ever ending.
      const chunk = Buffer.alloc(64 * 1024, 1);
      const iv = setInterval(() => res.write(chunk), 1);
      res.on("close", () => clearInterval(iv));
    });
    try {
      await assert.rejects(
        boundedFetchBytes(srv.url, { maxBytes: 128 * 1024, timeoutMs: 5000 }),
        (e: unknown) =>
          e instanceof BoundedFetchError && e.kind === "oversize",
      );
    } finally {
      await srv.close();
    }
  });

  it("aborts a slow response with `timeout`", async () => {
    const srv = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // Never finish the body.
    });
    try {
      await assert.rejects(
        boundedFetchBytes(srv.url, { timeoutMs: 150 }),
        (e: unknown) =>
          e instanceof BoundedFetchError && e.kind === "timeout",
      );
    } finally {
      await srv.close();
    }
  });

  it("rejects a content-type mismatch", async () => {
    const srv = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html></html>");
    });
    try {
      await assert.rejects(
        boundedFetchBytes(srv.url, { expectContentType: ["application/json"] }),
        (e: unknown) =>
          e instanceof BoundedFetchError && e.kind === "content-type",
      );
    } finally {
      await srv.close();
    }
  });

  it("returns bytes for a small body under the cap", async () => {
    const srv = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const { bytes } = await boundedFetchBytes(srv.url, {
        maxBytes: 64 * 1024,
      });
      assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), {
        ok: true,
      });
    } finally {
      await srv.close();
    }
  });
});

describe("CC-5 — solanaAddress zod helper", () => {
  const valid = new PublicKey(
    "So11111111111111111111111111111111111111112",
  ).toBase58();

  it("accepts a valid base58 pubkey", () => {
    assert.equal(solanaAddress.safeParse(valid).success, true);
  });

  it("rejects garbage / wrong-length / non-base58", () => {
    for (const bad of [
      "",
      "not-a-key",
      "0x1234",
      "IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII", // 'I' not in base58 alphabet
      "1".repeat(45),
      valid + "x",
    ]) {
      assert.equal(
        solanaAddress.safeParse(bad).success,
        false,
        `expected reject: ${bad}`,
      );
    }
  });

  it("solanaWalletAddress rejects an off-curve PDA", () => {
    const [pda] = deriveProtocolConfigPDA();
    // A PDA is off-curve by construction.
    assert.equal(
      solanaWalletAddress.safeParse(pda.toBase58()).success,
      false,
    );
    // But the plain solanaAddress still accepts it (it is a valid pubkey).
    assert.equal(solanaAddress.safeParse(pda.toBase58()).success, true);
  });
});
