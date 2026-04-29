# ADR-132: MCP HTTP origin gate + container-aware transport default

## Status

Accepted

## Date

2026-04-28

## Context

Cycle-3 MCP audit (`docs/audits/CYCLE-3-MCP-PUNCHLIST.md`) surfaced two
transport-hardening gaps that ADR-083 §"Transport security model" did
not anticipate:

- **MCP-321** — The HTTP transport is bearer-token-authenticated, but
  if an operator places MCP behind a reverse proxy that auto-injects
  the bearer header (e.g. for organization-internal SSO termination),
  browser callers from arbitrary origins can hit the surface as a
  confused-deputy. The bearer middleware alone is insufficient against
  cross-origin browser POSTs.
- **MCP-322** — The default `AEP_MCP_TRANSPORT=stdio` posture documents
  "trust boundary = parent process." That is correct for a CLI-launched
  MCP where the parent is a single trusted user. In a containerized
  deployment the parent is `tini`/`dumb-init`/PID 1 and any process
  that can `exec` into the container inherits stdio trust. The
  container threat model warrants a different default.

This ADR extends ADR-083 with two additions: an origin allowlist
middleware in front of the HTTP rate-limiter (MCP-321), and a
container-aware transport default (MCP-322).

## Decision

### MCP-321 — origin allowlist

New module `mcp-server/src/transport/origin-gate.ts` exporting
`makeOriginGate(config)` and `isOriginAllowed(req, config)`. The
middleware is wired BEFORE the rate-limiter in `startHttpTransport` so
cross-origin probes don't even consume bucket capacity.

**Configuration**: `AEP_MCP_HTTP_ALLOWED_ORIGINS` — comma-separated
list of allowed origins (e.g. `https://app.example.com,https://localhost:3000`).
Empty/unset means "no browser origins permitted"; only Origin-less
server-to-server callers pass.

**Decision rules** (`isOriginAllowed`):

| `Origin` | `Sec-Fetch-Site` | Result |
|---|---|---|
| absent | absent | pass (server-to-server) |
| absent | `none` / `same-origin` / `same-site` | pass |
| absent | `cross-site` | reject (anomalous browser shape) |
| in allowlist | any | pass |
| not in allowlist | any | reject (403) |

**Rationale**: server-to-server callers (curl, MCP clients, agent
runtimes) don't send `Origin`; they pass through to the auth gate
untouched. Browser origins must be explicitly allowlisted. The
`Sec-Fetch-Site: cross-site` defensive case handles browsers that
strip `Origin` for privacy under some configurations.

### MCP-322 — container-aware transport default

New helper `isContainerizedRuntime()` in `auth-gate.ts` detects
container context via three signals:

1. `/.dockerenv` exists (Docker, podman with `--init`)
2. `process.env.container` is set (systemd-nspawn, podman default)
3. `AEP_MCP_FORCE_CONTAINER_DEFAULT=1` (operator override)

When `AEP_MCP_TRANSPORT` is unset AND a container is detected,
`detectTransportPosture` flips the default from `stdio` to `unix`
and emits a WARN-level boot log naming the detection signal. The
operator can pin `AEP_MCP_TRANSPORT=stdio` explicitly to opt back in.

When the auto-flip fires AND `AEP_MCP_UNIX_PATH` is unset, the socket
defaults to `/run/aep-mcp/mcp.sock`. Outside auto-flip, an explicit
`AEP_MCP_TRANSPORT=unix` still requires `AEP_MCP_UNIX_PATH` (operators
choosing unix transport intentionally know where their orchestrator
expects the socket).

**Recovery path for operators**: if the auto-flip breaks an existing
deployment, set `AEP_MCP_TRANSPORT=stdio` and the previous behavior is
restored byte-for-byte. The boot log will name the detection signal so
operators see why the flip fired.

## Alternatives Considered

**Origin gate — server-side allowlist via reverse proxy instead.** The
operator could enforce origin checks at the proxy layer (nginx
`if ($http_origin ...)`, Cloudflare Worker, etc.). Rejected: ADR-083
§"Defense in depth" mandates that MCP not assume an upstream proxy
exists. The origin gate is cheap, in-process, and removes the
opt-out-by-misconfig hazard.

**MCP-322 doc-only.** Could ship a SECURITY note in ADR-083 saying
"in containers, set AEP_MCP_TRANSPORT=unix manually." Rejected per
the user decision (option (b)) on the cycle-3 implementation plan:
operator-action-required defaults are silently ignored by deployers
who follow tutorials. The auto-flip surfaces the security posture at
boot time via the WARN log.

**MCP-322 default-to-unix universally.** Could change the
non-container default from `stdio` to `unix`. Rejected: stdio is the
correct posture for CLI-launched single-user developer setups (the
dominant non-container use case). Flipping the universal default
would break those.

## Consequences

### Positive

- **MCP-321 closes the confused-deputy axis** for browser-origin
  callers when MCP sits behind an auto-auth proxy. Operators get
  defense-in-depth without any proxy-level config.
- **MCP-322 closes the container stdio-trust gap** for the dominant
  production deployment shape (Kubernetes / systemd / Docker Compose).
  Container deployments now default to a UID-bounded socket instead
  of inheriting parent-process trust from PID 1.
- **Auto-flip is observable** — the boot log names the detection
  signal so operators see why the default changed.
- **Backwards-compatible escape hatch** — `AEP_MCP_TRANSPORT=stdio`
  pin restores the pre-flip behavior exactly.

### Negative

- **Container-default flip can surprise existing deployments** that
  rely on the implicit stdio default. Mitigation: the WARN-level
  boot log explicitly states the new default and the override env
  var. Release notes call out the change.
- **`AEP_MCP_HTTP_ALLOWED_ORIGINS` defaults to empty** — operators
  who add a browser dashboard must explicitly allowlist the origin.
  The error mode is loud (403) and the fix is one env var.
- **The `/run/aep-mcp/mcp.sock` default may collide** with an
  operator's existing socket layout. Mitigation: the path is
  documented in ADR-132 and the boot log; operators with a
  conflicting layout set `AEP_MCP_UNIX_PATH` explicitly.

## Implementation

- `mcp-server/src/transport/origin-gate.ts` (~115 lines): config,
  `isOriginAllowed`, `makeOriginGate` factory.
- `mcp-server/src/transport/auth-gate.ts`: new `isContainerizedRuntime`
  helper; `detectTransportPosture` consults it when
  `AEP_MCP_TRANSPORT` is unset; container-auto-flip provides
  `/run/aep-mcp/mcp.sock` as the default unix path.
- `mcp-server/src/index.ts:startHttpTransport`: origin gate wraps
  rate-limit wraps bearer-auth (origin → rate-limit → auth →
  downstream).
- Boot log surfaces `origin_allowlist_count` + `origin_allowlist`
  when HTTP transport is enabled.

## Tests

- `mcp-server/test/transport-origin.test.ts` — 17 tests covering:
  CSV allowlist parse; six `isOriginAllowed` decision-table rows;
  middleware downstream-call vs 403; four `isContainerizedRuntime`
  signal cases; three `detectTransportPosture` auto-flip / pin /
  bare-host paths.

## Symmetric-coverage update (2026-04-29, CYCLE4-MCP-001 / Batch H)

The cycle-4 hostile re-audit on 2026-04-29 surfaced an asymmetric-
defense gap created by this ADR's container auto-flip:
`startUnixTransport` did NOT wire the rate-limit middleware that
landed alongside the origin gate, so any in-container peer with
socket reachability could fire unbounded `vault_transfer` calls
(the same axis MCP-320 closed at HTTP). The gap mirrored the cycle-3
asymmetric-defense pattern (`feedback_adr_symmetric_coverage.md` —
defenses on auth surfaces require symmetric init+mutation coverage).

**Closure (Batch H, in-wave with the audit):**

`startUnixTransport` now wraps the same
`originGate.middleware(rateLimiter.middleware(downstream))` chain
HTTP transport uses. The rate-limiter is constructed with a new
`unixMode: true` config flag that collapses the bucket key to a
single `unix:global` regardless of headers — there is no bearer
auth on the unix transport and `req.socket.remoteAddress` is empty
for AF_UNIX. Per-peer bucketing requires `SO_PEERCRED` native
introspection, which is deferred to the mTLS upgrade per ADR-083
§"Upgrade path to mTLS"; the global-bucket fall-back is sufficient
defense-in-depth given the filesystem-ACL trust boundary already
bounds the caller set to the container.

Origin gate works as-is — AF_UNIX requests carry no `Origin` header,
so the server-to-server pass-through path applies. The gate still
defends the hypothetical case where an operator builds an HTTP-to-
unix bridging proxy that forwards `Origin` verbatim.

**Threat-model statement (added per CYCLE4-MCP-001's suggested
closure path #3):** the unix transport's defenses are filesystem
ACL + optional peer-uid + rate-limit defense-in-depth (as of Batch
H). The container auto-flip is the right default ONLY because all
three layers are now in place.

Test coverage extended with 4 unix-mode tests in
`mcp-server/test/transport-rate-limit.test.ts`.

Full mcp-server suite after Batch H: 362/362.

## References

- ADR-083 (MCP transport security model) — origin gate and container
  default extend the posture defined here.
- `docs/audits/CYCLE-3-MCP-PUNCHLIST.md` — MCP-321 and MCP-322
  findings + closure footnote.
- `docs/audits/CYCLE-4-MCP-PUNCHLIST.md` — CYCLE4-MCP-001 finding +
  Batch H closure footnote.
- Memory `feedback_adr_symmetric_coverage.md` — the lesson driving
  the in-wave close: ADRs on auth/transport surfaces need symmetric
  defense across siblings, not just at the surface they were drafted
  against.
