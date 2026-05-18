# ADR-135: Single-source Zod schemas mirrored to MCP tool definitions

## Status

Accepted

## Date

2026-05-18

## Implementation Note (2026-05-18)

Landed as a bounded internal refactor. The pre-existing
`actions/*.ts` Zod schemas (already the runtime-enforced contract via
`adapters/mcp.ts#createActionRouter`) were made the **single source of
truth**; the hand-written JSON Schema literals in `tools/*.ts` were
deleted and each `Tool.inputSchema` is now derived from the Zod schema
via one shared renderer, `src/tools/render-schema.ts#renderInputSchema`
(`zodToJsonSchema(..., { target: "jsonSchema7", $refStrategy: "none" })`,
normalized to strip the `$schema` envelope and synthetic top-level
`additionalProperties` so the wire shape stays byte-stable). The router
adapter (`adapters/mcp.ts`) now calls the SAME renderer, so the
advertised and enforced contracts are provably one projection.

Per-field MCP-client descriptions were ported into the Zod schemas via
`.describe()`; a frozen snapshot gate
(`test/tools/schema-snapshot.test.ts` +
`test/tools/__schema_snapshot__.json`) asserts the rendered schema +
description for all 29 tools is byte-stable. Every pre-ADR-135 field
description is preserved. Two intentional, ADR-sanctioned drift
corrections (the "advertise loose / enforce different" antipattern this
ADR targets — §Consequences) shipped: `create_escrow` drops the stale
required `providerVaultAddress` (handlers/settlement.ts "Finding #21"
already ignored it at runtime), and `pay_x402_service` now advertises
the OPTIONAL `nonce` idempotency field the router already enforced. The
handler/`requireString` deletion and the CI drift-gate script noted in
§"What ships" remain follow-ups (the snapshot gate covers the
behavior-equivalence guarantee in the interim). Scope: 25 tools in the
original ADR; the live surface is 29 post-cycle-4.

## Context

The MCP server exposes 25 tools (`mcp-server/src/tools.ts`, ~591 LOC).
Each tool today has **three places** where its input contract lives:

1. **MCP tool schema** — JSON Schema fragments inline in `tools.ts`
   (`inputSchema: { type: "object", properties: { ... }, required: [...] }`).
   This is what MCP clients (Claude Desktop, Cursor, custom agent
   runtimes) introspect.
2. **Handler validation** — `requireString`, `requireNumber`,
   `requirePositiveNumber`, `optionalString` helpers (per ADR-005)
   inside each handler in `mcp-server/src/index.ts` (~1,104 LOC). This
   is what actually rejects malformed input at runtime.
3. **TypeScript handler signatures** — hand-written parameter types on
   each handler function. This is what consumers of the handler
   modules see.

These three are **independently maintained** and can drift. ADR-119
(SDK boundary validation) addressed part of the boundary discipline,
but the three-source split persists. A 2026-04-30 spot-check shows
small inconsistencies (e.g. one handler accepting `nonce?: number`
while the JSON Schema declares it required; another handler validating
`amount > 0` in code while the schema declares only `type: number`).
Symptom-class: a tool advertises a contract its handler does not
enforce, or vice versa.

The 2026-04-30 DX audit (this branch's prior turn) named two adjacent
shifts that motivate fixing this now:

- **AI-tool ingestibility.** MCP clients consume `inputSchema` to
  build their tool-call UI; if the schema is loose, the AI agent's
  call is malformed and gets rejected at the handler. Tightening the
  schema to match the handler is the single highest-leverage DX
  improvement on the MCP surface.
- **Codegen from spec, not hand-rolled.** ADR-141 lands codegen on
  the on-chain side. The off-chain side needs the same discipline:
  one schema definition per tool, mechanically projected to JSON
  Schema for MCP and to TypeScript types for handlers.

Zod has emerged as the de-facto TypeScript schema library; it is
already a transitive dep of several mcp-server modules and is the
runtime validator behind every popular tRPC, Hono, AI SDK, and
LangChain build. `zod-to-json-schema` produces JSON Schema Draft
2020-12 output suitable for MCP `inputSchema`.

## Decision

**Define every MCP tool's input contract as a single Zod schema. The
JSON Schema MCP advertises and the runtime validation MCP enforces
both derive from that schema; handler signatures are the inferred
`z.infer<typeof Schema>` type. The legacy ADR-005 `requireString`
helpers stay only as the `z.parse` failure-message renderers.**

### What ships

- New module `mcp-server/src/tools/schemas/` with one file per tool
  family: `vault.ts`, `registry.ts`, `reputation.ts`, `settlement.ts`.
  Each exports a Zod object schema per tool (e.g. `CreateVaultInput`,
  `RegisterAgentInput`).
- `mcp-server/src/tools.ts` rebuilt as a thin module that:
  - imports each `*Input` schema,
  - calls `zodToJsonSchema(schema, { target: "openApi3" })` to render
    the MCP `inputSchema`,
  - emits the MCP `Tool` descriptor with description + input schema.
- Handlers in `mcp-server/src/handlers/` and
  `mcp-server/src/handlers-v2/` accept `z.infer<typeof XInput>`
  instead of `unknown`/`Record<string, unknown>`. The first line of
  every handler is `const args = XInput.parse(rawArgs)` — the legacy
  `requireString`/`requireNumber` calls go away.
- A drift gate (`scripts/check-mcp-tool-schemas.sh`, wired into
  `.github/workflows/ci.yml`) re-renders JSON Schemas at CI time and
  fails the build if a stale rendering is committed (mirror of the
  ADR-082 IDL coverage gate and ADR-141 Codama diff gate).

### Error mapping

`ZodError` → MCP `ToolCallError` with the `AepError` shape from
ADR-103 (current variant: `data` field, error code, message). The
mapping module — `mcp-server/src/util/zod-error.ts` — converts
`ZodIssue[]` into a single human-readable error message that names the
exact failing field path (`agentIdentity: required`, `dailyLimitSol:
must be > 0`). This is strictly an improvement over the current
hand-written messages, which often drop the path.

### Source-of-truth ordering

When a tool input also corresponds to an on-chain instruction,
field-level types (`PublicKey`, `BN`, `u64`) follow the **Codama
generated builder's input shape** from ADR-141. The Zod schema is the
**outer** validator — it exists to enforce JSON-shaped input from
MCP clients before the handler hands off to the Codama builder. The
mapping is mechanical: `z.string()` for serialized PublicKeys with a
refine into `new PublicKey(...)`, `z.number().positive()` for
SOL/token amounts that the handler scales to lamports, etc.

### Out of scope

- We do **not** auto-generate Zod schemas from Codama IDL (yet). The
  on-chain surface and the MCP surface have different ergonomics
  (e.g. MCP accepts `dailyLimitSol: number`; the on-chain IX takes
  `daily_limit_lamports: u64`). Hand-written Zod schemas with
  Codama-typed handler bodies is the right granularity for v1.
- We do **not** cover output schemas in this ADR. MCP `outputSchema`
  on tool calls is a 2026-Q3 server-side feature; we note it as a
  follow-up.

## Consequences

### Positive

- **One source of truth** for each tool's input contract; the
  MCP-advertised schema and the runtime-enforced check cannot
  silently diverge.
- **Tighter MCP schemas mean better AI client behavior.** Claude,
  Cursor, GPT, etc. produce well-formed tool calls when the
  `inputSchema` declares `required` and `enum` constraints
  truthfully. The current "advertise loose, enforce strict" pattern
  is the worst of both worlds for AI callers.
- **Better error messages.** Zod's path-aware errors beat the
  current `requireString("foo")` thrown messages, especially for
  nested fields.
- **Builder DX.** Handler bodies become `args.foo`-typed end-to-end;
  the current `requireString(rawArgs, "foo")` ceremony goes away.
- **Composable.** Shared Zod fragments (`PublicKeyString`,
  `LamportsAmount`, `TaskId`) live in
  `mcp-server/src/tools/schemas/common.ts` and get reused — the
  current pattern hand-rolls each call's validation.

### Negative

- **Migration churn.** ~25 tools × 3 places = ~75 small edits across
  `tools.ts`, `index.ts`, and handler modules. Mechanical, but the
  PR will be large; we land it in two waves (vault + registry first,
  reputation + settlement second).
- **`zod-to-json-schema` lossy edges.** A small handful of Zod
  features (discriminated unions on non-string keys, `z.intersection`
  with conflicting fields) do not project cleanly to JSON Schema
  Draft 2020-12; we constrain the schema vocabulary to what does
  project cleanly. The drift-gate output diff catches surprises.
- **One more drift gate to maintain.** Acceptable — the ADR-082 +
  ADR-141 + this ADR triplet establishes the pattern that
  source-of-truth artifacts have CI diff gates. Net repo simplicity
  goes up because the failure modes the gates catch were
  previously caught only by reviewers.
- **MCP clients that consume the rendered schema may get stricter
  rejections than before.** Net positive (the calls were always
  going to fail at the handler), but we ship the change with a
  clear release note.

### Follow-ups

- Replace `requireString`/`requireNumber`/`requirePositiveNumber`
  helpers with the unified `XInput.parse()` call site. Delete them
  once unreferenced.
- Wire the rendered JSON Schemas into the documentation site so the
  `/api-reference` page is auto-generated. ADR-137 picks this up.
- ADR-103 Result-shape consolidation: the unified Zod error mapper
  is a forcing function to settle on one Result shape across
  mcp-server, sas-resolver, and action-runtime. Tracked in ADR-103
  follow-ups; not blocked by this ADR.
- 2026-Q3+: explore output schema mirroring once MCP server-side
  output schema lands.

## Alternatives Considered

**Keep `requireString` helpers; add a separate JSON Schema generator
that introspects them.** Rejected. The helpers are too thin to encode
JSON Schema's structural constraints (`enum`, `oneOf`, `pattern`); we
end up reinventing Zod with a worse type story.

**Use TypeBox or Valibot instead of Zod.** Considered. TypeBox
projects to JSON Schema natively (no `zod-to-json-schema` shim); it
would be a defensible pick. Zod wins on ecosystem familiarity (every
Solana / TS / AI dev knows Zod), and `zod-to-json-schema` is mature
enough that the shim cost is negligible.

**Auto-derive Zod from Codama IDL.** Considered for the on-chain
surface only. Rejected for v1 because MCP tool inputs are
deliberately ergonomic (SOL not lamports, ISO-8601 not Unix seconds);
the mapping is human, not mechanical. We can revisit when the
ergonomic vs. on-chain tradeoffs settle.

**JSON Schema as the source of truth, derive TypeScript.** The
ADR-005 status quo. Rejected — the runtime checking is hand-rolled
and TypeScript-from-JSON-Schema (`json-schema-to-typescript`)
produces less ergonomic types than `z.infer`.

## References

- ADR-005 — input validation consistency (the baseline this ADR
  upgrades).
- ADR-082 — indexer event coverage CI gate (the precedent for
  "spec-derived artifact under CI diff-gate").
- ADR-103 — standardized Result shape (this ADR pins one Zod-error
  mapper that uses the canonical Result; closes a follow-up).
- ADR-119 — SDK boundary validation; this ADR continues the
  boundary discipline at the MCP surface.
- ADR-141 — Codama-generated Anchor clients; pairs with this ADR
  to close "spec → typed code" on both sides of the boundary.
- Zod: https://zod.dev/
- `zod-to-json-schema`: https://github.com/StefanTerdell/zod-to-json-schema
- MCP `inputSchema` spec: model-context-protocol.io/specification §"Tools".
