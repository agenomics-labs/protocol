/**
 * ADR-139 — `Reputation` SDK namespace.
 *
 * Surfaces the portable reputation attestation primitives at the SDK
 * boundary so consumers don't need to depend on
 * `@agenomics/reputation-attestor` directly. The namespace bundles:
 *
 *   - `issue`           — wrap `issueAttestation` with the SDK's idiom
 *   - `verify`          — wrap `verifyAttestation`
 *   - `fromAgentProfile` — Anchor-decoded `AgentProfile` → `AgentProfileSnapshot`
 *   - `Schema` and `Credential` type aliases
 *
 * `Reputation` is a plain object, not a class — there is no state to
 * carry. SDK consumers import it once and call the helpers stateless.
 *
 *   import { Reputation } from "@agenomics/client";
 *   const cred = Reputation.issue(snapshot, { issuer, issuerUrl });
 *   const r = Reputation.verify(cred);
 *
 * The namespace also re-exports the schema constant so callers can pin
 * their `agenomics.reputation.v1` discriminator without a second import.
 */

import type { web3 } from "@anchor-lang/core";
import {
  issueAttestation,
  verifyAttestation,
  verifyAttestationWithChain,
  issuerKeypairFromSecret,
  loadIssuerKeypair,
  REPUTATION_SCHEMA_V1,
  type AgentProfileSnapshot,
  type IssueOptions,
  type IssuerKeypair,
  type ReputationAttestationPayload,
  type ReputationCredential,
  type VerifyOptions,
  type VerifyResult,
  type OnChainProfileFetcher,
} from "@agenomics/reputation-attestor";

// AUD-112-style mirror of `MAX_REPUTATION_SCORE` in agent-registry/lib.rs.
// Re-exported by `registry.ts`; we re-use the constant here so the
// projection clamp matches the on-chain policy without a runtime import
// cycle. Kept inline so `fromAgentProfile` has no dependency on the
// registry client module.
const SDK_MAX_REPUTATION_SCORE = 100;

/**
 * Anchor-decoded `AgentProfile` shape — the subset of fields the
 * snapshot reads. The full account has many more fields; this interface
 * documents only what `fromAgentProfile` touches so callers know exactly
 * which Anchor fields they need to populate when stubbing.
 */
export interface AnchorAgentProfileLike {
  authority: web3.PublicKey;
  reputationScore: { toString(): string };
  reputationStake: {
    stakedAmount: { toString(): string };
    slashCount: number;
  };
  manifestHash: number[];
  registrationNonce: { toString(): string };
}

/** Options for building a snapshot from an Anchor-decoded profile. */
export interface FromAgentProfileOptions {
  /** Profile PDA (base58). */
  agentId: string;
  /** Current slot (decoded as bigint via `rpc.getSlot()`). */
  snapshotSlot: bigint;
  /**
   * Unix-seconds timestamp of the snapshot. Defaults to
   * `Math.floor(Date.now() / 1000)`. Tests pin this.
   */
  snapshotTimestamp?: number;
}

/**
 * Convert an Anchor-decoded `AgentProfile` plus a current slot into an
 * `AgentProfileSnapshot` ready for `Reputation.issue`. Performs the
 * standard transformations:
 *
 *   - `manifestHash` (`number[]` of length 32) → 64-char hex.
 *   - `reputationScore` (BN) → clamped `[0, 100]` `number`.
 *   - `reputationStake.stakedAmount` (BN) → `bigint`.
 *   - `registrationNonce` (BN) → `bigint`.
 *
 * Throws on malformed inputs (wrong manifestHash length, missing
 * fields). The hard-fail path is intentional — a malformed profile
 * snapshot would produce a signed credential that fails verification
 * downstream.
 */
function fromAgentProfile(
  profile: AnchorAgentProfileLike,
  opts: FromAgentProfileOptions,
): AgentProfileSnapshot {
  if (!Array.isArray(profile.manifestHash) || profile.manifestHash.length !== 32) {
    throw new Error(
      `Reputation.fromAgentProfile: manifestHash must be a 32-byte number[], got length ${
        Array.isArray(profile.manifestHash) ? profile.manifestHash.length : typeof profile.manifestHash
      }`,
    );
  }
  const manifest_hash = Array.from(profile.manifestHash, (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const rawScore = BigInt(profile.reputationScore.toString());
  let reputation_score: number;
  if (rawScore <= 0n) reputation_score = 0;
  else if (rawScore >= BigInt(SDK_MAX_REPUTATION_SCORE)) reputation_score = SDK_MAX_REPUTATION_SCORE;
  else reputation_score = Number(rawScore);

  return {
    agent_id: opts.agentId,
    authority: profile.authority.toBase58(),
    manifest_hash,
    reputation_score,
    slash_count: profile.reputationStake.slashCount,
    reputation_stake_lamports: BigInt(profile.reputationStake.stakedAmount.toString()),
    registration_nonce: BigInt(profile.registrationNonce.toString()),
    snapshot_slot: opts.snapshotSlot,
    snapshot_timestamp: opts.snapshotTimestamp ?? Math.floor(Date.now() / 1000),
  };
}

/**
 * Convenience: issue an attestation for an Anchor-decoded profile in
 * one call. Equivalent to
 *
 *   const snap = Reputation.fromAgentProfile(profile, opts);
 *   const cred = Reputation.issue(snap, issueOpts);
 *
 * but saves consumers the two-step dance.
 */
function issueForProfile(
  profile: AnchorAgentProfileLike,
  fromOpts: FromAgentProfileOptions,
  issueOpts: IssueOptions,
): ReputationCredential {
  return issueAttestation(fromAgentProfile(profile, fromOpts), issueOpts);
}

/**
 * `Reputation` — portable reputation attestation namespace.
 *
 * Stateless. Methods mirror `@agenomics/reputation-attestor` 1:1 plus
 * the SDK-flavoured `fromAgentProfile` / `issueForProfile` helpers.
 */
export const Reputation = {
  /** ADR-139 schema discriminator constant. */
  SCHEMA: REPUTATION_SCHEMA_V1,
  /**
   * Issue a signed credential from a pre-built snapshot.
   * See `@agenomics/reputation-attestor` for the canonical contract.
   */
  issue: issueAttestation,
  /** Verify a credential synchronously (no on-chain check). */
  verify: verifyAttestation,
  /** Verify with optional on-chain cross-check. */
  verifyWithChain: verifyAttestationWithChain,
  /** Load issuer key material from env vars. */
  loadIssuer: loadIssuerKeypair,
  /** Build an issuer key from a raw 32-byte Ed25519 scalar. */
  issuerFromSecret: issuerKeypairFromSecret,
  /** Convert an Anchor-decoded `AgentProfile` to a snapshot. */
  fromAgentProfile,
  /** Anchor profile → snapshot → signed credential, in one call. */
  issueForProfile,
} as const;

export type ReputationCredentialType = ReputationCredential;
export type ReputationAttestationPayloadType = ReputationAttestationPayload;
export type {
  ReputationCredential,
  ReputationAttestationPayload,
  AgentProfileSnapshot,
  IssueOptions,
  IssuerKeypair,
  VerifyOptions,
  VerifyResult,
  OnChainProfileFetcher,
};
