#!/usr/bin/env tsx
/**
 * STUB — TODO: implement before mainnet. ADR-081 §4.1.
 *
 * Implements the T+2h to T+24h step of ADR-063 §6.1 emergency runbook:
 * after `scripts/emergency-suspend-credential.ts` has cleared the
 * credential's authorized signer set (suspension), this script rotates
 * the compromised signer off the underlying Squads multisig AND restores
 * the credential's authorized signer set to the post-rotation membership.
 *
 * Two on-chain ceremonies, one script:
 *
 *   1. Squads `multisigAddMember` + `multisigRemoveMember` against the
 *      multisig configured in `scripts/.squads-devnet.json`. Threshold
 *      per ADR-063 §3 emergency-rotate row (3-of-5 + auditor cosign on
 *      AEP_PROTOCOL; 5-of-9 + auditor cosign on AEP_VALIDATORS).
 *
 *   2. SAS `change_authorized_signers` against the credential PDA from
 *      `scripts/.sas-devnet.json`, restoring the desired post-rotation
 *      signer set (excluding the compromised pubkey).
 *
 * Pattern to lift:
 *   - Squads propose/approve/execute flow + idempotency state machine
 *     from `scripts/emergency-suspend-credential.ts#runProposalFlow`.
 *     Same shape; the inner instructions differ.
 *   - SAS instruction encoding from
 *     `scripts/emergency-suspend-credential.ts#encodeChangeAuthorizedSignersData`
 *     and `#buildChangeAuthorizedSignersIx`.
 *   - Auditor-cosign verification from
 *     `scripts/emergency-suspend-credential.ts#verifyAuditorCosig`,
 *     adapted to a different cosign message:
 *       "AEP-EMERGENCY-ROTATE:<credential>:<compromised>:<replacement>:<sha256(reason)>"
 *   - Possession-proof verification per ADR-063 §4 step 3:
 *     replacement signer must have signed `"AEP-GOV-ROTATE:<replacement>"`
 *     proving control of the private key. Loaded via `--possession-proof`.
 *
 * CLI shape (when implemented):
 *
 *   tsx scripts/rotate-credential-authority.ts \
 *     --credential <pubkey> \
 *     --compromised-signer <pubkey> \
 *     --replacement-signer <pubkey> \
 *     --possession-proof <path> \
 *     --auditor-cosig <path> \
 *     [--dry-run]
 *
 * Idempotency: same shape as suspend script — read multisig
 * `transactionIndex` and proposal status, resume from the next required
 * stage. Two proposals total (Squads membership change + SAS signer-set
 * restore), so the state machine has two sequential "phases" each with
 * its own propose/approve/execute lifecycle.
 *
 * JSON log: `logs/credential-rotate-<timestamp>.json` capturing
 * proposalIndex(es), approvers, tx sigs, compromised + replacement
 * pubkeys, possession-proof signature, auditor cosign, timestamp,
 * reason. Emits next-step guidance for T+7d audit
 * (`scripts/audit-suspended-credential-attestations.ts`).
 *
 * Why deferred:
 *   - Suspend (the urgent emergency primitive) is the higher-priority
 *     ship — without it, ADR-063 §6.1 is unexecutable. Once suspend has
 *     halted issuance, rotate buys cleanup time.
 *   - This script touches Squads `multisigAddMember`/`multisigRemoveMember`,
 *     which the bootstrap pattern does NOT exercise. New ground; deserves
 *     its own PR with its own dedicated test surface.
 *   - The replacement signer's possession-proof workflow (ADR-063 §4
 *     step 3) is a separate operator-facing step that needs documentation
 *     in the runbook before the script ships.
 *
 * References:
 *   - ADR-081 §2 timeline T+24h row, §4.1 stub spec
 *   - ADR-063 §3 emergency-rotate threshold, §4 step 3 possession proof
 *   - ADR-063 §6.1 step 3 — the runbook this script implements
 *   - scripts/emergency-suspend-credential.ts — pattern source
 */

function fail(): never {
  process.stderr.write(
    [
      '',
      'rotate-credential-authority.ts is NOT IMPLEMENTED.',
      '',
      'This is a stub per ADR-081 §4.1 — TODO: implement before mainnet.',
      'See the script-header comment for the required CLI shape, the patterns',
      'to lift from scripts/emergency-suspend-credential.ts, and the rationale',
      'for the deferral.',
      '',
      'If you need to rotate a compromised signer right now, the manual',
      'fallback is documented in ADR-063 §6.1 step 3 and §4 — Squads',
      'multisigAddMember + multisigRemoveMember executed by the multisig',
      'members directly, followed by a manual SAS change_authorized_signers',
      'instruction (use scripts/emergency-suspend-credential.ts as a template',
      'for the SAS-instruction encoding).',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

if (require.main === module) {
  fail();
}

export {}; // mark module-scoped per tsconfig.json `isolatedModules` posture
