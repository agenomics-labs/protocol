// ADR-060: AEP capability manifest validator — public entry point.
//
// Consumers should import from the root:
//   import { validateManifest, manifestHash } from "@agenomics/capability-manifest-validator";
//
// v0.1.0 tightening notes (see DEEP-AUDIT-2026-04-22.md Audit 2):
//   - `canonicalJson` and `canonicalBytes` are demoted to internal —
//     exposing them as public surface locked us into RFC-8785-via-`canonicalize`
//     forever. Callers that need the canonicalized bytes can use
//     `unstable_canonicalJson` / `unstable_canonicalBytes` (name
//     intentionally flagged: NOT semver-stable, may change or be
//     removed in a minor release).
//   - `ValidationErrorCode` / `PreflightGate` / `SideEffect` /
//     `Stability` are widened to `Known<X> | (string & {})` so adding
//     a new value in a minor release is not a breaking type change.
//   - The `exports` field in package.json collapses to just `.`; any
//     prior subpath imports (`./schema`, `./canonical`, `./validate`)
//     must route through the root entry point.

export {
  validateManifest,
  manifestHash,
  taggedManifestHash,
  MANIFEST_HASH_DOMAIN_PREFIX,
  CapabilityManifestSchema,
  MANIFEST_SCHEMA_V1_URL,
  unstable_canonicalJson,
  unstable_canonicalBytes,
  type ValidateInput,
  type ValidationResult,
  type ValidationError,
  type ValidationErrorCode,
  type KnownValidationErrorCode,
  type CapabilityManifest,
  type Capability,
  type CostEstimate,
  type RequiredCapability,
  type PreflightGate,
  type KnownPreflightGate,
  type SideEffect,
  type KnownSideEffect,
  type Stability,
  type KnownStability,
} from "./validate.js";
