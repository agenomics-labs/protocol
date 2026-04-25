# ADR-073: Dispute `None` resolver — reject at `create_escrow` or route via timeout-only

## Status
Accepted

## Date
2026-04-22

## Context

DEEP-AUDIT-2026-04-22.md Audit 1 finding **SEC-7 (HIGH)** identified a client-controlled dispute path when `dispute_resolver == None`.

`programs/settlement/src/contexts.rs:216-221` in `ResolveDispute` allows `resolver.key() == escrow.client` as an OR-branch alongside the named resolver. `create_escrow` at `escrow.rs:39-45` rejects *naming yourself* as resolver (prevents the obvious self-dealing path), but `dispute_resolver = None` is a legal construction, and the constraint OR-branch promotes the client to de facto resolver in that case.

The A-03 slash guard at `dispute.rs:116` prevents reputation slashing when the resolver is the client themselves, which is correct, but does not prevent the client from dictating the **refund split**: the client can call `resolve_dispute(client_refund=remaining, provider_refund=0)` unilaterally.

**Exploit**: client creates escrow with `dispute_resolver = None`, waits for the provider to submit milestones (doing the work), raises a dispute, and drains the escrow back to themselves. The provider's only recourse is `resolve_dispute_timeout` (ADR-030), which — depending on the current timeout logic — may also refund the client. The entire dispute path is client-controlled when resolver is None.

The audit proposes two alternatives: (A) reject `dispute_resolver = None` at `create_escrow`, forcing every escrow to name a third-party resolver; (B) allow `None` but route None-resolver disputes *exclusively* through `resolve_dispute_timeout` with a **symmetric split** (50/50 or pro-rata by milestones-submitted), removing unilateral resolution entirely.

## Decision

Adopt **Alternative B** — route None-resolver disputes through timeout-only with a symmetric split. Rationale: `None`-resolver escrows are a legitimate low-friction flow for small engagements where neither party wants to select a third party upfront; rejecting them at create time forces every escrow to designate a resolver, which adds friction to the happy path. The safer fix is to make the dispute path *symmetric* when no resolver exists.

**Concrete changes in `programs/settlement`**:

1. **`ResolveDispute` context (`contexts.rs:216-221`)**: remove the `resolver.key() == escrow.client` OR-branch. `ResolveDispute` now requires `resolver.key() == escrow.dispute_resolver` (where `dispute_resolver` is `Some`). If `dispute_resolver == None`, `resolve_dispute` unconditionally fails with a new error `NoResolverUseTimeout`.

2. **`resolve_dispute_timeout` instruction (`instructions/dispute.rs`)**: amend the refund logic. When called against an escrow with `dispute_resolver == None` AND `status == Disputed`, the refund split is **symmetric** — pro-rata by approved milestones. If N of M milestones were approved before dispute: provider gets `(N/M) × remaining`, client gets `((M-N)/M) × remaining`. If no milestones were ever approved, split 50/50. No reputation delta applies (consistent with the A-03 slash guard rationale).

3. **`raise_dispute` instruction**: when the escrow's `dispute_resolver == None`, the dispute moves immediately into a "timeout-only" flag on the escrow state. This flag prevents any actor (including the protocol's own off-chain cranker) from attempting `resolve_dispute`. The flag is advisory — the contexts.rs-level rejection in step 1 is the enforced gate — but the flag enables off-chain UIs to surface "this dispute resolves at timeout" to both parties.

4. **No change to `create_escrow`**: `dispute_resolver = None` remains a legal construction. The validation is moved from "reject at create" to "restrict at resolve."

**Timeout-only semantics** preserve the existing `resolve_dispute_timeout` timer per ADR-030, so the client cannot force an immediate resolution by raising the dispute — they must wait out the dispute timeout window, during which off-chain negotiation can occur.

**Program changes**: `programs/settlement` only.

**Tests to add** (under `tests/settlement/`):

- Exploit regression: client creates escrow with `dispute_resolver = None`, provider submits milestones, client calls `raise_dispute` → `resolve_dispute` → MUST fail with `NoResolverUseTimeout`.
- Happy path: same scenario with `resolve_dispute_timeout` after the timeout window → symmetric pro-rata refund based on approved milestone count.
- Edge: zero approved milestones before dispute → 50/50 split.
- Edge: all milestones approved → provider gets 100% (degenerate case, but consistent with the formula).
- Regression: named-resolver disputes continue to work unchanged.

**Deployment**: program upgrade required. **Multisig signing required** per ADR-031.

## Alternatives Considered

- **Alternative A — reject `dispute_resolver = None` at `create_escrow`.** Viable and simpler (one-line rejection). Rejected for this ADR because it breaks an existing valid use case (zero-friction low-value escrows) and forces a UX change in every client SDK. The symmetric-timeout approach fixes the exploit without eliminating the use case.
- **Allow unilateral `resolve_dispute` but cap client share at 50%.** Rejected — still allows the client to dictate timing and retains a material incentive for bad-faith dispute-raising. Symmetric-timeout removes the timing incentive entirely.
- **Require the provider to co-sign `resolve_dispute` when resolver is None.** Rejected — collapses to a negotiated-settlement model, which is reasonable but is a larger design change and conflates dispute resolution with mutual cancellation. Mutual cancellation is already covered by `cancel_escrow` in the `Created` state and by off-chain side agreements.
- **Auto-select a random on-chain resolver from a pool.** Rejected — introduces a resolver-pool governance structure (who's in the pool, how are they paid, how are conflicts of interest managed) that is well out of scope for a security fix.

## Consequences

**Positive**: closes the client-controlled drain exploit; preserves the `dispute_resolver = None` use case; makes the None-dispute path deterministic and symmetric, removing asymmetric-information advantage.

**Negative**: the dispute-timeout window (ADR-030) now gates a class of disputes it previously did not gate. Clients who legitimately want fast resolution must designate a resolver at create time — this is a slight UX regression for good-faith escrows that hit a real disagreement. Acceptable trade; the alternative is the exploit surface.

**Migration path**: one program upgrade. Existing escrows with `dispute_resolver = None` retain their current state — the new rule applies only to `resolve_dispute` calls after upgrade, so in-flight escrows in `Disputed` state may need the off-chain UI to prompt operators to wait for the timeout path. The `@agenomics/mcp-server` dispatch for `resolve_dispute` must surface the new `NoResolverUseTimeout` error and direct the caller to `resolve_dispute_timeout`. Devnet rehearsal mandatory (GOV-6). No data migration; existing accounts unchanged.

## References
- `docs/adr/DEEP-AUDIT-2026-04-22.md` — Audit 1, finding SEC-7
- `docs/adr/ADR-030-dispute-timeout.md` — existing timeout mechanism
- `docs/adr/ADR-026-resolve-dispute-bookkeeping.md` — dispute resolution accounting
- `programs/settlement/src/contexts.rs:216-221`
- `programs/settlement/src/instructions/escrow.rs:39-45`, `instructions/dispute.rs:116`

## Revisions

- 2026-04-25 — Status flipped Proposed → Accepted. The audit caught the Status
  field lying: the enforcement actually shipped. `programs/settlement/src/contexts.rs:249-251`
  enforces `escrow.dispute_resolver.is_some()` on `ResolveDispute`, and the
  symmetric-timeout refund logic is live at `programs/settlement/src/instructions/dispute.rs:121`
  and `:215`. Audit reference: AUD-2026-04-25, drift matrix §3.
