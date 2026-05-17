# Cycle-4 Security Audit — ONCHAIN B (settlement + cctp-hook)

Repo: `/home/neo/dev/projects/protocol` · branch `audit-baseline` (origin/main b8fe80b)
Scope: `programs/settlement/`, `programs/cctp-hook/` · Read-only.
Method: settlement escrow fund-flow, ProtocolConfig authority/bootstrap, CCTP-hook ↔ Settlement CPI trust boundary, ADR-138 attestation scope, account-closing / fund-drain vectors. Cycle-3 onchain punchlist confirmed drained; this pass targets settlement/cctp deltas + cross-program CPI trust.

Severity counts: CRITICAL 1 · HIGH 3 · MEDIUM 4 · LOW 3 · INFO 2

---

## CRITICAL

### C4-OB-01 — CCTP hook does not bind `escrow_token_account` / `provider_token_account` to the escrow it approves (fund mis-route via CPI account substitution)
- **Program::ix**: `cctp_hook::auto_approve_milestone` → CPI `settlement::approve_milestone`
- **File:line**: `programs/cctp-hook/src/lib.rs:399-409` (account decls), `:257-275` (CPI account list); contrast `programs/settlement/src/contexts.rs:153-165`
- **Detail**: In `AutoApproveMilestone`, `escrow_token_account` and `provider_token_account` are bare `UncheckedAccount` with NO constraints (`lib.rs:401-409`, comments literally say "validated by Settlement"). The hook forwards them positionally into the raw `approve_milestone` CPI (`lib.rs:260-261`). Settlement's `ApproveMilestone` *does* constrain `escrow_token_account.owner == escrow.key()` and `provider_token_account.owner == escrow.provider` (`contexts.rs:155-164`), so a wrong-mint/owner account is rejected there. **However**, the hook's own attestation event `MilestoneAutoApproved` (`lib.rs:295-301`) and the `ReplayRecord` (`lib.rs:227-233`) are written *before* `invoke_signed` and commit `amount_returned_micros` from the *payload* — an attacker-influenced field never reconciled against the milestone amount Settlement actually releases (payload.rs:54-59 explicitly says "this field does not authorize a different number", but the on-chain replay/audit record stores it as if authoritative). The escrow-client gate (`lib.rs:170-173`, `escrow_client == hook_signer`) is the only real authorization; combined with the absence of any `provider_token_account` ↔ `escrow.provider` *pre-CPI* check in the hook, a caller who controls the `payer` (any signer — the hook "does not authorize off this signer's identity", `lib.rs:314-318`) can drive auto-approval of *any* escrow whose `client` is the derived `hook_signer(agent_authority)` for an `agent_authority` whose Registry profile carries a `Some(cdp_wallet)` matching a payload value the same caller supplies. The CDP-binding check (`lib.rs:214-217`) compares `bound_wallet == payload.cdp_recipient` where BOTH the on-chain bound wallet read and the payload are effectively chosen by the relayer fallback (payload.rs:36-37: "the field is supplied by the relayer fallback as the agent's CDP wallet bytes"). Net: there is no cross-chain attestation actually verified on-chain — no CCTP message, no Circle attestation, no nonce, no Base burn proof is checked. `base_tx_hash` is only required `!= [0u8;32]` (`lib.rs:126-129`) and used solely as a replay-PDA seed; any 32 non-zero bytes pass.
- **Exploit**: Relayer (or anyone able to submit the tx) calls `auto_approve_milestone` with a fabricated `ReflexHookPayload` (`base_tx_hash` = arbitrary non-zero, `cdp_recipient` = the value already bound on the target profile, `amount_returned_micros` = 1) for a real, funded escrow whose `client` is a `hook_signer` PDA. No actual CCTP burn/mint on Base need ever have occurred. Settlement's `approve_milestone` releases the milestone amount to `provider_token_account`. Because the hook signs as the escrow `client` via `hook_signer` seeds, the milestone is approved with zero client consent and zero proof that USDC was returned cross-chain. Repeat per milestone (distinct `base_tx_hash` defeats the replay PDA).
- **Fix**: The hook must verify cross-chain authenticity, not just shape. Minimum: (a) consume Circle's CCTP V2 `MessageTransmitter`/attestation account (or the receiver's mint-confirmation PDA) and bind `base_tx_hash` + `amount_returned_micros` to that on-chain artifact; (b) constrain `escrow_token_account`/`provider_token_account` with `token::mint`/`owner` in the hook context (defense-in-depth, do not rely solely on the callee); (c) reconcile `payload.amount_returned_micros` against the milestone amount read from escrow data before writing the `ReplayRecord`; (d) restrict the `payer`/dispatcher to the canonical CCTP receiver program via `address`/CPI-caller check rather than "any signer". Until (a) lands the program must not be deployed to a fund-bearing cluster.
- **ADR-needed?**: Yes — the spec defers CCTP authenticity to "Surface 4 owner" (Q-S3-A/Q-S3-G, `lib.rs:11-12,90-93`); an ADR must pin the on-chain attestation source and freeze IC-4 before mainnet. Cross-reference the missing settlement/cctp ADR (only ADR-002/007/074 exist for settlement; no CCTP ADR present in `docs/adr/`).

---

## HIGH

### C4-OB-02 — `close_escrow` is a no-op; terminal escrow can be closed while its token account still holds funds
- **Program::ix**: `settlement::close_escrow`
- **File:line**: `programs/settlement/src/instructions/escrow.rs:741-743`; context `programs/settlement/src/contexts.rs:689-703`
- **Detail**: `close_escrow` body is `Ok(())`; the only effect is Anchor's `close = client` (`contexts.rs:696`) reclaiming the `TaskEscrow` PDA rent. The context does **not** include `escrow_token_account`, so closing does not assert the escrow ATA balance is zero. Terminal states are `Completed | Cancelled | Expired` (`contexts.rs:697-700`). `resolve_dispute` settles `total_refund == remaining` and `resolve_dispute_timeout` sends `remaining`, so the *expected* invariant is "ATA drained before terminal". But `expire_escrow`'s `client_refund = remaining - provider_earned` only moves `provider_earned + client_refund` (escrow.rs:558-634); any token dust transferred *directly* to the escrow ATA by a third party after creation is never swept. More importantly, once the `TaskEscrow` PDA is closed, the escrow ATA (authority = the now-closed escrow PDA) becomes permanently unreachable — `approve_milestone`/`cancel_*`/`expire_escrow` all require the `escrow` account to deserialize as `TaskEscrow`, which fails post-close. Any residual balance is frozen forever (the PDA can be re-init under the same seeds via `create_escrow` with the same `task_id`, but a fresh `escrow_token_account` `init` will fail because the ATA already exists, bricking re-use of that `(client,provider,task_id)` triple).
- **Exploit**: Griefer transfers 1 lamport-worth of the mint into a target escrow's ATA before/around settlement; victim calls `close_escrow`; residual is permanently locked and the `(client,provider,task_id)` escrow slot is bricked for re-creation (DoS on a deterministic escrow address; relevant where `task_id` is externally meaningful, e.g. the CCTP session escrow).
- **Fix**: In `close_escrow`, include `escrow_token_account` and either (a) `require!(escrow_token_account.amount == 0)` or (b) sweep residual to `client` then `close` the ATA, then close the PDA. Add the ATA `close_account` CPI so rent + dust are reclaimed.
- **ADR-needed?**: No — bug fix within ADR-002 constraint discipline.

### C4-OB-03 — `expire_escrow` is permissionless and slashes provider reputation with no provider-side grace beyond the per-milestone window
- **Program::ix**: `settlement::expire_escrow`
- **File:line**: `programs/settlement/src/instructions/escrow.rs:520-543,636,706-723`; context `contexts.rs:541-543` (`payer: Signer` only)
- **Detail**: `ExpireEscrow` has no authorization constraint — any signer is `payer` (`contexts.rs:541-543`). The ADR-102 grace gate (`escrow.rs:536-543`) only blocks expiry while a *Submitted* milestone is inside its window; a milestone the provider never `submit_milestone`'d (`grace_ends_at == 0`) offers no protection. `should_slash = prior_status == Active && has_pending` (`escrow.rs:636`) then fires `reputation_delta_expiry_undelivered` against the provider. A provider who accepted in good faith but whose `submit_milestone` tx is censored/delayed past `deadline` (note `submit_milestone` requires `now <= deadline`, `escrow.rs:178`) is permissionlessly slashable by the *client* the instant `now > deadline`. This is the inverse of the C1 stall-attack the codebase already hardened against — the symmetric client-side grief is only partially mitigated.
- **Exploit**: Client sets a tight `deadline`, withholds nothing, and at `deadline+1` calls `expire_escrow` (or front-runs the provider's late `submit_milestone`); provider eats the undelivered slash and the client recovers the full unreleased balance. Censoring a single `submit_milestone` for one block suffices because `submit_milestone` hard-rejects `now > deadline`.
- **Fix**: Either (a) extend the grace concept to a protocol-level minimum execution window after `accept_task` independent of per-milestone submission, or (b) gate the *slash* (not the refund) behind a short post-deadline challenge window during which the provider can still submit. At minimum document the asymmetry as accepted risk with the rationale, mirroring the AUD-121 worst-case-window note in `state.rs:56-67`.
- **ADR-needed?**: Yes — slash-fairness policy is an economic-integrity decision; warrants an ADR analogous to ADR-102.

### C4-OB-04 — Settlement → Registry reputation CPI not gated on ADR-095/097 suspension state at the Settlement boundary
- **Program::ix**: `settlement::approve_milestone` / `resolve_dispute` / `resolve_dispute_timeout` / `expire_escrow` → `agent_registry::propose_reputation_delta`
- **File:line**: `programs/settlement/src/instructions/cpi.rs:58-90`; call sites `escrow.rs:303-312,689-698,713-722`, `dispute.rs:147-156,242-251`
- **Detail**: `update_provider_reputation` (`cpi.rs:58-90`) clamps the i64 governance delta into i16 and invokes the Registry. Settlement re-derives `provider_owner_nonce`/`provider_profile` (AUD-117 defense-in-depth, `contexts.rs:196-221`) but performs **no** check that the provider profile is not Registry-suspended (ADR-095/097, referenced in ADR-138 `:244` as "registry suspension gate"). Whether suspension is honored depends entirely on the Registry's `propose_reputation_delta` enforcing it on the callee side. If the Registry's suspension gate is only enforced on other instructions, Settlement can mutate a suspended provider's reputation. This is a cross-program trust assumption that is asserted nowhere on the Settlement side and not covered by the cycle-3 punchlist (which was Registry-internal).
- **Exploit**: If Registry `propose_reputation_delta` omits the suspension check (out of scope to confirm here — ONCHAIN-A territory), a suspended provider keeps accruing `+task_completed` via Settlement, defeating ADR-095/097. Even if Registry enforces it today, the Settlement side has no compile-time or runtime pin (unlike the AUD-202/AUD-104 layout pins) so a Registry refactor silently re-opens it.
- **Fix**: Add a Settlement-side defense-in-depth read of the provider profile's suspension flag before the reputation CPI, or a compile-time symbol/test pin (mirroring `test_cpi_propose_reputation_delta_symbol_exists`, `lib.rs:287-290`) asserting the Registry CPI struct still carries the suspension-enforcing account. Flag for ONCHAIN-A cross-check of the Registry callee.
- **ADR-needed?**: No if Registry enforces it (document the cross-program invariant); ADR/cross-team note if the boundary is genuinely unguarded.

---

## MEDIUM

### C4-OB-05 — Hook reads `TaskEscrow.client` from raw offset 8 with no discriminator check
- **Program::ix**: `cctp_hook::auto_approve_milestone`
- **File:line**: `programs/cctp-hook/src/lib.rs:95-97,141-151`
- **Detail**: `TASK_ESCROW_CLIENT_OFFSET = 8` and the handler `copy_from_slice(&escrow_data[8..40])` after only `escrow_data.len() >= 40` (`lib.rs:142-145`). Ownership is pinned (`owner = SETTLEMENT_PROGRAM_ID`, `contexts.rs:395-398`) but the 8-byte Anchor discriminator is never verified to be `TaskEscrow`'s. Any Settlement-owned account ≥40 bytes whose bytes [8..40] form a pubkey passes the hook's `escrow_client` gate; final safety rests entirely on Settlement's `approve_milestone` deserializing it as `TaskEscrow`. A Settlement account-type confusion or a future second account type of compatible size weakens this. Brittle hard-coded offset with no `#[repr]`/layout pin like `state.rs:222-231` has for `ProtocolConfig`.
- **Exploit**: Limited today (Settlement callee rejects non-`TaskEscrow`), but the hook's pre-CPI authorization decision is made on unauthenticated bytes; combine with C4-OB-01 for the full chain.
- **Fix**: Verify `escrow_data[0..8] == TaskEscrow` discriminator (Anchor `[u8;8]` of `sha256("account:TaskEscrow")`) before trusting offset 8, with a build-time pin like `state.rs`'s `const _: ()`.
- **ADR-needed?**: No.

### C4-OB-06 — `resolve_dispute_timeout` always slashes even when prior milestones were delivered
- **Program::ix**: `settlement::resolve_dispute_timeout`
- **File:line**: `programs/settlement/src/instructions/dispute.rs:170-262` (esp. 242-251)
- **Detail**: The timeout path refunds the *entire* `remaining` to the client (`dispute.rs:187-221`) and unconditionally applies `reputation_delta_dispute_loss` (`dispute.rs:242-251`) regardless of how many milestones the provider had legitimately delivered before the dispute. A provider who completed 4/5 milestones (paid via `released_amount`, kept) but is disputed on the 5th and the resolver never acts gets the same slash as a total non-deliverer, and the *client* recovers the 5th milestone's funds even if work was delivered. Asymmetric with `expire_escrow`'s C1 "silence = acceptance" logic which auto-pays Submitted work; the timeout path has no such reconciliation.
- **Exploit**: Client disputes the final milestone, lets the (governance-controlled, up to 365-day) timeout elapse, recovers the unreleased balance and slashes the provider — a profitable variant of the C1 stall attack on the dispute rail rather than the expiry rail.
- **Fix**: Apply the same Submitted-milestone auto-pay reconciliation `expire_escrow` uses before refunding `remaining` on timeout; only slash when at least one milestone is genuinely Pending.
- **ADR-needed?**: Yes — parity with C1/ADR-030 economic model; the timeout path was not brought into the C1 fix.

### C4-OB-07 — `update_protocol_config` authority rotation has no two-step / non-zero guard
- **Program::ix**: `settlement::update_protocol_config`
- **File:line**: `programs/settlement/src/instructions/protocol_config.rs:57-122`; context `contexts.rs:674-685`
- **Detail**: The instruction validates the five tunables but the `authority` field itself is never mutated here, and `has_one = authority` (`contexts.rs:680`) is the only gate. ADR-005/Finding-19 design says authority is rotated "to any key" (`state.rs:155-158`) — but there is no `update_authority` instruction in scope and no nominate/accept two-step. Combined with C4-OB-08, a single fat-finger or compromised key is unrecoverable: there is no recovery path because `initialize_protocol_config` is `init`-once and bound to the (possibly different / lost) upgrade authority.
- **Exploit**: Operational — loss/compromise of the config authority permanently freezes the protocol's economic tunables at their last value with no on-chain recovery.
- **Fix**: Add a two-step authority rotation (nominate + accept) and document the recovery story; or bind config authority to the upgrade authority for emergency re-init.
- **ADR-needed?**: Yes — governance lifecycle; extends ADR-005.

### C4-OB-08 — Devnet ProtocolConfig uninitialized: every escrow instruction is bricked, init gated to a key that may not be the deployer
- **Program::ix**: `settlement::initialize_protocol_config` / all escrow ix
- **File:line**: `programs/settlement/src/contexts.rs:640-670` (init context), `:96-100` (every escrow ctx requires `protocol_config`)
- **Detail**: `CreateEscrow`/`ApproveMilestone`/`ExpireEscrow`/etc. all require the `ProtocolConfig` PDA with `bump = protocol_config.bump` (`contexts.rs:96-100,237-241,617-623`), which fails if the account does not exist. Per project memory the devnet PDA is uninitialized and only the `8vj7tB…` upgrade authority can run the one-shot bootstrap (the `program_data.upgrade_authority_address == Some(payer.key())` constraint, `contexts.rs:664-665`). The init-authority gating logic itself is **correct and well-tested** (AUD-005 tests, `protocol_config.rs:151-210`, including the finalized-program `None` foot-gun). The finding is the *operational coupling*: there is no fallback, no governance multisig at init, and the entire program is non-functional until exactly one specific key acts; a finalized (immutable) program can never have its config initialized at all (`protocol_config.rs:190-198` proves the predicate rejects every payer when `upgrade_authority == None`).
- **Exploit**: Not an attacker exploit — a liveness/availability cliff. If the upgrade authority key is lost before `initialize_protocol_config` runs, the deployed Settlement program is permanently unusable (no escrow can ever be created).
- **Fix**: Document the deploy runbook ordering (init MUST precede finalize and any escrow), and consider allowing a governance multisig as an alternative init payer, or emit a clear health-check.
- **ADR-needed?**: No (ADR-005 covers the design); add a deploy-runbook doc + ADR-005 operational addendum.

---

## LOW

### C4-OB-09 — `cancel_active_escrow` provider co-signer is not `mut`-checked for token ownership; full balance to client only
- **File:line**: `programs/settlement/src/instructions/escrow.rs:454-518`; context `contexts.rs:505-538`
- **Detail**: Correctly dual-signed (AUD-201). Minor: refunds the entire unreleased balance to `client` with no provider split path; a provider who delivered Submitted-but-unapproved work must rely on the client's good faith to first `approve_milestone`. Acceptable by design (mutual consent) but the provider has no on-chain leverage — worth a doc note that providers should approve-then-rescind, not rescind blind.
- **ADR-needed?**: No.

### C4-OB-10 — `raise_dispute` allows either party with no minimum-progress / anti-spam gate
- **File:line**: `programs/settlement/src/instructions/dispute.rs:10-45`; context `contexts.rs:262-273`
- **Detail**: Either client or provider can flip `Active → Disputed` at any time (grace gate only blocks Submitted-in-window). No bond, no rate limit. A provider can dispute immediately on `accept_task` to lock funds into the (up to 365-day) dispute timeout window as a grief. Bounded by the timeout cap (state.rs:46) but still a 1-tx DoS on the client's capital for the configured window.
- **ADR-needed?**: Consider — dispute-bond design; low priority.

### C4-OB-11 — Hook `ReplayRecord` stores attacker-supplied `amount_returned_micros` as audit truth
- **File:line**: `programs/cctp-hook/src/lib.rs:227-233`; `payload.rs:54-59`
- **Detail**: `replay.amount_returned_micros = payload.amount_returned_micros` is persisted and emitted (`lib.rs:299`) as if authoritative, while payload.rs:54-59 admits it "does not authorize a different number". Off-chain dashboards keying on this event get an unauthenticated number. Subsumed by C4-OB-01 but flagged separately for the indexer/observability surface.
- **ADR-needed?**: No (folds into C4-OB-01 fix).

---

## INFO

### C4-OB-12 — ADR-138 `ExecutionAttested` is correctly scoped to agent-vault only; settlement/cctp emit no attestation and none is required
- ADR-138 (`docs/adr/ADR-138-execution-provenance-attestations.md:51-53,240-244`) binds the event to `programs/agent-vault` instructions exclusively. Settlement/cctp-hook are out of scope; their event surfaces (`settlement/src/events.rs`, `cctp-hook/src/events.rs`) are unaffected. **No ADR-138 attestation-emission integrity defect exists in this scope** — the replay/spoofing rows in ADR-138 §"Threat model" (`:173-176`) apply to the vault program. Confirmed: the cycle-3 onchain punchlist is drained and ADR-138 introduces no settlement/cctp regression.

### C4-OB-13 — Strong existing hardening confirmed (no regression)
- C1/C2/C3 economic fixes, AUD-009/105 deadline gating, AUD-024 deadline cap, AUD-201 mutual rescission, AUD-117/202/203/104 cross-program layout & seeds pins, SEC-1/7/8/11 + AUD-102 governance bounds are all present, internally consistent, and well-tested in `lib.rs` unit/proptest suites. The `escrow` PDA signer-seeds are correctly reconstructed at every transfer site. No signer-privilege-escalation found *within* Settlement. The CPI i16 clamp + governance ±10 bound (`cpi.rs:84-87`, `protocol_config.rs:81-110`) correctly prevent the `i64::MIN` negation panic (SEC-11).

---

## Cross-program CPI trust summary

The Settlement-internal surface is mature and well-defended. **The exploitable trust gap is the CCTP-hook → Settlement boundary (C4-OB-01):** the hook performs zero on-chain verification of the cross-chain CCTP message/attestation/nonce — `base_tx_hash` is a shape-only sentinel used as a replay-PDA seed, and the only real authorization is `escrow.client == hook_signer`. The hook can be driven by *any* signer (by design, per spec, "trust anchor is the CCTP-attestation guarantee that already gated the mint" — but that guarantee is asserted nowhere on-chain). This is the canonical "trusting an off-chain proxy" anti-pattern the protocol elsewhere explicitly rejects (ADR-138 context, `:30-33`). Must not deploy cctp-hook to a fund-bearing cluster until a real CCTP attestation account is consumed and bound.
