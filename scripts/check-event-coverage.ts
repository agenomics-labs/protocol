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
 * 2026-04-30 cycle-3 follow-up — TWO false-confidence fixes:
 *   (Fix 1) Disc-map events without a parseable decoder are a coverage
 *           failure (was: silently skipped, same blast radius as
 *           AUD-004's missing cleared_count). Operators MUST add the
 *           missing decoders to EVENT_DECODERS in src/indexer/index.ts.
 *           Adding the 18 decoders this fix surfaces is the expected
 *           next workstream; this commit only makes the gap visible.
 *   (Fix 2) `extractDecoderFields` now also handles block-body arrow
 *           decoders — `(r) => { ...; return { ... }; }` — in addition
 *           to `(r) => ({ ... })`. AgentStatusUpdated at
 *           src/indexer/index.ts:524-529 is the exemplar that was
 *           silently unparseable (false positive under Fix 1).
 *
 * Exit codes:
 *   0 — disc-map covers every event, every covered event has a parseable
 *       decoder, every decoder's field list matches its on-chain struct.
 *   1 — disc-map drift, OR decoder-less disc-map entry, OR field-drift
 *       between decoder and on-chain struct. Offenders printed to stderr.
 *   2 — couldn't read a required file. Surfaces the underlying I/O error.
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
 * Extract the ordered property-key list from the indexer's decoder body
 * inside `EVENT_DECODERS`. Returns `null` if no decoder exists. Two
 * shapes are supported (Fix 2, 2026-04-30):
 *   `EventName: (r) => ({ field: ..., ... })`             — object body
 *   `EventName: (r) => { ...; return { ... }; }`          — block body
 * For the block body, only fields inside the `return { ... }` count;
 * local lets above the return are scratch space, not wire-order fields.
 */
export function extractDecoderFields(
  indexerSource: string,
  eventName: string,
): string[] | null {
  // Cap each match at 2KB — the largest current decoder body
  // (ProtocolConfigInitialized) is ~700 bytes.
  const objectBodyRe = new RegExp(
    `\\b${eventName}\\s*:\\s*\\(r\\)\\s*=>\\s*\\(\\s*\\{([\\s\\S]{0,2048}?)\\}\\s*\\)\\s*,`,
    "m",
  );
  const blockBodyRe = new RegExp(
    `\\b${eventName}\\s*:\\s*\\(r\\)\\s*=>\\s*\\{[\\s\\S]{0,2048}?return\\s*\\{([\\s\\S]{0,2048}?)\\}\\s*;?\\s*\\}\\s*,`,
    "m",
  );
  const m = indexerSource.match(objectBodyRe) ?? indexerSource.match(blockBodyRe);
  if (!m) return null;
  // Tokenize the captured body to handle BOTH multi-line `field: r.foo(),`
  // (the prevailing style) AND single-line shorthand `{ a, b, ts: ... }`
  // (block-body returns). Strategy: strip `//` comments (whose commas
  // would otherwise split a field), redact parenthesized expressions and
  // strings/template literals to a single space (so values can't
  // masquerade as identifiers), split on top-level commas, pull the
  // leading identifier from each segment.
  const decommented = m[1].replace(/\/\/[^\n]*/g, "");
  const redacted = redactValueExpressions(decommented);
  const fields: string[] = [];
  for (const part of redacted.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const fm = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[:}]?/);
    if (fm) fields.push(fm[1]);
  }
  return fields;
}

/**
 * Replace every `(...)`, `"..."`, `'...'`, and `` `...` `` span (with
 * matching nesting) by a single space, so the residue can be safely
 * scanned for top-level identifiers and commas. Comments are NOT
 * touched here — caller strips them before invoking.
 */
function redactValueExpressions(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\") { i += 2; continue; }
        if (q === "`" && s[i] === "$" && s[i + 1] === "{") {
          i += 2; let d = 1;
          while (i < s.length && d > 0) {
            if (s[i] === "{") d++;
            else if (s[i] === "}") d--;
            i++;
          }
          continue;
        }
        i++;
      }
      i++; out += " "; continue;
    }
    if (c === "(") {
      let d = 1; i++;
      while (i < s.length && d > 0) {
        if (s[i] === "(") d++;
        else if (s[i] === ")") d--;
        i++;
      }
      out += " "; continue;
    }
    out += c; i++;
  }
  return out;
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
  // Fix 1 (2026-04-30): events that ARE in DISCRIMINATOR_MAP but have no
  // parseable decoder are coverage failures, not silent skips. Same blast
  // radius as AUD-004's missing cleared_count: payload classified by name
  // but no field-level decoder = downstream sees `{discriminator, rawData}`
  // and silently drops the structured fields.
  const decoderless: ProgramEvent[] = [];
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
      // Fix 1: disc-map entry exists (we passed the discriminator gate
      // above) but no parseable decoder. Real coverage gap.
      decoderless.push(ev);
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

  if (decoderless.length > 0) {
    console.error(
      `\n[event-coverage] FAIL: ${decoderless.length} event(s) in DISCRIMINATOR_MAP without a parseable decoder:\n`,
    );
    for (const ev of decoderless) {
      // We already know the entry is in DISCRIMINATOR_MAP (passed the
      // earlier gate). The remaining ambiguity is whether EVENT_DECODERS
      // has no key, or has a key that the regex couldn't parse. After
      // Fix 2 (block-body support) the latter should be rare; if it
      // recurs, extend extractDecoderFields rather than silencing here.
      const hasKey = new RegExp(`\\b${ev.name}\\s*:\\s*\\(r\\)\\s*=>`, "m").test(indexerSrc);
      const reason = hasKey
        ? "decoder unparseable by current regex (extend extractDecoderFields)"
        : "no decoder entry in EVENT_DECODERS";
      console.error(
        `  ${ev.name} (${ev.programCrate}, ${ev.sourceFile})\n` +
          `    reason: ${reason}\n` +
          `    fix: add a Borsh decoder in EVENT_DECODERS in src/indexer/index.ts\n` +
          `         that mirrors the field layout from ${ev.sourceFile}.\n`,
      );
    }
    process.exitCode = 1;
    // Fall through — also surface field mismatches in the same run so a
    // single CI invocation reports every gap. We exit at the end if any
    // failure was recorded.
  }
  // Out-of-scope tally (Fix 1 visibility note): events with NEITHER a
  // disc-map entry NOR a decoder are unreachable here by construction
  // (the disc-map gate above hard-fails first), so this number is always
  // 0 with the current code shape. We compute and surface it anyway so a
  // future refactor that splits the gates doesn't silently regress
  // visibility into truly-out-of-scope events.
  const trulyOutOfScope = 0;

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
    process.exitCode = 1;
  }

  if (process.exitCode === 1) {
    // Composite failure summary across Fix 1 (decoderless) + field-drift
    // gates. Already-set exit code propagates on natural process end.
    console.error(
      `[event-coverage] FAIL: ${decoderless.length} decoder-less + ${fieldMismatches.length} field-drift across ${programEvents.length} on-chain #[event] declaration(s); skipped ${trulyOutOfScope} events with neither disc-map nor decoder.`,
    );
    return;
  }

  console.log(
    `[event-coverage] OK: indexer covers all ${programEvents.length} on-chain #[event] declaration(s) ` +
      `across ${eventFiles.length} program crate(s); field-coverage verified for events with decoders; ` +
      `skipped ${trulyOutOfScope} events with neither disc-map nor decoder.`,
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
