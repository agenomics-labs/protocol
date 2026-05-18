// ADR-135 — schema-equivalence regression gate.
//
// This test FREEZES the JSON Schema (and description) every MCP tool
// advertises via `tools/list`. ADR-135 made the Zod schema in
// `actions/*.ts` the single source of truth and rewired `tools/*.ts`
// to DERIVE the advertised `inputSchema` from it via
// `renderInputSchema` (zod-to-json-schema). MCP clients (Claude
// Desktop, Cursor, custom agent runtimes) introspect this schema to
// build their tool-call UI, so any unintended change to the rendered
// shape is a wire-contract regression.
//
// The frozen fixture (`__schema_snapshot__.json`) was generated at
// ADR-135 landing time and audited field-by-field against the
// pre-ADR-135 hand-written descriptors: EVERY field description from
// the pre-ADR-135 contract is preserved, and the ONLY structural
// deltas vs. the pre-ADR-135 schema are the two ADR-sanctioned drift
// corrections documented in the PR:
//   - `create_escrow` drops the stale required `providerVaultAddress`
//     (handlers/settlement.ts "Finding #21" — already ignored at
//     runtime; the router never accepted it).
//   - `pay_x402_service` surfaces the OPTIONAL `nonce` idempotency
//     field the router already enforced but the hand-written
//     descriptor under-advertised.
// Both make the advertised schema match the already-enforced runtime
// contract (ADR-135 §Decision / §Consequences).
//
// If this test fails, a Zod schema change altered the wire contract.
// That is allowed ONLY as a deliberate, reviewed contract change:
// regenerate the fixture with
//   node --import tsx -e 'import {allTools} from
//   "./src/tools/index.js"; const m={}; for (const t of
//   [...allTools].sort((a,b)=>a.name.localeCompare(b.name)))
//   m[t.name]={description:t.description,inputSchema:t.inputSchema};
//   process.stdout.write(JSON.stringify(m,null,2)+"\n")'
//   > test/tools/__schema_snapshot__.json
// and call out the wire-contract change in the PR description.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allTools } from "../../src/tools/index.js";

const snapshotPath = fileURLToPath(
  new URL("./__schema_snapshot__.json", import.meta.url),
);
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<
  string,
  { description: string; inputSchema: unknown }
>;

function currentByName() {
  const m: Record<string, { description: string; inputSchema: unknown }> = {};
  for (const t of allTools) {
    m[t.name] = { description: t.description, inputSchema: t.inputSchema };
  }
  return m;
}

describe("ADR-135 — derived MCP tool schema equivalence", () => {
  const current = currentByName();

  it("advertises exactly the snapshotted tool set (no add/remove drift)", () => {
    const snapNames = Object.keys(snapshot).sort();
    const curNames = Object.keys(current).sort();
    assert.deepEqual(curNames, snapNames);
    assert.equal(curNames.length, 29);
  });

  // Per-tool deep equality: the derived JSON Schema + description for
  // every tool must match the frozen, pre-ADR-135-audited contract
  // byte-for-byte.
  for (const name of Object.keys(snapshot)) {
    it(`${name}: rendered inputSchema + description matches frozen contract`, () => {
      assert.ok(current[name], `tool '${name}' missing from allTools`);
      assert.deepEqual(
        current[name].inputSchema,
        snapshot[name].inputSchema,
        `inputSchema for '${name}' diverged from the ADR-135 frozen wire contract`,
      );
      assert.equal(
        current[name].description,
        snapshot[name].description,
        `description for '${name}' diverged from the ADR-135 frozen wire contract`,
      );
    });
  }

  it("every rendered schema is a normalized object schema (no zod-to-json-schema envelope)", () => {
    for (const t of allTools) {
      const s = t.inputSchema as Record<string, unknown>;
      assert.equal(s.type, "object", `${t.name}.inputSchema.type`);
      // The pre-ADR-135 wire shape never carried these zod-to-json-schema
      // envelope keys; renderInputSchema strips them so the contract is
      // byte-stable for clients that introspect tools/list.
      assert.ok(
        !("$schema" in s),
        `${t.name}.inputSchema must not carry a $schema envelope`,
      );
      assert.ok(
        !("additionalProperties" in s),
        `${t.name}.inputSchema must not carry a top-level additionalProperties`,
      );
    }
  });
});
