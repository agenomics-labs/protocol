# ADR-109: Agent Identity URI scheme for topology-independent naming

- **Status**: Proposed
- **Date**: 2026-04-23
- **Related**: ADR-060 (capability manifest), ADR-061 (SAS
  attestation resolver), ADR-069 (agent identity rotation), ADR-088
  (typed Anchor IDL), ADR-092 (manifest hash domain separation),
  ADR-098 (client SDK), ADR-104 (observability)

## Context

An agent's on-chain identity today is a **base58 Solana pubkey**
(`AgentProfile.authority` and `AgentProfile.vault_address`). Off-chain
identifiers exist in parallel:

- DNS / HTTPS endpoint of the agent's MCP server (implicit).
- IPFS CID or Arweave tx-id embedded in `manifest_cid`
  (ADR-060, 64-byte zero-padded).
- Optional SAS credential subject (ADR-061).

These are **topology-dependent**: a consumer who wants to "find agent
X" has to know which surface they're searching (on-chain registry vs.
off-chain capability graph vs. MCP directory). There's no single
stable name that survives all three.

Rodriguez — **"Agent Identity URI Scheme: Topology-Independent Naming
and Capability-Based Discovery for Multi-Agent Systems"**
(hf.co/papers/2601.14567, Jan 2026) — proposes an opaque URI scheme
that encodes:

1. a **stable identity** (resistant to endpoint / host migration),
2. a **capability fingerprint** (resistant to endpoint but updated
   when the agent's capabilities change), and
3. a **discovery hint** (location-shaped, rewritable).

The scheme is `agent:<identity>[@<capability-fp>][?hint=<...>]`. The
`identity` part is a stable, self-certifying identifier (a pubkey or
DID); the `capability-fp` is a short hash derived from the published
manifest; the `hint` is advisory only.

For this protocol the identity is already there — it's the
`authority` pubkey. The capability fingerprint is also already there —
it's `manifest_hash` (ADR-092 tagged, 32 bytes). The hint can be the
`manifest_cid` OR the MCP endpoint URL. The URI scheme ties them
together without changing any on-chain state.

## Decision

Standardize an `aep:` URI scheme at the client + SDK layer:

```
aep:<authority-base58>[@<manifest-hash-base58url-12>][?endpoint=<https-url>]
```

- `authority`: full base58 Solana pubkey. REQUIRED. Self-certifying
  identity; equal to `AgentProfile.authority`.
- `manifest-hash`: first 12 base58url-encoded bytes of the domain-
  tagged `manifest_hash` (ADR-092). OPTIONAL. Pins to a specific
  capability state — consumers can verify the live manifest still
  matches this prefix before trusting downstream calls.
- `endpoint`: URL of the agent's MCP server. OPTIONAL. Rewritable,
  advisory. Cached resolution only — do NOT treat as authoritative.

Examples:

```
aep:8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh
aep:8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh@a1b2c3d4e5f6
aep:8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh@a1b2c3d4e5f6?endpoint=https%3A%2F%2Fagent.example.com
```

### Implementation surface

1. `@agenomics/client` (ADR-098) gains parse/format helpers:
   ```typescript
   parseAgentUri(uri: string): AgentUriParts
   formatAgentUri(parts: AgentUriParts): string
   resolveAgentUri(uri: string, provider: AnchorProvider): Promise<ResolvedAgent>
   ```
   where `resolveAgentUri` reads the on-chain profile, verifies
   (if given) that `manifest-hash` still matches the profile's
   current manifest, and returns the endpoint either from the URI
   hint or from the manifest's `mcp_endpoint` field.

2. `mcp-server` accepts `aep:` URIs anywhere a base58 authority is
   accepted today (optional, behind a feature flag until ADR-098's
   stable SDK ships).

3. Indexer renders `aep:` form alongside the base58 pubkey in
   `/agents/:authority` responses.

### What we are NOT doing

- We are NOT introducing a new on-chain field. The URI is derived
  from existing state.
- We are NOT adding a DNS-like central resolver. There's no
  "registrar." Every resolve is a direct on-chain read.
- We are NOT adopting W3C DIDs. A `did:aep:<authority>` could layer on
  top later without conflict (just a different encoding). DIDs are
  out of scope here; this ADR is explicitly about the ergonomic
  surface, not a standards track.

## Alternatives considered

- **W3C DIDs (did:sol, did:pkh, did:web)**: heavier stack
  (resolvers, verification methods, service endpoints) for a feature
  already satisfiable by a local URI format. Revisit if the protocol
  joins a DID-based federation.
- **Bare base58 pubkey** (current state). Works, but doesn't capture
  capability-fingerprint or endpoint in a single shareable string.
- **ActivityPub-style URLs** (`https://registry.example.com/agents/<id>`).
  Ties identity to a hostname; a custodial registry becomes the
  single point of failure. Directly opposes ADR-094's trust inversion.
- **Ethereum-style `0x` prefix + ENS**. Solana ecosystem convention
  is base58 + no name service. Cross-chain bridges will use their
  own encodings; we don't need to standardize there.

## Consequences

### DX

- One stable human-readable (or at least copy-pasteable) handle per
  agent. Works in Discord, GitHub issues, CLI args, env vars without
  quoting surprises.
- Capability-pinning via the `@<hash>` segment: consumers can lock to
  a specific manifest version without trusting the registry's
  mutable pointer.

### Security

- URI verification MUST be part of the client library: parsing the
  string is not trust; only reading the on-chain account at
  `authority` gives you the signed state. Document this prominently
  in the SDK README — the URI is NOT proof.
- The `endpoint` hint is a candidate for phishing (attacker sets
  their own MCP endpoint in the URI for an otherwise-legitimate
  `authority`). Mitigation: SDK should ALWAYS prefer the manifest's
  `mcp_endpoint` field over the URI hint; use hint only as a
  bootstrap for the first read. Codify in ADR-098 v0.2.

### Interop

- `aep:` is a **URI** (RFC 3986), not a URL. It has no wire protocol.
  HTTP clients that see `aep:` should return a "this isn't a
  scheme I handle" error; wrapping libraries resolve to HTTPS via
  the manifest lookup.
- Alignment with ADR-104 tracing: structured-log field
  `agent_uri=aep:...` replaces the ad-hoc `authority=<base58>` we
  use today. Non-breaking — add the new field and keep the old.

## Open items

1. **Registered scheme**. `aep:` is not reserved with IANA. For an
   internal ecosystem this is fine; if the protocol goes cross-chain,
   consider applying for `aep:` or switching to `ens:agenomics:`.
2. **QR-code payload format**. Wallets like to encode pay-to-agent
   intent. `solana:` URI format already exists; `aep:` should
   interoperate. Deferred — open issue to spec a composite
   `solana:...?aep=...` shape.
3. **Multi-vault agents** (future). If a single `authority`
   eventually owns multiple vaults (not currently supported), the
   URI will need a `?vault=` selector. Not in scope now.
4. **Binary encoding for logs**. OpenTelemetry span attributes prefer
   short binary values; `aep:` as text is ~55–95 chars. Acceptable
   for our traffic volume; revisit if log cost becomes material.

## References

- Rodriguez, R. **"Agent Identity URI Scheme: Topology-Independent
  Naming and Capability-Based Discovery for Multi-Agent Systems."**
  2026. <https://hf.co/papers/2601.14567>
- RFC 3986 — Uniform Resource Identifier (URI): Generic Syntax.
- Internal: ADR-060, ADR-061, ADR-069, ADR-088, ADR-092, ADR-098,
  ADR-104.
