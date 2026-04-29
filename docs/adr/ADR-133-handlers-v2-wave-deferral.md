# ADR-133: Handlers-v2 wave deferral — keep dual-path as living reference until Anchor v2 ships

## Status

Accepted

## Date

2026-04-29

## Context

The Web3.js v1 → v2 (now `@solana/kit`) migration has been a multi-cycle
effort tracked by ADR-012 / ADR-033 (same-day duplicate, ADR-087 is the
canonical migration plan). The cycle-3 audit
(`docs/audits/CYCLE-3-MCP-PUNCHLIST.md` §"Handlers v1/v2 status")
flagged that the migration is **paused at ~4%** (1/27 actions on
Kit-native): only `execute_transfer` ships through `handlers-v2/vault.ts`,
and only when the operator opts in via `AEP_USE_V2_VAULT_TRANSFER=1`.

The dual-path branch lives at `mcp-server/src/actions/vault.ts:171-189`
(env-gated dispatcher) plus a separate `vault_transfer_v2` action export
at lines 223-241 (v2-only, used by tests / ops tooling). The Kit-native
implementation is `mcp-server/src/handlers-v2/vault.ts` (441 LOC) +
`keypair-signer.ts` (114 LOC).

The cycle-3 audit framed the decision as: **(a)** defer indefinitely +
delete the dual-path branching, OR **(b)** commit a wave to migrate
`vault_token_transfer` + `create_vault` next.

A 2026-04-28 research pass (researcher subagent, sources cited in
`docs/audits/CYCLE-3-MCP-PUNCHLIST.md` §"References") established
the upstream timeline:

- `@coral-xyz/anchor@0.32.1` (published 2025-10-10, ~6.5 months stale
  as of this ADR) still depends on `@solana/web3.js ^1.69.0`. **No
  v2 support shipped, none on master CHANGELOG.** The 25 Anchor-bound
  actions in this codebase cannot migrate ahead of Anchor itself.
- `@solana-program/token@0.13.0` is the Kit-native SPL replacement
  (clean of `bigint-buffer`); not yet ≥1.0.0 stable.
- No Anza/Foundation EOL date for v1; v1.x is "maintenance-only"
  since the kit rename.

The v2 wave (option b) for `vault_token_transfer` + `create_vault`
would only migrate **non-Anchor** code paths today. `vault_token_transfer`
specifically pulls `@solana/spl-token@0.4.14`, which is the source of the
HIGH-sev `bigint-buffer` Dependabot alert on transitive deps. Migrating
it to `@solana-program/token@0.13.0` would clear that one alert for
**only** the migrated handler — the broader chain (Anchor → web3.js v1
→ rpc-websockets → uuid) remains.

## Decision

**Option (c) — hybrid: keep handlers-v2/vault.ts as a living reference
implementation; defer the v2 wave; do NOT delete the dual-path.**

This ADR neither closes nor expands the migration. It pins the rationale
for the current shape and names the explicit triggers for re-opening the
decision.

### What stays as-is

- `actions/vault.ts:171-189` — env-gated dual-path dispatcher.
  Default v1; opt-in v2 via `AEP_USE_V2_VAULT_TRANSFER=1`.
- `actions/vault.ts:223-241` — `vault_transfer_v2` test/ops action
  export, not registered in the default router.
- `mcp-server/src/handlers-v2/vault.ts` (441 LOC) +
  `keypair-signer.ts` (114 LOC) — Kit-native reference impl.
- `mcp-server/test/handlers-v2-vault.test.ts` (503 LOC) — pinning
  tests for the v2 path.
- `mcp-server/src/solana-v2.ts` — Kit RPC factory; consumed by
  v2 path, also re-used by other modules.

### What is NOT done

- We do NOT migrate additional actions to v2 (option b).
- We do NOT delete the dual-path or v2 reference impl (option a).

### Why this shape, not (a) or (b)

- **(a) delete** would discard ~600 LOC of working Kit-native code
  that we will rewrite from scratch when Anchor v2 lands. The
  pattern proven in Batch G (`pipe()` + Kit's actual
  `TransactionPartialSigner` + IDL-derived `Program<X>` typing) is
  the template the wave will use; deleting now means re-discovering
  it later.
- **(b) wave** of `vault_token_transfer` + `create_vault` would add
  ~700 LOC and migrate 2/27 actions to ~7% on v2, but does not
  unblock the 25 Anchor-bound actions and does not clear the
  `bigint-buffer` HIGH alert for the broader chain. The win is small;
  the cost (more dual-path surface to maintain through the Anchor
  blocker window) is real.
- **(c) hybrid** preserves the reference impl, holds the line at
  4% until the gate opens, and pins the re-evaluation triggers
  below.

## Re-evaluation triggers

Re-open this decision (and either expand the v2 wave OR delete the
dual-path) when ANY of the following becomes true:

1. **Anchor v2 ships** — `@coral-xyz/anchor` releases a version that
   either drops the `@solana/web3.js ^1.x` peer dependency or adds
   `@solana/kit` as a peer/dependency. The scheduled
   `trig_01GkKKZQd39rY2Z7w7tmmYou` (2026-06-03) explicitly checks for
   this signal.
2. **`@solana-program/token` reaches ≥1.0.0** — stability signal that
   the non-Anchor SPL surface is safe to migrate. Same scheduled
   agent checks this.
3. **Active mainnet exposure of `bigint-buffer`** — if a CVE hits
   `bigint-buffer` with an exploitable code path that our handlers
   reach, migrate `vault_token_transfer` to `@solana-program/token`
   immediately regardless of broader Anchor-blocker state.
4. **A new feature requires Kit-native primitives** (versioned
   transactions with address lookup tables, transaction priority fee
   tuning beyond what `compute-budget.ts` exposes today, etc.) — the
   feature drives the migration of its dependent actions, not the
   global wave.
5. **18+ months elapse without Anchor v2** (i.e. ≥ 2027-10-29 with no
   movement) — at that point, defer-indefinitely starts to look like
   "delete and re-write the handlers-v2 reference if/when Anchor v2
   eventually arrives." Re-litigate.

If none of (1-5) fire by 2026-12-31, schedule a no-op review to confirm
the deferral still holds.

## Alternatives Considered

**(a) delete dual-path immediately.** Rejected per "Why this shape"
above — discards a tested, working reference impl that pins the
patterns Batch G refined; the cost of re-discovering them later
exceeds the maintenance cost of keeping ~600 LOC behind a gated env.

**(b) commit the `vault_token_transfer` + `create_vault` wave now.**
Rejected — the win (2 more actions on Kit, possibly clears one
Dependabot HIGH for the migrated handler only) does not justify ~700
LOC of new dual-path while the 25 Anchor-bound actions stay on v1.
The wave is the right move once Anchor v2 ships and the gate opens
across all actions, not piecemeal.

**Cargo-cult full migration (rip out v1 entirely).** Not on the table
— Anchor 0.32.1 still depends on `@solana/web3.js ^1.69.0`, so 25/27
actions cannot migrate without forking Anchor. ADR-033 already
considered and rejected the fork approach.

## Consequences

### Positive

- **Keeps the Kit-native pattern proven by Batch G alive** — the
  `pipe()` + `TransactionPartialSigner` + `Program<IDL>` shape is the
  template for the eventual wave; deleting it would reset the
  experience curve.
- **No new dual-path surface to maintain** — option (b) would have
  doubled the dual-path footprint (3 actions × v1+v2 ≈ 6 handlers
  to keep in lockstep through the Anchor-blocker window).
- **Re-evaluation triggers are explicit** — future-us doesn't have
  to re-derive the deferral rationale; the 5 triggers above name
  the conditions.
- **Aligns with the deferred Dependabot triage** — same upstream
  gate (`@coral-xyz/anchor` v2) is what unblocks both the alerts
  and the wave; the 2026-06-03 scheduled agent covers both checks.

### Negative

- **The `bigint-buffer` HIGH alert remains** for the
  `vault_token_transfer` path. Mitigation: the alert is structurally
  unreachable as deployed (`toBigIntLE` is not called with
  attacker-controlled input on our hot paths); see
  `docs/audits/CYCLE-3-MCP-PUNCHLIST.md` triage notes.
- **`AEP_USE_V2_VAULT_TRANSFER` env flag stays in the operator
  surface** indefinitely. Documentation in
  `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` should call out the flag's
  experimental status.
- **Stale-handler risk**: `handlers-v2/vault.ts` could rot if the v1
  `execute_transfer` shape changes and the v2 path doesn't track. The
  existing `test/handlers-v2-vault.test.ts` (503 LOC) pins behavioral
  parity at the action-router boundary; this ADR makes the parity
  contract explicit so future v1-side refactors know to update both
  sides.

## References

- ADR-012 / ADR-033 / ADR-087 — original Web3.js v2 migration plans.
- ADR-088 — typed Anchor program clients; the `Program<IDL>` pattern
  Batch G extended to sdk/client.
- ADR-129 §"Resilience primitives" + ADR-132 — recent ADRs that
  would need re-touch if the v2 wave moves forward.
- `docs/audits/CYCLE-3-MCP-PUNCHLIST.md` §"Handlers v1/v2 status"
  — the cycle-3 framing of this decision.
- `mcp-server/src/actions/vault.ts:171-189, 223-241` — dispatcher +
  v2-only action export.
- `mcp-server/src/handlers-v2/vault.ts` — Kit-native reference
  implementation.
- Researcher report 2026-04-28 — Solana JS SDK v1→v2 status (cited
  in punchlist References).
- Scheduled agent `trig_01GkKKZQd39rY2Z7w7tmmYou` — checks
  re-evaluation triggers (1) + (2) on 2026-06-03.
