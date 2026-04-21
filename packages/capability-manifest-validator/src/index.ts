// ADR-060: AEP capability manifest validator — public entry point.
//
// Consumers should import from the root:
//   import { validateManifest, manifestHash } from "@agenomics/capability-manifest-validator";

export {
  validateManifest,
  manifestHash,
  canonicalJson,
  canonicalBytes,
  CapabilityManifestSchema,
  MANIFEST_SCHEMA_V1_URL,
  type ValidateInput,
  type ValidationResult,
  type ValidationError,
  type ValidationErrorCode,
  type CapabilityManifest,
  type Capability,
  type CostEstimate,
  type RequiredCapability,
  type PreflightGate,
  type SideEffect,
  type Stability,
} from "./validate.js";
