# ADR-081: Emergency-suspend-credential procedure operationalized

## Status
Accepted

## Date
2026-04-23

## Context

ADR-063 §6.1 spells out a single-signer-compromise emergency runbook for SAS credential authorities — declare at T+0, **suspend issuance by T+2h**, **rotate the compromised signer by T+24h**, **publish a retroactive audit by T+7d**, then resume under §3's slow path. The runbook is correct on paper; it is also fiction at the code layer. Architecture-Audit 2026-04-23 punch-list item 3 (sourced from operational-review R-01, originally from Deep-Audit 2026-04-22 Audit 3 gap #8) calls this out:

> Build `scripts/emergency-suspend-credential.ts` — ADR-063 §6.1 currently fiction.

ADR-063 itself acknowledges the gap explicitly under "Pending items before Accept" item #5: *"§6.1's T+2h suspend / T+24h rotate / T+7d audit sequence has no operational script (`scripts/emergency-suspend-credential.ts`), no auditor contact list, no transparency-log publisher for retroactive flagging. The spec exists only on paper."* As long as that script does not exist, the §6.1 emergency path is a runbook nobody can execute under pressure — which means in a real signer-compromise event the operator is reading ADR-063 and writing TypeScript at 3 AM. That is the wrong moment to learn the SAS instruction encoding and the wrong moment to remember which Squads helper takes a `bigint` `transactionIndex`.

ADR-077 §3 (pre-conditions for the T+90 `AEP_VALIDATORS` ceremony) lists "ADR-063 §6.1 emergency runbook scripted (Audit 3 gap #8). The `scripts/emergency-suspend-credential.ts` tool exists and has been rehearsed on devnet" as a hard pre-condition. ADR-077 cannot move forward until this ADR ships; this ADR exists to unblock that chain.

Three constraints shape the script's design:

- **Mirror the existing Squads-flow patterns.** `scripts/bootstrap-sas-credential-devnet.ts` already demonstrates the propose → approve → execute pattern with `@sqds/multisig` against the 2-of-3 devnet vault, including explicit per-stage `confirmTransaction` to defeat fire-and-forget races. The emergency script must reuse that pattern verbatim — not invent a parallel one — so an operator who has run the bootstrap script can read the emergency script without surprises.
- **Idempotency / resumability is non-negotiable.** A 3 AM run that crashes at the `proposalApprove` stage cannot leave the operator stranded; re-invocation must pick up from the on-chain Squads state (`nextIndex`, proposal status) rather than re-creating the proposal at a fresh index. The bootstrap script uses `multisig.accounts.Multisig.fromAccountAddress(...).transactionIndex` for exactly this; the emergency script does the same plus a per-stage proposal-status check.
- **The action records its own paper trail.** §6.1 step 4 (T+24h–T+7d retroactive audit) requires an auditable record of *what was suspended, when, by whom, against which proposal*. Stuffing the result in a JSON log file at write time — capturing the multisig proposal index, every approver's pubkey, transaction signatures, timestamp, and stated reason — is cheap; reconstructing it later from RPC archive queries is expensive and fragile.

What "suspended" means at the SAS layer needs to be unambiguous, because the SAS program does not have a literal `pause_credential` instruction. The decision is captured in §1 of this ADR: suspension is implemented as a multisig-signed `change_authorized_signers` instruction that **clears the credential's authorized signer set to empty**. After execution, only the credential's authority (the multisig vault PDA itself) can issue new attestations under that credential — and the multisig vault can only sign when 2-of-3 (devnet) or 3-of-5 (mainnet) approvals reach quorum. Downstream, `@agenomics/sas-resolver` validates each attestation's `signer` against the credential's authority and authorized-signer list per ADR-061 §3 / ADR-076; with the signer list emptied, any new attestation issued under the compromised signer's pubkey fails resolver validation and is silently dropped from manifest output. No code change is required in the resolver.

This ADR is **operational** — it ships the script (`scripts/emergency-suspend-credential.ts`) plus two stub follow-up scripts (`scripts/rotate-credential-authority.ts` for T+24h, `scripts/audit-suspended-credential-attestations.ts` for T+7d) marked `TODO: implement before mainnet`. The stubs exist so the runbook does not reference scripts that do not exist, which is the failure mode this ADR is written to close.

## Decision

### 1. Suspension semantics at the SAS layer

A "suspended" credential is one whose **authorized signer set is empty** and whose authority is the multisig vault PDA. The state is reached by executing the SAS `change_authorized_signers` instruction with `signers: []` against the credential PDA, signed by the multisig vault.

Operational effect:

- New attestations under the compromised signer's pubkey **cannot be issued** — the SAS program rejects `create_attestation` whose `signer` is not in the credential's authorized signer list (and is not the authority itself).
- The multisig vault PDA *itself* could still sign attestations, but only via a 2-of-3 (devnet) or 3-of-5+auditor-cosign (mainnet, per ADR-063 §3 emergency threshold) ceremony per attestation — operationally equivalent to "no new attestations validated downstream" because that rate is not viable for routine issuance.
- Existing attestations issued before suspension **remain on-chain and validatable**. ADR-063 §6.1 step 4 explicitly does not retroactively revoke; the T+7d audit (§5) flags suspect attestations for downstream consumers but the protocol does not delete them. The `audit-suspended-credential-attestations.ts` follow-up script (§4) produces the flag list.
- Resumption is the inverse: a multisig-signed `change_authorized_signers` instruction restoring the desired signer set. Per ADR-063 §3, resumption requires supermajority (4-of-5 on `AEP_PROTOCOL`, 7-of-9 on `AEP_VALIDATORS`) and a 7-day notice window. Resumption is **not** in the scope of this ADR — it is a routine governance proposal, not an emergency action.

Rejected alternatives for "suspend" semantics:

- **Close the credential PDA.** Permanent, irreversible, requires a fresh credential creation to resume — unacceptable for a procedure designed to be reversible by §3's resume threshold.
- **Rotate authority to a null/sentinel pubkey.** Would suspend issuance but also locks the credential — no party could resume without a fresh ceremony to claim the sentinel-controlled authority. Same irreversibility problem as closing.
- **Set signer list to a single high-friction signer (e.g., the auditor).** Adds a separate trust assumption (auditor availability for issuance) on top of the suspension; conflates "issuance is paused" with "issuance is delegated to the auditor." Cleaner to keep these orthogonal — empty signer list, authority unchanged.

### 2. Operational timeline (mirrors ADR-063 §6.1)

| Timestamp | Action | Who | Script |
|-----------|--------|-----|--------|
| T+0 | Compromise declared. Auditor co-sign pre-fetched. | Multisig member or compromised signer | (none — proposal posted to GitHub Discussions per ADR-063 §2) |
| T+0 to T+2h | **Suspend issuance** — multisig-signed `change_authorized_signers` clearing signer list. | Multisig (simple-majority threshold per ADR-063 §3) + auditor co-sign | `scripts/emergency-suspend-credential.ts` (this ADR) |
| T+2h to T+24h | **Rotate compromised signer** — replace compromised signer with new pubkey on the multisig itself (Squads `multisigAddMember` / `multisigRemoveMember`), then resume the credential's signer set excluding the compromised pubkey. | Multisig (emergency-rotate threshold per ADR-063 §3) + auditor co-sign | `scripts/rotate-credential-authority.ts` (stub follow-up — §4) |
| T+24h to T+7d | **Retroactive audit** — enumerate all attestations issued by the compromised pubkey since last known-good event (default: 30 days). Flag all such attestations in the transparency log. | Auditor + indexer | `scripts/audit-suspended-credential-attestations.ts` (stub follow-up — §4) |
| T+7d | **Resume** under ADR-063 §3 routine-resume threshold (supermajority + 7-day notice). | Multisig | (no dedicated script — uses the `change_authorized_signers` path with the post-rotation signer set; can be a copy-paste of the suspend script with a non-empty signer list) |

### 3. Auditor co-sign requirement

Per ADR-063 §3, the suspension action's threshold is "simple-majority + auditor co-sign." The simple-majority part is enforced on-chain by the multisig program (the threshold is baked into the multisig account at creation). The auditor co-sign is **off-chain** — it is an Ed25519 signature by a designated, pre-registered auditor pubkey over a deterministic message (`"AEP-EMERGENCY-SUSPEND:<credential_pubkey>:<reason_sha256>"`).

The script accepts the auditor co-sign via the `--auditor-cosig <path>` CLI flag (path to a JSON file containing `{ auditorPubkey, signature }`). The script:

1. Reconstructs the expected message from `--credential` and SHA-256 of `--reason`.
2. Verifies the Ed25519 signature using `@noble/curves/ed25519` (already a transitive dep via `@solana/web3.js`).
3. Embeds the signature and auditor pubkey in the JSON log written to `logs/credential-suspend-<timestamp>.json`.

If `--auditor-cosig` is omitted **and** the script is not in `--dry-run` mode, execution refuses. Devnet rehearsal can run with `--dry-run` (which prints the proposal payload without submitting) to test the script flow without an auditor in the loop. **Mainnet runs MUST have a valid auditor co-sign**; devnet rehearsals SHOULD have a valid auditor co-sign (using a rehearsal-only auditor keypair) to exercise the full path. The script does not enforce a different policy by cluster — the operator is trusted to honor the policy because §6.1 is itself a policy document.

The pre-registered auditor pubkey is read from `scripts/.sas-devnet.json` field `governance.auditorCosignPubkey` (added by this ADR — defaults to `null` until the auditor slot is populated per ADR-063 §1.1 slot 3 / §6.1). When `null`, the script refuses outside `--dry-run` mode with a pointer back to ADR-063 "Pending items before Accept" item #2. This is intentional: the script will not let the operator paper over the missing auditor with a self-signed cosign.

### 4. Companion stub scripts

Two stub scripts ship with this ADR. Both are skeletal — they parse CLI args, validate config, and exit with a clear `TODO: implement before mainnet` message. They exist so the §2 timeline does not reference filenames that do not exist on disk.

#### 4.1 `scripts/rotate-credential-authority.ts`

Implements the T+2h to T+24h step. Replaces the compromised pubkey on the underlying Squads multisig (so the compromised signer cannot vote on future proposals) and then re-issues the credential's authorized signer set excluding the compromised pubkey.

CLI shape (see script header):

- `--credential <pubkey>`
- `--compromised-signer <pubkey>`
- `--replacement-signer <pubkey>`
- `--possession-proof <path>` (Ed25519 sig over `"AEP-GOV-ROTATE:<replacement_signer>"` per ADR-063 §4 step 3)
- `--auditor-cosig <path>`
- `--dry-run`

Implementation deferred — the suspend path is the higher-priority emergency (rotate buys time the suspend path has already secured); see TODO list at the bottom of this ADR.

#### 4.2 `scripts/audit-suspended-credential-attestations.ts`

Implements the T+24h to T+7d retroactive audit. Queries the indexer (or `solana getProgramAccounts` against the SAS program directly if the indexer is down) for all `Attestation` accounts with `signer == --compromised-signer` and `created_at >= --window-start`. Writes a flag manifest to `governance/attestation-log/YYYY-MM/flagged-<timestamp>.json` per ADR-063 §7's transparency-log format.

CLI shape:

- `--credential <pubkey>`
- `--compromised-signer <pubkey>`
- `--window-start <iso8601>` (defaults to T-30d from the suspend timestamp recorded in `logs/credential-suspend-*.json`)
- `--output <path>` (defaults to `governance/attestation-log/YYYY-MM/flagged-<timestamp>.json`)

Implementation deferred — depends on the transparency-log publisher (ADR-063 "Pending items before Accept" item #4) being live first. See TODO list.

### 5. Idempotency / resumability

The suspend script is structured as a state machine over the Squads proposal lifecycle:

1. **Read on-chain state** — `multisig.accounts.Multisig.fromAccountAddress` for `transactionIndex`, plus `multisig.accounts.Proposal.fromAccountAddress` (if the proposal account exists at the candidate index) for proposal status.
2. **Decide entry point** — based on proposal status, jump to the next required stage:
   - No proposal at index: start at `vaultTransactionCreate`.
   - Proposal `Draft`: start at `proposalCreate` (rare — `vaultTransactionCreate` should leave it `Active`).
   - Proposal `Active`: start at `proposalApprove` (skip already-recorded approvals by reading `proposal.approved`).
   - Proposal `Approved`: start at `vaultTransactionExecute`.
   - Proposal `Executed`: state machine done — write the JSON log and exit success.
   - Proposal `Rejected` / `Cancelled`: refuse — operator must escalate to a fresh proposal at the next index, which is itself a multisig action requiring out-of-band coordination.
3. **Execute** the missing stages, with explicit `confirmSig` after each (mirroring the bootstrap script).

The on-chain state is the source of truth. The `logs/credential-suspend-<timestamp>.json` file is written **after** the proposal reaches `Executed`, and contains:

```jsonc
{
  "credentialPda": "GvDdPwwqV9wfEaRh1LjLYhjDRFkMxCDRdepVeHGMfRhS",
  "credentialName": "AEP_PROTOCOL",
  "multisigPda": "EHdxwBkcSEcJe3E2UrRwwYozPjqZNe8HZrrBTeU6NPcz",
  "multisigVaultPda": "Exs7cm5dKZNr5c7rBAcq52EHUs7nxDWiZtHXzTEh3LPo",
  "proposalIndex": "3",
  "reason": "signer-compromise: 8xMiCZdgCTB9J244JDiPqkm2yVTQbLuGTc12Qu5AynjB suspected leaked at 2026-04-23T01:14:00Z",
  "auditorCosig": {
    "auditorPubkey": "...",
    "signature": "..."
  },
  "approvers": [
    "BUdXA1FiWnV7ksXYodH3uEhDUhfBJ8g4UmmWdshWjTXL",
    "C1vm83htBDUwbHyBn4GAzwHoKtLeyc13EPW2nc3udvW5"
  ],
  "transactions": {
    "vaultTransactionCreate": "...",
    "proposalCreate": "...",
    "proposalApprove": ["...", "..."],
    "vaultTransactionExecute": "..."
  },
  "suspendedAt": "2026-04-23T01:18:43.291Z",
  "nextSteps": {
    "rotateBy": "2026-04-24T01:18:43.291Z",
    "rotateScript": "scripts/rotate-credential-authority.ts (TODO: implement before mainnet)",
    "auditBy": "2026-04-30T01:18:43.291Z",
    "auditScript": "scripts/audit-suspended-credential-attestations.ts (TODO: implement before mainnet)"
  }
}
```

Re-running the script after a successful execute is a no-op: the script reads `logs/credential-suspend-*.json` for the credential, sees the latest entry has a fully-populated `transactions` block, and exits with `Already suspended at <timestamp>; nothing to do.`

### 6. Transparency-log publication step

Per ADR-063 §7, every suspension event is published to the public append-only feed at `governance/attestation-log/YYYY-MM/`. The suspend script writes a stub entry to `governance/attestation-log/YYYY-MM/suspend-<timestamp>.json` containing the same fields as the JSON log above (minus the `nextSteps` section, which is operator-facing not consumer-facing). The stub entry is a placeholder until the transparency-log publisher (ADR-063 "Pending items before Accept" item #4) is live; once that worker is operational, it will pick up the file on its next run.

The script does not commit or push the file to the protocol repo — that is the publisher's job. It writes locally only. The `governance/` directory is included in the repo path layout (created on first run) but is `.gitignore`'d for the placeholder phase to avoid accidental commits during the rehearsal period; the `.gitignore` line will be removed when the publisher ships.

### 7. CLI shape

```bash
tsx scripts/emergency-suspend-credential.ts \
  --credential GvDdPwwqV9wfEaRh1LjLYhjDRFkMxCDRdepVeHGMfRhS \
  --reason "signer-compromise: <details>" \
  --auditor-cosig /path/to/auditor-cosig.json \
  [--dry-run]
```

If `--credential` is omitted, the script reads `credential.pda` from `scripts/.sas-devnet.json`. If both are present and they disagree, the script refuses (typo-defense).

If `--dry-run` is set, the script:

- Validates the credential pubkey matches the config.
- Constructs the `change_authorized_signers` instruction and the wrapping Squads `vaultTransactionCreate` payload.
- Prints the payload (decoded fields, not raw bytes) to stdout.
- **Does not submit any transaction.**
- Does not require `--auditor-cosig` (rehearsal mode).
- Writes a `logs/credential-suspend-DRY-<timestamp>.json` log marked `dryRun: true` for traceability.

## Alternatives Considered

### Alternative A: Build only the suspend script, no follow-up stubs

**Rejected.** The §2 timeline references rotate and audit scripts. If those names do not exist on disk, the runbook is half-fictional — the same failure mode this ADR is written to close. Stubs with clear `TODO: implement before mainnet` markers are cheap to ship and force the next engineer to either implement or explicitly delete them; either outcome is better than dangling references.

### Alternative B: Implement suspend, rotate, and audit all in one PR

**Rejected.** The suspend path is the urgent emergency primitive — without it, the §6.1 runbook is unexecutable. Rotate is recoverable-from (the suspend has already isolated the compromised signer; rotate just resolves the long-term seat) and audit is inherently retroactive (T+24h–T+7d). Shipping the urgent path now and leaving the recoverable paths as documented stubs is the right priority order; bundling them all delays the urgent piece for no gain. The TODO follow-ups are tracked at the bottom of this ADR.

### Alternative C: Use SAS `close_credential` for suspension

**Rejected.** Closing the credential PDA is irreversible — the PDA cannot be re-opened without a fresh authority-signed `create_credential` ceremony, which requires the same multisig coordination that suspension is trying to avoid time-pressuring. ADR-063 §3 explicitly distinguishes asymmetric suspension (fast in, slow out) from authority compromise (which §6.2 handles via fresh PDA creation). Conflating the two collapses the clean separation §6.1/§6.2 establishes.

### Alternative D: Rotate authority to a sentinel pubkey for suspension

**Rejected.** Rotating authority away from the multisig vault locks the credential — no party can resume without a fresh ceremony to claim the sentinel-controlled authority. Same irreversibility problem as Alternative C, with the added downside that the sentinel pubkey itself becomes a piece of state requiring custody (who controls the sentinel? if nobody, the rotation is a pseudo-close; if someone, that person is now an unaccounted-for signer).

### Alternative E: Manual ceremony with a runbook PDF

**Rejected.** This is the status quo — and it is what Audit 3 gap #8 flagged. A runbook PDF requires the operator to compose Squads transactions by hand under time pressure during an active compromise. The bootstrap script exists precisely because hand-composing Squads transactions is error-prone; the emergency script applies the same reasoning to the emergency path. The runbook PDF should still exist (as ADR-063 §6.1) — but it should reference a concrete script, not be the script.

### Alternative F: Make the script rotate the multisig signer set in the same transaction

**Rejected.** Conflates suspension (action against the SAS credential) with multisig-membership rotation (action against the Squads multisig). They have different threshold profiles per ADR-063 §3 (suspension is simple-majority + auditor; multisig-membership change is the underlying multisig's own threshold), different audit trails (suspension is a transparency-log entry; multisig change is a `multisigConfig` event), and different reversibility profiles. Keeping them as separate scripts (`emergency-suspend-credential.ts` for the SAS action, `rotate-credential-authority.ts` for the Squads action) preserves the clean separation. They are intended to run sequentially in a real emergency, not atomically.

## Consequences

### Positive

- **ADR-063 §6.1 is no longer fiction.** The §6.1 runbook references a concrete script with a defined CLI, a tested idempotency contract, and a published JSON log format. An operator at 3 AM runs the script with the credential pubkey, the reason, and the auditor cosign — and the script handles the Squads ceremony, the SAS instruction encoding, and the audit-trail writing.
- **Resumability under failure.** A script crash mid-ceremony does not orphan the multisig at an in-flight proposal index. Re-running the script reads the on-chain proposal status and resumes from the next required stage. Operators do not need to debug Squads internals to recover.
- **Auditor cosign is enforced.** The script refuses to execute outside `--dry-run` without a valid auditor co-signature, which closes the policy gap where the operator could otherwise self-issue an "emergency" suspension without external oversight.
- **Companion stubs prevent runbook drift.** `rotate-credential-authority.ts` and `audit-suspended-credential-attestations.ts` exist as files even though their bodies are TODO. The next engineer implementing the rotate/audit paths cannot refer to the runbook without seeing the stub; the stub forces them to choose between implementing or deleting, both of which are improvements over dangling references.
- **Unblocks ADR-077.** ADR-077 §3 pre-condition #2 (emergency runbook scripted) is satisfied by this ADR, which removes one of the five mainnet pre-conditions blocking the T+90 `AEP_VALIDATORS` ceremony.
- **Mirrors existing patterns.** No new operational primitives are introduced — the script reuses `proposeApproveExecute` shape, `confirmSig` discipline, and `loadKeypair` / `loadSquadsConfig` helpers from the bootstrap script. An operator familiar with bootstrap can read this script without context-switching.

### Negative

- **Untested against real devnet.** The script ships syntactically correct and unit-tested with mocked Squads RPC, but it has not been run against devnet because no devnet rehearsal is in scope for this PR (the rehearsal is itself an ADR-077 §3 pre-condition that depends on this script existing). First real run carries risk.
- **Auditor cosign infrastructure does not exist yet.** ADR-063 "Pending items before Accept" item #2 (auditor contact registered) is unresolved. The script's `--auditor-cosig` validation works in isolation, but until an auditor is named in `governance.auditorCosignPubkey`, the script is permanently in `--dry-run` mode for any non-rehearsal use. This is intentional (refusing without an auditor) but means the script's full path is not exercisable until that governance gap closes.
- **Stub scripts are dead code until implemented.** `rotate-credential-authority.ts` and `audit-suspended-credential-attestations.ts` are skeletal files that exit with `TODO: implement before mainnet`. They take up review surface and give a false sense of completeness if not read carefully. Mitigated by clear TODO markers and ADR back-references in their headers.
- **Transparency-log file written but not published.** The local `governance/attestation-log/YYYY-MM/suspend-*.json` file is written by the script but not committed/pushed — the publisher (ADR-063 §7, "Pending items before Accept" item #4) does not exist yet. During the rehearsal phase, the file is `.gitignore`'d to prevent accidental commits, which means the rehearsal record is not durable across machine wipes. Acceptable for the rehearsal phase; revisited when the publisher ships.

### Neutral

- **No on-chain program changes.** Suspend is a SAS-program-level action via an existing instruction (`change_authorized_signers`) wrapped in a Squads vault transaction. No `agent-registry`, `agent-vault`, `settlement`, or `mcp-server` changes.
- **No SDK changes.** `@agenomics/sas-resolver` already validates attestation signers against the credential's authorized signer list per ADR-076. Suspension (empty signer list) causes any new attestation under the compromised signer to fail validation and silently drop from manifest output — exactly the behavior the runbook expects, no resolver change needed.
- **CLI shape can evolve.** The `--credential` / `--reason` / `--auditor-cosig` / `--dry-run` flag set is the minimum viable for the emergency path. Future flags (e.g., `--cluster mainnet`, `--multisig-config <path>` for a separate mainnet config file, `--governance-proposal-id AEP-GOV-NNN` for cross-referencing the off-chain proposal) can be added without breaking the existing flag contract.

## TODO follow-ups

The following must be resolved before mainnet — tracked here so they are not forgotten when this ADR is referenced from the §2 timeline:

1. **Implement `scripts/rotate-credential-authority.ts`** — currently a stub. Required for the T+2h–T+24h step of ADR-063 §6.1. Depends on Squads `multisigAddMember` / `multisigRemoveMember` instruction wrapping (the bootstrap script does not exercise these; new ground).
2. **Implement `scripts/audit-suspended-credential-attestations.ts`** — currently a stub. Required for the T+24h–T+7d step. Depends on the transparency-log publisher (ADR-063 "Pending items before Accept" item #4) being live so audit output has a place to land.
3. **Devnet rehearsal** of the suspend script end-to-end. Required by ADR-077 §3 pre-condition #2 to be marked complete. Out of scope for this PR.
4. **Auditor pubkey registered** in `scripts/.sas-devnet.json` `governance.auditorCosignPubkey`. Required for the script to run outside `--dry-run` mode; tracked separately under ADR-063 "Pending items before Accept" item #2.

## References

- `docs/adr/ADR-063-sas-credential-authority-governance.md` §6.1 — the runbook this ADR operationalizes; "Pending items before Accept" item #5 — the gap this ADR closes
- `docs/adr/ADR-061-sas-integration.md` §3 — credential authority model; SAS attestation signer validation
- `docs/adr/ADR-076-sas-resolver-schema-credential-binding.md` — resolver-side enforcement of credential's authorized signer list (downstream effect of suspension)
- `docs/adr/ADR-077-aep-validators-credential-bootstrap.md` §3 pre-condition #2 — this ADR unblocks that ceremony
- `scripts/emergency-suspend-credential.ts` — the script
- `scripts/rotate-credential-authority.ts` — stub follow-up (TODO)
- `scripts/audit-suspended-credential-attestations.ts` — stub follow-up (TODO)
- `scripts/bootstrap-sas-credential-devnet.ts` — pattern template (Squads propose/approve/execute, hand-built SAS instruction encoding, per-stage `confirmSig`)
- `scripts/.sas-devnet.json` — credential PDA registry; will gain `governance.auditorCosignPubkey` field
- `tests/emergency-suspend-credential.test.ts` — Node `node:test` unit suite with mocked Squads RPC
