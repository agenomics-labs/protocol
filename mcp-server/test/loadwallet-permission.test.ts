/**
 * ADR-083 Finding 5.1 — assertKeyfilePermissions tests.
 *
 * Mode 0600  → ok (silent)
 * Mode 0644  → throws with actionable error
 * Mode 0640  → throws (group read still leaks)
 * Mode 0700  → ok (the executable bit doesn't matter for our policy, but a
 *              real Solana CLI keyfile is 0600 — we test 0700 so we don't
 *              accidentally enforce a stricter rule than ADR-083 specifies)
 *
 * Skipped on Windows (no meaningful mode bits).
 *
 * Runs under `node --import tsx --test`.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { assertKeyfilePermissions } from "../src/transport/auth-gate.js";

const SKIP_ON_WINDOWS = process.platform === "win32";

function withTempKeyfile(mode: number, body: (p: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aep-keyperm-"));
  const file = path.join(dir, "id.json");
  fs.writeFileSync(file, "[1,2,3]");
  fs.chmodSync(file, mode);
  try {
    body(file);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

describe("ADR-083 Finding 5.1 — assertKeyfilePermissions", { skip: SKIP_ON_WINDOWS }, () => {
  it("accepts mode 0600 silently", () => {
    withTempKeyfile(0o600, (file) => {
      assert.doesNotThrow(() => assertKeyfilePermissions(file));
    });
  });

  it("rejects mode 0644 with actionable error citing chmod 600", () => {
    withTempKeyfile(0o644, (file) => {
      try {
        assertKeyfilePermissions(file);
        assert.fail("expected throw");
      } catch (e) {
        const msg = (e as Error).message;
        assert.match(msg, /Refusing to load wallet keyfile/);
        assert.match(msg, /644/);
        assert.match(msg, new RegExp(`chmod 600 ${file.replace(/\//g, "\\/")}`));
      }
    });
  });

  it("rejects mode 0640 (group-read but not other-read)", () => {
    withTempKeyfile(0o640, (file) => {
      assert.throws(
        () => assertKeyfilePermissions(file),
        /too permissive/,
      );
    });
  });

  it("rejects mode 0604 (no group-read but other-read)", () => {
    withTempKeyfile(0o604, (file) => {
      assert.throws(
        () => assertKeyfilePermissions(file),
        /too permissive/,
      );
    });
  });

  it("accepts mode 0700 (executable bit on owner is irrelevant to the policy)", () => {
    withTempKeyfile(0o700, (file) => {
      assert.doesNotThrow(() => assertKeyfilePermissions(file));
    });
  });

  it("accepts mode 0400 (read-only owner is fine)", () => {
    withTempKeyfile(0o400, (file) => {
      assert.doesNotThrow(() => assertKeyfilePermissions(file));
    });
  });

  it("does not throw on a missing path (caller's existsSync surfaces the error)", () => {
    const missing = path.join(os.tmpdir(), "definitely-not-a-real-file-" + Date.now());
    assert.doesNotThrow(() => assertKeyfilePermissions(missing));
  });
});
