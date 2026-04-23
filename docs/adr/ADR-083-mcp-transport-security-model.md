# ADR-083: MCP transport security model

## Status
Accepted

## Date
2026-04-23

## Context

The Agenomics MCP server in `mcp-server/src/index.ts` exposes 23 capability-gated
actions (ADR-058) over a Model Context Protocol transport. A subset of those
actions — `vault_transfer`, `vault_program_call`, `register_agent`,
`update_my_profile`, `create_task`, `accept_task`, `submit_milestone`,
`approve_milestone`, `resolve_dispute`, etc. — are **privileged**: the handler
calls `loadWallet()` from `mcp-server/src/solana.ts:118-137` and signs a Solana
transaction with the operator's keypair (typically
`~/.config/solana/id.json`).

Today the server unconditionally connects to `StdioServerTransport`:

```ts
// mcp-server/src/index.ts:106
const transport = new StdioServerTransport();
await server.connect(transport);
```

This works because the MCP host (Claude Desktop, an SDK process, etc.) spawns
the server as a **subprocess**, and stdin/stdout are inherited file descriptors.
Anyone who can write to stdin is the parent process — and the parent process is
already inside the operator's trust boundary.

The deep-audit run on 2026-04-22 (Sec finding 5.2) flagged this as the
load-bearing assumption that is **nowhere documented and nowhere enforced in
code**. Concretely:

1. **The MCP SDK ships a `StreamableHTTPServerTransport`** in
   `@modelcontextprotocol/sdk/server/streamableHttp` — a Node HTTP transport
   that listens on a port and accepts JSON-RPC over HTTP+SSE. Nothing in our
   tree forbids someone wiring it up. If an operator follows the SDK's example
   `app.post('/mcp', (req, res) => transport.handleRequest(req, res, req.body))`
   and binds to `0.0.0.0`, every reachable client gets to call `vault_transfer`
   for free.
2. **There is zero authentication on the transport surface.** The handler at
   `mcp-server/src/index.ts:76-103` builds a `buildLocalDevContext()` that
   grants `ALL_CAPABILITIES`, including `sign:vault`, `sign:registry`,
   `sign:settlement`, and the cross-program admin caps, to **every incoming
   request**, irrespective of who sent it.
3. **The capability set was designed for per-request enforcement, not per-peer
   authentication.** ADR-058's Capability gating defends against an action
   accidentally invoking a privileged surface; it does not defend against a
   malicious peer asking for that surface directly.
4. **Finding 5.1 (separate but adjacent)** — `loadWallet()` does not check the
   keyfile permission mode. A `0644` `id.json` is silently loaded on Unix,
   meaning any local user account on the operator's machine can read the secret
   key. An accidental `chmod 644` (e.g., from a backup-restore tool) leaves the
   protocol's signing key world-readable with no audit trail.

The threat model is therefore:

| Adversary | Local stdio | Local Unix socket | Network HTTP (lan) | Network HTTP (internet) |
|-----------|-------------|-------------------|--------------------|--------------------------|
| Same-uid local malware | Already inside trust boundary (handles wallet directly) | Same | Same | Same |
| Other-uid local user | Cannot reach stdin — needs ptrace or fd inheritance | Can connect to socket without auth → sign vault | Same | Same |
| LAN peer (printer, IoT device, container) | Cannot reach stdin | N/A | **Direct vault drain** with no auth | Same |
| Internet attacker | Cannot reach stdin | N/A | N/A | **Direct vault drain** with no auth |

The first row is correctly handled by the OS — same-uid is already inside the
trust boundary because they can read the keyfile, attach ptrace to the running
process, and replace `~/.config/solana/id.json` itself. No transport-level
defense changes that calculus.

The other three rows are wide open today. The audit's Sec 5.2 finding is
specifically that **rows 2-4 are unauthenticated and undocumented**.

## Decision

Adopt a **transport-aware authentication posture** for the MCP server, gated at
process startup, with three explicit modes:

### Mode 1 — stdio (default, unchanged behavior)

When `AEP_MCP_TRANSPORT` is unset or equals `"stdio"`:
- The server starts on `StdioServerTransport`.
- One-line info log on startup confirms the local-only assumption:
  ```
  MCP transport: stdio (local subprocess; trust boundary = parent process)
  ```
- No new env vars are required. **Existing local-stdio invocations are
  preserved bit-for-bit.**

### Mode 2 — HTTP (opt-in, requires bearer token)

When `AEP_MCP_TRANSPORT="http"`:
- The server **refuses to start** unless `AEP_MCP_AUTH_TOKEN` is set to a
  non-empty value of at least 16 bytes (after UTF-8 encoding). The error is
  actionable and explicit:
  ```
  AEP_MCP_TRANSPORT=http requires AEP_MCP_AUTH_TOKEN to be set
  (>=16 bytes). Generate one with: openssl rand -hex 32.
  Refusing to start: serving an unauthenticated tx-signing surface
  over HTTP would expose the operator wallet to any reachable peer.
  ```
- Every incoming HTTP request must carry `Authorization: Bearer <token>`. The
  comparison uses `crypto.timingSafeEqual` over the SHA-256 of expected and
  presented tokens, which gives us constant-time semantics and equal-length
  inputs irrespective of presented-token length.
- Rejected requests return HTTP `401` with `WWW-Authenticate: Bearer
  realm="aep-mcp"` and a single-line JSON error body. The MCP transport is
  never reached.
- Bind defaults to `127.0.0.1` and the port is configurable via
  `AEP_MCP_HTTP_PORT` (default `7037`). Operators who want to expose the server
  on `0.0.0.0` must set `AEP_MCP_HTTP_HOST` explicitly — the documentation
  states unambiguously that this is for advanced operators with mTLS terminated
  upstream (a load balancer or sidecar).

### Mode 3 — Unix domain socket (opt-in, optional peer-credential check)

When `AEP_MCP_TRANSPORT="unix"`:
- The server listens on the path given by `AEP_MCP_UNIX_PATH` (required).
- The socket file is created with mode `0600` (owner-only).
- If `AEP_MCP_ALLOWED_UID` is set (decimal string), the v0.1.0
  implementation cross-checks the running process's `geteuid()` against the
  declared expected UID at startup. The full SO_PEERCRED-per-connection
  check requires a native addon and is out of scope for v0.1.0 — it ships
  with the mTLS upgrade ADR (see §"Upgrade path to mTLS").
- If `AEP_MCP_ALLOWED_UID` is unset, the socket-mode-0600 check is the only
  gate. This is suitable for single-uid containers; the documentation calls
  out that multi-uid hosts must set the env var.

### Operational guidance

- **Default for local development**: leave everything unset. Stdio mode is the
  default and is unchanged.
- **Default for CI / single-host containers**: Unix socket mode with
  `AEP_MCP_UNIX_PATH=/run/aep-mcp/mcp.sock` and `AEP_MCP_ALLOWED_UID=$(id -u)`.
- **Default for hosted multi-tenant**: HTTP mode behind a sidecar that
  terminates mTLS and sets the bearer token from a secrets manager. The
  protocol-level token is the second factor; the network-level mTLS is the
  first.
- **Default for direct internet exposure**: not supported in v0.1.0. The HTTP
  bearer-token path will accept such a deployment but it is an explicit
  operator decision, documented in the README's SECURITY section.

### Adjacent fix — `loadWallet()` permission check (Finding 5.1)

`loadWallet()` in `mcp-server/src/solana.ts` and (if duplicated) the keyfile
read path in `mcp-server/src/handlers-v2/keypair-signer.ts` will refuse to
proceed if the file mode has any group or other bits set. The check is
`(statSync(path).mode & 0o077) === 0`; otherwise the loader throws:
```
key file is world-readable; refuse to load. chmod 600 <path>
```

In practice `keypair-signer.ts` does not read keyfiles from disk — it operates
on an in-memory `Keypair` produced by `loadWallet()` — so the single fix at
`loadWallet` covers both code paths.

This is a defense-in-depth measure: it does not stop a same-uid attacker, but
it does stop the silent-permissions-regression class of incidents.

### CI lint gate

A regex-based gate (`scripts/check-mcp-transport-auth.sh`) runs in CI and fails
if any new wiring of `app.listen(` or `server.listen(` appears in
`mcp-server/src/**` outside the auth-gated wrapper. The wrapper itself lives
in `mcp-server/src/index.ts` (the `startHttpTransport` and `startUnixTransport`
functions) and explicitly references `mcp-server/src/transport/auth-gate.ts`
for the auth middleware. Existing `app.listen` call sites in
`src/x402-relay/` and `src/indexer/` are explicitly listed as out-of-scope
because those services have their own JWT auth (ADR-017) and are not
tx-signing surfaces.

## Alternatives Considered

### Alternative A: Document the stdio assumption only; do not implement HTTP auth

**Rejected.** Documentation alone does not stop a future contributor from
wiring `StreamableHTTPServerTransport` into `index.ts` because the SDK example
makes it look easy. The CI lint gate plus the hard-fail at startup are the
only enforceable defenses. Documentation is necessary but not sufficient.

### Alternative B: Require mTLS at the protocol layer, not bearer tokens

**Rejected for v0.1.0.** mTLS is the right answer for production deployments
with a PKI in place. For v0.1.0 it is a much heavier operational lift (cert
issuance, rotation, OCSP, CRL distribution) than the threat justifies. The
pragmatic answer is "bearer token in v0.1.0; mTLS-at-the-sidecar today; native
mTLS in a follow-up ADR." The bearer-token path does not foreclose a future
mTLS upgrade — they compose.

### Alternative C: JWT (HS256 or RS256) instead of opaque bearer

**Rejected.** JWT brings claims, expiry, audience, and a JWS signature surface
that we don't need yet. The MCP server is a single-tenant signing surface in
v0.1.0; opaque bearer tokens are smaller, simpler, and easier to rotate
operationally (one env var swap and a process restart). When per-tool
fine-grained authz lands (Capability-set-per-token), JWT becomes the right
shape — that is a follow-up ADR (#102 in the audit's numbering plan, the
hosted-mode ADR-058 PR3 spec).

### Alternative D: SO_PEERCRED only for the Unix-socket mode; no UID env var

**Rejected.** The default behavior on a single-uid host is correctly captured
by the socket-mode-0600 check, but multi-uid containers (e.g., a sidecar that
runs as a different user than the MCP server) do exist. The optional
`AEP_MCP_ALLOWED_UID` covers that case without imposing the check on
single-uid deployments.

### Alternative E: Refuse to start in HTTP mode unconditionally; force operators
to deploy a reverse proxy with auth

**Rejected.** This is a real position taken by some MCP servers, but it shifts
all responsibility for authentication onto the operator's reverse-proxy
configuration. Operators will get this wrong; the stakes are vault drain.
Building bearer-token auth into the server itself means a misconfigured
reverse proxy is one factor of failure, not the only factor.

### Alternative F: Ship the bearer-token check as middleware optional via a
plugin system

**Rejected.** The action being defended (transaction signing) is the primary
purpose of the server; auth for it cannot be optional or configurable away. A
plugin system makes the security posture less inspectable and more brittle
under refactors.

## Consequences

### Positive
- **Default stdio behavior unchanged** — no impact on local development or
  existing Claude Desktop integrations.
- **HTTP exposure is fail-closed** — the server cannot be started in HTTP mode
  without an explicit token. The error message is actionable.
- **Constant-time comparison** mitigates token-length timing oracles per
  `crypto.timingSafeEqual` semantics. Best-effort under V8's timing model but
  correctness-of-comparison is independent of timing.
- **Unix-socket mode supports container deployments** without requiring a full
  mTLS PKI.
- **CI gate prevents regression** — a new contributor cannot accidentally wire
  `StreamableHTTPServerTransport` into `index.ts` without going through the
  auth-gated wrapper.
- **`loadWallet()` permission check** catches the silent-permissions-regression
  class of incidents, with no impact on correctly-configured deployments.

### Negative
- **One more env var to manage** when running in HTTP mode
  (`AEP_MCP_AUTH_TOKEN`). Operators must rotate it on a cadence; no automation
  ships in v0.1.0.
- **Bearer tokens are bearer tokens** — anyone who can read the env var can
  sign vault transactions. The token must be treated with the same care as the
  wallet keyfile. The README SECURITY section calls this out explicitly.
- **No per-tool authz yet.** The bearer token grants the full action surface.
  Per-capability tokens (e.g., a read-only token) require ADR-058 PR3 and a
  per-token Capability resolver.
- **HTTP mode is less hardened than mTLS.** The recommendation is to terminate
  TLS upstream (sidecar / load balancer) — but the server itself does not
  enforce TLS. Operators who deploy raw HTTP across an untrusted network must
  layer in their own transport encryption.
- **Unix-socket mode is Unix-only.** Windows operators must use stdio or HTTP.

### Neutral
- **The SDK's `StreamableHTTPServerTransport` is wrapped, not replaced.** The
  underlying protocol behavior is unchanged; we add a gate above it.
- **Tests that import `actionRouter` from `src/index.ts` are unaffected.** The
  `main()` function is still gated behind `require.main === module` and the
  transport selection is inside `main()`.

## Upgrade path to mTLS

The bearer-token path is deliberately a stepping stone, not a destination.
The upgrade looks like:

1. Operator deploys a sidecar (Envoy, ghostunnel, nginx with TLS) terminating
   mTLS on the MCP server's port. Bearer token is set in the sidecar's headers.
2. The MCP server adds an optional `AEP_MCP_REQUIRE_CLIENT_CERT_HEADER` env
   that, when set, additionally validates a sidecar-injected
   `X-Client-Cert-DN` header (or equivalent) against an allow-list before
   accepting the bearer token. This is the second factor.
3. A follow-up ADR (planned #110+ in the audit's numbering plan) replaces the
   bearer-token surface with native Node `https.createServer` + client-cert
   verification, deprecating the sidecar-injected-header pattern. Bearer tokens
   become a fallback for environments where mTLS is operationally infeasible
   (e.g., Anthropic-hosted clients without a customer PKI).

Each step is additive and backward-compatible with the previous step.

## References
- `docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md` item 5 — punch-list entry for
  this ADR
- `docs/adr/ADR-058-action-pipeline-and-capabilities.md` — the per-request
  capability set this ADR complements (it does not replace)
- `mcp-server/src/index.ts:29-135` — current stdio-only transport wiring
- `mcp-server/src/solana.ts:118-137` — `loadWallet()`, the privileged signer
  surface this ADR defends
- `mcp-server/src/handlers-v2/vault.ts:180-330` — the `vault_transfer` v2
  handler, representative of the privileged surface
- `mcp-server/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/streamableHttp.d.ts`
  — the HTTP transport this ADR gates
- `crypto.timingSafeEqual` — Node 20+ constant-time comparison, used for token
  validation
- `getsockopt(SO_PEERCRED)` — Linux peer-credential mechanism for the
  Unix-socket mode (per-connection check arrives with the mTLS upgrade)
