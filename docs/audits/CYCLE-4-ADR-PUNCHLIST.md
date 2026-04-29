# Cycle 4 — ADR Governance + Repo Hygiene Punchlist (2026-04-29)

Hostile re-audit of the cycle-3 ADR governance posture against HEAD
`cd233dc`. Cross-checks the cycle-3 closure ADRs (ADR-119 promoted,
ADR-130/131/132/133 added) against the operator-facing runbooks
(`docs/MAINNET_CHECKLIST.md`, `docs/PROTOCOL_AUTHORITY_OPERATIONS.md`)
and the ADR inventory. The mindset is: an operator following the
mainnet checklist verbatim, with no out-of-band knowledge, gets the
posture the protocol intends.

## Source

- Audit: cycle-4 hostile re-audit (security-auditor agent, 2026-04-29)
- ADRs in scope: ADR-119 (promoted), ADR-130 (number reserved),
  ADR-131 (sybil cost calibration), ADR-132 (origin gate + container
  default), ADR-133 (handlers-v2 deferral)
- Runbooks audited: `docs/MAINNET_CHECKLIST.md` (351 lines),
  `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` (243 lines)

## Severity tally

| Critical | High | Medium | Low |
|---|---|---|---|
| 0 | 0 | 1 | 1 |

## Findings

### CYCLE4-ADR-001 (Medium) — `MAINNET_CHECKLIST.md` does not surface ADR-132 transport defaults

**File:lines:** `docs/MAINNET_CHECKLIST.md` (entire file — no
mention of `AEP_MCP_TRANSPORT`, `AEP_MCP_HTTP_ALLOWED_ORIGINS`,
`AEP_MCP_ALLOWED_UID`, ADR-132, ADR-083, or the container auto-flip).

**Threat (operator runbook drift).** ADR-132 / MCP-322 changed the
default MCP transport behavior under containerized runtime detection
(`/.dockerenv`, `process.env.container`,
`AEP_MCP_FORCE_CONTAINER_DEFAULT=1`). When `AEP_MCP_TRANSPORT` is
unset AND the runtime appears containerized, the default flips from
`stdio` to `unix` with the auto-flip socket path
`/run/aep-mcp/mcp.sock`.

A mainnet operator who follows `MAINNET_CHECKLIST.md` verbatim has no
visibility into:

1. **Which transport their MCP server will land on.** The checklist
   does not surface `AEP_MCP_TRANSPORT` at all. An operator deploying
   inside Docker / k8s / podman gets the unix-transport default
   without knowing it; an operator deploying outside containers gets
   stdio. Both are correct postures, but the operator should be told.

2. **The peer-uid check is OFF by default on the auto-flip path.**
   `AEP_MCP_ALLOWED_UID` is unset → the auth-gate at
   `mcp-server/src/transport/auth-gate.ts:399-407` returns false on
   non-Linux and matches process-uid against expected on Linux only
   when set. The default-no-UID-check posture is documented in the
   ADR-083 README SECURITY section, but the mainnet checklist does
   not bring this surface to the operator's attention. The auto-flip
   socket-mode-0600 + parent-directory-mode-0700 expectation is also
   not in the checklist.

3. **Origin allowlist is empty by default.** When the operator picks
   HTTP transport explicitly (out-of-checklist knowledge), the
   `AEP_MCP_HTTP_ALLOWED_ORIGINS` env defaults to empty — meaning
   "no browser origins permitted; only Origin-less server-to-server
   callers pass." This is a defensible default but is invisible to
   an operator who deploys MCP behind a reverse-proxy expecting the
   origin gate to pass browser traffic.

4. **ADR-132 acceptance footnote is in the ADR file, not in the
   checklist.** A new ADR's "operator-facing surface impact" needs
   to be cross-referenced in the deploy runbook for an operator-
   without-out-of-band-knowledge to get the right posture. ADR-132
   was accepted on 2026-04-28; the checklist hasn't been updated.

**Severity rationale:** Medium because:
- The defaults ADR-132 ships are sane (more secure than the
  pre-cycle-3 stdio-everywhere default in containers).
- An operator who reads the source / ADRs gets the right posture.
- An operator who reads only the checklist may miss the auto-flip
  semantic, which doesn't degrade security but is surprising on
  rolling deploy.

Not Low because:
- Mainnet checklist is the documented operator surface. Updates to
  defaults that the checklist doesn't surface are a runbook drift,
  and runbook drift on tx-signing surfaces is the class of issue
  the cycle-3 audit pattern is designed to catch.

**Suggested closure path:**

1. Add a new section to `MAINNET_CHECKLIST.md` after "Pre-Deployment
   Setup" (before line 41 `MCP server test suite passes`):

   ```
   ## MCP transport posture (ADR-083, ADR-132)

   - [ ] Decide transport: stdio (parent-process trust), http (bearer
         token + origin allowlist + rate limit), or unix (socket-mode
         0600 + optional peer-uid).
   - [ ] If deploying in a container WITHOUT explicit
         `AEP_MCP_TRANSPORT`, the default flips to `unix` with auto-
         path `/run/aep-mcp/mcp.sock`. Confirm this is what you want.
   - [ ] If using `unix`, set `AEP_MCP_ALLOWED_UID=$(id -u
         <mcp-service-user>)` so the optional peer-uid check is on.
   - [ ] If using `http`, set `AEP_MCP_HTTP_ALLOWED_ORIGINS=<csv>`
         for browser callers and confirm `AEP_MCP_AUTH_TOKEN` is at
         least 16 bytes (`openssl rand -hex 32`).
   - [ ] Confirm the parent dir of the unix socket is mode 0700.
   ```

2. Update `PROTOCOL_AUTHORITY_OPERATIONS.md` with the same surface
   so the authority operator is also aware of the transport posture
   choices when running rotation / governance ix through MCP.

3. Cross-reference: add a `> See MAINNET_CHECKLIST.md §"MCP
   transport posture"` line at the bottom of ADR-132 §"Operator
   surface" (currently the ADR has no such section — add one) so
   the runbook ↔ ADR loop is closed.

**Status:** Open.

---

### CYCLE4-ADR-002 (Low) — ADR-133 `handlers-v2` deferral trigger surfaces are documented in the ADR but not in any operational artifact

**File:lines:** `docs/adr/ADR-133-handlers-v2-wave-deferral.md` and
the absence of any matching operational hook.

**Threat (deferred-decision drift).** ADR-133 accepts option (c)
hybrid: keep dual-path + reference impl, defer the migration wave,
pin re-evaluation triggers (Anchor v2 ship, `@solana-program/token`
≥1.0.0, active CVE on `bigint-buffer`, feature requiring Kit-native
primitives, or 18+ months elapsed). The MCP punchlist footnote
states "Scheduled agent `trig_01GkKKZQd39rY2Z7w7tmmYou` (2026-06-03)
checks the first two triggers automatically."

Two of the five triggers are NOT covered by the scheduled agent:

- **Active CVE on `bigint-buffer`** — needs a recurring CVE-feed
  watcher pointed at the workspace's transitive dep graph (the
  package is pulled in via `@solana/buffer-layout-utils` →
  `@solana/web3.js`). No such watcher is documented.
- **Feature requiring Kit-native primitives** — this is a
  product-side trigger (a new feature lands and the v1 path can't
  satisfy it). No process gate on the issue tracker says "before
  marking a feature as v1-blocked, re-evaluate ADR-133." A future
  contributor could ship a Kit-only feature in v2 without flipping
  the wave decision back open.
- **18+ months elapsed** — counts from the 2026-04-29 acceptance.
  Trigger date 2027-10-29. No follow-up agent scheduled past
  2026-06-03.

**Severity rationale:** Low because:
- ADR-133 is a deferral, not a security control. The triggers are
  about WHEN to revisit, not about an active threat.
- The first two triggers (Anchor v2 ship + `@solana-program/token`
  ≥1.0.0) ARE covered by the existing scheduled agent.
- The CVE trigger is partially covered by Dependabot (which the
  cycle-3 dependabot-silence investigation already verified).

**Suggested closure path:**

1. Schedule a single follow-up agent for 2027-10-29 ("18-month re-
   evaluation of ADR-133") so the time-based trigger is on the
   calendar rather than dependent on someone re-reading the ADR.
2. Add a one-liner to `CONTRIBUTING.md` (if it exists) or to the
   handlers-v2 directory README: "Before adding a Kit-native-only
   feature to handlers-v2, see ADR-133 §'Triggers' for the wave-
   reopen criteria."
3. Verify Dependabot covers `bigint-buffer` directly. The existing
   investigation (`docs/audits/DEPENDABOT-SILENCE-INVESTIGATION-2026-
   04-27.md`) covered the silence pattern but did not enumerate
   coverage of the specific transitive packages ADR-133 names.

**Status:** Open.

## Adjacent surfaces probed (no findings)

- **ADR-119 promotion (Proposed → Accepted)** —
  `docs/adr/ADR-119-sdk-boundary-validation.md`. Scope expanded to
  cover the mcp-server vault-layout drift gate. Read at HEAD; the
  acceptance is well-formed and the codegen + drift-check call sites
  are in place.

- **ADR-130 cosign artifact provenance (number reserved)** —
  `docs/adr/ADR-130-artifact-provenance-cosign.md`. Number reserved,
  no implementation surface yet. Out of cycle-4 scope.

- **ADR-131 sybil cost calibration** —
  `docs/adr/ADR-131-sybil-cost-calibration.md`. Read in full; the
  economic argument (`R + L > E/3` per the per-agent slash cost
  inequality) is internally consistent. The "levers if threat model
  expands" section is well-thought-through. No code surface at HEAD.

- **ADR-132 origin gate + container auto-flip** —
  `docs/adr/ADR-132-mcp-http-origin-gate-and-container-default.md`.
  Read in full. The decision rationale, decision table, and
  consequences are all well-formed. **The cross-reference to the
  operator runbook is missing — captured as CYCLE4-ADR-001 above.**

- **ADR-133 handlers-v2 deferral** —
  `docs/adr/ADR-133-handlers-v2-wave-deferral.md`. Read in full. The
  hybrid option (keep dual path + reference impl) preserves both the
  v1 production path and the v2 reference impl as a learning sample.
  The trigger list is comprehensive but not all triggers are wired
  to operational artifacts — captured as CYCLE4-ADR-002 above.

- **ADR-INVENTORY refresh** — `docs/audits/ADR-INVENTORY.md`. The
  parallel-agent refresh covered ADR-119/130/131/132/133. Read at
  HEAD `cd233dc`; entries are present and statuses are correct.

- **Closure footnote SHA self-references** — verified by grep that
  every cycle-3 closeout commit is footnoted with its own SHA in
  the corresponding punchlist. The "self-referential SHA" memory
  pattern from the OFF-208/209/210/212/213/214/215 + AUD-203 +
  AUD-205 commits is consistent. No drift.

## Recommendation

Cycle-3 ADR governance is mostly clean. The two findings are
runbook-side rather than ADR-side:

- **CYCLE4-ADR-001 (Medium)** — checklist update needed before
  containerized mainnet rollout. Not a code blocker.
- **CYCLE4-ADR-002 (Low)** — process gap on three of five ADR-133
  triggers. Not blocking, but worth scheduling the 18-month follow-
  up agent now while the context is fresh.

Neither finding blocks the release window. Both are routine doc
updates that fit cleanly into the next operational bundle.
