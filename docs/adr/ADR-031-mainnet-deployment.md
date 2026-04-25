# ADR-031: Mainnet Deployment Preparation

## Status

Accepted

## Date

2026-04-15

## Context

AEP has been developed and tested on Solana devnet with three on-chain programs (Agent Vault, Agent Registry, Settlement). Deploying to mainnet-beta requires formal procedures for code freeze, key management, deployment execution, post-deployment verification, emergency response, and monitoring. Without documented procedures, mainnet deployment carries risks of misconfiguration, lost upgrade authority, or inability to respond to incidents.

## Decision

1. **Mainnet checklist**: Create `docs/MAINNET_CHECKLIST.md` documenting pre-deployment requirements (code freeze, audit completion, test passing), key management procedures (multi-sig via Squads), deployment steps, post-deployment verification, emergency procedures (vault pause, upgrade freeze), and monitoring setup (Helius webhooks).

2. **Deployment script**: Create `scripts/mainnet-deploy.sh` modeled on `scripts/deploy-devnet.sh` with additional safety checks:
   - Enforces mainnet-beta cluster configuration
   - Requires minimum 20 SOL balance (vs. 10 SOL for devnet)
   - Verifies program ID keypairs match expected values before deployment
   - Requires explicit confirmation prompts before each program deployment
   - Prints SHA-256 hashes of binaries for audit verification
   - Optionally transfers upgrade authority to a configurable multi-sig address (`MULTISIG_ADDRESS` env var)
   - Performs post-deployment verification of all programs

3. **Multi-sig for upgrade authority**: Upgrade authority for all three programs must be transferred to a Squads multisig (minimum 3-of-5) after deployment. The deployer wallet retains no upgrade authority post-transfer.

4. **Monitoring**: Helius enhanced webhooks configured for all three program IDs to stream events to an alerting pipeline with Critical/Warning/Info severity levels.

## Alternatives Considered

1. **Single deployer wallet as upgrade authority** -- Simpler but creates a single point of compromise. Rejected for mainnet.
2. **Immutable programs (no upgrade authority)** -- Maximum security but prevents bug fixes. Rejected; too early in protocol lifecycle.
3. **Timelock on upgrades** -- Adds upgrade delay for community review. Deferred to a future ADR; Squads supports timelocked proposals.

## Consequences

- Deployment to mainnet follows a repeatable, auditable process.
- Upgrade authority is distributed across multiple signers, reducing key compromise risk.
- Emergency procedures are documented before they are needed.
- Monitoring is in place from day one of mainnet launch.
- The deployment script prevents accidental deployment to wrong cluster.

## Files Changed

- `docs/MAINNET_CHECKLIST.md` -- new mainnet deployment checklist
- `scripts/mainnet-deploy.sh` -- new mainnet deployment script

## Revisions

- 2026-04-25 — ADR-080 operationalises this decision and identifies four bugs
  in the deliverable script (local-outside-function, MULTISIG_ADDRESS
  skip-prompt, hash-verification theatre, no source-tree integrity). See also
  ADR-080. AUD-2026-04-25 drift matrix §4.
