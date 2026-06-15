// ADR-139 — issuer-side helpers.
//
// `issueAttestation(profile, opts)` is the canonical way to produce a
// signed `ReputationCredential`. It does not touch the network or the
// filesystem: the on-chain `AgentProfile` is read by the caller (the
// issuer service or an SDK consumer) and handed in as a plain object.
//
// Keypair material is resolved by `loadIssuerKeypair()` from one of:
//   - `REPUTATION_ATTESTOR_KEYPAIR_PATH` — filesystem path to a 64-byte
//     Solana-style keypair JSON array (the same format `solana-keygen`
//     emits and `Anchor.toml` uses).
//   - `REPUTATION_ATTESTOR_KEYPAIR_B64` — base64 of a raw 64-byte secret
//     key (used in environments where touching disk is undesirable).
//   - `REPUTATION_ATTESTOR_KMS_URI` — opaque URI for KMS-backed signers.
//     v0.1.0 only documents the env var; an actual KMS adapter ships in
//     a follow-up because the production KMS choice is not yet decided
//     (AWS KMS vs. GCP KMS vs. HSM). Setting this var without one of the
//     above two raises a clear "KMS adapter not implemented" error.
//
// The "load once, sign many" pattern is intentional — the issuer service
// holds a single `IssuerKeypair` for its lifetime, and rate-limits
// at the HTTP layer rather than re-loading per request.

import { ed25519 } from "@noble/curves/ed25519.js";
import { readFileSync } from "node:fs";
import {
  REPUTATION_SCHEMA_V1,
  type ReputationAttestationPayload,
  type ReputationCredential,
} from "./schema.js";
import { attestationPreimage } from "./canonical.js";
import { encodeBase58, hexEncode } from "./util.js";

/**
 * In-memory issuer key material. The 32-byte `secretKey` is the Ed25519
 * scalar; `publicKey` is the base58-encoded compressed point.
 *
 * The 64-byte Solana keypair format that `solana-keygen` emits is the
 * 32-byte scalar followed by the 32-byte public key. We accept that
 * format on input and project down to the scalar.
 */
export interface IssuerKeypair {
  readonly secretKey: Uint8Array;
  readonly publicKey: string;
}

/**
 * Load issuer key material from environment variables. Inspected in
 * declaration order; the first set value wins.
 *
 * @throws if no usable env var is set, or a set var points at malformed
 *         key material.
 */
export function loadIssuerKeypair(
  env: NodeJS.ProcessEnv = process.env,
): IssuerKeypair {
  const path = env.REPUTATION_ATTESTOR_KEYPAIR_PATH;
  const b64 = env.REPUTATION_ATTESTOR_KEYPAIR_B64;
  const kms = env.REPUTATION_ATTESTOR_KMS_URI;

  if (path && path.length > 0) {
    const raw = readFileSync(path, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error(
        `REPUTATION_ATTESTOR_KEYPAIR_PATH: expected 64-element JSON array, got length ${
          Array.isArray(arr) ? arr.length : typeof arr
        }`,
      );
    }
    const bytes = Uint8Array.from(arr);
    return keypairFromSolanaBytes(bytes);
  }

  if (b64 && b64.length > 0) {
    const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
    if (bytes.length !== 64) {
      throw new Error(
        `REPUTATION_ATTESTOR_KEYPAIR_B64: decoded length must be 64, got ${bytes.length}`,
      );
    }
    return keypairFromSolanaBytes(bytes);
  }

  if (kms && kms.length > 0) {
    throw new Error(
      "REPUTATION_ATTESTOR_KMS_URI is set but no KMS adapter is bundled in this build. " +
        "See ADR-139 §6 (issuer trust model) — a production deployment must integrate a KMS adapter, " +
        "and that adapter is not yet selected. Use REPUTATION_ATTESTOR_KEYPAIR_PATH / _B64 for now.",
    );
  }

  throw new Error(
    "no issuer key material configured: set REPUTATION_ATTESTOR_KEYPAIR_PATH, " +
      "REPUTATION_ATTESTOR_KEYPAIR_B64, or wire a KMS adapter for REPUTATION_ATTESTOR_KMS_URI",
  );
}

/**
 * Build an `IssuerKeypair` from a raw 64-byte Solana keypair: the first
 * 32 bytes are the scalar, the last 32 are the public key.
 */
function keypairFromSolanaBytes(bytes: Uint8Array): IssuerKeypair {
  if (bytes.length !== 64) {
    throw new Error(`expected 64-byte keypair, got ${bytes.length}`);
  }
  const secretKey = bytes.slice(0, 32);
  const publicBytes = bytes.slice(32, 64);
  return {
    secretKey,
    publicKey: encodeBase58(publicBytes),
  };
}

/**
 * Build an `IssuerKeypair` directly from a 32-byte Ed25519 scalar.
 * Public key is derived via the curve so callers don't have to pre-pair.
 *
 * This is the entry point tests use to avoid touching the filesystem.
 */
export function issuerKeypairFromSecret(secretKey: Uint8Array): IssuerKeypair {
  if (secretKey.length !== 32) {
    throw new Error(`expected 32-byte Ed25519 scalar, got ${secretKey.length}`);
  }
  const pub = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey: encodeBase58(pub) };
}

/** The reputation-bearing snapshot of an `AgentProfile`. */
export interface AgentProfileSnapshot {
  /** Profile PDA (base58). */
  agent_id: string;
  /** Authority pubkey (base58). */
  authority: string;
  /** 32-byte SHA-256 of the canonical-JSON manifest, hex-encoded. */
  manifest_hash: string;
  /** Reputation score, clamped to `[0, 100]` (ADR-094). */
  reputation_score: number;
  /** Slash count (u8). */
  slash_count: number;
  /** Staked amount in lamports. */
  reputation_stake_lamports: bigint;
  /** Profile's registration nonce. */
  registration_nonce: bigint;
  /** Solana slot at which the snapshot was taken. */
  snapshot_slot: bigint;
  /** Unix-seconds timestamp of the snapshot. */
  snapshot_timestamp: number;
}

export interface IssueOptions {
  /** Issuer key material loaded via `loadIssuerKeypair()` or supplied directly. */
  issuer: IssuerKeypair;
  /** Discovery URL for the issuer — appears in the payload as `issuer_url`. */
  issuerUrl: string;
  /**
   * Unix-seconds expiry. `0` (default) means "perpetual but verifier
   * MUST check snapshot freshness" — see ADR-139 §7 threat model.
   */
  expiryUnixTs?: number;
}

/**
 * Produce a signed `ReputationCredential` from an in-memory profile
 * snapshot. Pure — does not touch the network or the filesystem.
 *
 * Throws on invalid input. The hard-fail path is intentional: a producer
 * with malformed inputs should not silently emit a corrupt credential.
 * Callers can defensively wrap in `try`/`catch` and degrade however they
 * see fit.
 */
export function issueAttestation(
  snapshot: AgentProfileSnapshot,
  opts: IssueOptions,
): ReputationCredential {
  if (!opts || !opts.issuer || !(opts.issuer.secretKey instanceof Uint8Array)) {
    throw new Error("issueAttestation: opts.issuer is required");
  }
  if (typeof opts.issuerUrl !== "string" || opts.issuerUrl.length === 0) {
    throw new Error("issueAttestation: opts.issuerUrl is required");
  }
  validateSnapshotInputs(snapshot);

  const payload: ReputationAttestationPayload = {
    schema: REPUTATION_SCHEMA_V1,
    agent_id: snapshot.agent_id,
    authority: snapshot.authority,
    manifest_hash: snapshot.manifest_hash.toLowerCase(),
    reputation_score: snapshot.reputation_score,
    slash_count: snapshot.slash_count,
    reputation_stake_lamports: snapshot.reputation_stake_lamports.toString(),
    registration_nonce: snapshot.registration_nonce.toString(),
    snapshot_slot: snapshot.snapshot_slot.toString(),
    snapshot_timestamp: snapshot.snapshot_timestamp,
    issuer: opts.issuer.publicKey,
    issuer_url: opts.issuerUrl,
    expiry_unix_ts: opts.expiryUnixTs ?? 0,
  };

  const preimage = attestationPreimage(payload);
  const sig = ed25519.sign(preimage, opts.issuer.secretKey);

  return {
    schema: REPUTATION_SCHEMA_V1,
    payload,
    signature: hexEncode(sig),
  };
}

function validateSnapshotInputs(snapshot: AgentProfileSnapshot): void {
  if (snapshot.reputation_score < 0 || snapshot.reputation_score > 100) {
    throw new Error(
      `reputation_score must be in [0, 100], got ${snapshot.reputation_score}`,
    );
  }
  if (snapshot.slash_count < 0 || snapshot.slash_count > 255) {
    throw new Error(`slash_count must be in [0, 255], got ${snapshot.slash_count}`);
  }
  if (snapshot.reputation_stake_lamports < 0n) {
    throw new Error("reputation_stake_lamports must be non-negative");
  }
  if (snapshot.registration_nonce < 0n) {
    throw new Error("registration_nonce must be non-negative");
  }
  if (snapshot.snapshot_slot < 0n) {
    throw new Error("snapshot_slot must be non-negative");
  }
  if (snapshot.snapshot_timestamp < 0) {
    throw new Error("snapshot_timestamp must be non-negative");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(snapshot.manifest_hash)) {
    throw new Error("manifest_hash must be 64 hex chars");
  }
}
