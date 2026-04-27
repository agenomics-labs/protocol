# ADR-124: Vault `agent_identity` Proof-of-Control at Init (AUD-116)

## Status

Accepted (cycle-3 implementation landed 2026-04-26).

## Date

2026-04-26 (proposed); accepted same day on the cycle-3 implementation
commit.

## Context

Cycle-2 audit AUD-116 surfaced an under-protected seam in
`agent-vault::initialize_vault`: the `agent_identity` parameter is
bound from a caller-supplied `Pubkey` argument with no proof that the
caller controls the corresponding private key.

**Concrete threat**: an authority who supplies the wrong public key
(operator error, spoofed input from a malicious off-chain helper, or
key-confusion across a multi-vault deployment) carries that mis-bound
key permanently. Every `execute_transfer` and `execute_token_transfer`
accepts a signature from either the vault `authority` OR the bound
`agent_identity` (see `programs/agent-vault/src/instructions.rs:314,
435`), so a mis-bound hot key can drive vault spending under policy
until the authority issues `update_agent_identity`.

**Existing mitigations** (already in place, per ADR-069 and PR-X /
AUD-023):

  - The first `update_agent_identity` call is unrestricted
    (`last_rotation_at == 0` rate-limit short-circuit). If the wrong
    key was bound, the authority can rotate to the right one
    immediately.
  - Subsequent rotations are gated by a 24h sliding window.
  - Per-tx, per-day, and rate-limit spending policies cap the maximum
    blast radius regardless of who holds the hot key.

**Residual surface**: the window between `initialize_vault` and the
first `update_agent_identity` is bounded by spending policy, not by
a key-control proof. An authority who init-mis-binds absorbs at most
one spending-policy window of damage before the unrestricted first
rotation closes the gap.

The cycle-2 audit explicitly allowed two paths to closure: (a)
require an Ed25519 signature at init time, or (b) accept the threat
explicitly in the SECURITY model and call it out in `initialize_vault`
docs. The 2026-04-26 closure took path (b) via an inline doc-comment
on the handler. This ADR records the path-(a) design for cycle-3
implementation.

## Decision

When path (a) is implemented, mirror the existing manifest precompile
pattern in `agent-registry::lib.rs::manifest::verify_ed25519_precompile`:

  1. Add a new context field to `InitializeVault`:
     ```rust
     #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
     pub instructions_sysvar: AccountInfo<'info>,
     ```

  2. Define a vault-specific domain tag analogous to
     `MANIFEST_HASH_DOMAIN`:
     ```rust
     pub const VAULT_IDENTITY_BIND_DOMAIN: &[u8] = b"AEP_VAULT_IDENTITY_BIND_V1\x00";
     ```

  3. Bind the signed message to `(authority, agent_identity)` so a
     captured signature cannot be replayed against a different
     authority's vault init or used to bind a different `agent_identity`
     to the same vault:
     ```rust
     pub fn vault_identity_bind_message(
         authority: &Pubkey,
         agent_identity: &Pubkey,
     ) -> [u8; 32] {
         hashv(&[
             VAULT_IDENTITY_BIND_DOMAIN,
             authority.as_ref(),
             agent_identity.as_ref(),
         ]).to_bytes()
     }
     ```

  4. Add an `agent_identity_signature: [u8; 64]` parameter to
     `initialize_vault`. After the existing state init, call a new
     vault-side `verify_ed25519_precompile` helper (byte-for-byte
     mirror of the agent-registry helper, but pointing at the new
     domain tag) to assert the precompile sig over
     `vault_identity_bind_message(authority, agent_identity)` matches
     `agent_identity_signature` and `agent_identity`.

  5. Add error variants:
     ```rust
     MissingAgentIdentityBindSignature,
     AgentIdentityBindSignatureMismatch,
     ```

  6. Off-chain (mcp-server, SDK, integration tests): every caller of
     `initialize_vault` constructs the Ed25519 precompile instruction
     using `Ed25519Program.createInstructionWithPublicKey` (or the
     `@noble/curves/ed25519` path the project already uses for tests
     in `tests/emergency-suspend-credential.test.ts`) and prepends it
     to the transaction. The signature is computed by the holder of
     the `agent_identity` private key over the domain-tagged message.

## Consequences

  - Closes AUD-116 at the protocol level: a wrong-key bind becomes
    impossible because the authority cannot produce a valid signature
    from a key it does not control. The 24h-rotation protection
    becomes a defense for a different threat (compromised authority
    rotating) instead of a recovery mechanism for init-mis-bind.

  - Increases the required transaction size (one extra ed25519 ix
    + 64-byte signature + the introspection bytes the precompile
    needs). Solana's per-tx limits accommodate this comfortably; the
    manifest path already pays the same cost.

  - Forces every off-chain caller to have access to the `agent_identity`
    private key at vault-init time. The current flow already assumes
    this (the off-chain agent runtime's signing key is one and the
    same as `agent_identity`), so no architectural change is required.

  - Test surface impact: ~9 `initializeVault(...)` call sites in
    `tests/agent-vault.ts` and at least one in
    `mcp-server/src/handlers/`. Each needs a small wrapper that
    builds the message, signs it, prepends the precompile ix, and
    passes the signature as the new parameter. Estimated 2-4 hours
    of work paired with careful cargo + ts-test runs.

  - Coordination with the SDK: `sdk/client/src/vault.ts` (or the new
    handlers-v2 vault path) needs the same ix-construction helper.
    Adding it there at the same time avoids a flag-day where mcp-server
    and SDK construct the bind ix differently.

## Implementation Notes (cycle-3 closure)

What landed verbatim from the Decision section:

  - `VAULT_IDENTITY_BIND_DOMAIN = b"AEP_VAULT_IDENTITY_BIND_V1\x00"` and
    `vault_identity_bind_message(authority, agent_identity)` in
    `programs/agent-vault/src/lib.rs`. Domain separation pinned by
    `adr_124_domain_differs_from_registry_manifest_domain` unit test.
  - New `pub mod identity_bind` in the same file vendoring
    `verify_ed25519_precompile` — byte-for-byte port of
    `agent_registry::manifest::verify_ed25519_precompile` (no cross-program
    dependency, matching the settlement / registry reason-code constants
    pattern).
  - `instructions_sysvar` field on `InitializeVault` (address-pinned to
    `sysvar::instructions::ID`) and `agent_identity_signature: [u8; 64]`
    parameter on `initialize_vault`.
  - Two new error variants on `VaultError`:
    `MissingAgentIdentityBindSignature` (no neighbouring ed25519 ix) and
    `AgentIdentityBindSignatureMismatch` (precompile present but pubkey /
    signature / message bytes mismatched, OR malformed precompile data).

What landed off-chain to keep all callers in lockstep:

  - `mcp-server/src/handlers/vault.ts::handleCreateVault` now resolves the
    `agent_identity` signer via two branches: (1) self-bind (default) where
    `agent_identity == wallet.publicKey` and the wallet's secret key signs
    the bind message; (2) operator-managed where the caller supplies
    `agentIdentitySecretKey` (base58 64-byte secret OR `number[64]`). The
    handler builds the bind message + ed25519 precompile ix server-side
    and prepends it to the `initialize_vault` tx. Secret key material
    never leaves the process.
  - `mcp-server/src/actions/vault.ts` adds the optional
    `agentIdentitySecretKey` zod field with the union-of-shapes schema and
    explicit length / charset rejection. `mcp-server/src/tools/vault.ts`
    mirrors the same surface in the JSONSchema tool descriptor.
  - `sdk/client/src/vault.ts` exports `VAULT_IDENTITY_BIND_DOMAIN`,
    `vaultIdentityBindMessage(authority, agentIdentity)`, and
    `buildVaultIdentityBindInstruction({agentIdentity, message,
    signature})` — the typed off-chain mirror of the on-chain
    constants/helpers.

Test additions per surface:

  - **Program (Rust unit)**: 4 new tests in
    `programs/agent-vault/src/lib.rs` cover bind-message domain
    application, per-leg injectivity, registry-domain divergence, and
    domain-tag byte-shape pinning.
  - **On-chain integration (TS)**: 4 new tests in
    `tests/agent-vault.ts` under
    `describe("ADR-124 / AUD-116 (path-a): agent_identity proof-of-control"`):
    happy path, wrong-signer rejection, missing-precompile rejection, and
    untagged-message replay rejection. The 11 pre-existing
    `initializeVault` call-sites updated to use a new
    `initVaultWithBindProof()` helper that encapsulates the four-step
    coupling (message → signature → precompile ix → handler arg).
  - **mcp-server (`node:test`)**: 17 new tests in
    `mcp-server/test/create-vault-bind-proof.test.ts` cover action / tool
    / router registration, schema acceptance of self-bind / base58 /
    number[64] shapes, schema rejection of malformed shapes, and the
    `sign:vault` capability gate.
  - **SDK (`node:test`)**: 12 new tests in
    `sdk/client/test/vault-identity-bind.test.ts` cover domain-tag
    byte-shape pinning, message determinism + per-leg injectivity,
    cross-protocol replay defense at both the domain and digest layers,
    and instruction-builder length validation.

All four packages built clean (`cargo test -p agent-vault`,
`anchor build`, `npm test --prefix sdk/client`,
`npm test --prefix mcp-server`); the full `anchor test` suite passes
156 tests, 3 pending (pre-existing skips).

## References

  - `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-onchain.md` — AUD-116
    finding and the cycle-2 audit's "either/or" recommendation.
  - `docs/audits/ARCHITECTURE-AUDIT-2026-04-25.md` AUD-020 — cycle-1
    precursor that flagged the same threat.
  - ADR-069 — `update_agent_identity` rotation flow (the existing
    mitigation this ADR complements at the init seam).
  - ADR-060 / ADR-092 — manifest hash domain separation; the
    canonical precedent this ADR mirrors.
  - `programs/agent-registry/src/lib.rs` `manifest::verify_ed25519_precompile`
    — the byte-for-byte template for the vault-side helper.
  - `mcp-server/src/handlers-v2/keypair-signer.ts` — existing
    `@noble/curves/ed25519` usage that the off-chain caller can reuse.
