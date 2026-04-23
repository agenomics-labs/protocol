#!/usr/bin/env npx tsx
/**
 * ADR-082 / audit-2026-04-23 item 7: indexer event-coverage CI gate.
 *
 * Walks `programs/<crate>/src/events.rs` for every workspace crate and
 * extracts every `#[event] pub struct <Name>` declaration. For each
 * declared event, computes the Anchor 0.30+ discriminator
 * (`sha256("event:<Name>")[..8]`) and asserts the indexer's
 * `DISCRIMINATOR_MAP` contains a matching entry.
 *
 * Exit codes:
 *   0 — every program-side event is covered by the indexer.
 *   1 — at least one event is missing from `DISCRIMINATOR_MAP`. The
 *       offending event(s) and their expected discriminator hex are
 *       printed to stderr so the fix is copy-paste.
 *   2 — couldn't read a required file (programs not on disk, indexer
 *       moved, etc.). Surfaces the underlying I/O error.
 *
 * The script intentionally keeps the indexer parser dumb (regex) rather
 * than importing a full TypeScript AST library. The indexer's
 * `DISCRIMINATOR_MAP` is a flat `Record<string, string>` literal whose
 * keys we extract by matching object-literal entries inside the
 * declaration. If the indexer's shape changes, update INDEXER_MAP_REGEX.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve(__dirname, "..");
const INDEXER_PATH = join(REPO_ROOT, "src", "indexer", "index.ts");

interface ProgramEvent {
  name: string;
  programCrate: string;
  sourceFile: string;
  expectedDiscriminator: string;
}

/**
 * Anchor 0.30+ event discriminator: sha256("event:<EventName>") truncated
 * to 8 bytes, lower-case hex. Matches the indexer's pre-existing entries
 * exactly — see DISCRIMINATOR_MAP comment block in src/indexer/index.ts.
 */
export function discriminatorFor(eventName: string): string {
  return createHash("sha256")
    .update(`event:${eventName}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Extract the `<Name>` from every `#[event] pub struct <Name>` in a Rust
 * source file. Tolerates whitespace and trailing generics; rejects names
 * that don't start with an uppercase ASCII letter (the Anchor convention).
 *
 * The regex is two-step: first locate `#[event]` annotations, then on the
 * very next non-blank, non-attribute line find `pub struct <Name>`. This
 * is more robust than a single regex when authors put doc-comments
 * between `#[event]` and the struct declaration, which is the actual
 * style used in our events.rs files.
 */
export function extractEventNames(rustSource: string): string[] {
  const names: string[] = [];
  const lines = rustSource.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#\[event\]\s*$/.test(lines[i])) continue;
    // Walk forward skipping blank lines, doc comments, and additional
    // attribute lines (e.g. `#[derive(...)]`) until we hit the struct.
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^\s*$/.test(line)) continue;
      if (/^\s*\/\/\//.test(line)) continue; // /// doc comment
      if (/^\s*\/\//.test(line)) continue; // // line comment
      if (/^\s*#\[/.test(line)) continue; // additional attribute
      const m = line.match(/^\s*pub\s+struct\s+([A-Z][A-Za-z0-9_]*)/);
      if (m) names.push(m[1]);
      break;
    }
  }
  return names;
}

/**
 * Discover every events.rs file under programs/. Uses `git ls-files` so
 * we don't have to ship a directory walker — and so an event file that's
 * untracked (i.e. somebody added it but didn't `git add`) isn't checked,
 * which is the desired behavior since CI runs against tracked content.
 */
function findEventsFiles(): string[] {
  const out = execSync("git ls-files programs/*/src/events.rs", {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Pull the discriminator hex keys from the indexer's `DISCRIMINATOR_MAP`
 * literal. Both quoted and bare keys are accepted (see the existing map
 * in src/indexer/index.ts for the mixed style). Stops at the closing
 * brace so we don't bleed into other Records below.
 */
const INDEXER_MAP_REGEX = /const\s+DISCRIMINATOR_MAP\s*:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\n\};/m;

export function extractIndexerDiscriminators(indexerSource: string): Set<string> {
  const block = indexerSource.match(INDEXER_MAP_REGEX);
  if (!block) {
    throw new Error(
      "Couldn't locate DISCRIMINATOR_MAP literal in indexer source — has the variable been renamed?"
    );
  }
  const body = block[1];
  // Match either "deadbeefcafebabe" (quoted) or deadbeefcafebabe (bare)
  // followed by `:`.
  const KEY_REGEX = /(?:["']([0-9a-fA-F]{16})["']|([0-9a-fA-F]{16}))\s*:/g;
  const keys = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = KEY_REGEX.exec(body)) !== null) {
    keys.add((m[1] ?? m[2]).toLowerCase());
  }
  return keys;
}

function main(): void {
  let eventFiles: string[];
  try {
    eventFiles = findEventsFiles();
  } catch (err) {
    console.error(`[event-coverage] couldn't enumerate events.rs files: ${(err as Error).message}`);
    process.exit(2);
  }
  if (eventFiles.length === 0) {
    console.error("[event-coverage] no programs/*/src/events.rs files found — refusing to pass an empty check.");
    process.exit(2);
  }

  const programEvents: ProgramEvent[] = [];
  for (const relPath of eventFiles) {
    const absPath = join(REPO_ROOT, relPath);
    let src: string;
    try {
      src = readFileSync(absPath, "utf8");
    } catch (err) {
      console.error(`[event-coverage] couldn't read ${relPath}: ${(err as Error).message}`);
      process.exit(2);
    }
    const programCrate = relPath.split("/")[1] ?? "<unknown>";
    for (const name of extractEventNames(src)) {
      programEvents.push({
        name,
        programCrate,
        sourceFile: relPath,
        expectedDiscriminator: discriminatorFor(name),
      });
    }
  }

  let indexerSrc: string;
  try {
    indexerSrc = readFileSync(INDEXER_PATH, "utf8");
  } catch (err) {
    console.error(`[event-coverage] couldn't read indexer at ${INDEXER_PATH}: ${(err as Error).message}`);
    process.exit(2);
  }

  let indexerKeys: Set<string>;
  try {
    indexerKeys = extractIndexerDiscriminators(indexerSrc);
  } catch (err) {
    console.error(`[event-coverage] ${(err as Error).message}`);
    process.exit(2);
  }

  const missing: ProgramEvent[] = [];
  for (const ev of programEvents) {
    if (!indexerKeys.has(ev.expectedDiscriminator.toLowerCase())) {
      missing.push(ev);
    }
  }

  if (missing.length > 0) {
    console.error(
      `\n[event-coverage] FAIL: ${missing.length} on-chain event(s) missing from indexer DISCRIMINATOR_MAP:\n`
    );
    for (const ev of missing) {
      console.error(
        `  missing event: ${ev.name}\n` +
          `    program:               ${ev.programCrate}\n` +
          `    source:                ${ev.sourceFile}\n` +
          `    expected discriminator: ${ev.expectedDiscriminator}\n` +
          `    fix: add to DISCRIMINATOR_MAP in src/indexer/index.ts:\n` +
          `      "${ev.expectedDiscriminator}": "${ev.name}",\n` +
          `    and add a Borsh decoder in EVENT_DECODERS that mirrors the field\n` +
          `    layout from ${ev.sourceFile}. See ADR-082 for the rationale.\n`
      );
    }
    process.exit(1);
  }

  console.log(
    `[event-coverage] OK: indexer covers all ${programEvents.length} on-chain #[event] declaration(s) ` +
      `across ${eventFiles.length} program crate(s).`
  );
  process.exit(0);
}

// Only run when invoked directly — keeps the helpers importable from
// tests without firing process.exit.
if (require.main === module) {
  main();
}
