# ADR-051: One Vault/Agent Per Authority — Known Limitation

## Status
Accepted

## Date
2026-04-17

## Context

Vault PDA seeds `[b"vault", authority]` and Agent Profile PDA seeds `[authority, b"agent-profile"]` create a 1:1 mapping between a keypair and its on-chain accounts. Each authority can only own one vault and one agent profile. This means a single operator who wants multiple vaults or multiple agent personas must manage multiple keypairs.

## Decision

Accept the 1:1 mapping as a v1 limitation. Multi-vault and multi-agent support is deferred to v2.

### Rationale

1. **Migration cost**: Changing PDA seeds would break 100+ call sites across Rust programs and TypeScript client code. Every instruction that derives a vault or profile address would need updating.
2. **Account migration**: All existing on-chain vaults and profiles would require a migration instruction to re-derive under new seeds, adding upgrade risk.
3. **Discovery problem**: If multiple vaults exist per authority, callers need to know which index to query. This adds enumeration complexity to every client integration.
4. **Simplicity**: The 1:1 model is straightforward, well-tested, and sufficient for v1 use cases.

### Workaround

Generate a new keypair for each additional vault or agent profile. The keypair serves as a natural namespace boundary.

## v2 Sketch

Add a `u64 index` parameter to PDA seeds:

```
Vault:   [b"vault", authority, &index.to_le_bytes()]
Profile: [authority, b"agent-profile", &index.to_le_bytes()]
```

- Default `index = 0` preserves backward compatibility with v1 accounts.
- A `migrate_to_indexed` instruction re-derives existing accounts under the new seed scheme.
- Client SDKs expose `findVaultAddress(authority, index?)` with index defaulting to 0.

## Consequences

### Positive
- No migration risk or breaking changes in v1
- Simpler client code — one authority, one vault, one profile
- Clear upgrade path documented for v2

### Negative
- Operators needing multiple vaults must manage multiple keypairs
- Key management burden increases for power users
- v2 migration will still require coordinated upgrade across programs and clients
