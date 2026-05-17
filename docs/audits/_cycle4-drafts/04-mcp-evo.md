# Cycle-4 Draft — 04 MCP-SERVER + EVO (security-first)

Scope: `mcp-server/` tool surface + ADR-129 EVO integration. Audited
against branch `audit-baseline` (origin/main `b8fe80b`) PLUS the
**intended final state** from PR #165
(`origin/fix/evo-adapter-retrieval-shape`) for the two EVO adapter
files. READ-ONLY pass. Continues `CYCLE-4-MCP-PUNCHLIST.md`
(CYCLE4-MCP-001/002 already closed there).

## Severity tally

| Critical | High | Medium | Low | Info |
|---|---|---|---|---|
| 0 | 0 | 2 | 2 | 1 |

## Capability-bypass verdict (seed finding #1)

**NOT CONFIRMED — seed finding is a false positive. Resolved.**

The seed claimed `capability-gated-tool.ts:24` has a logic inversion
(`readOnly &&` vs `!readOnly`) letting read-only actions bypass
capability validation.

- Line 24 is an *interface field declaration*
  (`idempotencyStore?: IdempotencyStore;`), not gate logic.
- The actual capability gate is `capability-gated-tool.ts:57`:
  `if (!action.readOnly) { ...filter missing capabilities... }`.
  This is the **correct** default-deny direction per ADR-058 §4: the
  claim filter runs for non-readOnly actions and is intentionally
  skipped for `readOnly:true`.
- The design is internally consistent and well-understood by the
  codebase. `registry.ts:180-186` + `225-229` document that
  `find_similar_agents` is deliberately declared `readOnly:false`
  with `capabilities:["read:agent-memory"]` *specifically because*
  the gate skips claim enforcement on `readOnly:true`. The
  registration-time guard at `:32-36` enforces the symmetric
  invariant (non-readOnly ⇒ non-empty caps).
- Every genuinely state-changing action (`actions/vault.ts`,
  `actions/settlement.ts`, `actions/registry.ts:register_agent`)
  is `readOnly:false` + non-empty `capabilities` + `requiresSigner:
  true`. No mutating action is mis-declared `readOnly:true`.

Blast radius if it *were* inverted: none observed, because the
declarations are correct. No further action; recommend the seed
finding be marked **REJECTED (analyst misread interface line for
gate line)** in the punchlist.

## Findings

### C4-MCPEVO-001 (Medium) — IPFS manifest fetch is unbounded SSRF / DoS primitive

**File:line:** `mcp-server/src/handlers/reputation.ts:185-211`
(`fetchManifestFromIpfs`), reached from `handleGetAgentReputation`
:393.

**Scenario.** The manifest CID is decoded from the on-chain
`AgentProfile.manifest_cid` (`[u8;64]`, `decodeManifestCid` :289)
and passed straight into `fetch(`${base}/ipfs/${encodeURIComponent(
cid)}`)` with **no CID well-formedness validation, no response size
cap, no timeout, no content-type check, no redirect policy**.
`get_agent_reputation` is a `readOnly` action (`actions/reputation.ts
:43`) callable by any authenticated caller against *any*
`agentAddress`. An attacker who can publish/influence an
`AgentProfile` (own registration is sufficient — they control their
own `manifest_cid`) can:

1. **DoS / resource exhaustion.** Point the CID at a gateway path
   that streams an unbounded body. `await resp.arrayBuffer()` (:198)
   buffers the entire response into memory with no `Content-Length`
   guard — a multi-GB body OOMs the MCP process. No `AbortSignal`
   timeout means a slow-loris gateway response hangs the call
   indefinitely (the per-action timeout is on EVO/tx paths, not on
   this `fetch`).
2. **Content confusion.** `encodeURIComponent(cid)` neutralizes
   path-traversal/scheme-injection into the URL (good — no
   `file://`/`http://attacker` pivot, `..` and `/` are percent-
   encoded), so this is **not a classic same-origin SSRF**. The
   residual risk is (a) the operator-configured `AEP_IPFS_GATEWAY`
   itself being attacker-influencing, and (b) the gateway following
   the CID to attacker-controlled content. `validateManifest`
   (schema+hash+Ed25519, :398) *does* gate poisoning of the
   *validated* fields — a poisoned body fails hash/sig and throws.
   But the DoS (1) happens *before* validation.

**Severity rationale.** Medium not High: poisoning of trusted fields
is closed by `validateManifest` (on-chain hash + Ed25519 binding);
the SSRF is constrained by `encodeURIComponent`. But the unbounded
buffer + no timeout is a real unauthenticated-ish remote DoS on a
read action, reachable by any caller against any registered agent.

**Fix.**
- Add `AbortSignal.timeout(ms)` (e.g. 10s) to the `fetch`.
- Stream with a hard byte cap (manifests are KB-scale; cap at e.g.
  256 KiB and abort on exceed) instead of unconditional
  `arrayBuffer()`.
- Validate CID shape against a CIDv0/v1 regex before fetch (reject
  early, cheap, and tightens the URL surface further).
- Reject non-`https`/`http` `AEP_IPFS_GATEWAY` at config load and
  set `redirect: "error"` (or cap redirects) on the fetch.

**ADR-needed?** No new ADR — fits under ADR-061 §4 step-3 hardening.
Recommend a one-line amendment to ADR-061 documenting the size/
timeout bound as a protocol requirement.

### C4-MCPEVO-002 (Medium) — Solana address inputs typed `z.string()` without base58 refinement (settlement + vault)

**File:line:** `mcp-server/src/actions/settlement.ts:35,36,44,68,
91,118,120,148,172,193,215,239,242,243,275`;
`mcp-server/src/actions/vault.ts:103,137,160,247,248` — every
address/mint/token-account field is bare `z.string()` (contrast
`registry.ts:188-194` `findSimilarAgentsInput.agent_id` which
*does* `.refine(isValidPublicKey)`).

**Scenario.** Malformed/garbage address strings pass schema
validation and reach the handlers. The downstream
`parsePublicKey(requireString(...))` (`handlers/settlement.ts:97,
101,197,...`) *does* throw `isValidPublicKey`-gated, so a fully
malformed string is rejected — **defense-in-depth gap, not a
confirmed bypass**. Residual risk: any handler path that consumes
an address field *without* routing it through `parsePublicKey`
(e.g. logging, idempotency-key derivation, or a future handler)
inherits an unvalidated attacker string. The asymmetry (registry
validates at the schema boundary; settlement/vault defer entirely
to the handler) is exactly the symmetric-coverage pattern prior
cycles flagged (AUD-200 lesson).

**Severity rationale.** Medium: no confirmed exploit because
`parsePublicKey` is the actual chokepoint and throws. Flagged
because boundary validation is the documented invariant
(input validation at system boundaries, CLAUDE.md) and the
inconsistency is a latent footgun for the next handler author + a
prompt-injection-into-logs vector if any address is logged
pre-parse.

**Fix.** Replace bare `z.string()` with the shared
`.refine(isValidPublicKey, ...)` (already exists in
`registry.ts`/`solana.ts:392`) for every address/mint/token-account
field in `actions/settlement.ts` and `actions/vault.ts`. Extract a
`solanaAddress` zod helper to stop the drift recurring.

**ADR-needed?** No.

### C4-MCPEVO-003 (Low) — EVO `parseRetrievalResult` accepts attacker-shaped `node_id`/`content` into hydration without length/charset bound (PR #165 state)

**File:line:** `mcp-server/src/adapters/evo-bridge.ts:~370-425`
(PR #165 `origin/fix/evo-adapter-retrieval-shape`).

**Scenario.** Post-#165 the parser reads `entry.node_id` /
`entry.content` / `entry.metadata` from EVO subprocess stdout and
emits them as hits. EVO is a *trusted local subprocess* (ADR-129),
so this is low. But `content`/`metadata` flow into the
`find_similar_agents` response and onward to the calling LLM agent
with no length cap or control-char scrub. If EVO's DB is ever
populated from semi-trusted manifest text (it is — manifest content
is embedded), a crafted manifest could store a tool-poisoning /
prompt-injection payload that round-trips through
`find_similar_agents` into the consuming agent's context. The
on-chain hydration (`fetchMultiple` against `AgentProfile`) bounds
the *structured* fields but `content`/`metadata` pass through
verbatim.

**Severity rationale.** Low: requires the attacker to first land a
poisoned manifest in EVO's embedding store and the consumer to
treat retrieval `content` as instructions. Phase-1 EVO is
best-effort/kill-switched (`AEP_EVO_ENABLED` default off). Still a
genuine indirect prompt-injection surface worth a bound.

**Fix.** Cap `content` length and strip ASCII control chars in
`parseRetrievalResult` before pushing the hit; treat retrieval
content as untrusted data in the `find_similar_agents` response
contract (document "not instructions").

**ADR-needed?** No — ADR-129 §"Contracts" note suffices.

### C4-MCPEVO-004 (Low) — EVO subprocess argv from env without existence/shape validation

**File:line:** `mcp-server/src/adapters/evo-subprocess-transport.ts
:246-251` (PR #165 / main identical): `spawn(binaryPath, ["--json",
"--db", dbPath], { stdio:[pipe,pipe,pipe] })`.

**Scenario.** `binaryPath` (`AEP_EVO_BINARY`) and `dbPath`
(`AEP_EVO_DB`) are operator-supplied env. **Command injection is
NOT present** — `spawn` is used with an argv array (no shell), so
metacharacters in `dbPath` are inert; this is correctly safe. The
residual is operational: a relative/typo `AEP_EVO_BINARY` is
handled by `handleSpawnFailure`→breaker (graceful). MCP-303 already
fail-fasts on relative `AEP_EVO_DB` in `evo-bridge.ts:447-476`.
Noted to record that the command-injection scope item was
**checked and is clean** (argv form, no `shell:true`, no string
interpolation into a command).

**Severity rationale.** Low / effectively informational — defense
already correct; logged for scope completeness.

**Fix.** None required. Optional: assert `binaryPath` is absolute
at config load for symmetry with the `AEP_EVO_DB` MCP-303 check.

**ADR-needed?** No.

### C4-MCPEVO-005 (Info) — EVO handshake switched `version`→`health`; protocol-version pinning is now best-effort (PR #165)

**File:line:** `evo-subprocess-transport.ts` `onHandshakeOk`
(PR #165, ~:419-510).

**Observation (not a vuln).** PR #165 replaces the `version`
handshake with `health` because EVO's `JsonCommand` enum has no
`version` variant (the old code *always* fell back to
"legacy v1" — the pin was already non-functional on main). The new
code still pins on an explicit `protocol_version` when present and
trips `EvoBridgeVersionMismatchError` (permanent breaker) on a
major mismatch — that path is preserved and correct. When EVO
returns a `health` shape with no version (the real HEAD case) the
transport proceeds as `<major>.legacy`. Net: #165 *fixes* a silent
no-op handshake; it does not weaken a working pin (there was no
working pin on main). The added BLAKE3-fallback WARN log is a
positive observability improvement (surfaces a semantically-dead
EVO). Recorded so the punchlist reflects that the #165 handshake
change was security-reviewed and is an improvement, not a
regression.

## Adjacent surfaces probed (no finding)

- **Transport auth (ADR-083) — `auth-gate.ts`:** bearer compared
  via `crypto.timingSafeEqual` over fixed-size SHA-256 digests
  (:254-271), `MIN_TOKEN_BYTES` floor enforced (:182-183), http
  hard-fails when token unset. No timing/length oracle. No bypass
  found. CYCLE4-MCP-001 (unix-transport rate-limit/origin gap) is
  already closed in the punchlist (Batch H).
- **Capability provenance:** `ctx.wallet.capabilities` is a `Set`
  populated upstream of the action layer (claims), not from
  action input — no caller-controlled capability injection at the
  gate.
- **MCP-306 numeric-score gate** still holds post-#165 (`rank_score`
  preferred, then `score`, then `similarity`; `if (!id) continue`
  moved earlier but logically equivalent — entries with no id still
  dropped before push).
- **Idempotency / preflight ordering** in `capability-gated-tool.ts`
  unchanged and correct (signer → capability → preflight →
  idempotency; preflight runs before handler, no side effect on
  fail).

## Recommendation

Two Medium defense-in-depth items (SSRF/DoS bound on the IPFS
manifest fetch; base58 schema refinement parity for settlement/vault
address inputs) — both fixable without an ADR, neither a
release-window blocker but both should land before mainnet given
they sit on a tx-adjacent + reputation surface. Seed finding #1
(capability inversion) is a **false positive** — the gate logic is
correct; recommend rejecting it in the punchlist with the
line-misread note above. PR #165 EVO changes reviewed: net security
improvement, no regressions.
