# Design Decisions — Audit Phase 3

**Date**: 2026-04-25
**Status**: Locked. Implementation PRs reference this doc as the source of truth.
**Audit ref**: `ARCHITECTURE-AUDIT-2026-04-25.md` master findings; `REMEDIATION-PLAN.md` PR sequencing.

The four design-blocked critical/high findings (AUD-001/002, AUD-004, AUD-005, AUD-008) have a confirmed implementation shape. This doc records what was chosen, what was rejected, and the invariants every PR must preserve. Future audits can diff against this snapshot.

---

## AUD-001 + AUD-002 — Reputation policy unification (PR-G)

**Decision**: Option A — remove legacy `update_reputation` entirely. Migration `clamp` runs once via the existing `migrate_agent_profile` (ADR-096) versioned-migration mechanism. No temporary "panic button" admin instruction.

**Rationale (rejected alternatives)**:
- **B (gate to upgrade-authority)** rejected: shadow APIs become permanent. Two reputation paths is exactly the bug AUD-002 is closing.
- **C (one-shot `clamp_reputation_admin` ix)** rejected: idempotent migration + version-gating already gives us this for free without a surgical tool that someone will try to reuse.

**Implementation contract**:
1. `ProposeReputationDelta` context must:
   - Include `owner_nonce: Account<'info, OwnerNonce>` with seeds `[authority.key().as_ref(), b"owner-nonce"]` under `agent_registry::ID`.
   - Use seeds `[authority.key().as_ref(), b"agent-profile", &owner_nonce.nonce.to_le_bytes()]` for `agent_profile`.
   - **Note (PR-J finding, 2026-04-25)**: `OwnerNonce` has no `authority` field (only `pub nonce: u64`). The `require_keys_eq!(owner_nonce.authority, ...)` line in the original spec **does not compile**. The seeds binding `[authority.key().as_ref(), b"owner-nonce"]` already enforces the authority binding via PDA derivation — any account whose seeds don't match the passed `authority` fails `ConstraintSeeds`. Security property preserved without the explicit field check.
2. Rewire `programs/settlement/src/instructions/cpi.rs:65-80` to invoke `propose_reputation_delta`. Drop the TODO comment at `cpi.rs:43-48`.
3. Remove `update_reputation` from `programs/agent-registry/src/lib.rs:153-203` and its context.
4. Extend `migrate_agent_profile` (ADR-096) to apply normalization at v→v+N bump:
   ```rust
   profile.reputation_score = profile.reputation_score.clamp(0, 100);
   if profile.status == AgentStatus::Suspended && profile.reputation_stake.slash_count < 3 {
       profile.reputation_stake.slash_count = 3;
   }
   ```
5. Add `assert_valid_profile(profile: &AgentProfile) -> Result<()>` helper. Call it post-migration AND post-mutation in `propose_reputation_delta`. Defines the closed-state-machine invariants: `0 <= score <= 100`, `Suspended ⇒ slash_count >= 3`, `cleared_count <= MAX_CLEARED` (MAX_CLEARED = 3, see AUD-004).
6. Add `verify_protocol_invariants` admin-only ix, callable once post-migration, that fails loudly if any sampled profile violates `assert_valid_profile`.

**Acceptance**:
- Settlement no longer references legacy `update_reputation`. Verify by `grep -r 'update_reputation' programs/settlement/`.
- `cargo check` clean.
- `propose_reputation_delta` integration test exercises the new seed shape + cross-account-reuse rejection.
- Migration test runs on a fixture profile with `score=255`, `status=Suspended`, `slash_count=0` → asserts post-migration `score=100`, `slash_count=3`.

---

## AUD-004 — Status laundering (PR-I)

**Decision**: Cumulative `slash_count` (never reset) + new `cleared_count: u8` field with escalating cost. Reject self-issued `Active → Suspended` transitions in `update_status`. No timestamp cooldown.

**Rationale (rejected alternatives)**:
- **Cooldown via `cleared_at`** rejected: timing games invite edge exploits; cumulative escalation is monotonic and composable.
- **Floor-reset (score = 0)** rejected: erases the gradient that makes high-rep agents pay more for clearing. Cumulative escalation preserves it across multiple clears.

**Implementation contract**:
1. In `update_status` (`programs/agent-registry/src/lib.rs:137`), reject self-issued `* → Suspended`:
   ```rust
   require!(
       !(new_status == AgentStatus::Suspended
         && ctx.accounts.authority.key() == agent_profile.authority),
       AgentRegistryError::InvalidStatusTransition
   );
   ```
   The slash path (`lib.rs:191-194`) writes `Suspended` directly without going through `update_status`, so it's unaffected.
2. Add `cleared_count: u8` to `AgentProfile`. Schema migration via `migrate_agent_profile` (ADR-096) — existing profiles default to 0.
3. Modify `clear_suspension` (`programs/agent-registry/src/lib.rs:349-368`):
   - **Do not reset `slash_count`**. It stays cumulative.
   - Increment `cleared_count`.
   - Match on the new `cleared_count` value:
     ```rust
     match profile.cleared_count {
         1 => profile.reputation_score = profile.reputation_score / 2,
         2 => profile.reputation_score = 0,
         _ => profile.status = AgentStatus::Retired, // terminal
     }
     ```
   - Status moves to `Paused` (not `Active`) on cases 1/2 — matches existing semantics.
4. Update events:
   - `AgentSlashed` includes `total_slashes: u32` (renamed from existing `slash_count`).
   - `SuspensionCleared` includes `cleared_count: u8`.
5. `assert_valid_profile` (shared with AUD-001/002) enforces `cleared_count <= 3` invariant.

**Acceptance**:
- Test: agent with `slash_count = 3`, `cleared_count = 0` → `clear_suspension` → `slash_count = 3` (NOT reset), `cleared_count = 1`, `score = score / 2`.
- Test: same profile clears 3x → status terminally `Retired`, no further mutations possible.
- Test: agent calls `update_status(_, Suspended)` self-issued → reverts with `InvalidStatusTransition`.

---

## AUD-005 — Permissionless governance front-run (PR-H)

**Decision**: Option C — gate `initialize_protocol_config` to the program's upgrade authority via `BpfLoaderUpgradeable::ProgramData`. After init, `ProtocolConfig.authority` is independent. **No future ix references `ProgramData`.**

**Rationale (rejected alternatives)**:
- **A (hardcode multisig)** rejected: locks compile-time pubkeys — staging clusters and forks become painful.
- **B (atomic deploy only)** rejected: operational discipline alone leaves the race window open by mistake.

**Implementation contract**:
1. `InitializeProtocolConfig` context adds:
   ```rust
   /// Provided by the BPF Upgradeable Loader at deploy time.
   #[account(
       seeds = [crate::ID.as_ref()],
       bump,
       seeds::program = bpf_loader_upgradeable::ID,
       constraint = program_data.upgrade_authority_address == Some(payer.key())
           @ SettlementError::Unauthorized,
   )]
   pub program_data: Account<'info, ProgramData>,
   ```
2. After init, `ProtocolConfig.authority = ctx.accounts.payer.key()` (existing line). The link to upgrade authority is severed.
3. **Cultural enforcement**: no other instruction (now or future) loads `ProgramData`. If governance evolves, it goes through `ProtocolConfig.authority` rotation, never back through the upgrade authority.

**Acceptance**:
- Test: random keypair attempts `initialize_protocol_config` → reverts with `Unauthorized`.
- Test: program upgrade authority signs `initialize_protocol_config` → succeeds; `ProtocolConfig.authority == upgrade_authority_address`.
- Test: post-init `update_protocol_config` works without `ProgramData` (proves coupling is severed).

---

## AUD-008 — Vault `profile_nonce` sourcing (PR-J)

**Decision**: Strict register-first. `InitializeVault` reads the existing `OwnerNonce` PDA from Registry; user can no longer supply a scalar. UX-flow concerns are addressed in the SDK, not by relaxing program-level constraints.

**Rationale (rejected alternative)**:
- **`init_if_needed` on `OwnerNonce` in vault context** rejected: re-introduces the soft-fork-identity seam ADR-097 was guarding.

**Implementation contract**:
1. `InitializeVault` context (`programs/agent-vault/src/contexts.rs:13-28`) adds:
   ```rust
   /// MUST exist — vault initialization requires prior agent registration.
   /// Seeds binding to `authority` enforces cross-account-reuse rejection
   /// via PDA derivation (any non-matching authority fails ConstraintSeeds).
   #[account(
       seeds = [authority.key().as_ref(), b"owner-nonce"],
       seeds::program = agent_registry::ID,
       bump,
   )]
   pub owner_nonce: Account<'info, OwnerNonce>,
   ```
   **Note (PR-J finding, 2026-04-25)**: original spec also included `constraint = owner_nonce.authority == authority.key()`. That line does not compile — `OwnerNonce` has only `pub nonce: u64`, no `authority` field. Seeds-derivation binding is sufficient.
2. Handler reads `owner_nonce.nonce` and stores it in `vault.profile_nonce`. **Remove** any user-supplied `profile_nonce: u64` arg from `initialize_vault`.
3. SDK responsibility (separate, not in this PR but tracked as PR-JJ): `@agenomics/client` adds `ensureAgentRegistered(authority)` helper that registers + then initializes vault if needed.

**Acceptance**:
- Test: vault init without prior `register_agent` → reverts (OwnerNonce account does not exist).
- Test: vault init by Alice with Bob's `OwnerNonce` → reverts with `Unauthorized`.
- Test: vault init after Alice's `register_agent` → succeeds; `vault.profile_nonce == owner_nonce.nonce`.

---

## Cross-cutting: closed-state-machine invariant (`assert_valid_profile`)

A single helper used post-mutation in every reputation/status writer, AND post-migration in `migrate_agent_profile`:

```rust
pub fn assert_valid_profile(profile: &AgentProfile) -> Result<()> {
    require!(profile.reputation_score <= 100, InvalidReputationScore);
    require!(
        !(profile.status == AgentStatus::Suspended
          && profile.reputation_stake.slash_count < 3),
        InvalidSuspendedProfile
    );
    require!(profile.cleared_count <= 3, InvalidClearedCount);
    Ok(())
}
```

Mutation sites that must call this post-write:
- `propose_reputation_delta` (after delta applied)
- `clear_suspension` (after cleared_count + score update)
- `update_status` (after transition)
- `migrate_agent_profile` (after normalization)

Implemented as part of PR-G (AUD-001/002), since that PR introduces all the invariants. Other PRs add their write-sites to the call list as they land.

---

## Ship sequence (locked)

1. **PR-H (AUD-005)** — governance gate. Locks the surface before any other state mutation lands.
2. **PR-J (AUD-008)** — register-first. Prevents new bad-state vault creation.
3. **PR-I (AUD-004)** — status laundering. Schema bump for `cleared_count`. Additive, safe.
4. **PR-G (AUD-001/002)** — reputation rewire + migration + invariant check. Last because it's the largest and depends on the migrate_agent_profile pattern landed in PR-I.

Within PR-G's release window: deploy → run `migrate_agent_profile` per profile → run `verify_protocol_invariants` → confirm clean → publish.

Implementation can be **fully parallel** in 4 worktrees. Integration follows the sequence above.
