# ADR-121: Remove dangling reputation aggregates after ADR-094 / PR-G

## Status
Accepted

## Date
2026-04-25

## Context

ADR-094 / PR-G (`fix(registry,settlement): unify reputation policy + invariant
migration (AUD-001, AUD-002)`, commit `0a02850`) deleted the legacy
`update_reputation` instruction. That instruction was the **sole writer** of
three `AgentProfile` aggregate fields:

- `total_tasks_completed: u64`
- `total_earnings: u64`
- `avg_rating: u8`

After PR-G these fields are permanently zero on every newly-registered profile
and frozen at their last-written value on pre-existing profiles. They are
still surfaced through:

- The Anchor IDL (so SDK consumers see them).
- `mcp-server` reputation/registry handlers (`avgRating`, `totalTasksCompleted`,
  `totalEarnings` in MCP tool responses).
- TypeScript tests asserting `avg_rating == 0` on a fresh registration.
- A Settlement-layer comment claiming `approve_milestone(rating)` "folds into
  `avg_rating`" — true pre-PR-G, false today.

Audit finding **AUD-007** flagged the gameable rolling-average formula in the
old `update_reputation`. With the writer gone, the original "fix the formula"
solution is moot. The remaining question is what to do with the dangling
aggregates. An earlier PR-Q attempt (commit `92ee090`, never merged) layered
a `total_rated_tasks: u64` denominator on top of a *re-introduced* writer; that
contradicted PR-G's "Option A — remove, no escape hatch" decision (locked in
`docs/audits/DESIGN-DECISIONS-2026-04-25.md` AUD-001/002), so it could not
land. PR-Q was deferred (`f6422f4`) until a re-spec consistent with the
post-PR-G surface existed. This ADR is that re-spec.

## Decision

Remove `total_tasks_completed`, `total_earnings`, and `avg_rating` from the
public `AgentProfile` shape, replacing them with a 17-byte
`_reserved_aud007: [u8; 17]` padding array that sits at the same byte offsets
to preserve the on-disk layout for already-registered accounts. PR-G's
`migrate_agent_profile` is extended to zero those bytes during the schema
bump so post-migration accounts match a freshly-registered profile.

Three alternatives were considered and rejected:

- **Add a new `submit_rating` instruction** (Option B from the original
  AUD-007 plan). New attack surface, new tests, new consumer wiring for a
  metric of marginal value relative to the bounded `propose_reputation_delta`
  policy. ADR-094's per-call reputation cap (`|delta| ≤ 10`) and the closed
  state machine (`assert_valid_profile`) already give settlement the lever it
  needs. A real ratings instruction can be designed later with explicit
  governance owning the policy.
- **Clean removal of the fields without padding.** The fields are NOT
  contiguous at the end of `AgentProfile` — they sit between `reputation_score`
  and `created_at`. Removing them shifts every subsequent field's
  serialization offset. With `MIGRATION_HEADROOM = 64` and existing accounts
  on-chain, this would silently corrupt every profile on the next read.
- **Reorder the struct so the dangling fields ARE at the end, then remove.**
  Reordering shifts the same offsets — it doesn't help unless the migration
  also rewrites the entire account body, which is exactly the operation
  ADR-096's `realloc::zero = true` was designed to avoid.

## Consequences

- **Positive**: AUD-007's "gameable `avg_rating` formula" is closed by
  removing the field entirely — the gameable surface is gone, not patched.
  MCP tool responses, SDK shapes, and dashboards stop advertising
  permanently-zero telemetry. The Settlement→Registry CPI's "rating" arg
  becomes documentation-honest (validated, not folded into any aggregate).
- **Negative**: Any external consumer that read `avg_rating` /
  `total_tasks_completed` / `total_earnings` from the on-chain account must
  drop those reads or move them to the indexer. The 17 bytes of padding
  remain in every account in perpetuity — a deliberate trade for
  layout-preserving migration. The Settlement program's `approve_milestone`
  still accepts a `rating: u8` arg for forward-compat with a future on-chain
  rating instruction; callers that intend "no rating" should pass 0.
- **Follow-ups**:
  - A future ADR may design a dedicated rating instruction (governance-owned
    aggregate, explicit denominator semantics) and consume part of the
    `_reserved_aud007` region via a versioned migration.
  - Indexer-driven per-task counts already exist (ADR-061 §5 carve-out);
    documentation that conflated on-chain and indexer telemetry should be
    updated wherever it surfaces (`packages/sas-resolver` made
    `total_tasks_completed` optional in this PR).

## Migration

Concrete steps applied in PR-Q:

1. `programs/agent-registry/src/state.rs::AgentProfile` — three fields
   replaced by `pub _reserved_aud007: [u8; 17]` at the same struct position.
   `SPACE` constant is unchanged at `1415` bytes (8 + 8 + 1 = 17 byte delta
   in, 17 byte delta out).
2. `programs/agent-registry/src/lib.rs::register_agent` — three field
   initializations replaced by `_reserved_aud007 = [0u8; 17]`.
3. `programs/agent-registry/src/lib.rs::migrate_agent_profile` — added
   `profile._reserved_aud007 = [0u8; 17]` so pre-migration profiles that
   carry stale legacy values are normalized at version bump.
4. Anchor IDL regenerated; the dangling fields disappear from the public
   shape, replaced by a `_reserved_aud007: [u8; 17]` field. `idl/*.json` and
   `sdk/idl/src/idl/*.json` re-synced via `scripts/sync-idl.sh`.
5. Consumer cascade: `mcp-server/src/handlers/{registry,reputation}.ts`,
   `mcp-server/src/{tools,actions}/{registry,reputation,settlement}.ts`,
   `mcp-server/test/idl-typed-decode.test.ts`,
   `tests/agent-registry.ts`, `tests/settlement.ts`, `scripts/demo-e2e.ts`,
   `sdk/client/src/registry.ts`, `packages/sas-resolver/src/merge.ts`,
   `programs/agent-vault/src/lib.rs` (test fixtures),
   `programs/settlement/src/{lib.rs,instructions/{cpi,escrow}.rs}` comments.

## References

- ADR-040 — explicit account-space calculation (the `AgentProfile`
  space comment at `programs/agent-registry/src/state.rs:118-129`,
  which this ADR's removal of `avg_rating` / `total_*` field-shrinks).
- ADR-094 — bounded reputation policy (PR-G).
- ADR-096 — in-place account-resize migration mechanism.
- AUD-001 / AUD-002 — `update_reputation` removal (closed by PR-G).
- AUD-007 — `avg_rating` denominator gameable (closed by this ADR + PR-Q).
- `docs/audits/DESIGN-DECISIONS-2026-04-25.md` — locked decision corpus.
