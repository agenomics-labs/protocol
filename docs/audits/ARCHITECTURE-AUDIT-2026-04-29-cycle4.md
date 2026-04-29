# Architecture Audit — Cycle 4 Hostile Re-Audit (2026-04-29)

Hostile cycle-4 re-audit of the agenomics-labs/protocol repository,
post-cycle-3-closeout. Same pattern that surfaced cycle-3 Critical
findings AUD-200 + MCP-320: assume an attacker with full source access
who wants to exploit, not improve. Treat every closure footnote as a
claim, then chase that claim to the source-of-record at HEAD and
re-evaluate for adversarial bypass.

- **HEAD audited:** `cd233dc` (`docs(audits): cycle-3 on-chain + MCP
  summary docs`)
- **Cycle-3 closeout window:** `f0efc00..37f0acc` on `main` (Batches
  A through G, 2 new ADRs (132, 133), 1 promoted (119))
- **Audit duration:** ~50 minutes

## TL;DR

**No new Critical findings. No code-level Critical or High blockers
for mainnet on-chain or off-chain. One High finding on the MCP
container-default flip surface; one Medium operational durability
finding on the EVO bridge; one Medium runbook drift on
`MAINNET_CHECKLIST.md`. The cycle-3 corpus is genuinely clean from
the on-chain dimension.**

The cycle-4 mindset (hostile, non-collaborative) deliberately re-walked
every cycle-3 closure footnote against HEAD. The on-chain cycle-3
closures (AUD-200, AUD-201, AUD-202, AUD-203, AUD-205, AUD-206) all
hold under adversarial re-evaluation. The off-chain cycle-3 closures
(OFF-201/203/205/206/204/207/208-217) all hold; one Low operational
gap surfaced (SIGTERM does not gracefully release the indexer writer
lock — correctness preserved by PG TCP teardown). The MCP cycle-3
closures all hold individually, but the MCP-322 container auto-flip
introduces an asymmetric-defense gap where the new default unix
transport lacks the rate-limit defense MCP-320 closed for HTTP — this
is the cycle-4 finding most worth fixing before any containerized
mainnet operator deploys.

### Critical / High findings (release-window blocker tier)

- **CYCLE4-MCP-001 (High)** — Unix transport in `startUnixTransport`
  does NOT wrap the downstream listener in either the rate-limiter
  (MCP-320) or the origin gate (MCP-321), but MCP-322's container
  auto-flip makes the unix transport the default for any deployment
  inside Docker / k8s / podman / nerdctl that doesn't pin
  `AEP_MCP_TRANSPORT=stdio`. Defense-symmetry gap: the cycle-3 audit
  closed unbounded-call exposure on the HTTP transport, the new
  default re-opens it on the unix transport.
  **Recommended:** wire `rateLimiter.middleware(downstream)` into
  `startUnixTransport`, with a peer-uid-based or single-global bucket
  key (no bearer token on AF_UNIX). Detail in
  `CYCLE-4-MCP-PUNCHLIST.md`.

### Medium findings (operational)

- **CYCLE4-MCP-002 (Medium)** — `EvoSubprocessTransport.restartCount`
  is monotonic over MCP server process lifetime. A long-running
  production MCP (weeks-to-months uptime) with even a low-rate
  transient EVO failure pattern will eventually permanently brick the
  bridge after `maxRestarts` (default 10). Inconsistent with
  `consecutiveFailures`'s reset-on-success semantic. ADR-129 best-
  effort posture means no security defect, but the restart-cap-as-
  tripwire claim in the MCP-301 footnote is weaker than an operator
  reading the comment would assume.

- **CYCLE4-ADR-001 (Medium)** — `MAINNET_CHECKLIST.md` does not
  surface ADR-132 transport defaults. Operator following the
  checklist verbatim has no visibility into the container auto-flip,
  the empty-by-default origin allowlist, or the off-by-default peer-
  uid check. Mainnet checklist should include a "MCP transport
  posture" section. Runbook drift, not a code defect.

### Low findings (paper-cut)

- **CYCLE4-OFF-001 (Low)** — Indexer SIGTERM does not gracefully
  release the OFF-212 writer lock (only SIGINT does). PG TCP teardown
  is the correctness backstop, but rolling-deploy startups may see
  delayed lock release on slow-shutdown pods. Operational, not
  security.

- **CYCLE4-ADR-002 (Low)** — ADR-133 deferral triggers (CVE on
  `bigint-buffer`, Kit-native feature, 18+ months elapsed) are
  documented in the ADR but not all wired to operational artifacts
  (only the first two triggers — Anchor v2 ship + `@solana-program/
  token` ≥1.0.0 — have a scheduled agent). Process gap, not a
  code defect.

## Severity tally (corpus-wide)

| Domain | Critical | High | Medium | Low |
|---|---|---|---|---|
| On-chain Rust | 0 | 0 | 0 | 0 |
| Off-chain TS | 0 | 0 | 0 | 1 |
| MCP / SDK / EVO | 0 | 1 | 1 | 0 |
| ADR / runbook | 0 | 0 | 1 | 1 |
| **TOTAL** | **0** | **1** | **2** | **2** |

## Per-domain summaries

### On-chain Rust (`programs/{agent-vault,agent-registry,settlement}/src/**`)

**Result: clean.** All six cycle-3 on-chain closures (AUD-200 through
AUD-206, except AUD-204 which is the deferred ADR-125 rotation ix)
hold under adversarial re-evaluation:

- **AUD-200 rotation proof-of-control** — the `verify_ed25519_
  precompile` runs FIRST, before the rate-limit check. A rejected
  proof leaves `last_rotation_at` untouched. Domain tag is shared
  with init; cross-surface signature replay is closed because both
  surfaces bind the same `(authority, agent_identity)` tuple.
- **AUD-201 stuck-Active mutual rescission** — dual-signature via
  `has_one` on both `client` and `provider`; refund equals
  `total_amount - released_amount`; no reputation CPI; final status
  `Cancelled`.
- **AUD-202 `ProtocolConfig` field-order pin** — `#[repr(C)]` plus
  `const _: () = assert!(offset_of!(ProtocolConfig, authority) == 0)`
  fails the Settlement build itself if a field reorder ships.
  Discriminator gate (AUD-104) handles name-drift dimension.
- **AUD-203 seeds-parity** — `include_str!`-based mechanical-identity
  check covers the four AUD-117-touched contexts. The bankrun
  migration (2026-05-10) will add the runtime-rejection side.
- **AUD-205 sybil cost calibration** — ADR-131 is calibration
  documentation accepting current bounds. No code surface to probe.
- **AUD-206 retired-profile rejection on `propose_reputation_delta`**
  — rejection fires at handler entry, before any state mutation.
  Combined with `update_status`'s `Retired → *` transition table,
  `Retired` is now a true closed state.

Adjacent surfaces probed: `verify_protocol_invariants` (PDA ownership
+ discriminator gate close the forged-account threat),
`update_manifest` ed25519 path (distinct domain tag closes cross-
surface replay), owner-nonce monotonicity (`saturating_add` is
deliberate, no grief vector). All clean.

Detail in `CYCLE-4-ONCHAIN-PUNCHLIST.md`.

### Off-chain TypeScript (`src/{indexer,x402-relay}/**`)

**Result: 1 Low.** All cycle-3 OFF-* closures hold under hostile
re-walk. The single Low finding (CYCLE4-OFF-001) is the indexer
missing a SIGTERM handler — the SIGINT handler at line 2042 has the
right shape (release writer lock, close pool, `db.close()`), but
SIGTERM (the orchestrator default) has no parallel path. PG TCP
teardown is the correctness backstop; the gap is operational latency
on rolling deploys.

Adjacent surfaces probed: OFF-201 reconciler race (intentional and
bounded), OFF-203 atomic-claim (no JWT-mint-then-release shape
remains), OFF-205 owner-bound release (Lua CAS-DEL gates DEL on
GET == ARGV[1]; counter DECR gated on `removed > 0`), OFF-206 Redis
command timeout (NaN-safe parse closes silent-disable shape), OFF-204
pg.Pool four-timeouts + error handler. All clean.

Detail in `CYCLE-4-OFFCHAIN-PUNCHLIST.md`.

### MCP / SDK / EVO bridge (`mcp-server/src/**`, `sdk/client/src/**`)

**Result: 1 High, 1 Medium.** All Batch A-G closures hold individually,
but two findings surfaced:

- **CYCLE4-MCP-001 (High)** — defense-symmetry gap. MCP-322 container
  auto-flip makes unix transport the default in containers, but
  `startUnixTransport` does not wire either rate-limiter or origin
  gate. Treat as release-window blocker for containerized mainnet
  operators. Suggested closure: lift the rate-limiter middleware
  into the unix transport with a peer-uid bucket key.

- **CYCLE4-MCP-002 (Medium)** — operational durability gap.
  `EvoSubprocessTransport.restartCount` is lifetime-monotonic, so a
  long-running MCP server with low-rate transient EVO failures
  eventually bricks the bridge permanently. Suggested closure: reset
  on sustained-healthy-window, OR surface via Prometheus + amend
  ADR-129 to make the lifetime semantic explicit.

Adjacent surfaces probed: MCP-300 timeout + late-stdout drop, MCP-302
queue-depth (inflight counts), MCP-305 handshake (legacy `unknown
command` tolerated, version-mismatch trips breaker permanently),
MCP-307 multi-line capture (2KiB bounded), MCP-303 absolute-path,
MCP-304 symmetry, MCP-306 numeric-score gate, MCP-310 settle-time
TTL with replace-check, MCP-311 runtime drift gate (cwd-dependent but
build-time CI gate is authoritative), MCP-312 preflight contract,
MCP-313 IDL-derived codegen, MCP-314 cache invalidation, MCP-315
cross-instance clock skew, MCP-321 origin gate (decision table covers
cross-site-without-Origin), MCP-323 SDK typed Programs (zero `as any`
in SDK), MCP-324 four residual `VaultTransferV2Rpc` casts (sound at
runtime — cycle-3 footnote claim verified). All clean.

Detail in `CYCLE-4-MCP-PUNCHLIST.md`.

### ADR governance + repo hygiene

**Result: 1 Medium, 1 Low.** Both findings are runbook-side rather
than ADR-side:

- **CYCLE4-ADR-001 (Medium)** — `MAINNET_CHECKLIST.md` does not
  surface `AEP_MCP_TRANSPORT`, `AEP_MCP_HTTP_ALLOWED_ORIGINS`,
  `AEP_MCP_ALLOWED_UID`, ADR-132, or the container auto-flip. An
  operator following the checklist deploys MCP under whatever the
  default is, and the default just changed in ADR-132 without
  runbook update.

- **CYCLE4-ADR-002 (Low)** — ADR-133 deferral triggers are
  documented in the ADR but only two of five (Anchor v2 ship,
  `@solana-program/token` ≥1.0.0) are wired to a scheduled agent.
  CVE-on-`bigint-buffer`, feature-requiring-Kit-native-primitives,
  and 18+months-elapsed triggers have no operational hook.

ADRs themselves (ADR-119 promotion, ADR-130 number reservation,
ADR-131 sybil cost, ADR-132 origin + container, ADR-133 deferral)
are all well-formed and internally consistent.

Detail in `CYCLE-4-ADR-PUNCHLIST.md`.

## Cross-cycle observations

The cycle-3 closeout window's most consequential change — the
MCP-322 container auto-flip — is exactly the class of change the
cycle-3 audit pattern (AUD-200, MCP-320) was designed to catch:
landing a defense at one surface (HTTP transport rate-limit) and
silently re-opening the same threat at a sibling surface (unix
transport, now the default). The cycle-4 audit caught the
asymmetry at CYCLE4-MCP-001; this is the cycle-3 pattern repeating
at +1 wave-depth.

The cycle-3 closure footnote convention — every closeout commit is
self-referenced by its own SHA via the post-commit footnote-fill — is
working well as an audit-trail primitive. Every footnote at HEAD
points to a real commit, and every claim in a footnote is satisfied
by the source-of-record. This is a stronger guarantee than most
codebases produce; it materially shortened cycle-4's verification
time.

## Recommendation

The corpus is genuinely close to clean from a security-correctness
perspective. **The single release-window-relevant finding is
CYCLE4-MCP-001** (the unix-transport rate-limit gap under the new
container default). I would NOT label it a Critical mainnet blocker
because:

- The unix transport's filesystem ACL (mode 0600 + parent dir 0700)
  is a real defense, not nothing.
- A same-uid attacker who reaches the unix socket already has a
  broader threat surface than the MCP rate-limit.
- The MCP-320 footnote was explicit that stdio + unix were "intentionally
  skipped" — this isn't a regression of a closed defense, it's a
  symmetry gap on a defense that was scoped to HTTP.

But it IS a High because:
- MCP-322 changed the default, so the pre-MCP-322 reasoning ("unix
  is opt-in, the operator knows what they're doing") doesn't apply.
- The fix is small (lift the existing middleware into the unix
  transport).
- It would be cheap to close before the container auto-flip ships
  in production.

**Recommendation: fix CYCLE4-MCP-001 in the next routine bundle
before any containerized mainnet operator deploys; track CYCLE4-MCP-002,
CYCLE4-OFF-001, CYCLE4-ADR-001, CYCLE4-ADR-002 as routine cleanups
that do not block the release window.**

The cycle-3 closeout window is otherwise clean.
