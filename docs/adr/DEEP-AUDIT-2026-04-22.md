# Deep-Dive Audit — 2026-04-22

Three parallel audits run after the SAS-credential-bootstrap (PR #27) landed,
when `main` was stable, CI green, and the devnet smoke test passing
end-to-end (including live SAS PDAs). Scope was deliberately narrowed to
"anything expensive to change post-publish or post-mainnet" — out of scope:
style, test coverage, docs drift, performance tuning.

Audits:

- **Audit 1** — On-chain security + SAS resolver trust boundary
- **Audit 2** — `@agenomics/*` npm package API/ABI stability pre-v0.1.0
- **Audit 3** — Governance / ops gaps

Reports are preserved verbatim below. A synthesis punch-list follows.

---

## Audit 1 — Security Audit (Anchor programs + SAS resolver)

### CRITICAL

**1. `programs/agent-registry/src/contexts.rs:70-85` — `UpdateReputation` context is missing `has_one = authority` style binding AND authority is not in its seeds**

The `agent_profile` PDA in `UpdateReputation` is validated via
`seeds = [agent_profile.authority.as_ref(), ...]` (self-referential seed),
so Anchor re-derives the PDA using the field inside the account itself —
the only real gate is the `settlement_authority` signer. **Exploit**: a
caller passes any other agent's `AgentProfile` account; Anchor re-derives
`[that_authority, "agent-profile"]`, it matches, and the Settlement
program's signer CPI happily writes reputation to someone else's profile
(cross-agent reputation forgery via `approve_milestone` / `expire_escrow`
/ `resolve_dispute*`). **Mitigation**: bind `agent_profile` address to
`escrow.provider` at the Settlement call sites (the caller-side contexts
at `settlement/src/contexts.rs:153-159, 255-261, 309-316, 400-406` *do*
set `seeds = [escrow.provider.as_ref(), ...]`, but the Registry side
should also assert the profile key matches a provider passed as an
account, otherwise trust collapses to whatever Settlement signs for —
which is anything the attacker chose).

**2. `programs/agent-vault/src/contexts.rs:74-89, 93-120` — `ExecuteTransfer` / `ExecuteTokenTransfer` lack `has_one = authority`; instead check `agent.key() == vault.authority || agent.key() == vault.agent_identity`**

`vault.agent_identity` is supplied by the authority at `initialize_vault`
(lib.rs:26) with **zero on-chain validation** — an authority can set
`agent_identity` to any key. That's fine when used honestly, but combined
with the no-close-no-reinit protection below, an attacker who can *swap*
`agent_identity` via a policy-update path (none today — but `update_policy`
carries only 3 fields) is safe. Today this is exploitable if the authority
key is ever shared/rotated: the old authority can still sign as
`agent_identity` forever. **Exploit**: compromise of the off-chain "agent
runtime" key with `agent_identity` binding = full vault drain under the
daily cap indefinitely, even after the human rotates `vault.authority`.
**Mitigation**: add an `update_agent_identity` ix gated by
`has_one = authority` and document that `agent_identity` is a hot key that
should be rotated on compromise; alternatively, require `agent_identity`
to be a PDA owned by the registry so registry-level suspension kills
vault-draining.

**3. `packages/sas-resolver/src/resolver.ts:326` + `allowlist.ts:57` — allowlist is credential-authority–based, not schema-bound**

The schema PDA is checked (`resolver.ts:317`) and the credential authority
is checked (`resolver.ts:326`), but **nothing checks that the credential
itself authorized this schema**. In SAS, any credential authority can issue
attestations against any schema PDA it references. An allowlisted
credential (say `AEP_VALIDATORS`) whose signing key later leaks — or a
misconfigured allowlist containing a credential the attacker controls —
can mint a `AEP_AGENT_REPUTATION_v1` attestation claiming any subject has
score 10000. **Exploit**: attacker who controls one allowlisted credential
authority (or bootstrap-ceremony compromise per ADR-063) forges reputation
for any agent; downstream MCP consumers trust the score. **Mitigation**:
also verify the `raw.signer` against a per-credential signer allowlist (or
at minimum assert `signer == credential` when the credential authority is
the signer) and include a schema↔credential binding check (AEP publishes
which credentials are authorized to attest under the reputation schema).

### HIGH

**4. `programs/agent-registry/src/lib.rs:273-277` — `deregister_agent` closes the profile via `close = authority` but does NOT close/zero the `reputation-stake` PDA**

Lamports staked at `[authority, "reputation-stake"]` are orphaned when the
profile closes. Worse, because `close = authority` returns the profile's
rent to `authority`, the **authority can then re-register with the same
seeds**, creating a brand new `AgentProfile` with `reputation_score = 0,
slash_count = 0` while the old `staking_pda` survives. **Exploit**: a
suspended or low-reputation agent calls `deregister` → `register_agent` to
wipe `slash_count` and bypass the Suspended-status trap entirely (cheaper
than `clear_suspension` which halves score). **Mitigation**: force
`deregister_agent` to drain `staking_pda` (or refuse deregister while
`staked_amount > 0`), and optionally bind registration to a monotonic
nonce seed so a fresh profile cannot reuse the old PDA.

**5. `programs/agent-vault/src/contexts.rs:106-110` — `vault_token_account` mint is not verified against the allowlist at the constraint layer; only checked in the handler after rate-limit counters are consumed**

Handler at `instructions.rs:331` checks `is_token_allowed(&mint)`, but the
rate-limit increment at `instructions.rs:347-352` happens before the
`ok_or(TokenNotConfigured)` check at `instructions.rs:365`. **Exploit**:
attacker sends `execute_token_transfer` with a mint that's allowlisted but
has no `TokenSpendRecord` — the tx fails, but not before
`txs_in_current_window` is incremented, so the attacker can drain the
rate-limit bucket to DoS legitimate transfers. More severe: if
`token_allowlist` is empty (`state.rs:110-114`: "No allowlist = all tokens
allowed"), *every* mint passes the allowlist check and the
`ok_or(TokenNotConfigured)` is the only real gate — but the rate-limit
window is already burned. **Mitigation**: move the `TokenSpendRecord`
lookup before the rate-limit increment, or make `token_allowlist`
default-deny.

**6. `programs/agent-vault/src/contexts.rs:108` — `vault_token_account.owner == vault.key()` is the only gate; no check that `vault` is the vault for the signing agent**

`ExecuteTokenTransfer` derives the vault from `seeds = [b"vault",
vault.authority.key().as_ref()]` — self-referential again. Combined with
the `agent.key() == vault.authority || agent.key() == vault.agent_identity`
handler check, a user who signs as themselves and supplies a vault whose
`authority` happens to be the attacker (trivially true — they created their
own vault) will pass… but they can also supply *any vault where
agent_identity equals a key they control*. Since `agent_identity` is
attacker-supplied at init for their own vault, this is fine for their own
vault. However, the real risk: **the `recipient_token_account` has no
owner check** (`contexts.rs:113-117`), only mint match. The handler
doesn't verify the recipient is not the vault itself or a sanctioned
account — authority can transfer tokens anywhere under the cap, which is
by design, but there is no "recipient != vault" guard preventing a
fee-manipulation griefer from burning rate-limit slots on self-transfers.

**7. `programs/settlement/src/contexts.rs:216-221` — `ResolveDispute` allows client-as-resolver when `dispute_resolver == None`**

The constraint allows `resolver.key() == escrow.client` even if
`dispute_resolver` is unset. `create_escrow` at `escrow.rs:39-45` rejects
*naming* yourself as resolver, but if `dispute_resolver = None`, the client
becomes de facto resolver via the OR branch. The A-03 slash guard at
`dispute.rs:116` prevents reputation slashing in that case, but the client
still decides refund split 100/0 unilaterally. **Exploit**: client creates
escrow with `dispute_resolver = None`, waits for provider to submit
milestones, raises dispute, calls `resolve_dispute(client_refund=remaining,
provider_refund=0)` — client drains escrow with no provider recourse
except `resolve_dispute_timeout` (which also refunds client 100%). The
entire dispute path is client-controlled when resolver is None.
**Mitigation**: require a non-None resolver at `create_escrow` time, or
route None-resolver disputes exclusively through `resolve_dispute_timeout`
with a symmetric split.

**8. `programs/settlement/src/contexts.rs:149, 247, 305, 393` — `registry_program` is `UncheckedAccount` with `executable` + `constraint = key == AGENT_REGISTRY_PROGRAM_ID`, but SPL token program in same programs is typed `Program<'info, Token>`; asymmetry is fine, but `settlement_authority` (`contexts.rs:164-168, 263-265, 318-320, 408-410`) has no `address = ...` constraint — only seeds**

Seeds derivation uses the calling program's ID implicitly, which is
correct, but the Registry's `UpdateReputation` context
(`registry/contexts.rs:78-84`) validates
`seeds::program = SETTLEMENT_PROGRAM_ID`. A compromise of the settlement
PDA's derivation (seed change in a future upgrade) silently desyncs.
**Mitigation**: add `address = <derived>` as a belt-and-braces assertion
on `settlement_authority`.

### MEDIUM

**9. `programs/agent-vault/src/instructions.rs:263-266` — SOL transfer uses direct lamport mutation on a program-owned PDA, but pre-check reads `vault_info.lamports()` before `checked_sub`**

If the vault is *also* used as the payer on a nested CPI in the same tx,
the balance observed here may not reflect the post-CPI balance. Currently
no such nesting exists, but a future instruction that CPI-calls the
vault-as-authority and then calls `execute_transfer` in the same tx would
race. **Mitigation**: document the invariant or use `try_borrow_mut_lamports`
semantics consistently.

**10. `programs/settlement/src/instructions/escrow.rs:159-276` — `approve_milestone` does not require `escrow.status == Active` AND the Active→Completed transition via `all_approved` check races with parallel milestone approvals**

Anchor serializes instructions but `all_approved` is computed from
`escrow.milestones.iter().all(...)` *after* mutating one milestone. No
actual race (single-threaded tx), but if `provider_profile` is a wrong
profile (see finding #1), the all_approved branch CPIs into the wrong
registry account. Already covered in #1.

**11. `programs/agent-registry/src/lib.rs:127-130` — reputation_delta casting `(-reputation_delta) as u64`**

If `reputation_delta == i64::MIN`, negation overflows. `saturating_sub`
masks the panic in release, but in debug `-(i64::MIN)` panics. **Exploit**:
Settlement passes `i64::MIN` through `reputation_delta_dispute_loss`
governance field (`update_protocol_config` only checks `v <= 0`, so
`i64::MIN` passes). Result: registry panics, the CPI fails, but a
malicious authority of `protocol_config` can brick all slashing.
**Mitigation**: bound protocol-config deltas to a sane range (e.g.,
`v >= -1_000_000`) and use `checked_neg()`.

**12. `programs/agent-registry/src/lib.rs:135-141` — `avg_rating` formula uses `n / 2` rounding with `(avg * (n-1) + rating + n/2) / n`**

When `n` is large, `avg * (n-1)` may overflow u128? No — `avg ≤ 5` so
`5 * (u64::MAX - 1)` fits in u128. Safe. **Downgrade: Info.**

**13. `packages/sas-resolver/src/resolver.ts:412-423` — cache envelope mismatch between resolver and cache**

Analysis concluded no bug, cache shape is correct. **Downgrade: Info.**

**14. `packages/sas-resolver/src/schema.ts:190-195` — attestation tag hardcoded to `2`**

If SAS bumps discriminator versions (likely, given SAS pre-v1 status —
ADR-064), every resolver silently fails with `discriminator mismatch` and
the system degrades to "no reputation signal for anyone." Not a security
hole, but a centralized kill switch on SAS's side. **Info.**

**15. `packages/sas-resolver/src/resolver.ts:311-323` — schema match is pubkey-based, but attacker can register their own schema at a chosen PDA**

If the allowlisted credential authority signs an attestation pointing at a
*different* schema PDA than `this.#schemaPda`, it is silently skipped (row
4c). However, the resolver's `#schemaPda` is supplied by config — **if an
operator misconfigures `schemaPda` to an attacker-controlled value**, any
attestation with that schema is trusted. Low likelihood, but combine with
#3: the v1 allowlist bootstrap (ADR-063) is the single trust root.
**Mitigation**: document and monitor schema PDA at deploy; add a runtime
assertion that `schemaPda`'s owner is the SAS program.

### LOW

**16. `programs/agent-vault/src/instructions.rs:227, 241` — `saturating_add` on daily totals**

Fine for correctness, but `spent_today.saturating_add(amount) <= daily_limit`
with saturation means a spend that would overflow is rejected
(`new_total == u64::MAX > daily_limit`). Correct behavior. **Info.**

**17. `programs/settlement/src/instructions/escrow.rs:358-499` — `expire_escrow` has no signer check beyond `payer: Signer`**

Anyone can call `expire_escrow` after deadline. By design (anyone-can-crank
pattern), but this lets adversaries front-run the provider's final
`submit_milestone` by racing the deadline — a provider who submits at
deadline-1 can have their milestone nullified by a pending flag check.
Actually `expire_escrow` pays Submitted milestones (line 385-389), so this
is OK. **Info.**

**18. `programs/agent-registry/src/lib.rs:296-345` — `update_manifest` Ed25519 precompile search checks `current - 1` and `current + 1` only**

If the tx contains the sig-verify ix at index `current - 2` or elsewhere,
the resolver returns `MissingEd25519Instruction`. Not exploitable, but
fragile. An attacker who crafts a transaction with the ed25519 ix at a
distant index cannot use it to forge — they get a rejection. Safe but
rigid. **Info.**

**19. `programs/agent-vault/src/contexts.rs:14-27` — `init` (not `init_if_needed`) for vault creation**

Good — no reinit attack. **Info (positive finding).**

**20. `programs/settlement/src/contexts.rs:10-92` — `CreateEscrow` PDA seeds `[b"escrow", client, provider, task_id]` allow collision by task_id reuse**

Client can reuse `task_id` only after the prior escrow is closed (via
`close_escrow`). That's gated on `Completed|Cancelled|Expired`
(`contexts.rs:468-471`), so reuse is legitimate. But the client can
`cancel_escrow` in `Created` state (`escrow.rs:306-356`), close, and
immediately recreate with the same task_id — which is fine but produces
event-stream ambiguity for indexers. **Info.**

### Summary (Audit 1)

Fix priority: **#1** (cross-agent reputation forgery via Settlement CPI)
and **#3** (SAS allowlist scope) are the two that compromise the protocol's
trust model as a whole. **#4** (stake-orphan + re-register) lets agents
bypass the Suspended state for ~0.001 SOL. **#2, #7, #11** are exploitable
but require specific operator conditions. Run `npm test` on the settlement
+ registry CPI bindings with a malicious `provider_profile` account after
fixing #1.

---

## Audit 2 — API/ABI Stability Review (pre-v0.1.0)

### `@agenomics/capability-manifest-validator`

**Export-surface hazards:**

- **`validate.ts:144-155` — High** — `src/index.ts` re-exports from
  `./validate.js`, and `validate.ts` itself re-exports from `./schema.js`
  and `./canonical.js`, so the same symbols are reachable via 3+ module
  paths plus 4 subpath entries. Consumers will pick arbitrary paths and
  any future reorg becomes breaking. **Rec:** drop the secondary subpath
  exports in `package.json` for v0.1.0; expose only `.`.
- **`canonical.ts:15 / canonical.ts:42` — High** — `canonicalJson` and
  `canonicalBytes` are public, which locks you into RFC-8785 via the
  `canonicalize` package forever (swapping to a faster impl that differs
  by even one edge case silently invalidates every published hash).
  **Rec:** keep only `manifestHash` public; demote
  `canonicalJson`/`canonicalBytes` to internal (or namespace as
  `unstable_canonicalJson`).
- **`schema.ts:21 / 29 / 38 / 41-46` — High** — `PreflightGate`,
  `SideEffect`, `Stability`, and `CostEstimate.unit`/`confidence` are
  closed `z.enum` unions. Adding a new preflight gate or side-effect
  becomes a breaking type change for every consumer doing exhaustive
  `switch`. **Rec:** document these as "open for v1"; either widen to
  `z.string()` with a known-list validator, or advertise in README that
  adding values is a minor bump and ship a typed "unknown" fallback now.
- **`validate.ts:16-20` — High** — `ValidationErrorCode` is a closed
  string-literal union of 4 values. Adding a 5th code (e.g. `EXPIRED`,
  `UNSUPPORTED_SCHEMA_URL` when v1.1 ships) breaks exhaustive matches.
  **Rec:** widen to `ValidationErrorCode | (string & {})` or publish as
  `const` object + `keyof typeof` with an explicit "extensible"
  disclaimer.
- **`schema.ts:87` — Info** — `$schema: z.literal(MANIFEST_SCHEMA_V1_URL)`
  is correct, but the constant is exported as `MANIFEST_SCHEMA_V1_URL`.
  Once on npm, renaming this is breaking. **Rec:** confirmed-intentional;
  fine as-is.
- **`schema.ts:113 / index.ts:17-23` — Low** — `CapabilityManifest` is
  inferred via `z.infer` from a Zod schema with `.readonly()`. Consumers
  that assign into it will see fresh `readonly` errors on any Zod upgrade
  that changes inference. **Rec:** explicitly export `type
  CapabilityManifest` with hand-written shape, not `z.infer`.

**Deps/side-effects:**

- **`package.json:44-49` — Info** — `canonicalize` has no public types
  that express "RFC-8785 compliance is a SemVer contract"; a
  `canonicalize` 3.x release could silently change output. **Rec:** pin
  `canonicalize` to exact `2.0.x` (not `^2.0.0`) before v0.1.0 goes out,
  OR add a hash-parity test against a checked-in golden vector.
- No module-level side effects observed. **Info** — Clean.

**Error shape:**

- **`validate.ts:22-30` — Low** — `ValidationError.details?: unknown`
  allows Zod's `parsed.error.issues` to leak into the public shape.
  Consumers will stabilize on that Zod type and block a Zod upgrade.
  **Rec:** document `details` as opaque/`unknown`, or narrow to a
  project-owned `{ path: string; message: string }[]` shape.

### `@agenomics/sas-resolver`

**Export-surface hazards:**

- **`index.ts:14-18` — Blocker** — `encodeBase58`, `base58Decode`,
  `base64Decode`, `base64Encode` are exported. These are implementation
  details of the RPC decoder; making them public binds you to their exact
  behavior (including the hand-rolled base58 in `resolver.ts:528-577`)
  forever. **Rec:** remove from `index.ts` before publishing; they are
  not needed by any consumer of the resolver.
- **`schema.ts:230 / 251 / index.ts:42-43` — Blocker** —
  `encodeReputationData` and `encodeAttestationAccount` are described in
  their own JSDoc as "only used in the test harness" yet are in the
  public surface. **Rec:** move to `test/fixtures.ts` or gate behind an
  `/internal` subpath; do not ship in `index.ts`.
- **`index.ts:44 / schema.ts:49,163` — High** — `ReputationDataFields`
  and `RawAttestationAccount` expose on-chain byte layout as type shapes.
  Any SAS account-format change (or migration to `sas-lib`) forces a
  breaking bump. **Rec:** drop these from public; the public contract is
  `AttestationReputation` only.
- **`index.ts:26 / cache.ts:69-80` — High** — `CacheMetrics` fields
  (`hits`/`misses`/`evictions`) are exposed as a closed object, and
  `resolver.ts:129` explicitly calls out ADR-065 §7 will add a per-layer
  breakdown. **Rec:** either add the per-layer fields now or widen to
  `CacheMetrics & Record<string, number>` so adding layer counters later
  is non-breaking.
- **`package.json:8-41` — High** — 8 subpath exports (`./resolver`,
  `./schema`, `./allowlist`, `./merge`, `./cache`, `./cache-redis`,
  `./types`, `.`) multiply the stable surface. Every file move becomes
  breaking. **Rec:** keep only `.` and `./cache-redis` (the latter only
  if documented as optional peer). Drop the rest for v0.1.0.
- **`cache.ts:359 / cache.ts:378` — High** — `createCache()` and
  `activeCacheBackend()` both default `env = process.env`. Reading
  `process.env` at call time is fine, but the signature locks the
  `AEP_REDIS_URL` convention publicly — any future env rename is
  breaking. **Rec:** confirm the env-var name is stable or flip the
  factory to a required `{ redisUrl?: string }` arg.
- **`types.ts:215` — Low** — `Result<T>` is re-invented
  (`capability-manifest-validator` also has `ValidationResult`). The two
  use different shapes (`{ ok, value }` vs `{ ok, manifest }`). **Rec:**
  alignment is a v1 concern, but flag that cross-package `Result` is
  already inconsistent.
- **`types.ts:201-205` — High** — `ResolverErrorCode` is a closed
  4-value union; `resolver.ts` already hints at more cases (cache errors,
  revocation, schema-URL mismatch). **Rec:** same as validator — widen or
  document as extensible.
- **`resolver.ts:482-493` — Info** — `AccountInfoResponse` is internal
  (not exported). Fine.

**Type extensibility:**

- **`types.ts:126-141` — High** — `AttestationReputation` is a closed
  interface. The ADR-061 spec foreshadows `AEP_AGENT_REPUTATION_v2`;
  adding fields like `attestation_version` later is additive in theory
  but consumers writing `satisfies AttestationReputation` will break.
  **Rec:** add `readonly version?: 1` discriminator now (even as a `1`
  literal) so v2 can be a discriminated union later without breaking v1.
- **`types.ts:174-194` — Low** — `ResolvedReputation` uses optional
  boolean flags (`absent`, `stale`) — extensible; OK.

**Side effects on import:**

- **`cache.ts:368 / cache-redis.ts:99` — Info** — Both use `require()`
  lazy-loading inside function bodies, not at module top level. No
  top-level env reads. Clean.
- **`resolver.ts:152` — Low** — Default `warn` binds `console.warn`.
  Stateless but means a consumer using structured logging sees
  uncontrolled `console.warn` until they wire `config.warn`. **Rec:** OK,
  document it.

**Dep surface:**

- **`package.json:62` — High** — `@solana/kit ^6.8.0` is a hard
  `dependency`. Consumers who already have `@solana/kit` at a different
  version will duplicate, and type identity for the `Rpc<SolanaRpcApi>`
  branded type breaks across copies (`types.ts:21`). **Rec:** move
  `@solana/kit` to `peerDependencies` with a matching range.
- **`package.json:60-63` — Info** — `@noble/curves` is declared but
  nothing in `src/` imports it (the resolver doesn't verify signatures —
  that's the validator's job). **Rec:** remove from `dependencies`.
- **`package.json:71-73` — Low** — `ioredis` as `optionalDependencies` is
  correct pattern but needs to be in `peerDependenciesMeta` too so
  downstream bundlers don't warn. **Rec:** add `peerDependenciesMeta:
  { ioredis: { optional: true } }`.
- **`package.json:66-69` — Low** — `ioredis-mock` is a dev dep —
  correct.

**Error shape:**

- **`types.ts:207-212` — Low** — `ResolverError.details?: unknown` same
  concern as validator; zod issues leak through (`resolver.ts:262`).
  **Rec:** narrow to a project-owned shape.
- No stack traces exposed. **Info** — Good.

**Semver hazards v0 → v1:**

- **Tightening priority before tag push — High** — Current public
  surface (both packages combined): ~35 symbols + 12 subpath entries. For
  a v1 candidate that'll be semver-locked, the minimum viable surface is
  closer to 8 symbols per package from `.` only. **Rec:** a single
  concentrated PR that (a) removes encoder/codec helpers from exports,
  (b) collapses subpath entries to `.`, (c) widens closed unions or
  documents them as extensible, (d) moves `@solana/kit` to peer. This is
  the cheapest pre-publish change; every hour after tag push it costs a
  major bump.

**Top 5 blockers before tag push:**

1. Drop `encodeBase58`/`base58Decode`/`base64*` from sas-resolver index
2. Drop `encodeReputationData`/`encodeAttestationAccount` from sas-resolver
   index
3. Move `@solana/kit` to peerDep
4. Collapse subpath exports to `.` in both packages
5. Widen or disclaim the closed enum/union types (`ValidationErrorCode`,
   `ResolverErrorCode`, `PreflightGate`, `SideEffect`)

---

## Audit 3 — Governance / Ops Gap Analysis

### BLOCKS MAINNET

**1. Upgrade authority still single-key on all 3 programs.**

Gap: Registry / Vault / Settlement upgrade authority is `BUdXA1Fi…jTXL`
(one hot key); multisig holds no real authority yet.
Cost: Key loss or compromise of that wallet = total protocol capture
(attacker can push a malicious upgrade that drains all vaults).
Fix: Transfer upgrade-auth to multisig PDA *only after* (a) devnet
multisig-signed upgrade rehearsal succeeds on one program, (b) rollback
keypair is sealed offline, (c) mainnet plan is written.

**2. ADR-063 is still "Proposed" and no 3-of-5 role slots 4-5 are named.**

Gap: §1.1 slots 4 (community-elected) and 5 (security researcher) have no
designated humans, no election procedure run, no auditor-co-signer
identified for §6 emergency path.
Cost: Mainnet ceremony §5 cannot close; emergency rotation §6 has no
auditor to co-sign — the "fast path" does not exist.
Fix: Drive ADR-063 to Accepted, publish the signer slate under
`docs/governance/signers.md` (referenced in §7 but not present), and
register an auditor contact with documented SLA before mainnet.

**3. External audit vendor not engaged (ADR-036).**

Gap: ADR-036 is Accepted but only specifies process; no vendor selected,
no contract signed, no `docs/AUDIT_SCOPE.md` actually submitted.
Cost: 6-9 week audit timeline + $40-80k not yet started = mainnet
realistically slips a full quarter past any "audit gates" language in
`mainnet-deploy.sh`.
Fix: Kick off auditor outreach this week; `mainnet-deploy.sh`'s
binary-hash-check line is inert until an audit report exists to compare
against.

**4. `mainnet-deploy.sh` safety gates are partly theatre.**

Gap: Script prints SHA-256 "verify against audit report" but does not
actually compare; `MULTISIG_ADDRESS` env unset triggers a prompt that lets
you proceed without transfer; no pre-deployment check that the multisig
PDA exists on mainnet.
Cost: Operator under pressure hits "y" on the skip-transfer prompt and
ships with single-key auth — same risk as gap #1 but post-mainnet, with
real funds.
Fix: Make `MULTISIG_ADDRESS` required (remove the skip prompt), add a
mandatory hash-match against a committed `AUDIT_REPORT_HASHES` file,
assert multisig account is live before deploy.

**5. `AEP_VALIDATORS` credential (ADR-061 §3, ADR-063 §1.2) has zero concrete work.**

Gap: 5-of-9 composition is specified; no member list, no election
procedure scripted, no bootstrap script analogous to
`bootstrap-sas-credential-devnet.ts`.
Cost: Mainnet launch with only `AEP_PROTOCOL` means the community-signal
half of the attestation story is vaporware — ADR-061 §3's
protocol/community split does not exist in practice.
Fix: Either ship `AEP_VALIDATORS` bootstrap before mainnet or publicly
defer it with a dated plan; do not silently launch mono-credential.

### BEFORE MAINNET

**6. No multisig-operated program-upgrade rehearsal on devnet.**

Gap: 2-of-3 Squads has executed two SAS ceremonies (credential + schema)
but never a `set-upgrade-authority`-like admin action or a real program
upgrade through the vault.
Cost: First time ever exercising that path is on mainnet with real funds
at stake — same class of failure that cost us signers 2/3 this session.
Fix: Transfer a throwaway devnet program's upgrade auth to the multisig
and execute a multisig-signed upgrade end-to-end before mainnet even plans
the transfer.

**7. End-to-end 2-of-3 flow never tested with an independent human signer.**

Gap: `bootstrap-sas-credential-devnet.ts` loads signer-1 and signer-2 from
local disk — same operator controls both approvals.
Cost: We have no evidence the flow works when signer 2 is a different
human on a different machine (UX, coordination, out-of-band
tx-serialization issues all untested).
Fix: Run one ceremony where signer 2 is on a second laptop/wallet and has
to independently approve; document pain points.

**8. Credential-compromise runbook (ADR-063 §6.1) not scripted.**

Gap: The spec says T+2h suspend, T+24h rotate, T+7d audit — no
`scripts/emergency-suspend-credential.ts`, no auditor contact list, no
transparency-log publisher, no retroactive-audit tooling.
Cost: 2 AM compromise response is ad-hoc while an attacker issues forged
attestations — the "0-day notice" path exists only on paper.
Fix: Script at minimum the suspend+rotate instructions; document auditor
escalation phone tree (can live in private repo).

**9. Transparency log (ADR-063 §7) has no publisher.**

Gap: Spec requires hourly JSON feed to
`governance/attestation-log/YYYY-MM/`; no worker exists.
Cost: > 24h publication gap is a declared transparency incident — if we
launch without the worker, we declare the incident on day 1.
Fix: Either build the hourly publisher or explicitly relax the spec in
ADR-063 before Accept.

**10. Signer-2/3 key-loss already happened once; devnet "throwaway" policy hides the real problem.**

Gap: `.keys/` is gitignored, not backed up, lost between sessions. Policy
works for devnet only because the multisig has no authority — the moment
it gains authority (even on devnet with real smoke-test funds) key-loss =
operational outage.
Cost: We will re-learn this on mainnet if the policy crosses over.
Already cost us one re-bootstrap cycle + an abandoned `6QUUP78…` PDA.
Fix: Define a bright-line trigger: "the day multisig touches upgrade
authority = keys move to hardware / KMS". Document now, not at the trigger
moment.

**11. No recovery procedure for signer-1 (`BUdXA1Fi…`) on devnet.**

Gap: Signer 1 is the operator's personal CLI wallet, single-copy at
`~/.config/solana/id.json`, no rotation plan in `SQUADS_DEVNET.md`.
Cost: That machine dying = loss of member-1 slot on devnet and loss of
current upgrade authority on all 3 programs simultaneously.
Fix: Back up signer-1 to cold storage now (independent of ADR-063 which
governs *mainnet* multisig rotation, not current operator hygiene).

**12. Missing ADRs cover real pre-mainnet surfaces.**

Gap: ADR-064 (resolver allowlist) is implemented but its ADR text is
referenced in ADR-063 §6.2 as the notification mechanism for authority
rotation; ADR-066 (on-chain-gov migration) and ADR-067 (cross-protocol
trust) are fine to defer; **ADR-045, 054, 055, 056 are referenced but not
present** — audit the reference graph to confirm none gate mainnet.
Cost: Shipping mainnet with unresolved cross-references = governance
hazards we haven't even catalogued.
Fix: One-hour audit of `grep -r "ADR-0[0-9]*"` vs. actual ADR files;
promote Proposed ADRs (063, 065) to Accepted.

### OPERATIONAL IMPROVEMENT

**13. Operator runbook in `SQUADS_DEVNET.md` is incomplete for non-authors.**

Gap: Doc shows how to propose but not: how to check the current proposal
queue, how to reject, how to cancel a stuck proposal, how to reconstruct
`nextIndex` if the script crashes mid-flow, what to do if confirm-retry
loop exhausts.
Cost: On-call operator without tribal knowledge can't unblock a stuck
ceremony at 2 AM.
Fix: Add a "common failure modes" section walking through the stages in
`proposeApproveExecute`.

**14. `scripts/.squads-devnet.json` and `.sas-devnet.json` are the only source of truth for PDAs and are local-filesystem.**

Gap: Yes they are committed, but loss of the file between commits (seen
once already this session with the abandoned PDA) causes re-bootstrap.
Cost: Each re-bootstrap burns rent and leaves inert on-chain dust; not
expensive but it's a signal that PDA discovery should be deterministic
from a committed seed, not a JSON file.
Fix: Either commit the `createKey` pubkey + re-derivation code, or accept
the file as the artifact and add CI check that it hasn't gone missing.

**15. Rollback plan in `mainnet-deploy.sh` is pseudocode.**

Gap: Final echo says "saved in deployment log" / "rebuild from pre-deploy
commit SHA" — no actual deployment log file gets written, no
pre-deploy-hash file is emitted.
Cost: During incident response, "check the deployment log" returns
nothing.
Fix: Have the script `tee` pre-deploy hashes + commit SHA to
`logs/mainnet-deploy-<timestamp>.log` automatically.

**16. Program-upgrade multisig ≠ SAS-authority multisig assumption (ADR-063 §6.2) is undocumented operationally.**

Gap: §6.2 relies on "structurally a different key set in practice" —
today both are `BUdXA1Fi…`-rooted. The separation only exists once
ADR-063 mainnet ceremony runs.
Cost: Emergency authority-recovery path §6.2 silently doesn't work if
the two multisigs overlap.
Fix: When building the mainnet multisig, verify and document non-overlap;
add CI assertion that pubkey sets are disjoint.

### INFO

**17. TS packages gated on SAS bootstrap round-trip — acceptable, not a gap.** `v0.1.0` publish-hold is correctly risk-driven per STATUS §5.

**18. ADR-062 / 066 / 067 properly deferred.** Not governance-critical pre-mainnet.

---

## Synthesis — triaged punch-list

### 🔴 Block the next v0.1.0 publish tag-push

One pre-publish tightening PR on both packages (~150 LOC across
`package.json` + `index.ts` files):

1. Drop 6 test-helpers from `sas-resolver/index.ts`
   (`encodeBase58`/`base58Decode`/`base64Decode`/`base64Encode`/`encodeReputationData`/`encodeAttestationAccount`)
2. Collapse subpath exports to `.` in both packages
3. Move `@solana/kit` from dependency → peerDependency in sas-resolver
4. Add `readonly version?: 1` discriminator to `AttestationReputation`
5. Widen/disclaim closed enums (`ValidationErrorCode`, `ResolverErrorCode`,
   `PreflightGate`, `SideEffect`, `Stability`)

Also: pin `canonicalize@2.0.x` exactly; add a golden-vector hash test;
remove unused `@noble/curves` dep from sas-resolver.

### 🔴 Critical security — must fix before downstream trust decisions

Two paired PRs, one coherent "reputation trust-boundary hardening" track:

- **SEC-1**: bind `agent_profile` to `escrow.provider` in the Registry's
  `UpdateReputation` context (requires program upgrade — hence ties to
  GOV-6 rehearsal).
- **SEC-3**: per-credential signer allowlist + schema↔credential binding
  in `sas-resolver`; update ADR-061 §3 / ADR-063 to publish which
  credentials may attest under which schemas.

### 🟠 High-severity bypasses

- **SEC-4**: `deregister_agent` must drain `reputation-stake` PDA or
  refuse while staked.
- **SEC-2**: `vault.agent_identity` needs a rotation path or must be
  registry-owned.
- **SEC-7**: `dispute_resolver = None` should route exclusively to
  `resolve_dispute_timeout`.
- **SEC-5**: rate-limit counter must increment AFTER all validation, not
  before.
- **SEC-11**: bound `protocol_config.reputation_delta_dispute_loss` to
  `>= -1_000_000`; use `checked_neg()`.

### 🔴 Block mainnet

- **GOV-1**: transfer upgrade-auth to multisig after rehearsal (GOV-6)
  + rollback keypair sealed offline.
- **GOV-2**: drive ADR-063 to Accepted; publish signer slate; register
  auditor contact.
- **GOV-3**: engage external audit vendor (6-9 weeks, ~$40-80k).
- **GOV-4**: harden `mainnet-deploy.sh` (required multisig, real hash
  check).
- **GOV-5**: ship or publicly defer `AEP_VALIDATORS` credential.

### Cross-cutting patterns all three reports pointed at

1. **Self-referential PDA seeds** — appears in SEC-1, SEC-6. Pattern
   worth auditing everywhere.
2. **Single-operator assumption** — every multisig script runs with both
   signers local. GOV-7 + GOV-10 + the signer-loss we already hit show
   the 2-of-3 flow is unexercised with a real second human.
3. **Test-helpers leaking into public surface** (API finding) +
   **hardcoded SAS discriminator** (SEC-14 info) — symptoms of the
   ADR-064 resolver being written alongside its tests without a clean
   boundary.

### Recommended next 3 actions

1. **Before tag push** — one tightening PR (the 5-item list above).
2. **Before v0.1.0 is used in any downstream trust decision** — paired
   SEC-1 + SEC-3 track.
3. **Before mainnet planning gets concrete** — devnet multisig-signed
   program-upgrade rehearsal with a real second human on signer-2
   (closes GOV-6 + GOV-7 at once).
