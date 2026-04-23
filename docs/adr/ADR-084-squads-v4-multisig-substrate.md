# ADR-084: Squads v4 as the multisig substrate for AEP governance

## Status
Accepted

## Date
2026-04-23 (backfill — decision is live in production via PR #24, commit `20af7d8`)

## Context

ADR-063 §9 stipulates that AEP governance executes via a multisig substrate but explicitly defers the choice of substrate ("Squads, Realms, or a custom program") to a follow-on ADR. PR #24 (`feat(governance): bootstrap Squads v4 multisig on devnet (2-of-3)`, commit `20af7d8`) and follow-up PR #26 (`fix(governance): recreate Squads devnet multisig after signer key loss`, commit `671f31e`) operationalized that decision by bootstrapping a Squads v4 2-of-3 multisig on devnet, captured in `scripts/bootstrap-squads-devnet.ts` and `scripts/.squads-devnet.json`.

The Squads v4 instance has executed the two SAS-credential bootstrap ceremonies on devnet (PR #34, commit `72e62e4`: `AEP_PROTOCOL` credential create + `AEP_AGENT_REPUTATION_v1` schema create) and is the substrate that ADR-077 (`AEP_VALIDATORS` bootstrap, deferred) and ADR-078 (program upgrade-authority transfer) both build on. Despite the substrate being live and load-bearing, no ADR documented the Squads-vs-Realms-vs-custom reasoning that led to it. This ADR backfills that decision so the corpus and the on-chain reality agree.

## Decision

Adopt **Squads v4** (Squads Protocol v4 multisig program, `@sqds/multisig`) as the AEP multisig substrate for:

1. SAS credential authorities (`AEP_PROTOCOL` 2-of-3 on devnet → 3-of-5 on mainnet per ADR-063 §1.1; `AEP_VALIDATORS` deferred per ADR-077).
2. Future program upgrade authorities (per ADR-078, currently single-key — transfer to Squads multisig pending HUMAN CEREMONY).
3. Any future `ProtocolConfig` admin authority if and when the v2 runtime-updatable config lands per ADR-053 §"v2 Sketch".

Devnet composition: 2-of-3 (operational; per `scripts/.squads-devnet.json`). Mainnet composition: 3-of-5 for `AEP_PROTOCOL` (per ADR-063 §1.1), 5-of-9 for `AEP_VALIDATORS` (per ADR-063 §1.2 when bootstrapped).

## Alternatives Considered

- **Realms (SPL Governance).** Rejected for v1 — Realms is built around token-weighted voting and DAO-style governance with on-chain proposal accounts, voter registrars, and time-locked execution. AEP governance volume (~10–30 proposals/year per ADR-063 §9) does not justify the operational surface area, and AEP explicitly does not have a governance token (per ADR-063 §"Rejected alternatives"). Realms would add dead infrastructure for a multisig-substrate use case that Squads handles directly.
- **Custom multisig program.** Rejected — re-implementing battle-tested multisig logic for AEP-specific needs is a security anti-pattern when Squads v4 is audited, mature, ecosystem-standard, and supports the exact 2-of-3 / 3-of-5 / 5-of-9 thresholds AEP needs out of the box. Maintenance burden on a custom program would compete with protocol work indefinitely.
- **Native multisig (`solana-program::system_instruction` or pure-keypair k-of-n).** Rejected — pure-keypair k-of-n schemes (e.g., raw Ed25519 multisig wrapped at the application layer) lack on-chain provenance and are harder to integrate with the SAS instructions that expect a single signer pubkey representing the credential authority. Squads v4 exposes a `vault` PDA that signs as one entity from the perspective of downstream programs (SAS, BPFLoaderUpgradeable), which is exactly the abstraction AEP needs.
- **Mean Multisig / other Solana multisig programs.** Rejected — Squads v4 has the strongest auditability, the most mature TypeScript SDK (`@sqds/multisig`), and is the de-facto standard for Solana multisig usage as of 2026. Using anything else creates a long-tail dependency risk.

## Consequences

### Positive
- Decision matches on-chain reality (corpus / reality alignment).
- Standard Solana ecosystem substrate with mature SDK and audit history.
- Single substrate covers all current and projected AEP multisig use cases (SAS credential authority, program upgrade authority, future config admin).
- Devnet bootstrap script (`scripts/bootstrap-squads-devnet.ts`) is idempotent and reproducible — a new contributor can recreate the devnet substrate in a single command.

### Negative
- AEP is now load-bearing on the Squads v4 program account remaining live on mainnet for the operational lifetime of any AEP authority that uses it. If Squads ever deprecates v4 in favor of a hypothetical v5, AEP must either migrate (executing the migration via the very multisig being migrated — bootstrapping problem) or accept the residual risk.
- Three-of-three SPOFs (program upgrade authority + SAS credential authority + Squads signer-1 all currently rooted at `BUdXA1Fi…jTXL`) — flagged as Architecture Audit 2026-04-23 Blocker #4 (HUMAN CEREMONY required to separate). This ADR codifies the substrate; ADR-079 (`operator-key-hygiene`) covers the SPOF-separation work.

### Neutral
- The mainnet multisig has not yet been bootstrapped — only devnet (per `scripts/.squads-devnet.json`). Mainnet bootstrap is a HUMAN CEREMONY pending operational readiness (see ADR-078).

## References
- `docs/adr/ADR-063-sas-credential-authority-governance.md` §9 — original substrate-deferral note ("Squads, Realms, or a custom program")
- `docs/adr/ADR-077-aep-validators-credential-bootstrap.md` — `AEP_VALIDATORS` credential, deferred
- `docs/adr/ADR-078-program-upgrade-authority-transfer.md` — program upgrade authority transfer to Squads, pending
- `docs/adr/ADR-079-operator-key-hygiene.md` — SPOF separation context
- `docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md` F-4 / F-5 / F-6 (missing-ADR backfill obligation)
- `scripts/bootstrap-squads-devnet.ts` — devnet bootstrap script (PR #24, commit `20af7d8`)
- `scripts/.squads-devnet.json` — recorded devnet multisig PDA + signer set
- `scripts/bootstrap-sas-credential-devnet.ts` — Squads-signed SAS credential bootstrap (PR #34, commit `72e62e4`)
- `docs/SQUADS_DEVNET.md` — operator-facing devnet substrate documentation
