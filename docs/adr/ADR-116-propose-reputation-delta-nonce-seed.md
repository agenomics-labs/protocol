# ADR-116: Align `ProposeReputationDelta` context with ADR-097 nonce seed

## Status
Accepted (2026-05-15) — implementation landed in commit `9ebfa4d` (the AUD-001/AUD-002 reputation-policy unification wave) and verified against §Decision items 1-5 below in the 2026-05-15 ADR backlog sweep (issue #71).

## Date
2026-04-24 (proposed) / 2026-05-15 (accepted, retrospective close)

## Context

ADR-097 established that every `AgentProfile` PDA is derived with a
registration nonce (`[authority, b"agent-profile", nonce.to_le_bytes()]`)
so that a deregister→re-register cycle yields a distinct address rather
than reusing the slashed historical one. Every instruction that reads
or writes `agent_profile` must therefore include the owner-nonce
account in its context and use the nonce in its seed derivation.

Re-audit finding **R-onchain-01** reports that
`programs/agent-registry/src/contexts.rs:301-325` (context for
`propose_reputation_delta`, introduced by ADR-094) derives
`agent_profile` with the pre-ADR-097 seed pair
`[authority, b"agent-profile"]`, omitting the owner-nonce account.

Concrete risk: when an authority re-registers (nonce increments from
0 → 1), every other instruction correctly targets the new profile via
the updated seeds. `propose_reputation_delta` would still resolve to
the old profile address or fail constraint. The Settlement CPI path
constructing this instruction would then either (a) hit an
`AccountNotFound` and abort the settlement call, or (b) in the worst
case — if the client is allowed to supply its own profile account
ref — point at a stale address.

This is not exploitable as found (the caller is a CPI from Settlement
using the authority pubkey), but it is a latent break waiting for the
first re-register-and-slash flow.

## Decision

Add the `owner_nonce` account to the `ProposeReputationDelta` context
and update the profile PDA seed to include the nonce bytes. Match the
exact pattern used by `update_reputation`, `propose_reputation_delta`'s
sibling path in `contexts.rs`.

Specifically:
1. Add `owner_nonce` account field, `seeds = [authority.as_ref(),
   b"owner-nonce"]`, `bump`.
2. Change `agent_profile.seeds` from
   `[authority.as_ref(), b"agent-profile"]` to
   `[authority.as_ref(), b"agent-profile",
   &owner_nonce.nonce.to_le_bytes()]`.
3. Add a `has_one = authority` on `agent_profile` to keep the
   invariant explicit.
4. Add a test exercising the flow: `register → propose_delta →
   deregister → register → propose_delta` and assert the second
   `propose_delta` targets the new nonce-1 profile.
5. Regenerate the Registry IDL and commit the diff.

No state migration required — the existing on-chain profiles do not
include a `propose_reputation_delta` side effect that persists.
Settlement's CPI call sites pass the accounts they own; they gain the
owner-nonce reference at the same time.

## Consequences

- Closes the latent break before the first re-register-and-slash
  flow hits it in devnet or mainnet.
- Registry IDL gains one extra account on one instruction.
  Settlement's CPI caller needs the same update (one site:
  `programs/settlement/src/instructions/...`, grep
  `propose_reputation_delta`).
- One-round IDL diff; off-chain SDK (`sdk/client/src/registry.ts`)
  gets the new account as a required argument on
  `proposeReputationDelta()`.

## References

- `docs/adr/ADR-094-reputation-trust-hierarchy-inversion.md` — defines
  `propose_reputation_delta`.
- `docs/adr/ADR-097-registration-nonce-sybil-resistance.md` — nonce
  seed invariant.
- `docs/ARCHITECTURE_REAUDIT_2026-05.md` R-onchain-01.
- `programs/agent-registry/src/contexts.rs:301-325` (affected
  context).

## Implementation verification (2026-05-15)

| §Decision item | Status | Evidence |
|---|---|---|
| 1. `owner_nonce` account field | ✅ | `programs/agent-registry/src/contexts.rs::ProposeReputationDelta` — `pub owner_nonce: Account<'info, OwnerNonce>` with seeds `[authority.key().as_ref(), b"owner-nonce"]` |
| 2. `agent_profile.seeds` includes nonce | ✅ | Same file — seeds now `[authority.key().as_ref(), b"agent-profile", &owner_nonce.nonce.to_le_bytes()]` |
| 3. `has_one = authority` on `agent_profile` | ✅ | `has_one = authority @ AgentRegistryError::UnauthorizedCaller` |
| 4. Re-register-and-slash flow test | ✅ | `tests/cpi-failures.test.ts:109,122,487,505-506` covers the ADR-097 nonce-seed binding for `propose_reputation_delta`; `tests/agent-registry.ts:33` documents the deregister→re-register helper used by tests |
| 5. Registry IDL regen | ✅ | `idl/agent_registry.json` and `sdk/idl/src/idl/agent_registry.json` both carry the `owner_nonce` account on the `proposeReputationDelta` instruction |

Implementation landed via commit `9ebfa4d` *fix(registry,settlement): unify reputation policy + invariant migration (AUD-001, AUD-002)* before this ADR's docs-only PR (#65, `50f9050`/`c264656`) — the audit re-write retro-documented the AUD-001/AUD-002 work as ADR-116. Status was therefore stale (`Proposed`) from the day the ADR landed; this update closes the loop.
