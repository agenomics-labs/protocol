/**
 * ADR-082 / audit-2026-04-23 item 7: tests for the event-coverage CI gate.
 *
 * Runs under node:test + tsx. Verifies:
 *   1. The discriminator computation matches the Anchor 0.30+ convention
 *      (sha256("event:<Name>")[..8]) for known-good values.
 *   2. The Rust events.rs parser finds every #[event] declaration.
 *   3. The indexer DISCRIMINATOR_MAP extractor returns every key.
 *   4. End-to-end: the script catches a deliberately removed event.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  discriminatorFor,
  extractEventNames,
  extractIndexerDiscriminators,
} from "../scripts/check-event-coverage";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "check-event-coverage.ts");
const INDEXER_PATH = join(REPO_ROOT, "src", "indexer", "index.ts");

test("discriminatorFor matches the Anchor sha256(event:<Name>)[..8] convention", () => {
  // These four values are the canonical Anchor discriminators for events
  // that the indexer has been parsing in production for months. If
  // discriminatorFor ever drifts from the Anchor convention, every
  // single one of these will mismatch.
  assert.equal(discriminatorFor("AgentRegistered"), "bf4ed936e864bd55");
  assert.equal(discriminatorFor("EscrowCreated"), "467f69665c6107ad");
  assert.equal(discriminatorFor("VaultInitialized"), "b42bcf021247034b");
  assert.equal(discriminatorFor("ReputationUpdated"), "1a24bb96eb5a6a59");
});

test("discriminatorFor produces the expected hex for the four newly-added events", () => {
  // ADR-082 / item 6: the four events that were silently missing.
  // Recorded here as a regression guard.
  assert.equal(discriminatorFor("AgentIdentityUpdated"), "aa69af3aa3095577");
  assert.equal(discriminatorFor("ManifestUpdated"), "6941986a36affdb3");
  assert.equal(discriminatorFor("ProtocolConfigInitialized"), "f3451bee6fa957e7");
  assert.equal(discriminatorFor("ProtocolConfigUpdated"), "146320ed6f56c3c7");
});

test("discriminatorFor is a 16-character lower-case hex string for arbitrary names", () => {
  const out = discriminatorFor("SomeNewEventName");
  assert.match(out, /^[0-9a-f]{16}$/);
});

test("extractEventNames finds every #[event] in agent-vault events.rs", () => {
  const src = readFileSync(
    join(REPO_ROOT, "programs", "agent-vault", "src", "events.rs"),
    "utf8"
  );
  const names = extractEventNames(src);
  // Order-independent: just assert membership for the events we care about.
  assert.ok(names.includes("VaultInitialized"), "VaultInitialized missing");
  assert.ok(names.includes("AgentIdentityUpdated"), "AgentIdentityUpdated missing");
  assert.ok(names.includes("PolicyUpdated"), "PolicyUpdated missing");
  assert.ok(names.includes("VaultPaused"), "VaultPaused missing");
  // Sanity: agent-vault has 9 events at the time of writing — if a
  // future PR adds one, this number should grow, not shrink.
  assert.ok(names.length >= 9, `expected >=9 events in agent-vault, found ${names.length}`);
});

test("extractEventNames tolerates doc comments and extra attributes between #[event] and the struct", () => {
  const src = `
use anchor_lang::prelude::*;

#[event]
/// A doc comment between the attribute and the struct.
pub struct WithDocComment { pub authority: Pubkey }

#[event]
#[derive(Debug)]
pub struct WithExtraAttribute { pub vault: Pubkey }

// not an event
pub struct Plain { pub x: u64 }
`;
  const names = extractEventNames(src);
  assert.deepEqual(names.sort(), ["WithDocComment", "WithExtraAttribute"]);
});

test("extractIndexerDiscriminators returns every key from the live indexer map", () => {
  const indexerSrc = readFileSync(INDEXER_PATH, "utf8");
  const keys = extractIndexerDiscriminators(indexerSrc);
  // Should contain at minimum the four newly-added events.
  assert.ok(keys.has("aa69af3aa3095577"), "AgentIdentityUpdated discriminator missing");
  assert.ok(keys.has("6941986a36affdb3"), "ManifestUpdated discriminator missing");
  assert.ok(keys.has("f3451bee6fa957e7"), "ProtocolConfigInitialized discriminator missing");
  assert.ok(keys.has("146320ed6f56c3c7"), "ProtocolConfigUpdated discriminator missing");
  // Plus the original 27.
  assert.ok(keys.size >= 31, `expected at least 31 entries, found ${keys.size}`);
});

test("script exits 0 when indexer covers every program-side event with a parseable decoder", () => {
  // Workstream arc:
  //   - cycle-3 audit (2026-04-23) found that the gate silently skipped
  //     disc-map events whose decoders were missing or unparseable;
  //   - commit dd498b2 hardened the gate to fail on those (Fix 1) and
  //     added a block-body arrow-decoder parser (Fix 2);
  //   - commit 9df533c codified the transitional fail-mode contract in
  //     this test (asserted exit 1 + ReputationStaked / later TaskAccepted
  //     anchor + composite FAIL summary), with an explicit note that the
  //     test would flip back to the OK contract once the 18 decoder-less
  //     events were wired;
  //   - commits ad14912 (1/3, agent-vault, 8 events), 0d13f50 (2/3,
  //     agent-registry, 3 events), and the same commit as this test
  //     flip (3/3, settlement, 7 events) added the 18 missing decoders;
  //   - this test now asserts the OK contract, retiring the fail-mode
  //     contract that lived only across commits dd498b2..0d13f50.
  //
  // Contract:
  //   (a) exit code 0
  //   (b) stdout contains the OK summary line emitted by
  //       scripts/check-event-coverage.ts when decoderLess === 0 AND
  //       fieldDrift === 0 (the all-covered path)
  //   (c) AgentStatusUpdated is NOT listed as decoder-less in stderr —
  //       Fix 2 (dd498b2) taught extractDecoderFields to parse block-
  //       body arrow decoders, of which AgentStatusUpdated is the
  //       exemplar; if the regex regresses, AgentStatusUpdated would
  //       resurface as decoder-less and the gate would fail with a
  //       concrete reason line. This guard outlives the fail-mode
  //       contract because it asserts a property of Fix 2's parser
  //       independent of the gate's overall pass/fail state.
  let exitCode = -1;
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync("npx", ["tsx", SCRIPT_PATH], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      encoding: "utf8",
    });
    exitCode = 0;
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    exitCode = e.status ?? -1;
    stdout = e.stdout?.toString() ?? "";
    stderr = e.stderr?.toString() ?? "";
  }
  assert.equal(
    exitCode,
    0,
    `expected gate to pass on the current tree (all decoders wired); got ${exitCode}. stderr: ${stderr}`
  );
  assert.match(
    stdout,
    /\[event-coverage\] OK: indexer covers all \d+ on-chain #\[event\] declaration\(s\) across \d+ program crate\(s\); field-coverage verified for events with decoders; skipped \d+ events with neither disc-map nor decoder\./,
    "expected the all-covered OK summary line emitted by scripts/check-event-coverage.ts when decoderLess === 0 && fieldDrift === 0"
  );
  // Fix 2 regression guard: AgentStatusUpdated has a block-body arrow
  // decoder (src/indexer/index.ts ~524-529). If extractDecoderFields
  // ever loses block-body support, AgentStatusUpdated would re-appear
  // as decoder-less and the gate would fail; in the OK path stderr is
  // empty, so the absence of the reason line is trivially true — but
  // we keep the assertion to flag a regression that flipped the gate
  // back to FAIL with this specific event listed.
  assert.doesNotMatch(
    stderr,
    /\bAgentStatusUpdated\b[^\n]*\n\s*reason:/,
    "AgentStatusUpdated should be parseable (Fix 2: block-body arrow decoder support)"
  );
});

test("script exits 1 and names the missing event when DISCRIMINATOR_MAP loses an entry", () => {
  // Simulate drift by writing a doctored copy of the indexer + a
  // wrapper script that points the gate at it. We can't easily redirect
  // the real script's INDEXER_PATH constant from outside, so instead
  // we copy programs/ + a doctored indexer + the script into a temp
  // directory and run the script from there.
  const tmp = mkdtempSync(join(tmpdir(), "event-coverage-drift-"));
  try {
    // Copy programs/ tree (we only need events.rs files).
    const programsDirs = ["agent-vault", "agent-registry", "settlement"];
    for (const crate of programsDirs) {
      const srcDir = join(REPO_ROOT, "programs", crate, "src");
      const dstDir = join(tmp, "programs", crate, "src");
      mkdirSync(dstDir, { recursive: true });
      const eventsContent = readFileSync(join(srcDir, "events.rs"), "utf8");
      writeFileSync(join(dstDir, "events.rs"), eventsContent);
    }
    // Doctored indexer: drop AgentIdentityUpdated entry.
    const indexerSrc = readFileSync(INDEXER_PATH, "utf8");
    const doctored = indexerSrc.replace(
      /aa69af3aa3095577:\s*"AgentIdentityUpdated",/,
      "// AgentIdentityUpdated removed for drift test"
    );
    assert.notEqual(doctored, indexerSrc, "expected the test setup to actually mutate the indexer source");
    const dstIndexerDir = join(tmp, "src", "indexer");
    mkdirSync(dstIndexerDir, { recursive: true });
    writeFileSync(join(dstIndexerDir, "index.ts"), doctored);
    // Initialize a tiny git repo so `git ls-files` works inside the
    // temp tree (the script uses git ls-files to enumerate events.rs).
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
    execFileSync("git", ["config", "user.name", "test"], { cwd: tmp });
    execFileSync("git", ["add", "-A"], { cwd: tmp });
    execFileSync("git", ["commit", "-q", "-m", "test fixture"], { cwd: tmp });
    // Copy the script.
    const dstScriptDir = join(tmp, "scripts");
    mkdirSync(dstScriptDir, { recursive: true });
    const scriptContent = readFileSync(SCRIPT_PATH, "utf8");
    writeFileSync(join(dstScriptDir, "check-event-coverage.ts"), scriptContent);
    execFileSync("git", ["add", "-A"], { cwd: tmp });
    execFileSync("git", ["commit", "-q", "-m", "add script"], { cwd: tmp });

    // Run via npx tsx — the workspace root has tsx; pass it explicitly
    // so the temp dir doesn't need its own node_modules.
    const tsxBin = join(REPO_ROOT, "node_modules", ".bin", "tsx");
    let stderr = "";
    let exitCode = 0;
    try {
      execFileSync(tsxBin, [join(tmp, "scripts", "check-event-coverage.ts")], {
        cwd: tmp,
        stdio: "pipe",
        encoding: "utf8",
      });
      exitCode = 0;
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      exitCode = e.status ?? -1;
      stderr = e.stderr?.toString() ?? "";
    }
    assert.equal(exitCode, 1, `expected gate to fail with exit 1, got ${exitCode}. stderr: ${stderr}`);
    assert.match(stderr, /missing event: AgentIdentityUpdated/);
    assert.match(stderr, /aa69af3aa3095577/);
  } finally {
    // tmp dir is left for inspection on test failure; CI runners GC.
  }
});
