// Canonical capability taxonomy + preflight gates per ADR-058 §2.1 / §3.
// Single source of truth; ADR-059 and ADR-060 reference these types.

export type Domain = "settlement" | "registry" | "vault";
export type ProgramSet = string;

export type Capability =
  | `read:${Domain}`
  | `sign:${Domain}`
  | `sign:cross_program:${ProgramSet}`
  | `admin:${Domain}`;

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
