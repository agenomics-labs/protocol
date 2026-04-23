# ADR-070: `deregister_agent` stake cleanup and Suspended-bypass prevention

## Status
Proposed

## Date
2026-04-22

## Context

DEEP-AUDIT-2026-04-22.md Audit 1 finding **SEC-4 (HIGH)** identified a Suspended-status bypass via stake-orphan and re-registration.

`programs/agent-registry/src/lib.rs:273-277` implements `deregister_agent` with `close = authority` on the `AgentProfile` account. The sibling `reputation-stake` PDA — derived at `[authority, b"reputation-stake"]` per ADR-020 — is **not** closed or drained. Its lamports are orphaned, but more importantly the PDA account persists on-chain with stale `slash_count` and `staked_amount` state.

Because `close = authority` refunds the profile's rent to `authority`, and registration uses the deterministic seed `[authority, b"agent-profile"]`, the authority can immediately call `register_agent` again, producing a **new** `AgentProfile` with `reputation_score = 0, slash_count = 0, status = Active`. The old staking PDA still exists but is now orphaned from the new profile (or, depending on how the stake PDA is re-used, may silently rebind).

**Exploit**: a Suspended agent (status set by slashing per ADR-020) calls `deregister_agent` → `register_agent` to wipe `slash_count` and bypass the Suspended trap entirely. Cost: ~0.001 SOL rent. This is materially cheaper than `clear_suspension`, which per ADR-020 halves `reputation_score` and is the intended escape hatch.

The Suspended state is the anti-sybil defense's last line (ADR-028); bypassing it for ~$0.02 defeats the entire reputation-staking economic model.

## Decision

Harden `deregister_agent` to refuse Suspended-bypass:

**Behavior change in `programs/agent-registry::deregister_agent`**:

1. Context loads the `reputation_stake` PDA as a mutable account (previously unreferenced). Binding uses `seeds = [authority.key().as_ref(), b"reputation-stake"], bump` — the existing ADR-020 derivation.
2. Handler asserts `stake.staked_amount == 0` **OR** drains the stake as part of deregister: if `staked_amount > 0`, the instruction fails with a new error `StakeNotEmpty` and a clear message directing the caller to `unstake_reputation` first. Rationale: requiring explicit unstake keeps the lamport-drain path auditable via the existing event stream rather than hidden inside deregister.
3. `reputation_stake` PDA is `close = authority` alongside `agent_profile`. Both accounts' rent returns to `authority` atomically.

**Registration seed amendment (optional, defense-in-depth)**: `register_agent`'s PDA seed is extended to `[authority.key().as_ref(), b"agent-profile", registry.global_registration_nonce.to_le_bytes().as_ref()]`, where `registry` is a new root PDA carrying a monotonic counter incremented on every `register_agent`. This makes a fresh profile occupy a different address than the old one, closing the "re-register with same seeds to resurrect" door even if a future bug re-orphans the stake. **Deferred** for this ADR — adopted only if the simpler stake-cleanup fix above proves insufficient in practice. A follow-up ADR will revisit if needed.

**Program changes**: `programs/agent-registry` only. Vault and Settlement unchanged.

**Tests to add** (under `tests/registry/`):

- Happy path: `unstake_reputation(full amount)` → `deregister_agent` → both accounts closed, rent refunded.
- Negative: `deregister_agent` while `staked_amount > 0` → fails with `StakeNotEmpty`.
- Exploit regression: Suspended agent attempts `deregister_agent` → `register_agent` sequence; the second `register_agent` must see a fresh zero-state profile BUT the agent has paid the unstake cost (full stake forfeiture if still slashed, per ADR-020 semantics), making the bypass strictly more expensive than `clear_suspension`.
- Integration: enumerate Settlement disputes that previously slashed the agent; confirm new profile cannot inherit the old stake's lamports without an explicit re-stake.

**Deployment**: program upgrade required. **Multisig signing required** per ADR-031.

## Alternatives Considered

- **Block `deregister_agent` unconditionally while `status == Suspended`.** Rejected — a Suspended agent that has served out `clear_suspension` cooling or genuinely wants to exit the protocol should be allowed to deregister cleanly. The correct gate is the stake, not the status.
- **Silently drain stake to authority in `deregister_agent`.** Rejected — hides lamport movement from the standard `unstake_reputation` event stream and makes off-chain indexers' slashing audits incomplete. Forcing explicit `unstake_reputation` keeps the invariant *"all stake exits the protocol via `unstake_reputation` events"* intact.
- **Add a monotonic nonce to registration seeds (the optional piece above) as the primary fix.** Rejected as sole mitigation — does not address the orphaned-lamports hygiene issue, and adds a new root PDA that needs its own initialization ADR. Adopted as a defense-in-depth layer only if stake cleanup proves leaky.
- **Forbid re-registration at the program level for N slots after deregister.** Rejected — introduces a time-based policy the program cannot cheaply enforce without a clock read in every `register_agent`, and the stake-cleanup fix addresses the economic attack directly.

## Consequences

**Positive**: closes the Suspended-bypass attack; ensures all stake movement is accounted for in the event stream; aligns `deregister_agent` with standard Anchor account-lifecycle hygiene.

**Negative**: `deregister_agent` now requires the `reputation_stake` PDA in the instruction's account list. SDKs and the dashboard's deregister flow must include the extra account. Additive to the instruction, not a breaking rename, but any caller that hard-coded a 3-account layout will fail with `NotEnoughAccountKeys` until updated.

**Migration path**: one program upgrade. Pre-existing orphaned stake PDAs (agents who already ran the deregister→register cycle before this fix) are a data-drift concern but not a protocol-integrity one — they are stale lamports that cannot be re-bound to an active profile because the new `AgentProfile` does not re-init them. A one-time off-chain cleanup script to enumerate and close orphaned `reputation-stake` PDAs (refunding lamports to their original authorities) is recommended but out of scope for this ADR. Devnet rehearsal mandatory.

## References
- `docs/adr/DEEP-AUDIT-2026-04-22.md` — Audit 1, finding SEC-4
- `docs/adr/ADR-020-reputation-staking.md` — stake PDA derivation and slashing semantics
- `docs/adr/ADR-028-anti-sybil-defense.md` — Suspended-state economic model
- `programs/agent-registry/src/lib.rs:273-277`
