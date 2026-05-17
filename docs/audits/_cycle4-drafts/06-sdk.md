# Cycle-4 Security Audit — SDK (`sdk/idl`, `sdk/client`, `sdk/action-runtime`)

Branch: `audit-baseline` @ `b8fe80b` (origin/main). READ-ONLY review.
Scope lens: ADR-141 codama trust, ADR-087 @solana/kit migration, IDL↔program
drift, action-runtime input validation / capability boundary, public-API
mis-use risk, transitive dependency risk.

---

## IDL-Drift Verdict — NO DRIFT (verified)

`sdk/idl/src/idl/*.json` are **byte-identical** (after JSON canonicalisation)
to both the committed source-of-truth `idl/*.json` and a fresh
`anchor build` output in `target/idl/*.json` (rebuilt 2026-05-16):

- `address` in each IDL == the `declare_id!()` in the matching
  `programs/*/src/lib.rs` (agent-registry `psJT…Nyv`, agent-vault `28Km…YYw`,
  settlement `9TRVbw…UF95`, cctp-hook `3yifM…14vb`). All four match.
- Instruction-name sets match program `pub fn` handler sets exactly:
  agent-vault 16/16, settlement 14/14, agent-registry 12/12 (the extra
  Rust `pub fn`s `tagged_manifest_hash` / `verify_ed25519_precompile` /
  `vault_identity_bind_message` are helper fns, not `#[program]`
  instructions — correctly absent from the IDL).
- Security-critical arg shapes verified: `execute_transfer(amount_lamports:
  u64, tool_id_hash: [u8;32])` and `execute_token_transfer(amount: u64,
  tool_id_hash: [u8;32])` in `sdk/idl/src/idl/agent_vault.json` match
  `programs/agent-vault/src/lib.rs:207-241` byte-for-byte (ADR-138).
- Drift is gated in CI: `.github/workflows/ci.yml` job S-xcut-03 runs
  `anchor build` then `scripts/check-idl.sh`, which hard-fails on any
  `diff` between `target/idl/*.json` and committed `idl/*.json`
  (`scripts/check-idl.sh:46-58`).

Conclusion: SDK IDL artifacts faithfully reflect the declared on-chain
program interfaces at this commit. No mis-encoding / fund-risk surface
from stale IDL.

---

## Findings

### F1 — `mainnet-beta` resolves to placeholder devnet program IDs (HIGH)

- File: `sdk/idl/src/index.ts:9-25`
- The `PROGRAM_IDS` record returns **byte-identical** program IDs for
  `devnet`, `mainnet-beta`, and `localnet`. `getProgramIds("mainnet-beta")`
  returns the devnet/test deployment addresses.
- Scenario: an integrator wires a production app with
  `new AepClient({ cluster: "mainnet-beta", ... })`, trusts the returned
  `settlement` ID, and constructs escrow / transfer transactions against a
  program whose upgrade authority is **not** the governance multisig. A
  compromised or rug-pulled test upgrade authority can drain or freeze
  escrowed funds. The API shape (`Cluster` union including `"mainnet-beta"`)
  actively implies a distinct, governance-controlled mainnet deployment
  that does not exist.
- The README (`sdk/idl/README.md:58-65`) documents this as the "AUD-207
  caveat", but the *code* and *type surface* carry no guard — a builder
  who does not read the README has no signal. Documentation is not a
  control for a fund-loss path.
- Fix: until the Track-A2 / ADR-083 keypair ceremony lands, either (a)
  remove `"mainnet-beta"` from the `Cluster` union and the `PROGRAM_IDS`
  record so the type system rejects production use, or (b) have
  `getProgramIds("mainnet-beta")` throw
  (`Error("mainnet-beta program IDs not yet provisioned — see ADR-083")`).
  Prefer (b): fail-closed, loud, at the call boundary.
- ADR-needed? Tracked by AUD-207 / ADR-083; this finding argues the
  *interim* state must be fail-closed in code, not doc-only. Recommend an
  ADR addendum mandating fail-closed placeholder-ID behaviour for any
  un-provisioned cluster.

### F2 — ADR-141 codama generation NOT adopted; hand-written wrappers remain the trust root (MEDIUM)

- Files: `sdk/client/src/{registry,vault,settlement,cctp-hook}.ts`;
  ADR-141 `Status: Proposed` (`docs/adr/ADR-141-codama-generated-anchor-clients.md`).
- The audit prompt asks whether codama-generated client code is
  reviewed/pinned. Finding: **codama is not used anywhere in `sdk/`** —
  no `codama` dep in any `sdk/*/package.json`, no generated client. The
  ADR is Proposed only. So there is no generation-time supply-chain
  surface today (good), but the *current* trust root is hand-coded PDA
  seeds and account decoders that mirror the on-chain Rust "by convention
  only" (ADR-141 Context, drift-risk #1).
- Residual risk: seed strings (`"vault"`, `"agent-profile"`, `"escrow"`,
  `"delegation"`, `"protocol_config"`, `"hook_signer"`, `"hook-replay"`),
  nonce endianness (`setBigUint64(..., true)`), and the
  `VAULT_IDENTITY_BIND_DOMAIN` 27-byte tag are all pinned by hand. A
  silent on-chain seed reorder would derive a valid-looking but wrong
  (un-owned) PDA — the same class of bug AUD-003 already caught
  (`vault.ts:308-313`, `settlement.ts:74-82` document the prior reversal).
  These are currently covered by `pda-equivalence.test.ts` /
  `vault-identity-bind.test.ts`, but the tests assert against constants
  in the *same* package, not against the program — they cannot catch a
  coordinated rename.
- Scenario: a future PR renames an on-chain seed and the IDL gate (which
  only diffs IDL JSON, not PDA seed *strings* — seeds are not in the IDL)
  passes green while the SDK silently derives wrong PDAs.
- Fix: when ADR-141 moves to Accepted, pin the codama version + a
  lockfile-integrity check and review the generated output in-tree
  (do not `.gitignore` it). Interim: add a cross-package test that
  derives a PDA via the SDK and asserts equality against a value produced
  by the on-chain program / a Rust test vector (not an SDK-local
  constant), closing the seed-rename gap the IDL gate cannot see.
- ADR-needed? Yes — ADR-141 should be progressed or explicitly deferred
  with an interim seed-parity test mandate recorded.

### F3 — `defineAction` / `wrap` capability boundary performs no input validation and leaks raw error strings (MEDIUM)

- File: `sdk/action-runtime/src/index.ts:13-41`
- `defineAction` wraps a handler in `wrap()`, which on rejection returns
  `err(e instanceof Error ? e : new Error(String(e)))`. There is **no
  input validation, no schema enforcement, and no capability/authorization
  check** at this boundary — `defineAction` is a thin try/catch. The
  type parameter `TInput` is erased at runtime; a handler receives whatever
  the caller passes.
- `String(e)` on a non-Error rejection (and the `Error` instance itself,
  whose `.message`/`.stack` flows back through the `Result`) can carry
  RPC endpoint URLs, keypair-path strings, or provider internals to an
  untrusted caller of the action. The README presents this as the
  capability-handler runtime; integrators will reasonably assume it
  enforces a boundary it does not.
- Scenario: a capability author writes
  `defineAction({ handler: (i) => transfer(i.amount, i.to) })` assuming
  the runtime validates `i`; a caller passes a negative/over-u64 `amount`
  or a hostile `to`, and the only defence is whatever the downstream
  on-chain program happens to enforce. Defence-in-depth is absent at the
  SDK layer that *advertises* itself as the action runtime.
- Fix: document explicitly (README + JSDoc) that `defineAction` performs
  NO validation and the handler owns all input validation + authz; or add
  an optional `validate?: (i: unknown) => TInput` hook to `ActionSpec`
  that runs before `handler` and short-circuits to `err`. Additionally,
  sanitise the error surface (return a stable `code` + safe message;
  log the raw error internally) so action output cannot exfiltrate
  environment internals to an untrusted consumer.
- ADR-needed? Yes — a small ADR fixing the action-runtime
  validation/authz contract and error-sanitisation policy.

### F4 — `idl-types.d.ts` couples published SDK type-safety to an uncommitted build artifact (LOW)

- File: `sdk/client/src/idl-types.d.ts:15-17` →
  `../../../target/types/{agent_registry,agent_vault,settlement}`
- The typed `Program<AgentRegistry>` guarantees (the entire ADR-088
  type-safety story) depend on `target/types/*.ts`, which is produced by
  `anchor build` and is **git-untracked** (confirmed: not in
  `git ls-files`). If `anchor build` is skipped or stale, `tsc` either
  fails (build dependency documented in the `.d.ts` header) or, worse,
  a stale `target/types` silently types the client against an old program
  shape while the runtime IDL (passed at construction) is current →
  unchecked-deserialization risk if a field type changed.
- Note: `cctp_hook` has no entry here, and `agent_vault.ts` casts
  `this.program.account as any` for `delegationGrant`
  (`vault.ts:403-417`) — the ADR-111 delegation-grant fetch/`all()` path
  is **untyped** (`as any`), bypassing the ADR-088 guarantee for exactly
  the funds-bearing delegation surface. `memcmp` offset 8 is asserted by
  comment only.
- Scenario: a `DelegationGrant` field reorder (e.g. `allowedActions`
  moves) changes the offset; `vault.ts:419` `memcmp.offset: 8` and the
  `as any` decode return wrong/empty results with no compile-time signal,
  causing `fetchAllDelegationGrantsForVault` to miss active grants in a
  revocation-audit UI.
- Fix: type the `delegationGrant` accessor against the generated
  `AgentVault` type (it exists in `target/types/agent_vault`) instead of
  `as any`; add a test that asserts the `DelegationGrant.vault` byte
  offset from the IDL rather than a hard-coded `8`. Ensure CI ordering
  guarantees `anchor build` precedes `sdk/client` typecheck (it does in
  `ci.yml` S-xcut-03, but the SDK build job dependency should be made
  explicit).
- ADR-needed? No — implementation hardening.

### F5 — Transitive / supply-chain surface (LOW / INFO)

- Files: `sdk/client/package.json:46-51`
- Runtime deps: `@coral-xyz/anchor ^0.31.0`, `@solana/kit 6.8.0`
  (pinned — good), `@agenomics/idl *`, `@agenomics/reputation-attestor *`.
  `^0.31.0` on anchor is a caret range on a security-sensitive
  (de)serialisation lib; a malicious/broken 0.31.x patch is auto-accepted.
- `@agenomics/reputation-attestor` (re-exported wholesale via
  `reputation.ts` into the public `Reputation` namespace, incl.
  `loadIssuer` / `issuerFromSecret` key-material handling) is consumed at
  `"*"`. Checked: it ships **no `postinstall`** hook (the branch name's
  `postinstall` concern does not implicate the SDK dependency chain).
  Still, `"*"` provides zero version floor for a package that performs
  Ed25519 signing of reputation credentials.
- `npm audit` could not be run (workspace has no per-package lockfile;
  `ENOLOCK`) — transitive CVE posture for the SDK packages is unverified
  here and depends on the root unified lockfile (ADR-089).
- Fix: pin `@coral-xyz/anchor` to an exact version (match the
  `anchor build` toolchain, 0.31.1); replace `"*"` workspace ranges with
  `workspace:^0.1.0` (or exact) so a future independent publish of
  `@agenomics/reputation-attestor` cannot float the signing dependency.
  Wire `npm audit --workspaces` (or osv-scanner) against the root
  lockfile into CI for the `sdk/*` packages before the 0.1.0 publish.
- ADR-needed? No — covered by ADR-089 lockfile discipline; add SDK
  packages to the audit gate.

### F6 — `clampReputationScore` / `fromAgentProfile` rely on a hand-mirrored constant (INFO)

- Files: `sdk/client/src/registry.ts:52` (`MAX_REPUTATION_SCORE = 100`),
  `sdk/client/src/reputation.ts:57` (`SDK_MAX_REPUTATION_SCORE = 100`)
- Two independent copies of the on-chain `MAX_REPUTATION_SCORE`
  (`programs/agent-registry/src/lib.rs:17`) are hand-pinned in two SDK
  modules. Not a vulnerability (clamp is total and fail-safe — `registry.ts:95-100`),
  but a divergence (on-chain raises the cap, SDK does not) would silently
  cap a legitimately high score in every consumer UI. Low impact
  (presentation only, no fund path), flagged for the same drift-class
  reason as F2.
- Fix: single-source the constant (export from one module, import in the
  other) and add a test asserting it equals the value the IDL/program
  exposes.
- ADR-needed? No.

### Positive findings

- IDL drift is structurally prevented by a CI hard-gate
  (`scripts/check-idl.sh` + `ci.yml` S-xcut-03) — strong control.
- ADR-087 @solana/kit migration is clean: no direct `@solana/web3.js`
  dependency; `PublicKey` reached only via Anchor's `web3` re-export at
  the Anchor boundary; `@solana/kit` pinned exactly (`6.8.0`).
- Strong, explicit input validation on the wire-format encoders:
  `encodeReflexHookPayload` (`cctp-hook.ts:67-117`) and
  `buildVaultIdentityBindInstruction` (`vault.ts:217-273`) validate every
  length/range and even add unreachable defence-in-depth assertions; PDA
  helpers validate `nonce` u8 range and `baseTxHash` length before
  derivation.
- Domain-separation is correctly pinned and documented
  (`VAULT_IDENTITY_BIND_DOMAIN` vs `MANIFEST_HASH_DOMAIN`,
  `vault.ts:116-137`) with the replay rationale spelled out.
- AUD-003 nonce-endianness regression is fixed and documented with the
  exact `u64::to_le_bytes()` rationale; constructor program-ID/IDL
  mismatch is hard-checked in all three clients.
- `clampReputationScore` is total and fail-safe over `bigint`
  (handles negative, > MAX_SAFE_INTEGER) — good defensive contract.

---

## Severity summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 1 (F1) |
| Medium   | 2 (F2, F3) |
| Low      | 2 (F4, F5) |
| Info     | 1 (F6) |
