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
 * AUD-016 / AUD-401 — `loadWallet()` env-var precedence regression tests.
 *
 * Resolution order (highest first):
 *   1. ANCHOR_WALLET            (Anchor's documented convention)
 *   2. SOLANA_KEYPAIR_PATH      (legacy MCP-only env var)
 *   3. ~/.config/solana/id.json (Solana CLI default, only when neither is set)
 *
 * Pre-AUD-016 the implementation only honoured (2) so users who set
 * ANCHOR_WALLET (the standard variable) saw "wallet not found" errors
 * despite having a working Anchor setup. AUD-401 (cycle-2 audit) flagged
 * that the closure was review-verified only — these tests are the
 * automated regression that fails the build if the precedence ever
 * regresses.
 *
 * Runs under `node --import tsx --test`.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { Keypair } from "@solana/web3.js";

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

// ===========================================================================
// AUD-016 / AUD-401 — ANCHOR_WALLET precedence regression
// ===========================================================================
//
// `loadWallet()` reads its keypath from `ANCHOR_WALLET || SOLANA_KEYPAIR_PATH`
// then falls back to `~/.config/solana/id.json`. The first env var WINS — that
// is the entire fix shipped in commit 9213c1a (mcp-server/src/solana.ts:155-177).
//
// Test strategy: `loadWallet()` memoises its return value in a module-level
// `_wallet` singleton, so we cache-bust the import via a unique query string
// per case. tsx's ESM loader honours the query string and re-evaluates the
// module, giving each case a fresh, uncached `loadWallet`.
//
// Each case writes a real (Keypair.generate()) 64-byte secretKey to a temp
// file at mode 0600 (so `assertKeyfilePermissions` is happy), points the
// relevant env var at it, and asserts the loaded public key matches the
// keypair we just wrote.

function writeKeypairTo(file: string): Keypair {
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  fs.chmodSync(file, 0o600);
  return kp;
}

interface SolanaModule {
  loadWallet(): Keypair;
}

async function freshSolanaModule(): Promise<SolanaModule> {
  // Cache-bust via query string so each test gets a fresh `_wallet` cache.
  // tsx's ESM loader serves this as a re-evaluated module instance.
  const url = `../src/solana.js?cb=${Date.now()}-${Math.random()}`;
  return (await import(url)) as SolanaModule;
}

interface EnvSnapshot {
  ANCHOR_WALLET: string | undefined;
  SOLANA_KEYPAIR_PATH: string | undefined;
  HOME: string | undefined;
}

function snapshotEnv(): EnvSnapshot {
  return {
    ANCHOR_WALLET: process.env.ANCHOR_WALLET,
    SOLANA_KEYPAIR_PATH: process.env.SOLANA_KEYPAIR_PATH,
    HOME: process.env.HOME,
  };
}

function restoreEnv(s: EnvSnapshot): void {
  for (const k of ["ANCHOR_WALLET", "SOLANA_KEYPAIR_PATH", "HOME"] as const) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}

describe(
  "AUD-016 / AUD-401: loadWallet ANCHOR_WALLET precedence",
  { skip: SKIP_ON_WINDOWS },
  () => {
    it("ANCHOR_WALLET wins when both env vars are set (and point at different files)", async () => {
      const snap = snapshotEnv();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aep-aud401-both-"));
      try {
        const anchorFile = path.join(dir, "anchor-wallet.json");
        const legacyFile = path.join(dir, "legacy-wallet.json");
        const anchorKp = writeKeypairTo(anchorFile);
        const legacyKp = writeKeypairTo(legacyFile);

        // Sanity: keys must be distinguishable so the assertion is meaningful.
        assert.notEqual(
          anchorKp.publicKey.toBase58(),
          legacyKp.publicKey.toBase58(),
          "test fixture: generated keypairs must differ",
        );

        process.env.ANCHOR_WALLET = anchorFile;
        process.env.SOLANA_KEYPAIR_PATH = legacyFile;

        const mod = await freshSolanaModule();
        const loaded = mod.loadWallet();
        assert.equal(
          loaded.publicKey.toBase58(),
          anchorKp.publicKey.toBase58(),
          "loadWallet() must use ANCHOR_WALLET when both env vars are set",
        );
        assert.notEqual(
          loaded.publicKey.toBase58(),
          legacyKp.publicKey.toBase58(),
          "loadWallet() must NOT fall back to SOLANA_KEYPAIR_PATH when ANCHOR_WALLET is set",
        );
      } finally {
        restoreEnv(snap);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("SOLANA_KEYPAIR_PATH is honoured when ANCHOR_WALLET is unset", async () => {
      const snap = snapshotEnv();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aep-aud401-legacy-"));
      try {
        const legacyFile = path.join(dir, "legacy-wallet.json");
        const legacyKp = writeKeypairTo(legacyFile);

        delete process.env.ANCHOR_WALLET;
        process.env.SOLANA_KEYPAIR_PATH = legacyFile;

        const mod = await freshSolanaModule();
        const loaded = mod.loadWallet();
        assert.equal(
          loaded.publicKey.toBase58(),
          legacyKp.publicKey.toBase58(),
          "loadWallet() must honour SOLANA_KEYPAIR_PATH when ANCHOR_WALLET is unset",
        );
      } finally {
        restoreEnv(snap);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("falls back to ~/.config/solana/id.json when neither env var is set", async () => {
      const snap = snapshotEnv();
      const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "aep-aud401-home-"));
      try {
        const cliDir = path.join(fakeHome, ".config", "solana");
        fs.mkdirSync(cliDir, { recursive: true });
        const cliFile = path.join(cliDir, "id.json");
        const cliKp = writeKeypairTo(cliFile);

        delete process.env.ANCHOR_WALLET;
        delete process.env.SOLANA_KEYPAIR_PATH;
        process.env.HOME = fakeHome;

        const mod = await freshSolanaModule();
        const loaded = mod.loadWallet();
        assert.equal(
          loaded.publicKey.toBase58(),
          cliKp.publicKey.toBase58(),
          "loadWallet() must fall back to ~/.config/solana/id.json " +
            "when neither ANCHOR_WALLET nor SOLANA_KEYPAIR_PATH is set",
        );
      } finally {
        restoreEnv(snap);
        fs.rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    it("throws an actionable error when no keyfile can be found at any precedence level", async () => {
      const snap = snapshotEnv();
      const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "aep-aud401-empty-"));
      try {
        // No keyfile at $fakeHome/.config/solana/id.json; both env vars unset.
        delete process.env.ANCHOR_WALLET;
        delete process.env.SOLANA_KEYPAIR_PATH;
        process.env.HOME = fakeHome;

        const mod = await freshSolanaModule();
        assert.throws(
          () => mod.loadWallet(),
          (err: Error) =>
            /Wallet keypair not found/.test(err.message) &&
            /ANCHOR_WALLET or SOLANA_KEYPAIR_PATH/.test(err.message),
          "missing-keyfile error must name both env vars",
        );
      } finally {
        restoreEnv(snap);
        fs.rmSync(fakeHome, { recursive: true, force: true });
      }
    });
  },
);
