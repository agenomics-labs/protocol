// ADR-139 — @agenomics/reputation-attestor public entry point.
//
// Consumers (issuer service, MCP tools, SDK Reputation namespace,
// third-party verifiers) should import from the root:
//
//   import {
//     issueAttestation,
//     verifyAttestation,
//     loadIssuerKeypair,
//     REPUTATION_SCHEMA_V1,
//   } from "@agenomics/reputation-attestor";
//
// The package is read-only with respect to chain state — issuers feed
// in a pre-fetched `AgentProfileSnapshot`, and verifiers can optionally
// supply an `OnChainProfileFetcher` for the §3 step-6 cross-check. The
// package itself does not depend on `@solana/kit` or `@coral-xyz/anchor`
// so it can be embedded by anyone that already has a typed profile.

export {
  REPUTATION_SCHEMA_V1,
  REPUTATION_ATTESTATION_DOMAIN_PREFIX,
  ReputationAttestationPayloadSchema,
  ReputationCredentialSchema,
  type ReputationAttestationPayload,
  type ReputationCredential,
} from "./schema.js";

export {
  canonicalJson,
  canonicalBytes,
  attestationPreimage,
} from "./canonical.js";

export {
  issueAttestation,
  loadIssuerKeypair,
  issuerKeypairFromSecret,
  type IssueOptions,
  type IssuerKeypair,
  type AgentProfileSnapshot,
} from "./issuer.js";

export {
  verifyAttestation,
  verifyAttestationWithChain,
  type VerifyOptions,
  type VerifyReason,
  type VerifyReasonCode,
  type VerifyResult,
  type VerifyResultOk,
  type VerifyResultErr,
  type OnChainProfileFetcher,
  type OnChainProfileView,
} from "./verifier.js";

export {
  encodeBase58,
  decodeBase58,
  hexEncode,
  hexDecode,
  bytesEqual,
} from "./util.js";
