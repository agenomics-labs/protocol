// ADR-135 — single-source Zod → MCP `inputSchema` renderer.
//
// Before ADR-135 each MCP tool's input contract lived in THREE
// independently-maintained places (see ADR-135 §Context):
//   1. a hand-written JSON Schema literal in `tools/*.ts`,
//   2. a Zod schema in `actions/*.ts` (the runtime-enforced contract,
//      validated by `adapters/mcp.ts#createActionRouter`),
//   3. the inferred handler parameter type.
//
// ADR-135 makes the Zod schema in `actions/*.ts` the SINGLE SOURCE OF
// TRUTH. This module renders that Zod shape into the JSON Schema MCP
// advertises via `tools/list`. The router adapter (`adapters/mcp.ts`)
// already renders the SAME shape for runtime validation, so the
// advertised contract and the enforced contract can no longer drift —
// they are now two call sites of one renderer over one schema.
//
// Output shape: the historically-shipped MCP `inputSchema` was a bare
// `{ type, properties, required }` object (Draft-07 implied, no
// `$schema` envelope, no top-level `additionalProperties`). We strip
// `zod-to-json-schema`'s `$schema` key and the synthetic top-level
// `additionalProperties: false` so the rendered schema stays byte-stable
// against the pre-ADR-135 wire contract for every MCP client that
// introspects `tools/list`. Field-level constraints already enforced by
// the router (min/max/enum/minLength/…) DO surface in the rendered
// schema — that is the ADR-135 goal (advertise the contract truthfully),
// and is covered by the frozen snapshot in
// `test/tools/schema-snapshot.test.ts`.

import { z, type ZodRawShape } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Render a Zod object shape to the MCP `inputSchema` JSON Schema,
 * normalized to the pre-ADR-135 wire shape (no `$schema`, no synthetic
 * top-level `additionalProperties`). This is THE projection function;
 * `tools/*.ts` and `adapters/mcp.ts` must both route through it.
 */
export function renderInputSchema(shape: ZodRawShape): Tool["inputSchema"] {
  // Cast to `any` to avoid TS2589 ("type instantiation is excessively
  // deep") which `ZodObject<ZodRawShape>` triggers under strict TS — the
  // same workaround `adapters/mcp.ts#toJsonSchema` carried pre-ADR-135.
  const obj = z.object(shape) as unknown as z.ZodType<unknown>;
  const rendered = zodToJsonSchema(obj as any, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;

  // Strip the zod-to-json-schema envelope/synthetic keys so the wire
  // shape matches what MCP clients have introspected since day one.
  delete rendered.$schema;
  delete rendered.additionalProperties;

  return rendered as unknown as Tool["inputSchema"];
}

/**
 * Build a complete MCP `Tool` descriptor from an Action-shaped source.
 * `name`/`description` come from the Action (its own single source);
 * `inputSchema` is derived from the Action's Zod `inputSchema` shape.
 * This guarantees the `tools/list` descriptor and the router's runtime
 * validator are projections of the one schema (ADR-135 §Decision).
 */
export function toolFromAction(action: {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
}): Tool {
  return {
    name: action.name,
    description: action.description,
    inputSchema: renderInputSchema(action.inputSchema),
  };
}
