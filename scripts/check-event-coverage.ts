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
 *
 * Field-level coverage (added 2026-04-30, paired with ADR-131): for every
 * event that has a decoder in `EVENT_DECODERS`, the gate now also asserts
 * the decoder's ordered field list matches the on-chain struct's ordered
 * field list. Borsh is positional, so a swap or omission silently
 * misaligns every following field. This catches the ADR-131 class of bug
 * (EscrowCreated missing token_mint) AND surfaced a pre-existing
 * SuspensionCleared decoder that was missing AUD-004's cleared_count
 * field — which had been silently bit-shifting `timestamp` since AUD-004
 * landed. Events without a decoder fall through to the raw
 * `event_<hex>` path by design and are NOT a coverage failure.
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

/**
 * Extract the ordered field-name list from `pub struct <Name> { ... }`.
 * Returns `null` if the struct is not present in the source. Tolerates
 * doc comments, line comments, and trailing-comma styles.
 *
 * The on-chain Borsh wire format serializes struct fields in declaration
 * order; the decoder MUST read them in the same order. So returning the
 * ordered list (not a set) is load-bearing — a swap of two same-typed
 * fields would be undetectable by an unordered comparison.
 */
export function extractStructFields(
  rustSource: string,
  structName: string,
): string[] | null {
  // Match `pub struct <Name> { ... }` capturing the body. The body terminator
  // is the matching `}`; we keep this regex shallow because event structs
  // do not nest braces (no inline tuple structs etc. in the codebase).
  const re = new RegExp(
    `pub\\s+struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\n\\}`,
    "m",
  );
  const m = rustSource.match(re);
  if (!m) return null;
  const body = m[1];
  const fields: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("//")) continue; // line + doc comments
    const fm = line.match(/^pub\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (fm) fields.push(fm[1]);
  }
  return fields;
}

/**
 * Extract the ordered property-key list from the indexer's
 * `<EventName>: (r) => ({ ... })` decoder body inside `EVENT_DECODERS`.
 * Returns `null` if the event has no decoder (an explicit, non-erroneous
 * state — events without a decoder fall through to the raw `event_<hex>`
 * classification path by design).
 *
 * Two shapes are supported:
 *   `EventName: (r) => ({ field: ..., ... })`   ← arrow with object body
 *   `EventName: (r) => { ... return { ... }; }` ← arrow with block body
 * Only the object-body shape is currently used in the codebase, but the
 * matcher tolerates both so a stylistic refactor doesn't break the gate.
 */
export function extractDecoderFields(
  indexerSource: string,
  eventName: string,
): string[] | null {
  // The EVENT_DECODERS literal sits at the top level of index.ts. We anchor
  // on `<EventName>: (r) =>` and then take everything up to the matching
  // close-paren of the wrapping `({ ... })` (object-literal arrow). For
  // simplicity we cap the match at 2KB which is well above any current
  // decoder body — the largest is ProtocolConfigInitialized at ~700 bytes.
  const re = new RegExp(
    `\\b${eventName}\\s*:\\s*\\(r\\)\\s*=>\\s*\\(\\s*\\{([\\s\\S]{0,2048}?)\\}\\s*\\)\\s*,`,
    "m",
  );
  const m = indexerSource.match(re);
  if (!m) return null;
  const body = m[1];
  const fields: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("//")) continue;
    // Property keys at the top level of the body. Excludes nested object
    // values by requiring the property key be at the start of the trimmed
    // line and followed by `:`.
    const fm = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (fm) fields.push(fm[1]);
  }
  return fields;
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

  // Field-coverage gate (ADR-082 follow-up): for every event that has a
  // decoder in EVENT_DECODERS, assert the decoder's ordered field list
  // matches the on-chain struct's ordered field list. Events without a
  // decoder fall through to the raw `event_<hex>` classification by
  // design — that's NOT a coverage failure here.
  //
  // This catches the EscrowCreated/token_mint class of bug: a new field
  // added on-chain that the decoder doesn't read. Pre-fix the
  // discriminator-only gate would pass, the decoder would silently emit
  // events without the new field, and downstream views (e.g. the
  // ADR-131 median-escrow trigger) would silently aggregate
  // unbucketed data.
  const fieldMismatches: Array<{
    event: ProgramEvent;
    structFields: string[];
    decoderFields: string[];
    diff: string;
  }> = [];
  for (const ev of programEvents) {
    const src = readFileSync(join(REPO_ROOT, ev.sourceFile), "utf8");
    const structFields = extractStructFields(src, ev.name);
    if (structFields === null) {
      // Discriminator gate already passed for this event, so the struct
      // exists; failing to extract its fields is a parser bug, not a
      // protocol mismatch. Surface and bail.
      console.error(
        `[event-coverage] internal: couldn't extract struct fields for ${ev.name} from ${ev.sourceFile}`,
      );
      process.exit(2);
    }
    const decoderFields = extractDecoderFields(indexerSrc, ev.name);
    if (decoderFields === null) {
      // No decoder for this event — raw classification path. OK.
      continue;
    }
    if (
      structFields.length !== decoderFields.length ||
      structFields.some((f, i) => f !== decoderFields[i])
    ) {
      const diff = buildFieldDiff(structFields, decoderFields);
      fieldMismatches.push({ event: ev, structFields, decoderFields, diff });
    }
  }

  if (fieldMismatches.length > 0) {
    console.error(
      `\n[event-coverage] FAIL: ${fieldMismatches.length} event decoder(s) drift from on-chain struct:\n`,
    );
    for (const fm of fieldMismatches) {
      console.error(
        `  ${fm.event.name} (${fm.event.programCrate}, ${fm.event.sourceFile}):\n` +
          `    on-chain struct fields: [${fm.structFields.join(", ")}]\n` +
          `    indexer decoder fields: [${fm.decoderFields.join(", ")}]\n` +
          `    diff: ${fm.diff}\n` +
          `    fix: align EVENT_DECODERS.${fm.event.name} in src/indexer/index.ts\n` +
          `         with the struct in ${fm.event.sourceFile}. Borsh is positional —\n` +
          `         field order MUST match.\n`,
      );
    }
    process.exit(1);
  }

  console.log(
    `[event-coverage] OK: indexer covers all ${programEvents.length} on-chain #[event] declaration(s) ` +
      `across ${eventFiles.length} program crate(s); field-coverage verified for events with decoders.`
  );
  process.exit(0);
}

/**
 * Compose a short human-readable diff between two ordered field lists.
 * Reports the first divergence (position + values) plus any tail
 * additions/removals — the operator's eye is faster than a full LCS.
 */
function buildFieldDiff(struct: string[], decoder: string[]): string {
  const n = Math.max(struct.length, decoder.length);
  for (let i = 0; i < n; i++) {
    const s = struct[i];
    const d = decoder[i];
    if (s !== d) {
      if (s === undefined) return `decoder has extra field at position ${i}: '${d}' (struct ends here)`;
      if (d === undefined) return `decoder is missing field at position ${i}: '${s}' (struct continues)`;
      return `mismatch at position ${i}: struct='${s}' vs decoder='${d}'`;
    }
  }
  return "(no diff — should be unreachable)";
}

// Only run when invoked directly — keeps the helpers importable from
// tests without firing process.exit.
if (require.main === module) {
  main();
}
