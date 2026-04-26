/**
 * AUD-027 / AUD-402 — JWT_SECRET length floor regression tests.
 *
 * `src/x402-relay/index.ts` enforces:
 *   1. JWT_SECRET must be set (else stderr "FATAL: ..." + process.exit(1)).
 *   2. JWT_SECRET must be >= 32 bytes (else `throw new Error("JWT_SECRET
 *      must be at least 32 bytes; got <N>.")`).
 *
 * AUD-402 (cycle-2 audit) flagged that the cycle-1 closure (commit 8255d03)
 * was hardcoded but had no automated rejection-path test, blocked because
 * `src/x402-relay/package.json` had no `test` script. This file plus the
 * newly-added `npm test` infra is that gate.
 *
 * Test strategy:
 *
 * `index.ts` calls `app.listen(PORT, ...)` at module load time, which means
 * importing it inside the test process would start a real HTTP server and
 * leak a port. Instead we spawn `tsx index.ts` as a child, set the env
 * exactly, wait for the process to either (a) exit with a non-zero status
 * + matching stderr (rejection cases) or (b) stay alive past a short
 * grace window (acceptance case — which we then SIGKILL).
 *
 * Logger ESM caveat: x402-relay's `import { logger } from "./logger.js"`
 * uses the ts-node/tsx ".js"-extension-on-.ts ESM convention. tsx handles
 * this transparently — confirmed by spawning the same command manually.
 *
 * Runs under `tsx --test` via the package's new `npm test` script.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as crypto from "node:crypto";

// `npm test` runs from `src/x402-relay/` (the workspace cwd), so resolve
// the relay entrypoint relative to that. We avoid `import.meta.url` here
// to remain agnostic to whether tsx loads this file as ESM or CJS — the
// package's tsconfig is "module: commonjs", but tsx's `--test` runner
// can promote files to ESM unpredictably; CWD-relative is portable.
const RELAY_CWD = path.resolve(process.cwd());
const RELAY_INDEX = path.join(RELAY_CWD, "index.ts");

interface SpawnOutcome {
  /** null when the process was still alive at the grace deadline. */
  exitCode: number | null;
  /** null when the process was killed via SIGKILL/SIGTERM. */
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  /** True if the test killed the process because it stayed alive (i.e. it
   *  passed the JWT_SECRET gate and started `app.listen`). */
  killedAfterGrace: boolean;
}

/**
 * Spawn `tsx index.ts` for the relay and wait up to `graceMs`. If the child
 * exits within the grace window we return the captured exit code/signal
 * and stderr. If it is still alive at the deadline we SIGKILL and report
 * `killedAfterGrace: true` — that is the "passed the JWT_SECRET gate"
 * signal, since the gate is synchronous-at-module-load.
 */
function spawnRelay(env: Record<string, string | undefined>, graceMs = 2500): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    // Pin RELAY_PORT=0 so the OS allocates an ephemeral port if the gate
    // passes — otherwise concurrent test runs would collide on the
    // hardcoded default 3200.
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      RELAY_PORT: "0",
      ...env,
    };
    // Allow callers to *unset* a var by passing `undefined`.
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete childEnv[k];
    }

    // Spawn `node --import tsx index.ts` directly (NOT via `npx tsx`).
    //
    // `npx tsx ...` actually runs `npm exec` → `sh` → `node tsx` → `node
    // index.ts` — a 4-deep process chain. SIGKILL on the top `npx` does
    // not propagate to the leaf node, so the relay listener leaks and
    // the test runner hangs at the grace timer (the leaf keeps
    // file-handle refs alive on stdout/stderr).
    //
    // Spawning `node` directly with the tsx loader (`--import tsx`)
    // produces a single child process that we own end-to-end — kill
    // semantics become straightforward and the listener actually dies.
    // Mirrors the pattern in `mcp-server/package.json`'s test script
    // (`node --import tsx --test ...`).
    const child = spawn(
      process.execPath,
      ["--import", "tsx", RELAY_INDEX],
      {
        cwd: RELAY_CWD,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });

    let killedAfterGrace = false;
    const killTimer = setTimeout(() => {
      killedAfterGrace = true;
      child.kill("SIGKILL");
    }, graceMs);

    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      resolve({
        exitCode: code,
        signal,
        stderr,
        stdout,
        killedAfterGrace,
      });
    });
  });
}

describe("AUD-027 / AUD-402: JWT_SECRET length floor (>= 32 bytes)", () => {
  it("rejects unset JWT_SECRET with a FATAL stderr line and non-zero exit", async () => {
    const out = await spawnRelay({ JWT_SECRET: undefined });
    assert.equal(out.killedAfterGrace, false, "process must exit on its own when JWT_SECRET is unset");
    assert.notEqual(out.exitCode, 0, `expected non-zero exit, got ${out.exitCode}`);
    assert.match(
      out.stderr,
      /FATAL: JWT_SECRET environment variable must be set/,
      "stderr must include the FATAL line",
    );
  });

  it("rejects empty-string JWT_SECRET", async () => {
    // process.env value "" is truthy-undefined for `process.env.JWT_SECRET`
    // in the loader (Node returns the literal "" — `!JWT_SECRET_RAW` is
    // true on "" so the FATAL path fires).
    const out = await spawnRelay({ JWT_SECRET: "" });
    assert.equal(out.killedAfterGrace, false, "process must exit on its own");
    assert.notEqual(out.exitCode, 0, `expected non-zero exit, got ${out.exitCode}`);
    assert.match(
      out.stderr,
      /FATAL: JWT_SECRET environment variable must be set/,
      "empty JWT_SECRET takes the unset-check branch",
    );
  });

  it("rejects 5-byte JWT_SECRET with the length-floor error", async () => {
    const out = await spawnRelay({ JWT_SECRET: "short" });
    assert.equal(out.killedAfterGrace, false, "process must exit on its own when secret is too short");
    assert.notEqual(out.exitCode, 0, `expected non-zero exit, got ${out.exitCode}`);
    assert.match(
      out.stderr,
      /JWT_SECRET must be at least 32 bytes/,
      "stderr must cite the 32-byte floor",
    );
    // Sanity: the error message should also report the actual length the
    // operator supplied, so misconfiguration is self-diagnosing.
    assert.match(out.stderr, /got 5/, "error must report the supplied length");
  });

  it("rejects 31-byte JWT_SECRET (one byte below the floor)", async () => {
    // 31 ASCII chars = 31 UTF-8 bytes — boundary case for the >= 32 check.
    const secret = "a".repeat(31);
    const out = await spawnRelay({ JWT_SECRET: secret });
    assert.equal(out.killedAfterGrace, false, "process must exit on its own");
    assert.notEqual(out.exitCode, 0, `expected non-zero exit, got ${out.exitCode}`);
    assert.match(out.stderr, /JWT_SECRET must be at least 32 bytes/);
    assert.match(out.stderr, /got 31/);
  });

  it("accepts a 32-byte JWT_SECRET (exactly at the floor) and passes the gate", async () => {
    // openssl rand -hex 16 → 32-char hex = 32 UTF-8 bytes — matches the
    // RFC 7518 HS256 key-size guidance the AUD-027 comment cites.
    const secret = crypto.randomBytes(16).toString("hex");
    assert.equal(Buffer.byteLength(secret, "utf8"), 32, "test fixture: secret must be exactly 32 bytes");

    const out = await spawnRelay({ JWT_SECRET: secret });
    // Passing the gate means the process reaches `app.listen(PORT, ...)`
    // and stays alive until our grace timer SIGKILLs it.
    assert.equal(
      out.killedAfterGrace,
      true,
      "32-byte secret must pass the gate; process should still be running at grace deadline. " +
        `stderr=${JSON.stringify(out.stderr)}`,
    );
    assert.doesNotMatch(
      out.stderr,
      /JWT_SECRET must be at least 32 bytes/,
      "must NOT emit the length-floor error at the boundary",
    );
    assert.doesNotMatch(
      out.stderr,
      /FATAL: JWT_SECRET environment variable must be set/,
      "must NOT emit the unset-check error at the boundary",
    );
  });

  it("accepts a 64-byte JWT_SECRET (well above the floor)", async () => {
    // openssl rand -hex 32 — the value the AUD-027 comment recommends.
    const secret = crypto.randomBytes(32).toString("hex");
    assert.equal(Buffer.byteLength(secret, "utf8"), 64);

    const out = await spawnRelay({ JWT_SECRET: secret });
    assert.equal(
      out.killedAfterGrace,
      true,
      `64-byte secret must pass the gate. stderr=${JSON.stringify(out.stderr)}`,
    );
  });
});
