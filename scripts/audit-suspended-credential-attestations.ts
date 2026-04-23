#!/usr/bin/env tsx
/**
 * STUB — TODO: implement before mainnet. ADR-081 §4.2.
 *
 * Implements the T+24h to T+7d step of ADR-063 §6.1 emergency runbook:
 * after suspension (`scripts/emergency-suspend-credential.ts`) and
 * rotation (`scripts/rotate-credential-authority.ts`), this script
 * enumerates every SAS attestation issued by the compromised signer's
 * pubkey within the suspected-compromise window (default: T-30d from
 * the suspend timestamp) and writes a flag manifest to the transparency
 * log per ADR-063 §7.
 *
 * Per ADR-063 §6.1 step 4, the protocol does NOT retroactively revoke
 * affected attestations — revocation is an authority action and the
 * authority may choose to close affected attestations explicitly via a
 * separate ceremony. The flag manifest is consumer-facing: downstream
 * resolvers and consumers honoring suspect attestations is their call,
 * but they need a list to make that call. This script produces the list.
 *
 * Data sources (try in order):
 *
 *   1. Indexer database (`aep-events.db` or remote endpoint configured
 *      via env). Preferred — has pre-decoded attestation data and
 *      `created_at` timestamps. Query: all `Attestation` accounts where
 *      `signer == --compromised-signer` AND `created_at >= window_start`.
 *
 *   2. Direct `getProgramAccounts` against the SAS program (fallback if
 *      the indexer is down or behind). Uses memcmp filters on the
 *      attestation account layout's `signer` field. Slower; rate-limited
 *      by the RPC provider.
 *
 *   3. Off-chain attestation log at `governance/attestation-log/` (last-
 *      resort fallback). Walks the JSON files in the suspected window;
 *      requires the transparency-log publisher to have been running.
 *
 * Output:
 *
 *   `governance/attestation-log/YYYY-MM/flagged-<timestamp>.json`
 *
 *   {
 *     "credentialPda": "...",
 *     "compromisedSigner": "...",
 *     "suspendedAt": "...",         // from logs/credential-suspend-*.json
 *     "windowStart": "...",
 *     "windowEnd": "...",            // = suspendedAt
 *     "flaggedAttestations": [
 *       {
 *         "attestationPda": "...",
 *         "subject": "...",
 *         "createdAt": "...",
 *         "expiry": ...,
 *         "schema": "...",
 *         "signature": "..."         // create-tx sig
 *       },
 *       ...
 *     ],
 *     "consumerGuidance": "These attestations were issued by a key that ...",
 *     "auditedAt": "...",
 *     "auditorPubkey": "..."
 *   }
 *
 * CLI shape (when implemented):
 *
 *   tsx scripts/audit-suspended-credential-attestations.ts \
 *     --credential <pubkey> \
 *     --compromised-signer <pubkey> \
 *     [--window-start <iso8601>]    # default: T-30d from suspendedAt
 *     [--output <path>]              # default: governance/attestation-log/YYYY-MM/flagged-<ts>.json
 *     [--source indexer|rpc|log]    # default: indexer
 *     [--dry-run]
 *
 * Why deferred:
 *   - Depends on the transparency-log publisher (ADR-063 §7, "Pending
 *     items before Accept" #4) being live. Without the publisher, the
 *     output file lives only on the auditor's local machine and provides
 *     no consumer-facing benefit.
 *   - The indexer query path requires deciding whether the indexer
 *     exposes a query API or whether this script reads its SQLite
 *     directly. Both have trade-offs (API: clean dependency boundary;
 *     direct read: simpler but couples to schema). Worth a separate
 *     design discussion before committing.
 *   - The flag manifest's `consumerGuidance` field is a policy
 *     statement, not a code artifact — it needs governance-level
 *     wording sign-off before this script can write it definitively.
 *
 * References:
 *   - ADR-081 §2 timeline T+7d row, §4.2 stub spec
 *   - ADR-063 §6.1 step 4 — the runbook this script implements
 *   - ADR-063 §7 — transparency-log format the output conforms to
 *   - scripts/emergency-suspend-credential.ts — produces the
 *     logs/credential-suspend-*.json file this script reads for `suspendedAt`
 */

function fail(): never {
  process.stderr.write(
    [
      '',
      'audit-suspended-credential-attestations.ts is NOT IMPLEMENTED.',
      '',
      'This is a stub per ADR-081 §4.2 — TODO: implement before mainnet.',
      'See the script-header comment for the required CLI shape, data',
      'sources, output format, and the rationale for the deferral',
      '(depends on the transparency-log publisher being live).',
      '',
      'If you need to audit suspect attestations right now, the manual',
      'fallback is `solana getProgramAccounts <SAS_PROGRAM_ID>` with a',
      'memcmp filter on the attestation `signer` field at the correct',
      'offset (see sas-lib generated/accounts/attestation.ts for the',
      'layout), filtered client-side by `created_at` per ADR-063 §6.1',
      'step 4 ("conservatively: since last known-good event").',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

if (require.main === module) {
  fail();
}

export {}; // mark module-scoped per tsconfig.json `isolatedModules` posture
