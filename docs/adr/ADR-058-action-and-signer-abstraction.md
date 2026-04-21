# ADR-058: Action shape + CapabilityGatedTool + @solana/keychain-core adoption for mcp-server

## Status
Accepted

## Date
2026-04-21

## Context

`mcp-server/` currently splits each domain across two files: **tool declarations** in `mcp-server/src/tools/{settlement,registry,vault}.ts` (using MCP SDK's raw `Tool` type with JSON Schema inputs) and **handler functions** in `mcp-server/src/handlers/{settlement,registry,vault,validation}.ts`. The two are aggregated in `mcp-server/src/index.ts` — tool list from `tools/index.ts`, handlers imported per-function. Handlers assume a loaded keypair signer, register actions in bulk, and return `Record<string, any>` to MCP clients. There is no capability gating at the boundary — any MCP client that can reach the server effectively inherits the signer's full authority. Input schemas are raw MCP JSON Schema, not Zod — strict typed validation must be added.

Two external ecosystems were scanned before this ADR:

1. **sendaifun** (`solana-agent-kit`, `solana-mcp`, `plugin-god-mode`) defines the universal "Action shape" across its plugin system. However, `solana-mcp` ships a single env-var hot keypair, blanket tool registration, untyped handler returns, and zero capability model. A settlement protocol's MCP endpoint cannot inherit those assumptions.

2. **solana-foundation** ships `@solana/keychain-core` with the `SolanaSigner` trait and **9 production backends** (Vault, Privy, Turnkey, Para, Fireblocks, Dfns, Coinbase CDP, AWS-KMS, GCP-KMS). `solana-mcp-official` defines the canonical MCP tool shape (`SolanaTool { title, description, parameters, outputSchema?, func }`) but is **read-only with zero auth** — it deliberately omits signing.

The gap both ecosystems leave open is **capability-gated, state-mutating MCP with a custody-free default**. That gap is AEAP-specific and must be closed by this ADR.

Companion analysis docs:
- `docs/SENDAIFUN_ECOSYSTEM_ANALYSIS.md`
- `docs/SOLANA_ECOSYSTEM_ANALYSIS.md`

## Decision

### 1. Adopt `@solana/keychain-core` as a peer dependency

Use `SolanaSigner` (verbatim from `@solana/keychain-core`) as AEAP's signer abstraction. Do **not** design a new `BaseWallet` trait from scratch.

```ts
export interface SolanaSigner<TAddress extends string = string>
    extends TransactionPartialSigner<TAddress>, MessagePartialSigner<TAddress> {
    readonly address: Address<TAddress>;
    isAvailable(): Promise<boolean>;
    signMessages(messages: readonly SignableMessage[]): Promise<readonly SignatureDictionary[]>;
    signTransactions(
        transactions: readonly (Transaction & TransactionWithinSizeLimit & TransactionWithLifetime)[]
    ): Promise<readonly SignatureDictionary[]>;
}
```

### 2. Define `Action<I, O>` as a strengthened superset of `SolanaTool`

```ts
// mcp-server/src/types/action.ts
interface Action<I, O> {
    // Conforms to solana-mcp-official SolanaTool shape
    name: string;                            // MCP tool name
    title: string;                           // human-readable
    description: string;
    parameters: ZodRawShape;                 // alias for inputSchema
    outputSchema: z.ZodType<O>;              // STRICTER than SolanaTool — REQUIRED, not optional

    // AEAP additions
    similes: string[];                       // LLM trigger phrases
    examples: Example[];
    readOnly: boolean;
    capabilities: Capability[];              // default-deny gating (see §3)
    preflight?: PreflightGate[];             // per-action opt-in preflight checks
    handler: (ctx: ActionContext, input: I) => Promise<Result<O>>;
}
```

### 2.1 Shared taxonomy types (canonical)

The following types are defined **once here** and referenced by ADR-059 and ADR-060. If a value is added or removed, this section is the single source of truth — downstream ADRs link, not redeclare.

```ts
// Preflight gates — values referenced by Action.preflight (§2); semantics elaborated in ADR-059 §6
type PreflightGate =
    | 'cluster_health'                 // getRecentPerformanceSamples + slot lag < 150
    | 'account_rent_exempt'            // recipient ATA exists + rent-exempt
    | 'daily_cap_not_exhausted'        // SOL-denominated vault daily cap check
    | 'token_daily_cap_not_exhausted'  // per-mint SPL daily cap check (vault.token_spend_records[mint])
    | 'dispute_window_open';           // settlement timing gate

// Signing mode — set per-request on ActionContext; selects between custody-free (default) and signed execution
type SigningMode = 'signed' | 'passthrough';

interface ActionContext {
    mode: SigningMode;
    signer: SolanaSigner | null;             // non-null iff mode === 'signed'
    wallet: { capabilities: Set<Capability> };
    connection: Connection;
    // ...handler-specific fields
}
```

### 3. Capability taxonomy (default-deny)

```ts
type Domain = 'settlement' | 'registry' | 'vault';
type ProgramSet = string;   // e.g., "settlement+vault"

type Capability =
    | `read:${Domain}`                              // read:settlement, read:registry, read:vault
    | `sign:${Domain}`                              // sign:settlement, sign:vault
    | `sign:cross_program:${ProgramSet}`            // multi-program CPI scopes
    | `admin:${Domain}`;                            // dispute resolution, registry moderation
```

MCP boundary enforces `wallet.capabilities ⊇ action.capabilities` at registration time and re-verifies per-call. Default-deny: an Action with an empty `capabilities: []` array that is not `readOnly: true` fails validation at boot.

### 4. Wrap state-mutating Actions in `CapabilityGatedTool<I, O>`

```ts
// mcp-server/src/adapters/capability-gated-tool.ts
function capabilityGated<I, O>(action: Action<I, O>): Action<I, O> {
    return {
        ...action,
        handler: async (ctx, input) => {
            if (!action.readOnly) {
                const missing = action.capabilities.filter(c => !ctx.wallet.capabilities.has(c));
                if (missing.length > 0) {
                    return Result.err({ code: 'CAPABILITY_MISSING', missing });
                }
            }
            if (action.preflight) {
                for (const gate of action.preflight) {
                    const r = await runPreflight(gate, ctx);
                    if (r.isErr()) return r;
                }
            }
            return action.handler(ctx, input);
        },
    };
}
```

### 5. Ship three `SolanaSigner` adapters

- **`KeychainSignerAdapter`** (production): wraps any `@solana/keychain-core` backend (Vault/Privy/Turnkey/etc.) as a `SolanaSigner`. This is the default path for real signers.
- **`KeypairSigner`** (dev only): wraps a local Keypair. Gated behind explicit `--allow-dev-keypair` CLI flag. Fails to boot without the flag.
- **`PassthroughSigner`** (**default for hosted MCP**): **not a `SolanaSigner` implementation** — implementing it would violate `@solana/keychain-core`'s `TransactionPartialSigner` contract (which mandates returning real `SignatureDictionary[]`) and break downstream `framework-kit` helpers that expect a signed artifact. Instead, `PassthroughSigner` is a sentinel represented on `ActionContext` as `mode: 'passthrough'` with `signer: null` (see §2.1). In this mode the Action handler constructs and simulates the transaction, then returns the unsigned-tx MCP response shape (§6); the MCP client signs and submits with its own wallet. Custody-free MCP by default. A handler in `passthrough` mode that dereferences `ctx.signer` is a programmer error — the `CapabilityGatedTool` wrapper (§4) throws `SIGNER_UNAVAILABLE` before calling the handler if the handler declares `requiresSigner: true` while `mode === 'passthrough'`.

### 6. Unsigned-tx MCP response convention

MCP has no native primitive for "return a blob for the client to sign." Define an AEAP convention:

```json
{
  "type": "unsigned_transaction",
  "serialized_tx": "<base64>",
  "required_signers": ["<address>", "..."],
  "simulation": {
    "compute_units": 12345,
    "logs": ["..."],
    "estimated_fee_lamports": 5000
  },
  "expiration": { "last_valid_block_height": 123456789 }
}
```

Calling clients (Claude Code via wallet-adapter, custom runtimes) inspect `type: "unsigned_transaction"` and hand the `serialized_tx` to their wallet for signing. Documented as **required** behavior for any MCP client integrating with AEAP.

### 7. Error shape

```ts
type Result<T, E = AeapError> =
  | { ok: true; data: T }
  | { ok: false; error: E };

interface AeapError {
    code: AeapErrorCode;
    message: string;
    details?: Record<string, unknown>;
}

type AeapErrorCode =
    | 'CAPABILITY_MISSING'
    | 'SIGNER_UNAVAILABLE'
    | 'PREFLIGHT_FAILED'
    | 'INVALID_INPUT'
    | 'RPC_ERROR'
    | 'PROGRAM_ERROR'
    | 'IDEMPOTENCY_VIOLATION'
    | 'UNKNOWN';
```

Discriminated union eliminates `Record<string, any>` returns.

### 8. Tool registration and migration from the current `tools/handlers` split

Consolidate the current two-file-per-domain split into one `Action<I, O>` array per domain:

- `mcp-server/src/tools/{settlement,registry,vault}.ts` (current `Tool` declarations with JSON Schema) + `mcp-server/src/handlers/{settlement,registry,vault}.ts` (current handler functions) → one file per domain under `mcp-server/src/actions/{settlement,registry,vault}.ts`, each exporting an `Action<I, O>[]`
- `mcp-server/src/handlers/validation.ts` stays as a shared validator helper
- `mcp-server/src/handlers/formatters.ts` stays as shared response formatters
- `mcp-server/src/tools/index.ts` is replaced by `mcp-server/src/actions/index.ts` (re-exports + aggregation)
- `mcp-server/src/index.ts` registers via a new `mcp-server/src/adapters/mcp.ts` adapter

Port `zodToMCPShape()` from sendaifun's `packages/adapter-mcp/src/index.ts` into the new adapter. It flattens Zod into MCP's JSON Schema subset. Known precision loss: discriminated unions, refinements, transforms are flattened — document per-action where this bites. Tools register via MCP SDK `server.registerTool()` (with `outputSchema`) — **not** `server.tool()`, because output schema is required in AEAP's shape.

**Migration must be non-breaking from the MCP client perspective**: every existing tool `name` + input contract is preserved. Add a snapshot test asserting `mcp/list_tools` returns the same set before/after.

## Alternatives Considered

### Alternative A: Write a bespoke `BaseWallet` trait
Rejected. `@solana/keychain-core` already ships the exact trait we'd design, with 9 production backends. Writing our own adds ~400 LoC and forks from the Foundation roadmap. The only AEAP-specific signer behaviors (unsigned-tx passthrough, dev keypair) fit cleanly as additional `SolanaSigner` implementations, not a new trait.

### Alternative B: Adopt sendaifun's hot-keypair pattern
Rejected. A settlement/vault MCP endpoint cannot have a drainable signer at the boundary. Sendaifun's model works for read-and-low-stakes-write agent tools; it does not work for an economic protocol.

### Alternative C: Conform exactly to `solana-mcp-official` (no capability layer)
Rejected. `solana-mcp-official` is read-only with zero auth — that design is appropriate for doc search and RPC inspection, not for state mutation. AEAP ships state-mutating operations (vault deposit, settlement release, dispute resolution) and must add the gating layer that `solana-mcp-official` deliberately omits.

### Alternative D: Untyped handler returns (`Record<string, any>`)
Rejected. Breaks typing at LLM consumer boundary + indexer boundary. `outputSchema` required.

### Alternative E: Server-side auto-signing with policy check (like kora)
Rejected for v1. `kora`'s model is sound but requires a production-grade policy engine (covered by a separate ADR on vault policies). For the MCP layer, `PassthroughSigner` + capability gate + client-side signing is simpler and has a smaller blast radius.

## Consequences

### Positive
- **~60% scope collapse** for the signer trait vs. the original plan — dependency adoption replaces bespoke design.
- Drop-in access to 9 production signer backends (Vault, Privy, Turnkey, Para, Fireblocks, Dfns, CDP, AWS-KMS, GCP-KMS) for any deployment.
- Default-deny capability gating closes the blanket-registration hole in `solana-mcp`.
- Typed errors at LLM + indexer boundary eliminate the `any` leak.
- Custody-free MCP by default (`PassthroughSigner`) — no drainable keypair at the AEAP endpoint.
- Non-breaking refactor: existing tool names + parameter shapes preserved via snapshot test.

### Negative
- Adds `@solana/keychain-core` as a runtime dep (new surface).
- Clients must understand the unsigned-tx response convention — this is a new contract we publish and maintain.
- Capability taxonomy adds cognitive load for tool authors; needs documented worked examples per domain.
- `zodToMCPShape` precision loss on refinements/unions/transforms needs per-action documentation.
- Migration cost: every existing handler must be wrapped in `capabilityGated()` and declare `capabilities[]`. Estimated ~1–2 days of refactor.

## Open items (tracked for follow-up ADRs)

- **ADR-061 (planned)**: SAS integration depth — whether AEAP Registry references `solana-attestation-service` attestations as reputation substrate.
- **ADR-062 (planned)**: `mpp-sdk` canonical wire-format conformance if AEAP speaks HTTP-402.

## References

- `docs/SOLANA_ECOSYSTEM_ANALYSIS.md` — `@solana/keychain-core`, `solana-mcp-official`, `framework-kit` findings
- `docs/SENDAIFUN_ECOSYSTEM_ANALYSIS.md` — Action shape analysis; rejected patterns
- ADR-059 — tx submission pipeline (paired)
- ADR-060 — capability descriptor format (paired)
