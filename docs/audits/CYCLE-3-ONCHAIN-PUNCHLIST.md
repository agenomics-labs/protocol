# Cycle 3 — On-chain Punchlist (2026-04-27)

Findings from the cycle-3 on-chain hostile re-audit. Five cycle-2 closures
(AUD-100/101/102/104/117) verified held at HEAD; AUD-104 holds with the
field-order caveat in AUD-202. AUD-200 reopens the threat ADR-124 was
supposed to close — **mainnet-promotion verdict from cycle 2 is REVOKED.**

## Source

- Audit: cycle-3 hostile re-audit transcript (security-auditor agent, 2026-04-27)
- Cycle-2 baseline: `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-onchain.md`

## Verified closures (cycle 2 at HEAD)

| ID | State | Evidence |
|---|---|---|
| AUD-100 | **Held** | Slash path live: `programs/agent-registry/src/lib.rs:354-376` increments `slash_count` on `reason in {1,2}`; writes `Suspended` at `>= 3`. Self-suspend blocked at `lib.rs:182-186`. |
| AUD-101 | **Held** | `MigrateAgentProfile` carries `owner_nonce: Account<OwnerNonce>` with full 3-component seeds — `programs/agent-registry/src/contexts.rs:417-458`. E2E covered at `tests/agent-registry.ts:1694+`. |
| AUD-102 | **Held** | `MIN_REPUTATION_DELTA = -10`, `MAX_REPUTATION_DELTA = 10` at `programs/settlement/src/state.rs:101,109`; `update_protocol_config` enforces both. |
| AUD-104 | **Held with caveat** | Discriminator gate at `programs/agent-registry/src/lib.rs:783-786`; tests pin discriminator name only (NOT field-order layout). See AUD-202. |
| AUD-117 | **Held** | All 4 settlement contexts carry `provider_authority` + `provider_owner_nonce` PDA + `provider_profile` PDA with `seeds::program = AGENT_REGISTRY_PROGRAM_ID`. Test case E intentionally skipped — see AUD-203. |

## Critical (mainnet blockers)

| ID | Title | File:Lines | Owner | Status |
|---|---|---|---|---|
| AUD-200 | `update_agent_identity` rotation has no proof-of-control over new `agent_identity` — same threat ADR-124 closed at init is wide open at rotation. Compromised authority rotates to attacker key after 24h cool-down, drains via daily cap. | `programs/agent-vault/src/instructions.rs:203-242`, `programs/agent-vault/src/contexts.rs:120-130` (no `instructions_sysvar`) | k2jac9 | **Closed — `4c2341c`** [^aud200] |

[^aud200]: Symmetric closure of ADR-124's init-leg fix. `UpdateAgentIdentity` context now carries `instructions_sysvar`; `update_agent_identity` handler accepts `new_agent_identity_signature: [u8; 64]` and calls `identity_bind::verify_ed25519_precompile` over `vault_identity_bind_message(authority, new_agent_identity)` BEFORE the rotation rate-limit check. Mirrors `initialize_vault`'s call chain at `instructions.rs:98-102` exactly. 4 new test cases (happy path + 3 rejection paths: wrong-message, missing precompile ix, precompile-pubkey vs handler-arg mismatch). MCP `rotate_agent_identity` handler updated to bundle the Ed25519 precompile ix; SDK consumers get the new shape via IDL regen. Anchor full integration suite: 160 passing.

## High (block next release)

| ID | Title | File:Lines | Owner | Status |
|---|---|---|---|---|
| AUD-201 | Stuck-Active escrow refund gap — provider accepts then abandons; only refund path is `expire_escrow` after 365-day deadline. With dispute timeout the worst-case lock is up to 730 days. `cancel_escrow` is `Created`-only. | `programs/settlement/src/instructions/escrow.rs:360-410` | _unassigned_ | Open |
| AUD-202 | AUD-104 closure pins discriminator name but NOT field-order layout. Settlement prepending a field to `ProtocolConfig` would leave the discriminator unchanged but shift `authority` past offset 8 → Registry reads garbage as `config_authority`, silently rejects every legitimate sweep. | `programs/agent-registry/src/lib.rs:773-798`; tests `lib.rs:2079-2135` | _unassigned_ | Open |

## Medium (next-cycle)

| ID | Title | File:Lines | Status |
|---|---|---|---|
| AUD-203 | AUD-117 case E (ResolveDisputeTimeout substitution) intentionally untested per `tests/cpi-failures.test.ts:1255-1270`; defense-in-depth claim is asymmetric — only 3 of 4 contexts have negative-path proof. | `tests/cpi-failures.test.ts:1255` | Open |
| AUD-204 | ADR-125 (`rotate_protocol_config_authority`) is `Proposed` and explicitly deferred to post-launch. `ProtocolConfig.authority` is operationally entangled with the BPF upgrade authority forever post-init; wrong-bind at `initialize_protocol_config` has zero recovery short of redeploy. | `programs/settlement/src/instructions/protocol_config.rs:18`, `docs/adr/ADR-125-rotate-protocol-config-authority.md` | Open |

## Architecture (calibration)

| ID | Title | File:Lines | Status |
|---|---|---|---|
| AUD-205 | Sybil economics: with `\|delta\|<=10` and `slash_count>=3` for Suspended, a sybil agent absorbs 3 dispute losses (~score 85) before suspension. Per-agent slash cost amortizes below per-task escrow value if escrow > 3× rent + 3× per-loss opportunity-cost. ADR-097 owner-nonce raises authority-reuse cost; new authorities cost nothing. | `programs/agent-registry/src/lib.rs:21,358`, `state.rs:83-85` | Open |

## Low (paper-cut)

| ID | Title | File:Lines | Status |
|---|---|---|---|
| AUD-206 | `propose_reputation_delta` accepts calls on `status == Retired` profiles; `slash_count` increments forever, events emitted on closed-state agent. Doesn't break invariants but fills indexer noise. | `programs/agent-registry/src/lib.rs:296-392` | Open |

## Mainnet-promotion gates

- **Critical**: AUD-200 ✅ closed `4c2341c` (rotation proof-of-control mirrors ADR-124 init flow)
- **High**: AUD-201, AUD-202 closed
- **ADR-125 (AUD-204)**: ship the propose/accept rotation before mainnet (C4 runbook §4 lists 3 redeploy-only recovery scenarios without it)

Architecture themes (carry to ADR governance): require ADR closure to demonstrate *symmetric* coverage of init + mutation surfaces (the ADR-124 → AUD-200 lesson).
