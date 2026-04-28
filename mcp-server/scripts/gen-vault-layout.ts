/**
 * MCP-313 (ADR-119, scope-expanded by Batch D) — IDL-derived vault-layout
 * code generator.
 *
 * Reads `sdk/idl/src/idl/agent_vault.json`, walks the `Vault` account type
 * down to the first variable-width field, and emits
 * `mcp-server/src/pipeline/vault-layout.generated.ts` containing the
 * field-offset constants the runtime cap gates consume.
 *
 * Wired into `npm run build` via a `prebuild` script. CI verifies
 * `git diff --exit-code mcp-server/src/pipeline/vault-layout.generated.ts`
 * after running the codegen, so a Rust struct reorder on the on-chain
 * `agent_vault` program surfaces as a CI failure rather than a
 * runtime garbage decode.
 *
 * Approach
 * ========
 * The Anchor IDL is statically loaded as JSON; we walk the field list,
 * computing offsets via Anchor's primitive-size table. The walk stops at
 * the first variable-width field (vec / option / string), because beyond
 * that the offset is data-dependent. Constants emitted:
 *
 *   - VAULT_DISCRIMINATOR_SIZE = 8
 *   - SPENT_TODAY_OFFSET, LAST_SPEND_DAY_OFFSET,
 *     POLICY_PER_TX_LIMIT_OFFSET, DAILY_LIMIT_OFFSET, POLICY_FIXED_END_OFFSET
 *   - TOKEN_SPEND_RECORD_SIZE (computed from the `TokenSpendRecord` type)
 *
 * Run: `npm run gen:vault-layout` (or automatically via `prebuild`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Anchor IDL primitive size table
// ---------------------------------------------------------------------------

type AnchorPrimitive =
  | "bool"
  | "u8"
  | "i8"
  | "u16"
  | "i16"
  | "u32"
  | "i32"
  | "u64"
  | "i64"
  | "u128"
  | "i128"
  | "f32"
  | "f64"
  | "pubkey"
  | "publicKey";

const PRIMITIVE_SIZES: Record<AnchorPrimitive, number> = {
  bool: 1,
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  u128: 16,
  i128: 16,
  f32: 4,
  f64: 8,
  pubkey: 32,
  publicKey: 32,
};

interface IdlField {
  name: string;
  type: unknown;
}

interface IdlStructType {
  kind: "struct";
  fields: IdlField[];
}

interface IdlType {
  name: string;
  type: IdlStructType | { kind: string };
}

interface IdlAccount {
  name: string;
  type?: IdlStructType;
  discriminator?: number[];
}

interface Idl {
  accounts?: IdlAccount[];
  types?: IdlType[];
}

// ---------------------------------------------------------------------------
// Layout walk — fixed-width prefix only.
// ---------------------------------------------------------------------------

class VariableWidthEncountered extends Error {
  constructor(public readonly fieldPath: string) {
    super(`variable-width field encountered at ${fieldPath}`);
  }
}

function fieldSize(idl: Idl, fieldType: unknown, fieldPath: string): number {
  if (typeof fieldType === "string") {
    const prim = fieldType as AnchorPrimitive;
    if (prim in PRIMITIVE_SIZES) return PRIMITIVE_SIZES[prim];
    throw new Error(`unsupported primitive at ${fieldPath}: ${prim}`);
  }
  if (fieldType && typeof fieldType === "object") {
    const obj = fieldType as Record<string, unknown>;
    if ("vec" in obj || "option" in obj || obj === undefined) {
      throw new VariableWidthEncountered(fieldPath);
    }
    if (typeof obj.string === "string" || obj.string !== undefined) {
      throw new VariableWidthEncountered(fieldPath);
    }
    if ("array" in obj && Array.isArray(obj.array)) {
      const [elemType, len] = obj.array as [unknown, number];
      const elemSize = fieldSize(idl, elemType, `${fieldPath}[*]`);
      return elemSize * len;
    }
    if ("defined" in obj) {
      const def = obj.defined as { name?: string } | string;
      const refName = typeof def === "string" ? def : def.name;
      if (!refName) throw new Error(`malformed defined ref at ${fieldPath}`);
      const referenced = (idl.types ?? []).find((t) => t.name === refName);
      if (!referenced) throw new Error(`unknown defined type: ${refName}`);
      if (referenced.type.kind !== "struct") {
        throw new Error(`non-struct defined type unsupported: ${refName}`);
      }
      let total = 0;
      for (const f of (referenced.type as IdlStructType).fields) {
        total += fieldSize(idl, f.type, `${fieldPath}.${f.name}`);
      }
      return total;
    }
  }
  throw new Error(`unsupported field type at ${fieldPath}: ${JSON.stringify(fieldType)}`);
}

interface FieldOffset {
  name: string;
  offset: number;
  size: number;
}

interface FixedPrefix {
  /** Fields encountered in struct order, including those inside nested defined structs. */
  fields: FieldOffset[];
  /** Total bytes from the start of the account (after discriminator) to the
   *  first variable-width field. */
  prefixEndOffset: number;
}

const DISCRIMINATOR_SIZE = 8;

/**
 * Walk a field. When the field is a defined-struct reference, recurse INTO
 * the struct's fixed prefix (emitting nested field names like
 * `policy.per_tx_limit_lamports`) and STOP at the first variable-width
 * sub-field. Returns the end cursor + whether we stopped early due to a
 * variable-width field.
 */
function walkField(
  idl: Idl,
  pathPrefix: string,
  fieldName: string,
  fieldType: unknown,
  cursor: number,
  out: FieldOffset[],
): { cursor: number; stopped: boolean } {
  // String / vec / option / undefined → stop here.
  if (fieldType && typeof fieldType === "object") {
    const obj = fieldType as Record<string, unknown>;
    if ("vec" in obj || "option" in obj || "string" in obj) {
      return { cursor, stopped: true };
    }
    if ("array" in obj && Array.isArray(obj.array)) {
      // Fixed-size array — treat as a single primitive-size field.
      const [elemType, len] = obj.array as [unknown, number];
      const elemSize = fieldSize(idl, elemType, `${pathPrefix}${fieldName}[*]`);
      const totalSize = elemSize * len;
      out.push({ name: `${pathPrefix}${fieldName}`, offset: cursor, size: totalSize });
      return { cursor: cursor + totalSize, stopped: false };
    }
    if ("defined" in obj) {
      const def = obj.defined as { name?: string } | string;
      const refName = typeof def === "string" ? def : def.name;
      if (!refName) {
        throw new Error(`malformed defined ref at ${pathPrefix}${fieldName}`);
      }
      const referenced = (idl.types ?? []).find((t) => t.name === refName);
      if (!referenced) throw new Error(`unknown defined type: ${refName}`);
      if (referenced.type.kind !== "struct") {
        // Enums / aliases — stop walking; they're not byte-stable for our
        // offset purposes here.
        return { cursor, stopped: true };
      }
      const startCursor = cursor;
      let inner = cursor;
      let stopped = false;
      // Emit the parent name as a sentinel pointing at the start of the
      // nested struct.
      out.push({ name: `${pathPrefix}${fieldName}`, offset: startCursor, size: 0 });
      const nextPathPrefix = `${pathPrefix}${fieldName}.`;
      for (const sf of (referenced.type as IdlStructType).fields) {
        const r = walkField(idl, nextPathPrefix, sf.name, sf.type, inner, out);
        inner = r.cursor;
        if (r.stopped) {
          stopped = true;
          break;
        }
      }
      // Patch the parent sentinel size to reflect the walked fixed prefix.
      const parent = out.find((f) => f.name === `${pathPrefix}${fieldName}` && f.size === 0);
      if (parent) parent.size = inner - startCursor;
      return { cursor: inner, stopped };
    }
  }
  // Primitive
  const size = fieldSize(idl, fieldType, `${pathPrefix}${fieldName}`);
  out.push({ name: `${pathPrefix}${fieldName}`, offset: cursor, size });
  return { cursor: cursor + size, stopped: false };
}

function walkFixedPrefix(idl: Idl, accountName: string): FixedPrefix {
  const account = (idl.accounts ?? []).find((a) => a.name === accountName);
  if (!account) throw new Error(`account not found in IDL: ${accountName}`);
  let struct: IdlStructType | undefined;
  if (account.type && account.type.kind === "struct") {
    struct = account.type as IdlStructType;
  } else {
    const t = (idl.types ?? []).find((tt) => tt.name === accountName);
    if (t && t.type.kind === "struct") struct = t.type as IdlStructType;
  }
  if (!struct) throw new Error(`account ${accountName} has no struct type`);

  const fields: FieldOffset[] = [];
  let cursor = DISCRIMINATOR_SIZE;
  for (const f of struct.fields) {
    const r = walkField(idl, "", f.name, f.type, cursor, fields);
    cursor = r.cursor;
    if (r.stopped) break;
  }
  return { fields, prefixEndOffset: cursor };
}

// ---------------------------------------------------------------------------
// Codegen
// ---------------------------------------------------------------------------

function findOffset(fields: FieldOffset[], qualifiedName: string): number {
  const f = fields.find((x) => x.name === qualifiedName);
  if (!f) {
    throw new Error(
      `field "${qualifiedName}" not found in IDL prefix; available: ` +
        fields.map((x) => x.name).join(", "),
    );
  }
  return f.offset;
}

function tokenSpendRecordSize(idl: Idl): number {
  const t = (idl.types ?? []).find((tt) => tt.name === "TokenSpendRecord");
  if (!t || t.type.kind !== "struct") {
    throw new Error("TokenSpendRecord struct not found in IDL");
  }
  let total = 0;
  for (const f of (t.type as IdlStructType).fields) {
    total += fieldSize(idl, f.type, `TokenSpendRecord.${f.name}`);
  }
  return total;
}

function generate(idl: Idl): string {
  const prefix = walkFixedPrefix(idl, "Vault");
  const SPENT_TODAY_OFFSET = findOffset(prefix.fields, "spent_today_lamports");
  const LAST_SPEND_DAY_OFFSET = findOffset(prefix.fields, "last_spend_day");
  const POLICY_PER_TX_LIMIT_OFFSET = findOffset(
    prefix.fields,
    "policy.per_tx_limit_lamports",
  );
  const DAILY_LIMIT_OFFSET = findOffset(prefix.fields, "policy.daily_limit_lamports");
  // POLICY_FIXED_END_OFFSET is the byte after `max_txs_per_hour` in the
  // VaultPolicy struct.
  const policyMaxTxsField = prefix.fields.find((f) => f.name === "policy.max_txs_per_hour");
  if (!policyMaxTxsField) {
    throw new Error("policy.max_txs_per_hour not found in IDL prefix");
  }
  const POLICY_FIXED_END_OFFSET = policyMaxTxsField.offset + policyMaxTxsField.size;
  const TOKEN_SPEND_RECORD_SIZE = tokenSpendRecordSize(idl);

  return `// AUTO-GENERATED — DO NOT EDIT.
//
// Generated by \`mcp-server/scripts/gen-vault-layout.ts\` from
// \`sdk/idl/src/idl/agent_vault.json\`. Run \`npm run gen:vault-layout\`
// (or \`npm run build\` which calls it via prebuild) after any change to
// the on-chain Vault struct.
//
// CI verifies \`git diff --exit-code\` for this file post-codegen so a
// Rust struct reorder surfaces as a CI failure rather than a runtime
// garbage decode (MCP-313).

export const VAULT_DISCRIMINATOR_SIZE = ${DISCRIMINATOR_SIZE};
export const SPENT_TODAY_OFFSET = ${SPENT_TODAY_OFFSET};
export const LAST_SPEND_DAY_OFFSET = ${LAST_SPEND_DAY_OFFSET};
export const POLICY_PER_TX_LIMIT_OFFSET = ${POLICY_PER_TX_LIMIT_OFFSET};
export const DAILY_LIMIT_OFFSET = ${DAILY_LIMIT_OFFSET};
export const POLICY_FIXED_END_OFFSET = ${POLICY_FIXED_END_OFFSET};
export const TOKEN_SPEND_RECORD_SIZE = ${TOKEN_SPEND_RECORD_SIZE};

/**
 * Field offsets walked from the IDL at codegen time. The runtime drift
 * assertion (\`vault-layout.ts\`) re-walks the IDL and asserts these
 * constants still match — protects against the codegen artifact drifting
 * from the on-chain struct (MCP-311).
 */
export const VAULT_PREFIX_FIELDS: ReadonlyArray<{
  readonly name: string;
  readonly offset: number;
  readonly size: number;
}> = ${JSON.stringify(prefix.fields, null, 2)} as const;
`;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function main(): void {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const idlPath = path.join(repoRoot, "sdk/idl/src/idl/agent_vault.json");
  const outPath = path.join(
    repoRoot,
    "mcp-server/src/pipeline/vault-layout.generated.ts",
  );

  if (!fs.existsSync(idlPath)) {
    console.error(`gen-vault-layout: IDL not found at ${idlPath}`);
    process.exit(1);
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
  const generated = generate(idl);
  const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";

  if (existing === generated) {
    console.log(`gen-vault-layout: ${outPath} is up to date`);
    return;
  }
  fs.writeFileSync(outPath, generated);
  console.log(`gen-vault-layout: wrote ${outPath}`);
}

main();
