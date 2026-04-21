// ADR-060 §2: CapabilityManifest schema (v1.0).
//
// Zod mirrors the TypeScript interface in ADR-060 §2. Schema-level
// cross-field invariants (e.g. version === '1.0' ties to $schema URL)
// are enforced here; cryptographic invariants (hash integrity, Ed25519
// signature) are enforced in `validate.ts`.

import { z } from "zod";

// JSON Schema subset we accept inside input/output/parameter schemas.
// We do NOT bundle a full JSON Schema meta-schema here — ADR-060 §5
// says minor bumps are additive and consumers MUST accept unknown
// optional fields, so we keep this permissive (`z.record` = any keys).
const JsonSchemaLike = z.record(z.string(), z.unknown());

// Canonical v1.0 $schema URL. A major-version bump will publish a new
// URL and a future schema module; this one rejects foreign URLs.
export const MANIFEST_SCHEMA_V1_URL =
  "https://aep.dev/schemas/capability-manifest/v1.0.json";

export const PreflightGateSchema = z.enum([
  "cluster_health",
  "account_rent_exempt",
  "daily_cap_not_exhausted",
  "dispute_window_open",
]);
export type PreflightGate = z.infer<typeof PreflightGateSchema>;

export const SideEffectSchema = z.enum([
  "read-onchain",
  "write-onchain",
  "signs-tx",
  "external-http",
  "emits-event",
]);
export type SideEffect = z.infer<typeof SideEffectSchema>;

export const StabilitySchema = z.enum(["experimental", "beta", "stable"]);
export type Stability = z.infer<typeof StabilitySchema>;

export const CostEstimateSchema = z.object({
  unit: z.enum(["micro_usd", "lamports"]),
  // JSON-safe bigint: string-encoded integer.
  amount: z.string().regex(/^[0-9]+$/, "amount must be a decimal-integer string"),
  confidence: z.enum(["exact", "estimate", "worst-case"]),
});
export type CostEstimate = z.infer<typeof CostEstimateSchema>;

export const RequiredCapabilitySchema = z.object({
  // ADR-058 Capability literal; we accept any string so this crate
  // doesn't need to pin to ADR-058's enum (which may evolve).
  capability: z.string().min(1),
  rationale: z.string().optional(),
});
export type RequiredCapability = z.infer<typeof RequiredCapabilitySchema>;

export const CapabilitySchema = z.object({
  // ADR-060 §2: verb-noun, kebab-case.
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/,
      "capability name must be kebab-case verb-noun (e.g. 'transfer-funds')",
    ),
  description: z.string().min(1),
  input_schema: JsonSchemaLike,
  output_schema: JsonSchemaLike,
  cost_estimate: CostEstimateSchema.optional(),
  required_capabilities: z.array(RequiredCapabilitySchema),
  preflight: z.array(PreflightGateSchema).optional(),
  side_effects: z.array(SideEffectSchema),
  stability: StabilitySchema,
});
export type Capability = z.infer<typeof CapabilitySchema>;

// Base58 Solana address: 32-44 chars from the base58 alphabet.
const Base58Address = z
  .string()
  .regex(
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    "agent.pubkey must be a base58 Solana address",
  );

export const CapabilityManifestSchema = z
  .object({
    $schema: z.literal(MANIFEST_SCHEMA_V1_URL),
    version: z.literal("1.0"),
    agent: z.object({
      pubkey: Base58Address,
      name: z.string().min(1),
      owner_attestation: Base58Address.optional(),
      website: z.string().url().optional(),
    }),
    agent_version: z
      .string()
      .regex(
        /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
        "agent_version must be semver-like (e.g. '1.2.3' or '1.2.3-beta.1')",
      ),
    capabilities: z.array(CapabilitySchema).min(1),
    published_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }).optional(),
  })
  // ADR-060 §5: consumers MUST accept unknown optional fields (minor
  // bumps are additive). Zod's default `.strict()` would reject them,
  // so we deliberately leave this in default "strip" mode — unknown
  // keys are silently dropped in the parsed output but the manifest
  // body seen by the hash check is the original bytes, so forward
  // compatibility is preserved.
  .readonly();

export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;
