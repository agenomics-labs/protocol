// ADR-139 — portable reputation attestation schema.
//
// A `ReputationAttestation` is a signed snapshot of an `AgentProfile`'s
// reputation-bearing fields at a specific Solana slot. It is the
// transport-format primitive that lets a third party verify, in one
// Ed25519 signature check, that a given agent has score X / slash count
// Y on Agenomics at snapshot slot Z — without trusting a centralised
// API and without re-reading Agenomics on-chain state.
//
// Wire format (RFC-8785 canonical-JSON of `ReputationAttestationPayload`,
// Ed25519-signed by the issuer key, packaged as `ReputationCredential`).
//
// Schema identifier: `agenomics.reputation.v1`. New schema versions are
// new identifiers; the field set MUST NOT be mutated under v1 because the
// canonical-JSON preimage is stable across producers.

import { z } from "zod";

/** Stable schema identifier. Bump to v2 when the field set changes. */
export const REPUTATION_SCHEMA_V1 = "agenomics.reputation.v1" as const;

/**
 * Domain separator prepended to the canonical-JSON bytes before SHA-256
 * / Ed25519. Prevents cross-protocol replay where a legitimate Agenomics
 * reputation credential could be mis-presented as a different schema's
 * payload. Mirrors the ADR-092 manifest-hash domain prefix style.
 *
 * Format: UTF-8 encoding of "AEP_REPUTATION_ATTESTATION_V1\0" (30 bytes).
 */
export const REPUTATION_ATTESTATION_DOMAIN_PREFIX: Uint8Array =
  new TextEncoder().encode("AEP_REPUTATION_ATTESTATION_V1\0");

/**
 * The canonicalisable payload. EVERY field is required; producers MUST
 * NOT omit a field even when the underlying datum is zero (e.g.
 * `slash_count: 0`). The whole point of canonicalisation is that absent
 * vs. zero are different inputs.
 *
 * Base58 pubkey fields use Solana's base58 encoding. Lamport / nonce
 * fields use decimal-string encoding because canonical JSON cannot
 * preserve `bigint` precision losslessly through JS's `number` type.
 */
export interface ReputationAttestationPayload {
  /** Schema discriminator. MUST equal `REPUTATION_SCHEMA_V1`. */
  schema: typeof REPUTATION_SCHEMA_V1;
  /** Agent profile PDA (base58). */
  agent_id: string;
  /** Authority pubkey on the profile (base58). */
  authority: string;
  /** Hex-encoded 32-byte SHA-256 of the canonical-JSON manifest body. */
  manifest_hash: string;
  /** Reputation score in `[0, 100]`. ADR-094 caps this at 100. */
  reputation_score: number;
  /** Cumulative slash count. u8 on-chain; widened to number off-chain. */
  slash_count: number;
  /** Staked amount in lamports. Decimal string to preserve precision. */
  reputation_stake_lamports: string;
  /** Profile's registration nonce (u64). Decimal string. */
  registration_nonce: string;
  /** Solana slot at which the snapshot was taken. Decimal string. */
  snapshot_slot: string;
  /** Unix-seconds timestamp of the snapshot. */
  snapshot_timestamp: number;
  /** Issuer signing key (base58). */
  issuer: string;
  /** Discovery URL where verifiers can fetch issuer metadata. */
  issuer_url: string;
  /**
   * Optional unix-seconds expiry. `0` means "perpetual but verifier MUST
   * still check snapshot freshness" — a snapshot from 5 years ago is
   * useless for a real-time gate even if the credential never formally
   * expires.
   */
  expiry_unix_ts: number;
}

/** A serialised, signed credential. JSON-safe for HTTP transport. */
export interface ReputationCredential {
  /** The exact payload that was signed. */
  payload: ReputationAttestationPayload;
  /** Hex-encoded 64-byte Ed25519 signature. */
  signature: string;
  /** Schema discriminator hint at the top level — convenience for resolvers. */
  schema: typeof REPUTATION_SCHEMA_V1;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const HEX_128 = /^[0-9a-fA-F]{128}$/;
const DECIMAL_STR = /^(0|[1-9][0-9]{0,38})$/;

/**
 * Zod schema for the canonicalisable payload. Used by both the producer
 * (sanity-check before signing) and the verifier (validate after
 * deserialising untrusted input).
 */
export const ReputationAttestationPayloadSchema = z.object({
  schema: z.literal(REPUTATION_SCHEMA_V1),
  agent_id: z.string().regex(BASE58, "agent_id must be base58"),
  authority: z.string().regex(BASE58, "authority must be base58"),
  manifest_hash: z.string().regex(HEX_64, "manifest_hash must be 64 hex chars"),
  reputation_score: z.number().int().min(0).max(100),
  slash_count: z.number().int().min(0).max(255),
  reputation_stake_lamports: z
    .string()
    .regex(DECIMAL_STR, "reputation_stake_lamports must be a non-negative decimal string"),
  registration_nonce: z
    .string()
    .regex(DECIMAL_STR, "registration_nonce must be a non-negative decimal string"),
  snapshot_slot: z
    .string()
    .regex(DECIMAL_STR, "snapshot_slot must be a non-negative decimal string"),
  snapshot_timestamp: z.number().int().min(0),
  issuer: z.string().regex(BASE58, "issuer must be base58"),
  issuer_url: z.string().url("issuer_url must be a valid URL"),
  expiry_unix_ts: z.number().int().min(0),
});

export const ReputationCredentialSchema = z.object({
  payload: ReputationAttestationPayloadSchema,
  signature: z.string().regex(HEX_128, "signature must be 128 hex chars"),
  schema: z.literal(REPUTATION_SCHEMA_V1),
});

/** Inferred Zod payload type — identical to `ReputationAttestationPayload`. */
export type ReputationAttestationPayloadParsed = z.infer<
  typeof ReputationAttestationPayloadSchema
>;
