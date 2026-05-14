# AUD-410: Delegation grants invariant matrix (ADR-111 v1)

**Date:** 2026-05-14
**ADR:** [ADR-111](../adr/ADR-111-vault-delegation-grants.md)
**Status:** Accepted alongside ADR-111 v1.
**Scope:** `programs/agent-vault/src/` — `DelegationGrant` PDA, the five
new instruction handlers, and the four new on-chain events.

## Purpose

Pin the invariant set every `execute_grant_*` / `create_delegation_grant`
/ `update_delegation_grant` / `revoke_delegation_grant` call MUST
satisfy. ADR-111 §"Enforcement" introduced a dual-gating contract
(grant cap AND vault cap) that is uniquely vulnerable to silent
loosening under a future refactor — this note exists so the invariant
matrix is reviewable independently of the prose ADR.

## Invariants enforced (v1)

### I-1 — Authority surface

| Operation | Acceptable signer(s) |
|---|---|
| `create_delegation_grant` | `vault.authority` (only) |
| `revoke_delegation_grant` | `vault.authority` OR `grant.grantor` OR `grant.grantee` |
| `update_delegation_grant` | `vault.authority` (only) |
| `execute_grant_transfer` | `grant.grantee` (only) |
| `execute_grant_token_transfer` | `grant.grantee` (only) |

Enforced by Anchor `has_one = authority` / `constraint = grant.grantee
== grantee.key()` plus explicit handler-body `require!` on the revoke
path (Anchor `has_one` accepts a single pubkey field; the
three-acceptor matrix is checked in code).

### I-2 — Suspension propagation (ADR-095)

Every state-changing handler in the ADR-111 set gates on
`require_not_suspended(&agent_profile)` BEFORE any state mutation. A
suspended agent cannot:

- Issue new grants (`create_delegation_grant`).
- Move SOL or SPL via existing grants (`execute_grant_*`).

Revoke and update are NOT gated — they shrink scope and are emergency-
response paths.

### I-3 — Pause propagation (ADR-081)

`execute_grant_*` requires `!vault.paused`. Pause is the operator's
emergency stop and MUST propagate through every transfer surface,
including grant-signed ones.

### I-4 — Grant lifecycle gate

`execute_grant_*` requires:

- `!grant.revoked` (raises `GrantRevoked`).
- `grant.is_within_window(now)` — `expires_at == 0 || now <
  expires_at` (raises `GrantExpired`).

### I-5 — Action / recipient gate

- `grant.allows(action_bit)` — `allowed_actions & action_bit ==
  action_bit && action_bit != 0`. Read-only sentinel (`0`) authorizes
  no transfer.
- `grant.is_recipient_allowed(recipient)` — empty list = wildcard;
  non-empty = strict membership.

### I-6 — Cap dominance (load-bearing)

A transfer is accepted iff it satisfies BOTH gates:

- Grant gate: `grant.spent + amount <= grant.spend_cap_lamports` for
  SOL; per-mint analog for SPL.
- Vault gate: `amount <= vault.policy.per_tx_limit_lamports`,
  `vault.spent_today_lamports + amount <=
  vault.policy.daily_limit_lamports`, and the rate-limit window
  consumption.

**Anti-regression:** the fuzz target
`fuzz/fuzz_targets/delegation_grant_policy.rs` asserts on every
iteration that an accepted SOL transfer satisfies BOTH gates and that
a transfer accepted by the grant but rejected by either vault gate
produces the correct `VaultPerTxExceeded` / `VaultDailyExceeded` reject.
The accept condition is the conjunction `grant_ok && vault_ok`; a
refactor that short-circuits vault-side checks when `grant_ok` is true
will fail the fuzz contract.

### I-7 — Create-time cap consistency

`create_delegation_grant` rejects a `spend_cap_lamports` strictly
greater than `vault.policy.per_tx_limit_lamports`. Same rule for each
per-mint cap vs. the vault's `per_tx_limit` for that mint. The grant's
lifetime cap MUST NOT license a SINGLE transfer above the vault's
own ceiling.

### I-8 — Tighten-only update invariant

`update_delegation_grant` is monotonic in the tightening direction:

- `new_allowed_actions ⊆ stored.allowed_actions`.
- `stored.spent_lamports ≤ new_spend_cap_lamports ≤
  stored.spend_cap_lamports`.
- For each per-mint cap: `stored.spent ≤ new.cap ≤ stored.cap`. New
  mints cannot be added through update — re-issue a fresh grant.
- `new_allowed_recipients ⊆ stored.allowed_recipients` when stored is
  non-empty; non-empty → empty (wildcard) is rejected as loosening.
- `new_expires_at`: stored 0 → any new is tightening; stored != 0 →
  `new != 0 && new <= stored`.

### I-9 — Resource ceilings

- `MAX_ACTIVE_GRANTS_PER_VAULT = 32`. Decrement on
  `revoke_delegation_grant`; create returns `TooManyActiveGrants`
  when full.
- `MAX_GRANT_ALLOWED_RECIPIENTS = 8`, `MAX_GRANT_TOKEN_CAPS = 10`.
- `DelegationGrant::SPACE = 1024` bytes including the Anchor
  discriminator. Worst-case serialized payload is ~884 bytes; the
  140-byte headroom is reserved for v2 (sub-delegation link, optional
  SAS credential reference).

### I-10 — Arithmetic safety

Every cap-vs-spent comparison uses `checked_add` (rejects on overflow)
or `saturating_add` (vault per-day rollover only — clamps at u64::MAX,
which is then trapped by the limit comparison). No silent wrap.

### I-11 — Event coverage

The four new events (`DelegationGrantCreated`,
`DelegationGrantRevoked`, `DelegationGrantUpdated`,
`DelegationGrantExecuted`) have:

- Disc-map entries in `src/indexer/index.ts` at the sha256-derived
  hex prefixes.
- Borsh decoders in `EVENT_DECODERS` matching the field declaration
  order on `programs/agent-vault/src/events.rs`.
- Postgres + SQLite projection rows wired in the indexer
  (`delegation_grants` table for current state,
  `delegation_grant_events` for the append-only audit log).

The `scripts/check-event-coverage.ts` gate enforces both presence and
field-order parity on every CI run.

### I-12 — Sub-authority is NOT recursive

V1 grantees CANNOT sub-delegate. A grantee cannot issue a fresh
delegation grant under their own signature; only `vault.authority` can
call `create_delegation_grant`. ADR-111 §"Governance" defers recursive
grants to v2.

## Anti-regression test surface

| Surface | Test | Property pinned |
|---|---|---|
| Rust unit | `tests::adr_111_*` in `lib.rs` | I-5, I-6 (math), I-8 (subset/expiry semantics), I-9 (SPACE bound) |
| Rust fuzz | `fuzz/fuzz_targets/delegation_grant_policy.rs` | I-2, I-3, I-4, I-5, I-6, I-8 — full priority order across the input space |
| TS integration | `tests/agent-vault.ts` "ADR-111: Delegation Grants" | All gates exercised against a live test validator |
| Indexer | `scripts/check-event-coverage.ts` | I-11 |
| Tooling parity | `scripts/check-tools-parity.sh` | MCP tool inventory consistency |

## Open follow-ups

These do NOT block v1 acceptance but are tracked here for visibility.

1. **ADR-111b: `close_delegation_grant`**. Allow rent reclaim for
   grants that are both `revoked` and past `expires_at + 30 days`.
   Same shape as the `close_*` instructions on Settlement.
2. **`max_active_grants_per_vault` in `ProtocolConfig`**. Currently
   hard-coded at 32; move to governance-tunable per the ADR-075
   validation envelope.
3. **Optional SAS credential gate at create time** (ADR-061 +
   ADR-111 open item #3). High-risk grants could require the grantee
   to hold an `AEP_AGENT_REPUTATION_v1` attestation.
4. **Recursive (sub-)delegation** — ADR-111c, deferred until v1 sees
   production use.

## Test plan

- [x] `cargo test -p agent-vault --lib` — 57 unit tests pass.
- [x] `cargo test -p aep-fuzz --bin delegation_grant_policy` — 15
  fuzz smoke-tests pass.
- [x] `bash scripts/check-tools-parity.sh` — 35 MCP tools consistent
  across server / dashboard / README.
- [x] `npx tsx scripts/check-event-coverage.ts` — indexer disc-map
  + decoders cover every on-chain event.
- [ ] `anchor test` against the localnet validator — requires the
  Anchor toolchain (not present in the CI environment that landed
  this acceptance). The ADR-111 TS suite in `tests/agent-vault.ts`
  is staged for the next CI pass that runs with the upgradeable
  loader and registered programs.
