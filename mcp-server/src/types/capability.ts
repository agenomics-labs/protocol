// Canonical capability taxonomy + preflight gates per ADR-058 §2.1 / §3.
// Single source of truth; ADR-059 and ADR-060 reference these types.

export type Domain = "settlement" | "registry" | "vault";
export type ProgramSet = string;

/**
 * AUD-206 (cycle-3): protocol-governance claims. Distinct from per-domain
 * `admin:*` because they gate cross-program governance instructions whose
 * signer is the upgrade-authority / multisig rather than a domain admin.
 * Format mirrors the existing 3-segment `sign:cross_program:<set>` shape:
 * `gov:<topic>:<action>`.
 *
 * `gov:invariant:check` — required to invoke `verify_protocol_invariants`
 * (Registry batch-sweep ix, batch capped at MAX_INVARIANT_BATCH = 16 per
 * AUD-106). On-chain authorization is `ProtocolConfig.authority`; this MCP
 * claim is the second wall (default-deny per ADR-058 §4) so untrusted MCP
 * callers cannot trigger the ix even if they hold a signed-mode session
 * with other capabilities.
 */
export type GovernanceClaim = "gov:invariant:check";

export type Capability =
  | `read:${Domain}`
  | `sign:${Domain}`
  | `sign:cross_program:${ProgramSet}`
  | `admin:${Domain}`
  | GovernanceClaim;

export type PreflightGate =
  | "cluster_health"
  | "account_rent_exempt"
  | "daily_cap_not_exhausted"
  | "token_daily_cap_not_exhausted"
  | "dispute_window_open";

export type SideEffect =
  | "read-onchain"
  | "write-onchain"
  | "signs-tx"
  | "external-http"
  | "emits-event";
