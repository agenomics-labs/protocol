# ADR-098: `@agenomics/client` — TypeScript SDK for AEP on-chain programs

## Status

Superseded by ADR-098-sdk-client-package

## Date

2026-04-23

**Audit-item:** ARCHITECTURE-AUDIT-2026-04-23 → item 23
**References:** ADR-088 (typed Anchor program clients), ADR-099 (`@agenomics/idl` package)

## Context

The AEP protocol exposes three Anchor programs — `agent-registry`, `agent-vault`,
and `settlement` — but has no programmatic interface for third-party developers.
The architecture audit (item 23) explicitly flags "third-party builders" as
"fiction" because:

1. There is no published package. Builders must clone the monorepo and read
   `mcp-server/src/` to understand how programs are consumed.
2. `mcp-server/src/` itself was, until ADR-088, riddled with `as any` casts —
   not a model worth copying.
3. PDA derivation is duplicated ad-hoc in `mcp-server/src/handlers/` with no
   shared, tested implementation.

ADR-088 resolved the `as any` problem inside `mcp-server` by threading the
Anchor-generated IDL types through the `Program<IDL>` generic. ADR-099 extracts
those IDL types into a publishable `@agenomics/idl` package. This ADR builds on
both: it wraps the Anchor `Program` in thin, ergonomic client classes that hide
provider construction boilerplate and centralise PDA derivation.

## Decision

Publish `@agenomics/client` as a workspace package (`packages/client/`) with:

1. **Three client classes** — `AgentRegistryClient`, `AgentVaultClient`,
   `SettlementClient` — each wrapping a `Program` instance.
2. **PDA helpers** on every client for the seeds used by each program, derived
   with `PublicKey.findProgramAddressSync` so the logic is testable off-chain.
3. **Typed `fetch*` methods** that call `program.account[X].fetch(pda)` and
   return the account shape as decoded by Anchor.
4. **Shared enums** (`AgentStatus`, `PricingModel`, `EscrowStatus`,
   `MilestoneStatus`) that mirror the on-chain Rust definitions in TypeScript.
5. **No dependency on `@agenomics/idl`** — because ADR-099 is being implemented
   in parallel and may not be stable. Callers pass the IDL as a constructor
   argument (`Idl` from `@coral-xyz/anchor`), keeping the client package
   decoupled from the IDL distribution strategy.

This is v0.1.0 scaffolding. The public surface is intentionally minimal:
PDA derivation + fetch. Instruction builders (e.g. `registerAgent(...)`) are
out of scope and will be added in a follow-up as the ecosystem matures.

## Consequences

### Positive

- Third-party builders have a typed, documented entry-point without cloning the
  monorepo.
- PDA derivation is centralised in one place rather than duplicated across
  `mcp-server`, the dashboard, and future integrations.
- Enums in `types.ts` are the single source of truth for off-chain consumers;
  they will drift-detect against `@agenomics/idl` once that package stabilises.
- The package is `"strict": true` and `"noImplicitAny": true` end-to-end — no
  `as any` leaks into the public API.

### Negative / cost

- IDL must be provided by the caller. Until `@agenomics/idl` is stable, callers
  must supply the IDL JSON themselves (from `target/idl/*.json` or a copy).
- Instruction builders are absent; callers must still use `program.methods.*`
  directly for writes. This is an intentional v0.1.0 scope restriction.

### Out of scope (follow-up)

- **Instruction builder methods** (`registerAgent`, `createEscrow`, etc.) —
  follow-up after `@agenomics/idl` stabilises.
- **`@agenomics/idl` integration** — once ADR-099 lands, add a peer dependency
  and re-export the IDL types so callers no longer supply raw JSON.
- **Event subscription helpers** — Anchor event parsing for `TransactionExecuted`,
  `TaskCompleted`, etc.

## References

- `ARCHITECTURE-AUDIT-2026-04-23.md` — item 23 ("third-party builders is fiction")
- ADR-088 — typed Anchor program clients in `mcp-server`
- ADR-099 — `@agenomics/idl` workspace package (being implemented in parallel)
- `programs/agent-registry/src/state.rs` — `AgentProfile`, `AgentStatus`, `PricingModel`
- `programs/agent-vault/src/state.rs` — `Vault`, `VaultPolicy`
- `programs/settlement/src/state.rs` — `TaskEscrow`, `EscrowStatus`, `MilestoneStatus`

## Revisions

- 2026-04-25 — Marked Superseded. Two ADR-098 files were created in parallel
  PRs (#50 / #51) and both landed as Accepted. The brief variant
  (`ADR-098-sdk-client-package`) matches the actual code: `sdk/client/package.json`
  declares `@agenomics/idl` as a dependency, contradicting §1.5 of this verbose
  variant. Audit reference: AUD-2026-04-25 / AUD-047, drift matrix §1.
