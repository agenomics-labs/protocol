# Appendix — On-chain Security Audit (2026-04-25)

**Source**: `security-auditor` sub-agent run, 2026-04-25
**Scope**: `programs/agent-vault`, `programs/agent-registry`, `programs/settlement` (full source)
**Method**: full-read of all three programs + 8–10 load-bearing ADRs (001, 007, 014, 028, 050, 068, 069, 074, 075, 080, 094, 097)
**Master IDs**: AUD-001, AUD-002, AUD-004, AUD-005, AUD-006..AUD-010, AUD-018..AUD-024, AUD-032..AUD-036, AUD-044..AUD-046, AUD-065..AUD-074

## Executive summary

The three programs show real iterative hardening (ADRs 068/072/093/094/095/097/102) and the unit-test suite documents historical mitigations. That said, the current `main` branch ships several **Critical** bugs that survive the existing tests because the tests exercise the older code path. Most acute:

1. `ProposeReputationDelta`'s `agent_profile` PDA seeds **do not** include the registration nonce while every other context does — making the new ADR-094 instruction either dead-on-arrival or, after the seed-mismatch is "fixed" naively, cross-account writeable.
2. The live Settlement→Registry CPI still uses the legacy unbounded `update_reputation`, defeating ADR-094's whole point.
3. An `init_if_needed` `OwnerNonce` permits any holder of an authority key to recreate a profile after suspension and reset slash_count to 0 (ADR-097 sealed only the close-then-reopen variant).
4. `update_status` lets a user voluntarily set their own profile to `Suspended`, then escape via `clear_suspension` for half their score — Sybil-friendly laundering of bad reputation.

Lower-severity issues include rate-limit-window arithmetic that compares signed/unsigned, a CPI helper that emits `ReputationUpdateScheduled` for a synchronous CPI (audit-trail noise), and the empty-allowlist "allow-all" semantics still unfixed (ADR-073 track, deferred).

## Detailed findings

| # | Severity | Location (file:line) | Issue | Recommendation | Master ID |
|---|---|---|---|---|---|
| F1 | **Critical** | `programs/agent-registry/src/contexts.rs:307-313` | `ProposeReputationDelta.agent_profile` uses seeds `[authority, b"agent-profile"]` — missing the `owner_nonce.nonce` component every other context (RegisterAgent, UpdateProfile, UpdateStatus, UpdateReputation, StakeReputation, UnstakeReputation, ClearSuspension, DeregisterAgent, UpdateManifest at lines 41, 84, 105, 152, 183, 217, 257, 285, 351) requires. After the first deregister bumps `OwnerNonce.nonce`, the live `agent_profile` PDA contains the nonce; this context's 2-seed derivation will never resolve to the live profile and will fail for any non-zero-nonce user. | Add `owner_nonce: Account<'info, OwnerNonce>` and change seeds to `[authority.key().as_ref(), b"agent-profile", &owner_nonce.nonce.to_le_bytes()]`. Ship in lockstep with the Settlement CPI rewire. | AUD-001 |
| F2 | **Critical** | `programs/settlement/src/instructions/cpi.rs:65-80` | The CPI still calls Registry's legacy `update_reputation` (unbounded `u64`), not the new `propose_reputation_delta`. ADR-094's `[0, 100]` clamp and `\|delta\| <= 10` policy is therefore inert — Settlement can still drive reputation arbitrarily high or low with the governance-tunable deltas. | Land the deferred CPI rewire in `cpi.rs` to call `propose_reputation_delta`, and gate the legacy `update_reputation` to `upgrade_authority`-only or remove it. | AUD-002 |
| F3 | **Critical** | `programs/agent-registry/src/contexts.rs:21-28` (`init_if_needed` on `OwnerNonce`) + `lib.rs:349-368` (`clear_suspension`) + `lib.rs:137-151` (`update_status`) | `update_status` accepts `Active → Suspended` as a self-issued status change; `clear_suspension` requires `slash_count >= 3` and halves score. Combined: an agent at score N with 3 slashes can self-suspend, clear, and continue at N/2 — a "soft-reset" of bad reputation. | (a) Reject `update_status(_, Suspended)` — Suspended must only be entered by the slash path. (b) `clear_suspension` should impose a floor reset (score = 0) plus a cooldown via stored `cleared_at`. | AUD-004 |
| F4 | **Critical** | `programs/agent-registry/src/lib.rs:153-203` (`update_reputation`) | Legacy path still on-chain and writable by Settlement. No per-call delta cap, no `[0, 100]` clamp. Combined with F2, an attacker who lands a malicious `update_protocol_config` can set `reputation_delta_task_completed = i64::MAX/2` and inflate scores. | Add an upper bound to `reputation_delta_task_completed` in `update_protocol_config`. Independently, fix F2 so this path is no longer the live one. | AUD-002 (merged) |
| F5 | **High** | `programs/settlement/src/instructions/protocol_config.rs:16-36` + `contexts.rs:491-505` | `initialize_protocol_config` is permissionless: any signer who lands the tx first becomes `authority`. No deployment-time guard tying authority to the program upgrade authority or a known multisig. ADR-031 mentions multisig; the program does not enforce it. | Constrain `payer` to a hard-coded governance pubkey via `address = ...`, OR run `initialize_protocol_config` atomically in the same tx as program deploy. | AUD-005 |
| F6 | **High** | `programs/agent-vault/src/instructions.rs:280-294`, `:455-468` | Rate-limit window uses `clock.unix_timestamp - vault.rate_limit_window_start` (signed `i64`) compared against `3600`. Clock-skew negative diff takes the "still in window" branch, never resets. | Use `clock.unix_timestamp.saturating_sub(vault.rate_limit_window_start).max(0)` and treat negatives as "window expired". | AUD-006 |
| F7 | **High** | `programs/agent-registry/src/lib.rs:177-188` | `avg_rating` formula uses `total_tasks_completed: u64` as denominator, but unrated tasks (`rating == 0`) still increment it. Providers can game by ordering rated approvals early. | Either skip incrementing on rating=0, or maintain a separate `total_rated_tasks` denominator. | AUD-007 |
| F8 | **High** | `programs/agent-vault/src/contexts.rs:141-150`, `:191-200` | `agent_profile` derivation uses `vault.profile_nonce` — user-supplied at `initialize_vault`. A wrong value (e.g. stale from old closed profile) makes the derivation never resolve; vault is permanently transfer-frozen. | At `initialize_vault`, derive `profile_nonce` from a passed `OwnerNonce` account with seeds `[authority, b"owner-nonce"]` under Registry's program ID, not from a user-supplied scalar. | AUD-008 |
| F9 | **High** | `programs/settlement/src/instructions/escrow.rs:114-128` (`accept_task`) | No deadline check. Provider accepts already-expired task → escrow becomes `Active` → `cancel_escrow` (Created-only) is no longer available → client funds locked until `expire_escrow`. Grief vector. | Add `require!(now <= escrow.deadline, SettlementError::DeadlinePassed);` to `accept_task`. | AUD-009 |
| F10 | **High** | `programs/settlement/src/instructions/escrow.rs:172-294` (`approve_milestone`), `:495-508` (`expire_escrow`) | Deadline guard at line 199 means `approve_milestone` cannot fire after deadline. `expire_escrow` auto-approves Submitted milestones but does not invoke the success-path reputation CPI for the now-implicitly-final milestone. Provider loses the +task_completed reward to client slowness. | Have `expire_escrow` invoke the success-path reputation CPI when **all** milestones end Approved (after the auto-approval step). | AUD-010 |
| F11 | **Med** | `programs/settlement/src/instructions/dispute.rs:10-25` (`raise_dispute`) | No grace gate. A client can dispute *immediately after* provider submits a milestone, sidestepping ADR-102's grace window which only protects against `expire_escrow`. | Apply the same `grace_ends_at` check to `raise_dispute` for any Submitted milestone. | AUD-018 |
| F12 | **Med** | `programs/settlement/src/contexts.rs:91-93` (`AcceptTask`) and peers | Status not constrained at Account level (only handler require). Defense-in-depth gap. | Hoist status constraints into the `Accounts` struct where feasible. | AUD-019 |
| F13 | **Med** | `programs/agent-vault/src/instructions.rs:228-344` (`execute_transfer`) | `agent_identity` is settable to any pubkey at init/rotate with no proof-of-control. Authority can install third-party as dual-signer without their consent. ADR-069 acknowledges; user docs do not warn. | Add comment + README warning. Optional: `pending_agent_identity` two-step rotation requiring new key to sign acceptance. | AUD-020 |
| F14 | **Med** | `programs/agent-vault/src/state.rs:115-129`; `instructions.rs:404-408` | Empty allowlist = allow all. ADR-073 deferred. Opt-out security. | Flip default: empty allowlist = deny all. Land ADR-073. | AUD-021 |
| F15 | **Med** | `programs/settlement/src/instructions/escrow.rs:495-502` | `released_amount` accounting safe today, but ordering-fragile under refactor (post-transfer increment, then milestone approve loop). | Compute total_release upfront in a single `checked_add` and assert equality with `total_amount`. | AUD-022 |
| F16 | **Med** | `programs/agent-vault/src/instructions.rs:478-493` | No per-day cap on `agent_identity` rotations. Compromised authority can rotate→drain→rotate→… | Add max 1 rotation per 24h to `update_agent_identity`. | AUD-023 |
| F17 | **Med** | `programs/settlement/src/instructions/escrow.rs:60-61` | `deadline > now` only — no upper bound. Client can lock funds in `Created` for years (voluntary, but indexers track as live). | Cap `deadline <= now + MAX_ESCROW_DEADLINE_SECS` (e.g., 365 days). | AUD-024 |
| F18 | **Low** | `programs/settlement/src/instructions/cpi.rs:82-86` | Emits `ReputationUpdateScheduled` after a synchronous CPI. Name implies async semantics that don't exist. Indexers will mis-model. | Rename to `ReputationUpdated` or remove (Registry already emits the canonical event). | AUD-032 |
| F19 | **Low** | `programs/agent-registry/src/lib.rs:357` | `score / 2` rounds down for odd scores. Cosmetic. | Document or use `(score + 1) / 2`. | AUD-033 |
| F20 | **Low** | `programs/agent-vault/src/instructions.rs:375-378, 420` | Two-tier check: `is_token_allowed` policy + `TokenSpendRecord` existence. With empty-allowlist default-allow (F14), the path skips to `TokenSpendRecord` lookup which fails with `TokenNotConfigured`. Confusing. | Collapse: a token is "allowed" iff a `TokenSpendRecord` exists. | AUD-034 |
| F21 | **Low** | `programs/settlement/src/contexts.rs:62-69` | `space = 298 + (milestones_data.len() * 49)` is user-driven before handler validates count ≤ 5. Tx-level rollback covers it but surface is wide. | Use constant `298 + (MAX_MILESTONES * 49)`; reject oversized vec earlier. | AUD-035 |
| F22 | **Low** | `programs/agent-registry/src/contexts.rs:21-28` | `init_if_needed` on `OwnerNonce` carries reinit-attack surface (Anchor docs warn). Currently safe via `deregister_agent`'s post-close increment. | Document the invariant; consider explicit re-init guard. | AUD-036 |
| F23 | **Info** | `programs/settlement/src/instructions/escrow.rs:380-385` | `expire_escrow` permissionless; spammers can call on every just-expired escrow. Standard Solana economic model — they pay tx fees. | None; document. | AUD-045 |
| F24 | **Info** | `programs/agent-registry/src/lib.rs:496-513` | `migrate_agent_profile` with `realloc::zero = true` only zeros new bytes. Future schemas repurposing existing fields need an explicit migration handler. | None — design constraint. ADR-096 notes this. | AUD-046 |
| F25 | **Info** | `programs/agent-registry/src/lib.rs:457-462` | `manifest::verify_ed25519_precompile` searches `current ± 1` only. Limits batch-tx flexibility. | None; document. | AUD-044 |

## Top 5 risks (ranked)

1. **F1 — `ProposeReputationDelta` PDA seed mismatch.** Broken on any account whose nonce is non-zero. Dormant until F2 fixed; the moment Settlement migrates to the new path, every existing agent's update breaks.
2. **F2 + F4 — Live `update_reputation` is unbounded.** ADR-094 promises `[0, 100]` and `|delta| <= 10`; live CPI ignores both. Any consumer trusting `score <= 100` is wrong.
3. **F3 — Suspension-laundering loop.** Self-issued `Active → Suspended` + `score / 2` clear is a one-sided cost: high-rep agents lose meaningfully, low-rep agents barely.
4. **F5 — Permissionless `initialize_protocol_config`.** First signer wins governance forever. On a fresh deploy = race condition between deployer and observers.
5. **F8 — Vault user-supplied `profile_nonce`.** Wrong value bricks transfers permanently; no `close_vault` exists for recovery (A3).

## Architecture-level critiques

- **A1 — Two parallel reputation update paths is one too many.** Registry exposes `update_reputation` (legacy, unbounded) AND `propose_reputation_delta` (new, bounded). Both live. Settlement uses the legacy. Worst kind of deprecation. → **AUD-065**
- **A2 — Anchor `has_one` cannot OR-match `Option<Pubkey>`.** Ad-hoc constraint logic in `ResolveDispute` (contexts.rs:247-253) and `RaiseDispute` (line 219-222). Each is a new audit surface. → **AUD-066**
- **A3 — Vault has no close instruction.** Bricked vaults (F8) are permanently bricked. → **AUD-067**
- **A4 — `ProtocolConfig.authority` rotation is single-key.** No two-step, no timelock, no renounce. ADR-031 waves at multisig; runtime doesn't enforce. → **AUD-068**
- **A5 — Reputation type-system smell.** `i64` delta + `u64` score + `u8` cap. After F2 fix, `u8` suffices. ADR-096 supports migration. → **AUD-069**
- **A6 — Settlement signing-PDA bump unstored.** Recomputed via `find_program_address` on every CPI. Cheap but wasteful. → **AUD-070**
- **A7 — Permissionless `expire_escrow` and `resolve_dispute_timeout` mix concerns.** No keeper fee = no incentive alignment. → **AUD-071**
- **A8 — `SUMMARY.md` documents `execute_program_call` as live; ADR-050 removed it.** README/SUMMARY/dashboard tell judges/users about a feature that no longer exists. → **AUD-072**

## Documented-but-not-implemented gaps

- **ADR-094**: declares `propose_reputation_delta` as new entry point; **code still uses `update_reputation`** (cpi.rs:74). Live policy enforcement = absent. (AUD-002, AUD-065)
- **ADR-097**: `ProposeReputationDelta` context missing nonce seed component. (AUD-001)
- **ADR-031**: mainnet multisig upgrade authority — not enforced at the program level. (AUD-005, AUD-068)
- **SUMMARY.md §1**: claims `execute_program_call` exists; ADR-050 removed it. (AUD-072)
- **ADR-073** track: empty allowlist = allow all reversal explicitly deferred. Live default-allow remains. (AUD-021)
