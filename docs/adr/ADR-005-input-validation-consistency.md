# ADR-005: Validate All MCP Handler Inputs Consistently

## Status
Accepted

## Date
2026-04-15

## Context
The MCP server had inconsistent input validation across its 20 tool handlers:

- `handleCreateVault` used proper helpers (`requireString`, `requirePositiveNumber`)
- `handleRegisterAgent` used raw casts (`args.name as string`) with no validation
- `handleUpdateVaultPolicy` used raw casts (`args.dailyLimitSol as number`)
- Several handlers cast directly without null/type checks

This inconsistency meant some tools would throw cryptic JavaScript errors (e.g., `Cannot read property 'toBase58' of undefined`) instead of clear validation messages, making debugging difficult for AI agents.

## Decision
Apply validation helpers consistently across all 20 handlers:

1. **All required string parameters** use `requireString(args, key)`
2. **All required numeric parameters** use `requireNumber(args, key)` or `requirePositiveNumber(args, key)`
3. **All required array parameters** use new `requireStringArray(args, key)`
4. **All optional parameters** use `optionalString(args, key)`
5. **All public key parameters** are validated through `parsePublicKey(requireString(...))`

A new `requireStringArray` helper was added for array parameters like `capabilities` and `acceptedTokens`.

## Alternatives Considered

### Alternative: Use a schema validation library (Zod, Joi)
Considered but rejected for v1 to avoid adding dependencies. The existing helper pattern is sufficient and keeps the codebase simple. Can be revisited if schema complexity grows.

### Alternative: Validate at the MCP SDK level
The MCP SDK validates against `inputSchema` JSON Schema, but TypeScript type narrowing from JSON Schema is limited. Explicit runtime validation provides both type safety and clear error messages.

## Consequences

### Positive
- All handlers now produce clear, consistent error messages for invalid input
- Type narrowing is explicit, preventing silent `undefined` propagation
- AI agents receive actionable error messages (e.g., "Missing required parameter: name")

### Negative
- Slight verbosity increase in handler code
- Validation is duplicated between JSON Schema (tool definitions) and runtime checks

## Files Changed
- `mcp-server/src/index.ts` - All handlers updated, `requireStringArray` added
