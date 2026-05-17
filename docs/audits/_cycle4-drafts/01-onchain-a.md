# Cycle-4 Security Audit — ONCHAIN A

**Scope:** `programs/agent-registry/` + `programs/agent-vault/` (Anchor/Solana)
**Branch:** `audit-baseline` (origin/main `b8fe80b`)
**Lens:** account/authority model, PDA seed/canonical-bump safety, signer/has_one/constraint,
CPI privilege boundaries, integer over/underflow, reinit/close, rent/lamport, ADR-139
portable-reputation trust root, ADR-111 vault-delegation grant authority.
**Prior cycle-3 onchain punchlist:** DRAINED — focus on ADR-139/111 deltas.
**Mode:** READ-ONLY. No code edits/commits.

---

## Severity counts

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 1 |
| MED      | 2 |
| LOW      | 3 |

---

## Findings

### HIGH-1 — ADR-138 provenance attestation missing on the two ADR-111 value-moving grant surfaces

- **Program::instruction:** `agent_vault::execute_grant_transfer`,
  `agent_vault::execute_grant_token_transfer`
- **File:line:** `programs/agent-vault/src/instructions.rs:1515` (SOL grant) and
  `programs/agent-vault/src/instructions.rs:1668` (SPL grant) — both emit only
  `DelegationGrantExecuted`, never `ExecutionAttested`.
- **Declared invariant violated:** ADR-138 §Decision (lines 51-52): *"Add an
  `ExecutionAttested` event emitted at the end of **every value-moving** or
  authority-changing instruction in the agent-vault program."* ADR-138 §Coexistence
  (lines 182-187) explicitly states the ADR-111 grant instructions **will** emit
  `ExecutionAttested` with `delegation_grant = Some(grant_pubkey)`. The
  `ActionKind::GrantTransfer` / `GrantTokenTransfer` enum variants
  (`programs/agent-vault/src/events.rs:101,104`) and the `delegation_grant:
  Option<Pubkey>` field (`events.rs:146`) were reserved *specifically* for this
  surface and are still dead.
- **Evidence of design intent vs. impl gap:** Every other value-moving path emits
  `ExecutionAttested` — `execute_transfer` (`instructions.rs:733`),
  `execute_token_transfer` (`:926`); even non-value-moving `pause_vault` (`:962`)
  and `resume_vault` (`:996`) emit it. The grant transfer paths, which move real
  SOL/SPL value signed by a sub-authority hot key, are the *only* value-moving
  instructions with no provenance attestation.
- **Exploit scenario:** A compromised or malicious grantee drains a vault up to the
  grant cap via `execute_grant_transfer` / `execute_grant_token_transfer`. The
  off-chain provenance pipeline (indexer `execution_attestations` table, ADR-139
  reputation-attestor cross-checks, SAS correlation per ADR-138 §Coexistence
  lines 189-193) keys on `ExecutionAttested`. Grant-authorised drains are invisible
  to every `ExecutionAttested`-driven detector, monitor, and `(vault, slot)`
  event-ID join — exactly the "grant-authorised action is invisible to provenance"
  gap ADR-138 §Context lines 38-39 was written to close. `DelegationGrantExecuted`
  is a separate event with a different schema not consumed by the ADR-138
  provenance model; the two are not interchangeable for detection.
- **Fix:** Emit `ExecutionAttested` at the end of both grant execute handlers
  (after the value move / CPI, mirroring the post-move ordering in
  `execute_transfer`:733 so a rollback drops the attestation atomically), with
  `action_kind: ActionKind::GrantTransfer` / `GrantTokenTransfer`,
  `delegation_grant: Some(ctx.accounts.grant.key())`, `manifest_hash` from
  `manifest_hash_from_profile(&ctx.accounts.agent_profile)` (the account is already
  in both contexts — `contexts.rs:535,583`), `policy_version` from the vault, and
  the moved `amount`/`mint`/`recipient`.
- **Remediation ADR required:** No — this is an implementation gap against an
  already-Accepted ADR (ADR-138 + ADR-111 §Coexistence). A code fix realigns the
  impl to the declared invariant; no decision needs revisiting.

---

### MED-1 — Grant `agent_profile` suspension-gate account has no authority cross-binding (defense-in-depth gap; address-validation analog of the seed MED finding)

- **Program::instruction:** `agent_vault::create_delegation_grant`,
  `execute_grant_transfer`, `execute_grant_token_transfer`
- **File:line:** `programs/agent-vault/src/contexts.rs:386-395` (Create),
  `:526-535` (ExecuteGrantTransfer), `:574-583` (ExecuteGrantTokenTransfer)
- **Detail:** The cross-program `agent_profile` (deserialized
  `Account<AgentProfile>` under `agent_registry::ID`) is bound *only* by
  `seeds = [vault.authority/authority.key(), b"agent-profile",
  vault.profile_nonce.to_le_bytes()]` with a non-cached `bump` (auto canonical).
  Unlike the registry's own contexts, there is **no** `has_one = authority` or
  `constraint = agent_profile.authority == vault.authority`. The direct-transfer
  contexts (`ExecuteTransfer`:231-240, `ExecuteTokenTransfer`:281-290) have the
  same shape. This is the on-chain analog of the noted offchain MED "Solana
  address validation gaps" (`vault.ts`): an untrusted/derived pubkey
  (`vault.profile_nonce`, a stored `u64`) feeds a PDA seed that is then trusted
  for an authorization decision (`require_not_suspended`) with no field-level
  reconciliation.
- **Why currently NOT exploitable (verified):** The seed derivation is keyed on
  `vault.authority` (itself authenticated by the `b"vault"` PDA seeds +
  `vault.bump`) and `vault.profile_nonce` is set *only* from the Registry's
  authoritative `OwnerNonce` PDA at `initialize_vault` (`instructions.rs:145`,
  AUD-008 fix) — never caller-supplied. Anchor's `seeds::program` +
  discriminator + owner checks on `Account<AgentProfile>` reject any account
  that is not the canonically-derived profile PDA. So the binding holds today.
- **Residual risk:** The invariant "`agent_profile.authority == vault.authority`"
  is enforced *transitively* (via two independent seed derivations sharing
  `vault.authority`), not *directly*. If a future change loosens the vault seed
  (`ADR-093` self-referential pattern), changes how `profile_nonce` is sourced,
  or a deregister/re-register cycle (ADR-097 nonce bump) leaves
  `vault.profile_nonce` stale relative to the live profile, the suspension gate
  could resolve to a non-existent or wrong-incarnation profile and fail
  open/closed unpredictably. The ADR-097 stale-`profile_nonce` interaction is
  explicitly *not* reconciled on-chain after a registry deregister.
- **Exploit scenario (conditional):** Authority deregisters the agent in Registry
  (OwnerNonce bumps, old profile PDA closed) but the vault retains the old
  `profile_nonce`. Subsequent `execute_grant_*` derives a profile PDA at the old
  nonce that no longer exists → `AccountNotInitialized` (fails closed, DoS on the
  grantee) rather than re-deriving against the live profile. A re-register at the
  new nonce is never re-bound to the vault, permanently bricking grant execution
  for that vault with no recovery instruction.
- **Fix:** Add an explicit `constraint = agent_profile.authority ==
  vault.authority @ VaultError::Unauthorized` to the three grant contexts (and
  the two direct-transfer contexts) so the authorization-relevant field is
  reconciled directly, not only transitively. Separately, consider a
  vault-side `resync_profile_nonce` (reads live `OwnerNonce`, ADR-097) so a
  legitimate deregister/re-register does not permanently brick the vault.
- **Remediation ADR required:** Yes — small ADR (or ADR-111b/ADR-095 addendum)
  to (a) mandate the direct authority cross-constraint on every cross-program
  `agent_profile` consumer, and (b) decide the deregister/re-register ↔ vault
  `profile_nonce` resync policy. This is a cross-program-coupling invariant
  decision, not a pure bug.

---

### MED-2 — ADR-111 §Enforcement "intersect `allowed_recipients` with vault `program_allowlist`" not implemented for grant SOL transfers

- **Program::instruction:** `agent_vault::execute_grant_transfer`
- **File:line:** `programs/agent-vault/src/instructions.rs:1428-1449`
- **Declared invariant:** ADR-111 §Enforcement (lines 124-126): *"MUST intersect
  `allowed_recipients` with the base vault `policy.program_allowlist` — the
  delegation never widens the vault's own allowlist (ADR-024 / ADR-072 guards
  still apply)."*
- **Detail:** `execute_grant_transfer` checks `grant.is_recipient_allowed(...)`
  and the vault per-tx/daily/rate gates, but never evaluates
  `vault.policy.is_program_allowed(...)` / `is_token_allowed(...)` against the
  recipient. The SPL path (`execute_grant_token_transfer`:1570-1573) *does* keep
  `vault.policy.is_token_allowed(&mint)`, so the SOL path is the asymmetric gap.
  For native SOL there is no mint, but the ADR's stated intent is that a grant
  must never reach a recipient class the vault's own policy would reject; the
  current SOL grant path delegates the recipient decision entirely to the grant's
  own `allowed_recipients` (which may be the empty "any recipient" sentinel —
  `state.rs:335-337`), so an empty-recipient grant on a vault with a restrictive
  policy can move SOL to recipients the vault-direct path would still gate.
- **Exploit scenario:** Vault authority issues a broad grant with empty
  `allowed_recipients` (the documented "delegate to vault guards" sentinel).
  Because the SOL grant path performs no vault-level recipient/program-allowlist
  intersection, the grantee can send SOL to any recipient — wider than the
  vault's own `program_allowlist` would permit on a comparable direct call,
  contradicting "the delegation never widens the vault's own allowlist."
- **Fix:** In `execute_grant_transfer`, when `grant.allowed_recipients` is empty,
  fall back to the vault-level recipient/program allowlist check (mirror the
  `is_token_allowed` retention in the SPL path) so the empty-sentinel genuinely
  means "subject to the vault's own guards" rather than "unrestricted."
- **Remediation ADR required:** No — straight ADR-111 §Enforcement conformance
  fix. (If the team decides native-SOL has no meaningful program-allowlist
  semantics and the ADR text is aspirational, then an ADR clarification instead.)

---

### LOW-1 — `revoke_delegation_grant` accepts any past `grantor` while comment claims rotation-awareness

- **Program::instruction:** `agent_vault::revoke_delegation_grant`
- **File:line:** `programs/agent-vault/src/instructions.rs:1216-1221`
- **Detail:** Revocation accepts `signer == grant.grantee || grant.grantor ||
  vault.authority`. `grant.grantor` is pinned at create time. There is no
  authority rotation today (`update_agent_identity` rotates `agent_identity`, not
  `authority`), so `grantor == vault.authority` always. The triple-OR is
  harmless now but the inline comment asserts it "stays correct under future
  rotation" — if authority rotation is ever added, a *former* authority
  (`grant.grantor`) could still revoke grants on a vault it no longer controls.
  Pre-document this as a known follow-up so a future rotation feature doesn't
  silently inherit it.
- **Exploit scenario:** None today (no authority rotation path exists). Latent
  if/when authority rotation lands.
- **Fix:** Drop `grant.grantor` from the accept-set, or gate it behind an
  explicit "rotation not yet supported" assertion, so a future rotation feature
  must consciously decide former-grantor revocation rights.
- **Remediation ADR required:** No (latent; revisit with any authority-rotation ADR).

---

### LOW-2 — Grant SOL execute uses direct lamport mutation; relies on Phase-2 ordering discipline

- **Program::instruction:** `agent_vault::execute_grant_transfer`
- **File:line:** `programs/agent-vault/src/instructions.rs:1488-1500`
- **Detail:** SOL is moved via `try_borrow_mut_lamports()` direct edits (same
  pattern as `execute_transfer`:695-699; valid because the vault PDA is
  program-owned). The rent-exempt floor check (`:1495`) and `checked_sub`/`
  checked_add` are present and correct. The risk is purely structural: all
  validation is hoisted into the pre-borrow block (`:1422-1485`) and the
  comment-enforced ordering is the only thing preventing a future refactor from
  reintroducing the SEC-5-class "counter mutated before a later failing check"
  hazard that ADR-071 fixed for the token path. No fuzz target pins the grant
  path ordering (ADR-111 §Invariants references a `delegation_grant_policy` fuzz
  target — confirm it asserts handler-faithful order incl. the lamport phase).
- **Exploit scenario:** None at current code; latent refactor hazard.
- **Fix:** Add a property to the `delegation_grant_policy` fuzz target pinning
  the validate-before-mutate order for the SOL grant path (priority list ADR-111
  §"Invariants enforced on every execute_grant_*" steps 1-12).
- **Remediation ADR required:** No (test-coverage hardening).

---

### LOW-3 — ADR-139 trust-root on-chain invariants: VERIFIED sound, one documentation gap

- **Program::instruction:** `agent_registry` (trust-root surface for the
  off-chain ADR-139 attestor)
- **Detail:** ADR-139 declares "No on-chain program change is required" and makes
  the off-chain verifier depend on three monotone on-chain invariants
  (ADR-139 §"Optional on-chain cross-check", lines 133-143):
  1. `slash_count` non-decreasing — VERIFIED: only written via
     `reputation_stake.slash_count.saturating_add(1)`
     (`agent-registry/src/lib.rs:393-394`); never reset (the AUD-004 fix made it
     cumulative; `clear_suspension` explicitly does NOT reset it,
     `lib.rs:541-542`). `migrate_agent_profile` only ratchets it *up* to 3
     (`lib.rs:765-769`). Monotone — holds.
  2. `registration_nonce` non-decreasing — VERIFIED: stamped from `OwnerNonce`
     at register (`lib.rs:141`); `deregister_agent` only `saturating_add`s the
     nonce (`lib.rs:613`). A new incarnation always has a higher nonce. Holds.
  3. `authority` exact match — VERIFIED: `has_one = authority` /
     `constraint = agent_profile.authority == owner.key()` on every mutation
     context; `authority` is set once at register (`lib.rs:83`) and never
     reassigned by any instruction. Holds.
- **Residual:** The `reputation_score` clamp window note (ADR-094/AUD-112,
  `lib.rs:298-309`): a pre-migration profile can still carry a legacy
  `reputation_score > 100` until the first post-migration call self-heals it.
  ADR-139's snapshot schema copies `reputation_score` verbatim; an attestor that
  snapshots an unmigrated profile emits an out-of-policy score (>100). ADR-139
  §"Snapshot semantics" rule 3 deliberately excludes `reputation_score` from the
  on-chain cross-check, so this does not break verification, but the ADR-139
  reference issuer SHOULD clamp on read (`min(score, 100)`) exactly as
  `propose_reputation_delta` does — confirm `packages/reputation-attestor/`
  applies this (offchain scope; flagged here as the on-chain ↔ attestor seam).
- **Exploit scenario:** None on-chain. The trust root is sound; the only gap is a
  documentation/clamp expectation at the off-chain attestor boundary.
- **Fix:** None on-chain. Cross-reference for the offchain auditor:
  verify `packages/reputation-attestor/` clamps `reputation_score` on read for
  unmigrated profiles.
- **Remediation ADR required:** No.

---

## ≤250-word summary

**Counts:** CRITICAL 0 · HIGH 1 · MED 2 · LOW 3.

Cycle-3's onchain punchlist is confirmed drained; no regressions in the
cycle-1/2/3 fixed surfaces (AUD-001/002/004/006/008/100-122/200-206 spot-checked
and intact). The ADR-139 portable-reputation trust root is **sound on-chain**:
all three monotone invariants the off-chain verifier depends on
(`slash_count` cumulative, `registration_nonce` monotone, `authority` immutable)
are correctly enforced (LOW-3).

**Top 3 findings:**

1. **HIGH-1** — `execute_grant_transfer` / `execute_grant_token_transfer`
   (ADR-111's two value-moving surfaces) emit only `DelegationGrantExecuted`,
   never `ExecutionAttested`. ADR-138 §Decision mandates the provenance event on
   every value-moving instruction and explicitly reserved the
   `GrantTransfer`/`GrantTokenTransfer` `ActionKind`s and `delegation_grant`
   field for exactly this. Grant-authorised drains are invisible to every
   provenance/SAS/reputation detector — the precise gap ADR-138 exists to close.
2. **MED-1** — Cross-program `agent_profile` suspension-gate accounts (grant +
   direct transfer contexts) have no `agent_profile.authority == vault.authority`
   cross-constraint; binding is transitive via shared seeds only. Not exploitable
   today (AUD-008 nonce sourcing holds) but brittle, and a deregister/re-register
   cycle can permanently brick grant execution with no recovery ix.
3. **MED-2** — `execute_grant_transfer` omits the ADR-111 §Enforcement
   "intersect grant recipients with vault `program_allowlist`" step (SPL path
   keeps the token allowlist; SOL path does not), so an empty-recipient grant can
   widen the vault's own recipient policy.

HIGH-1 and MED-2 are impl-vs-Accepted-ADR conformance fixes (no new ADR). MED-1
and the deregister/resync question need a small ADR-111b/ADR-095 addendum.
