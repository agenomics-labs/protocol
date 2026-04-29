# On-chain audit — cycle 3 (2026-04-27)

## Metadata

- **Audit cycle**: 3
- **Domain**: on-chain (Anchor / SBF programs — agent-registry, agent-vault, settlement)
- **Audit date**: 2026-04-27
- **Summary written**: 2026-04-29
- **HEAD at summary**: 37f0acc
- **Scope**: programs/agent-registry/, programs/agent-vault/, programs/settlement/
- **Prior cycle**: docs/audits/ARCHITECTURE-AUDIT-2026-04-26-onchain.md
- **Methodology**: hostile re-audit of post-cycle-2 closures (AUD-100/101/102/104/117) plus
  fresh threat-modelling against ADR-124 (vault identity binding), ADR-097 (owner-nonce),
  ADR-115 (protocol-authority rotation), and the AUD-104 discriminator-gate boundary
- **Punchlist**: docs/audits/CYCLE-3-ONCHAIN-PUNCHLIST.md

## TL;DR

The cycle-3 on-chain hostile re-audit confirmed five cycle-2 closures still hold at HEAD
(AUD-100/101/102/104/117) but surfaced one Critical mainnet blocker — AUD-200, an
asymmetric-coverage gap where ADR-124's init-side proof-of-control over `agent_identity`
was never extended to the rotation surface. Two High-severity follow-ups (AUD-201
stuck-Active escrow refund gap; AUD-202 missing field-order pin behind the AUD-104
discriminator gate) plus four Medium / Low / Calibration findings (AUD-203/204/205/206)
were filed alongside it. Cycle-2's mainnet-promotion verdict was explicitly REVOKED
pending AUD-200 closure. As of this summary, all seven findings are closed or accepted:
two via direct code fixes (AUD-200 / AUD-201 / AUD-202 / AUD-203 / AUD-206), one via an
explicit deferral ADR (AUD-204 → ADR-125 Accepted), and one via a calibration ADR (AUD-205
→ ADR-131 Accepted). Mainnet-promotion gate is cleared from the on-chain domain.

## Verdict

Cycle 2's on-chain posture was structurally sound for its stated scope (init flows,
discriminator-name gating, settlement → registry seed parity), but the cycle-3 hostile
re-audit demonstrated that ADR closures need to be challenged on the **mutation/rotation
surface**, not just the init surface — this is the AUD-200 lesson and now the standing
ADR-governance theme to carry forward (see "Architecture themes" below). Of the seven
fresh findings, six were closed in-tree and one (AUD-204) was accepted as a deliberate
post-launch deferral with a written ADR (ADR-125) so the decision is auditable rather than
silently parked. Three commits on `main` (`4c2341c`, `9daf07f`, `e59072a`) close the
launch-blocking subset; the remainder land in the docs-only or test-only path.

Phase posture: **mainnet-promotion gate cleared** from the on-chain domain. The remaining
launch-window dependencies sit in the off-chain and MCP domains (see companion summary
docs).

## Verified cycle-2 closures held

| ID | State | Evidence |
|---|---|---|
| AUD-100 | Held | Slash path live: `programs/agent-registry/src/lib.rs:354-376` increments `slash_count` on `reason in {1,2}`; writes `Suspended` at `>= 3`. Self-suspend blocked at `lib.rs:182-186`. |
| AUD-101 | Held | `MigrateAgentProfile` carries `owner_nonce: Account<OwnerNonce>` with full 3-component seeds (`programs/agent-registry/src/contexts.rs:417-458`); E2E coverage at `tests/agent-registry.ts:1694+`. |
| AUD-102 | Held | `MIN_REPUTATION_DELTA = -10`, `MAX_REPUTATION_DELTA = 10` at `programs/settlement/src/state.rs:101,109`; `update_protocol_config` enforces both bounds. |
| AUD-104 | Held | Discriminator gate at `programs/agent-registry/src/lib.rs:797-800`; field-order layout caveat (the cycle-2 follow-up note) is now closed via AUD-202. |
| AUD-117 | Held | All four settlement contexts carry `provider_authority` + `provider_owner_nonce` PDA + `provider_profile` PDA with `seeds::program = AGENT_REGISTRY_PROGRAM_ID`. Test case E (`ResolveDisputeTimeout`) blocked on bankrun migration (target 2026-05-10); asymmetric-coverage gap closed via AUD-203's mechanical-identity unit tests. |

## Per-finding closure status

### Critical — AUD-200: rotation lacks proof-of-control over new `agent_identity`

| Field | Detail |
|---|---|
| **Severity** | Critical (mainnet blocker) |
| **Surface** | `programs/agent-vault/src/instructions.rs:203-242`; `programs/agent-vault/src/contexts.rs:120-130` |
| **Original concern** | The cycle-1 AUD-115 + ADR-124 work closed proof-of-control over `agent_identity` at `initialize_vault` (Ed25519 precompile signature over a domain-separated message), but the symmetric mutation surface — `update_agent_identity` — accepted the new `agent_identity` argument with no equivalent precompile binding. A compromised or coerced authority could rotate to an attacker-held key after the 24h cooldown and then drain the vault via the daily-cap path. The rotation rate-limit was the only gate. |
| **Closure mechanism** | Symmetric closure of the init-leg fix. `UpdateAgentIdentity` context now carries `instructions_sysvar`; `update_agent_identity` handler accepts `new_agent_identity_signature: [u8; 64]` and calls `identity_bind::verify_ed25519_precompile` over `vault_identity_bind_message(authority, new_agent_identity)` BEFORE the rotation rate-limit check. Mirrors `initialize_vault`'s call chain at `instructions.rs:98-102` exactly. Four new test cases (happy path + three rejection paths: wrong-message, missing precompile ix, precompile-pubkey vs handler-arg mismatch). MCP `rotate_agent_identity` handler bundles the Ed25519 precompile ix; SDK consumers receive the new shape via IDL regen. |
| **Closure SHA** | `4c2341c` |
| **Tests** | Anchor full integration suite: 160 passing post-fix |
| **Follow-up** | None outstanding. Lesson "ADR closures must demonstrate symmetric init+mutation coverage" promoted to standing ADR-governance theme (carried in cycle-3 architecture themes below; pinned in user memory). |

### High — AUD-201: stuck-Active escrow refund gap

| Field | Detail |
|---|---|
| **Severity** | High (block next release) |
| **Surface** | `programs/settlement/src/instructions/escrow.rs:360-410` |
| **Original concern** | Provider accepts an escrow then abandons it; the only refund path was `expire_escrow` after the 365-day deadline, and with a dispute timeout the worst-case lock window stretched to up to 730 days. `cancel_escrow` was `Created`-only. The hostile re-audit framed this as "client funds locked for two years against a non-responsive provider, with no consensual exit." |
| **Closure mechanism** | New `cancel_active_escrow` instruction adds the only `Active → Cancelled` lifecycle edge, gated on **both** `client` and `provider` signing in the same transaction (Anchor `Signer<'info>` on both fields + `has_one = client` AND `has_one = provider`). Refunds the unreleased balance (`total_amount - released_amount`) to the client; already-approved milestone payouts stay with the provider; no reputation slash (consensual unwind is not non-delivery, mirroring the design distinction in ADR-025 / ADR-030). Status precondition `escrow.status == Active` hoisted to the Account-level constraint per AUD-019 pattern. Strict-superset safety: no party loses any prior right; the adversarial case (one side refuses to sign) falls back unchanged to `expire_escrow` / dispute paths. |
| **Why option 1** | Option 2 (provider-inactivity timeout) would require a new "last-status" timestamp, an additional governance-tunable timeout, and create a new attack surface against providers mid-execution who haven't yet `submit_milestone`'d. Option 3 (reduce Active deadline) doesn't close the gap — only shrinks it — while breaking the wall-clock contract `create_escrow` returns to clients. Mutual rescission was the only strict-superset option. |
| **Closure SHA** | `9daf07f` |
| **Tests** | 7 new Rust unit tests in `programs/settlement/src/lib.rs` (status predicate; refund-is-unreleased; full-total-when-zero-released; zero-refund safe path; no-CPI invariant; terminal-status pin; dual-signer truth table; 730-day pre-fix arithmetic guard). 3 new Anchor integration tests in `tests/settlement.ts` (happy path with mid-task M0-approved + mutual cancel; rejection on `Created` status via hoisted constraint; rejection on missing provider signer — single-sig drain attempt stays Active with vault intact). IDL regen committed. Anchor full integration suite: 163 passing. |
| **Follow-up** | None. |

### High — AUD-202: missing field-order pin behind AUD-104 discriminator gate

| Field | Detail |
|---|---|
| **Severity** | High (block next release) |
| **Surface** | `programs/agent-registry/src/lib.rs:773-798`; tests `lib.rs:2079-2135` |
| **Original concern** | AUD-104's closure pinned the `ProtocolConfig` discriminator name but NOT the field-order layout. If Settlement prepended a field to `ProtocolConfig`, the discriminator would stay unchanged (it's derived from the type name) but `authority` would shift past on-wire offset 8 — Registry would read the prepended field's bytes as `config_authority`, the comparison would fail silently, and every legitimate sweep would be rejected. A hostile downstream change to Settlement could DoS the sweep authority without tripping any compile-time or runtime guard. |
| **Closure mechanism** | Build-time pin in Settlement (option 1 over a Registry-side runtime check): `#[repr(C)]` on `ProtocolConfig` plus `const _: () = assert!(core::mem::offset_of!(ProtocolConfig, authority) == 0, ...)` in `programs/settlement/src/state.rs`. `offset_of!` (stable Rust 1.77) and const `assert!` (1.79) are both well below the workspace's `stable` toolchain (1.95), so no new dependency was needed (`static_assertions` was deliberately not added). Registry's `verify_protocol_invariants` doc-comment now references the upstream pin. |
| **Why build-time over runtime** | A const-assert fails at `cargo build`, blocking the deploy artifact from ever existing in a drifted state. A runtime check would only catch the drift on the first sweep attempt — by which time the program is already deployed and operators are debugging a live failure. |
| **Closure SHA** | `e59072a` |
| **Tests** | Belt-and-braces: 2 in `settlement::state::layout_pin` (Anchor `try_serialize` round-trip asserting `authority` lands at on-wire offset 8; simulated prepended-field scenario proves the gate's `[8..40]` read would surface garbage), 2 in `agent_registry::tests` (intact-layout buffer matches signer; drifted-layout buffer with discriminator-unchanged + prepended u64 + shifted authority fails the `config_authority == signer.key()` check). On-wire IDL surface unchanged (only doc-string additions + `repr: { kind: "c" }` annotation). `anchor build` clean; `cargo test`: settlement 65 passed (+2 new), agent-registry 88 passed (+2 new). |
| **Follow-up** | None. The const-assert is its own regression guard. |

### Medium — AUD-203: AUD-117 case E asymmetric coverage

| Field | Detail |
|---|---|
| **Severity** | Medium (next-cycle) |
| **Surface** | `tests/cpi-failures.test.ts:1255` |
| **Original concern** | AUD-117's closure was tested for three of the four settlement contexts (`ApproveMilestone`, `ResolveDispute`, `ExpireEscrow`); case E (`ResolveDisputeTimeout` substitution) was intentionally untested per a `BANKRUN-TODO` skip-comment because the 7-day governance timeout requires bankrun's clock-warp helper. The defense-in-depth claim was therefore asymmetric — only 3 of 4 contexts had negative-path proof. |
| **Closure mechanism** | Asymmetric-coverage closure via mechanical-identity proof (option 1 over option 2's documentation-only hardening). Anchor `#[derive(Accounts)]` is a proc-macro that does not preserve runtime AST access, so the parity test compares source text via `include_str!("contexts.rs")` — fails at `cargo test` BEFORE build if any of the four AUD-117-touched contexts drift from byte-identity on their `provider_owner_nonce` and `provider_profile` `#[account(...)]` blocks. New module `programs/settlement/src/contexts.rs::aud_117_seeds_parity` adds 3 unit tests: (1) parity of `provider_owner_nonce` constraints across all 4 contexts, (2) parity of `provider_profile` constraints, (3) reference-block token check pinning the seed-component identifiers. |
| **Why mechanical-identity over documentation-hardening** | Option 2 closes the *finding* but adds zero defensive surface — a regression in `ResolveDisputeTimeout`'s seeds block would still ship if the TS test stays skipped. Option 1's mechanical-identity proof actually defends case E: any drift in source fails `cargo test`, which fails `anchor build`'s test gate, which blocks the deploy. |
| **Closure SHA** | `3e8a724` |
| **Tests** | `cargo test -p settlement --lib` 65 → 68 (3 new in `contexts::aud_117_seeds_parity`, 0 changed). No IDL surface changes (test-only module gated by `#[cfg(test)]`). |
| **Follow-up** | The skip-rationale at `tests/cpi-failures.test.ts:1255` was strengthened to (a) cite the bankrun routine ID `trig_01NokXSDGAb7ECabM5n9ULR3` (target 2026-05-10), (b) carry a `BANKRUN-TODO(...)` marker so the migration has a hook to flip the skip to active, (c) point readers to the parity tests as the interim coverage. |

### Medium (deferred) — AUD-204: ADR-125 rotate-protocol-config-authority deferred to post-launch

| Field | Detail |
|---|---|
| **Severity** | Medium (next-cycle); status: deferred, not closed by code change |
| **Surface** | `programs/settlement/src/instructions/protocol_config.rs:18`; `docs/adr/ADR-125-rotate-protocol-config-authority.md` |
| **Original concern** | ADR-125 (`rotate_protocol_config_authority`) was `Proposed` and explicitly deferred to post-launch. `ProtocolConfig.authority` is operationally entangled with the BPF upgrade authority forever post-init; a wrong-bind at `initialize_protocol_config` has zero recovery short of redeploy at a new program ID. |
| **Closure mechanism (deferral)** | ADR-125 was promoted to **Accepted** as the auditable record that the AUD-115 path-(b) rotation instruction was considered for the launch window and explicitly deferred. Three load-bearing facts (per ADR-125 Decision §): (1) post-A2 the upgrade authority IS the Squads multisig PDA, so the original "rotate away from a weak key" use case has collapsed — there is no stronger key to rotate to; (2) Squads-internal membership/threshold mutation already covers normal-operation governance changes without changing the on-chain PDA (`docs/PROTOCOL_AUTHORITY_OPERATIONS.md` §4 rows 3-4); (3) adding a new on-chain governance surface during the launch window is high-risk per ADR-080 §H Alt-D's tested-rejection-path principle, at roughly the ADR-124 cost (~37 tests across 4 surfaces) for a non-compromise-defending change. |
| **Post-launch shape** | Option β (2-step propose-then-accept), per ADR-125 §"Options Considered". Future-cycle implementer inherits the design, does not re-litigate α/β/γ. |
| **Closure SHA** | `b2c4f86` (ADR-125 Accepted) |
| **Launch-window recovery posture** | The `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` §4 failure-modes table rows for `initialize_protocol_config` mis-bind (deployer-keypair signed instead of multisig; typo'd multisig PDA signed) remain redeploy-only at a new program ID until β ships; the §3 pre-bind operator checklist is the only mitigation in the launch window. |
| **Follow-up** | Re-open in the first post-launch governance cycle per ADR-125's accepted scope. |

### Architecture (calibration) — AUD-205: sybil-cost economics

| Field | Detail |
|---|---|
| **Severity** | Architecture / calibration (not a bug) |
| **Surface** | `programs/agent-registry/src/lib.rs:21,358`; `state.rs:83-85` |
| **Original concern** | With `|delta| ≤ 10` and `slash_count ≥ 3` for `Suspended`, a sybil agent can absorb 3 dispute losses (~score 85) before suspension. Per-agent slash cost amortizes below per-task escrow value if escrow > 3R + 3L (R = rent, L = per-loss opportunity cost). ADR-097 owner-nonce raises authority-reuse cost; new authorities cost nothing. |
| **Closure mechanism (calibration)** | ADR-131 (`docs/adr/ADR-131-sybil-cost-calibration.md`, Status: Accepted) is the auditable record that the launch parameters (`MAX_DELTA_PER_CALL = 10`, `SUSPEND_AT_SLASH_COUNT = 3`, no minimum-stake-at-registration, ADR-028 + ADR-097 economic / PDA-uniqueness defenses) were considered against AUD-205's `escrow > 3R + 3L` inequality and explicitly held at their current values for the launch window. |
| **Threat-model boundary (per ADR-131)** | Defends single-pair low-value sybil attempts at protocol-floor escrow values (`MIN_ESCROW_AMOUNT = 0.01 USDC`) and reputation-laundering via close-then-reopen on the same authority (ADR-097 nonce makes the post-close PDA address non-reusable). Does NOT defend capitalized sybil attackers transacting at high per-task escrow values, where `R ≈ 0.011 SOL` per-identity-rent dominates the right-hand side and any `E` two orders of magnitude above `R` flips the inequality into the attacker's favor. |
| **Levers enumerated for post-launch** | Lower `MAX_DELTA_PER_CALL`; raise `SUSPEND_AT_SLASH_COUNT` (with paired `assert_valid_profile` invariant update + migration cost); add minimum-stake-at-registration bond; tie escrow size to required reputation/stake; make the constants governance-tunable via `ProtocolConfig`. Each lever's cost is priced in the ADR; none are pulled today. |
| **Re-calibration triggers (per ADR-131)** | Re-open this ADR when ANY of (a) observed sybil-pattern incidents on mainnet exceed 5/qtr year-1 / 10/qtr year-2+, (b) median escrow value sustains above 1 SOL on a 30-day rolling average, (c) a funded sybil incident is forensically reconstructed where `E > 3R + 3L` was reachable, (d) a new dispute-resolution surface lands that emits `reason in {1, 2}` from a code path other than `resolve_dispute` / `expire_escrow`. |
| **Closure SHA** | `9c4fe78` (ADR-131 Accepted) |
| **Follow-up** | Calibration finding — closure is the Accepted ADR itself, not a code change. Re-litigation gated on the trigger conditions. |

### Low — AUD-206: `propose_reputation_delta` accepts calls on Retired profiles

| Field | Detail |
|---|---|
| **Severity** | Low (paper-cut — indexer-noise vector, no invariant break) |
| **Surface** | `programs/agent-registry/src/lib.rs:296-392` |
| **Original concern** | `propose_reputation_delta` had no entry-guard for `status == Retired`; `slash_count` could increment forever on a closed-state agent and emit phantom events into the indexer. No invariant break (the agent is already terminal), but it filled indexer noise and weakened the "Retired is terminal" claim from `update_status`. |
| **Closure mechanism** | Handler-entry guard (option 1 — direct `require!` at function head, mirroring AUD-004 self-suspend's reject-closed-states-at-entry pattern). New `require!(profile.status != Retired, ProfileRetired)` placed right after `let agent_profile = &mut ctx.accounts.agent_profile`, before the slash branch and the `assert_valid_profile` post-check. New error variant `AgentRegistryError::ProfileRetired` appended after AUD-108's `InvalidReputationReason` (code 6028 → 6029); IDL surfaces in `idl/agent_registry.json` and `sdk/idl/src/idl/agent_registry.json` regenerated cleanly. Combined with the existing `update_status` transition table, Retired is now a true terminal state for both status writes AND reputation/slash writes. |
| **Why no TS-direct-call rejection test** | The `settlement_authority` PDA signer constraint on `ProposeReputationDelta` (`contexts.rs:317-323`) is unreachable from a TS-only client (only the Settlement program can `invoke_signed` it); a TS direct call rejects at the signer boundary BEFORE reaching the handler body — same shape as AUD-108's boundary tests. The Rust unit tests are the regression coverage for handler-body semantics; the TS test pins the IDL surface for SDK consumers. |
| **Defense-in-depth** | A future Settlement upgrade that calls `propose_reputation_delta` on a Retired profile would now fail at the new guard rather than emit a phantom event. |
| **Closure SHA** | `2a2520f` |
| **Tests** | 2 new Rust unit tests in `programs/agent-registry/src/lib.rs::tests` (`aud_206_active_paused_suspended_pass_terminal_guard` + `aud_206_retired_profile_rejected_at_handler_entry`); 1 new TS IDL test pinning the new error variant's code (6029), name, and AUD-206 message substring. `cargo test -p agent-registry --lib` 88 → 90 (2 new, 0 changed); `anchor build` + `scripts/sync-idl.sh` clean. |
| **Follow-up** | None. |

## Architecture themes (carry to ADR governance)

1. **Symmetric init+mutation coverage requirement.** The AUD-200 → ADR-124 lesson is now a
   standing rule: any ADR closure that defends an init flow against a threat must also
   demonstrate the same threat is closed on the corresponding mutation / rotation /
   replace surface. Cycle-3's hostile re-audit specifically targeted this pattern and
   surfaced AUD-200 within minutes by checking for `instructions_sysvar` symmetry between
   `initialize_vault` and `update_agent_identity`. Carry this as the first thing the next
   cycle's auditor checks against any ADR-124-class closure.

2. **Calibration findings should land as auditable named decisions.** AUD-205 was not a
   bug — it was a tunable constant whose chosen value depends on threat-model assumptions
   that may shift over the protocol's lifetime. Rather than silently tuning the constant,
   ADR-131 captures the analysis (the `E > 3R + 3L` inequality), the assumptions (low-value
   single-pair sybil), the levers (5 enumerated), and the re-calibration triggers
   (4 explicit conditions). Future cycles can re-open ADR-131 against fresh telemetry
   without re-deriving the math.

3. **Build-time invariants beat runtime invariants for layout pins.** AUD-202 chose
   `const _: () = assert!(offset_of!(...) == ...)` over a runtime check in Registry's
   `verify_protocol_invariants`. The const-assert fails at `cargo build` — the deploy
   artifact for a drifted Settlement literally cannot exist. A runtime check would only
   catch the drift on the first sweep attempt, post-deploy, with operators already
   debugging a live failure. Prefer the build-time variant whenever the language permits.

4. **Deferral is a first-class closure mechanism when written down.** AUD-204 closes
   without a code change because ADR-125 is now Accepted with the post-launch shape
   pinned (option β, 2-step propose-then-accept) and the launch-window recovery posture
   explicitly documented (redeploy-only). The auditable artifact is the ADR; the absence
   of code is the decision. This pattern keeps the audit trail honest while preserving
   launch-window scope discipline.

## Closure verdict

All 7 cycle-3 on-chain findings are closed or accepted:

| ID | Severity | Closure | SHA |
|---|---|---|---|
| AUD-200 | Critical | Code (rotation precompile binding) | `4c2341c` |
| AUD-201 | High | Code (`cancel_active_escrow`) | `9daf07f` |
| AUD-202 | High | Code (build-time field-order pin) | `e59072a` |
| AUD-203 | Medium | Code (mechanical-identity parity tests) | `3e8a724` |
| AUD-204 | Medium | Deferred via ADR-125 Accepted | `b2c4f86` |
| AUD-205 | Calibration | Accepted via ADR-131 | `9c4fe78` |
| AUD-206 | Low | Code (Retired-state entry guard) | `2a2520f` |

**Mainnet-promotion gate cleared from the on-chain domain.** The cycle-2 promotion verdict
that was REVOKED on AUD-200 disclosure is reinstated as of `4c2341c` and reaffirmed
through `2a2520f`. Remaining launch-window dependencies sit in the off-chain (relay /
indexer) and MCP+SDK+EVO domains; see companion summary docs for those domains.

## Discrepancies between punchlist and code state

None observed. Each closure footnote in `CYCLE-3-ONCHAIN-PUNCHLIST.md` references a SHA
reachable from `main`, and the SHAs match the entries in `git log f0efc00^..HEAD` plus
the immediately preceding closure batch (`4c2341c`, `9daf07f`, `e59072a`, `3e8a724`,
`b2c4f86`, `9c4fe78`, `2a2520f` — all on `main`). No drift between the punchlist's
asserted closure state and the tree at HEAD `37f0acc`.

## References

- **Punchlist**: `docs/audits/CYCLE-3-ONCHAIN-PUNCHLIST.md`
- **Cycle-2 baseline**: `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-onchain.md`
- **Companion summaries**: `docs/audits/ARCHITECTURE-AUDIT-2026-04-27-cycle3-offchain.md`, `docs/audits/ARCHITECTURE-AUDIT-2026-04-27-cycle3-mcp.md`
- **ADRs referenced**:
  - ADR-025 / ADR-030 (escrow lifecycle and dispute design)
  - ADR-028 (per-agent economic floor)
  - ADR-080 (governance-surface design principles)
  - ADR-097 (owner-nonce / PDA-uniqueness defense)
  - ADR-115 / ADR-124 (vault identity binding init-leg)
  - ADR-125 (rotate-protocol-config-authority — Accepted, deferred)
  - ADR-131 (sybil-cost calibration — Accepted)
- **Closure commits on `main`**:
  - `4c2341c` — AUD-200 (rotation Ed25519 proof-of-control)
  - `9daf07f` — AUD-201 (mutual-rescission `cancel_active_escrow`)
  - `e59072a` — AUD-202 (Settlement-side build-time field-order pin)
  - `3e8a724` — AUD-203 (mechanical-identity parity tests)
  - `b2c4f86` — AUD-204 (ADR-125 Accepted)
  - `9c4fe78` — AUD-205 (ADR-131 Accepted)
  - `2a2520f` — AUD-206 (Retired-state entry guard)
- **Operator runbook**: `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` §3 pre-bind checklist; §4 failure-modes table (referenced for AUD-204 launch-window recovery posture)
