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

/**
 * ADR-129 Phase 1: agent-memory claims. EVO is consulted via the MCP
 * surface — `find_similar_agents` (Phase 1, read) needs `read:agent-memory`;
 * the future Phase 2 `learn` loop will need `write:agent-memory`. These
 * are NOT `<Domain>` because EVO is not a Solana program — it's the
 * cross-session cognitive-memory layer behind mcp-server (see
 * `docs/adr/ADR-129-evo-agent-memory-integration.md`). The post-register
 * best-effort observe is a side effect of an already-authorized
 * `register_agent` and intentionally does NOT consume `write:agent-memory`
 * — it inherits authorization from the surrounding ix. Phase 2 declares
 * the write claim explicitly when the learn-loop API surfaces.
 */
export type AgentMemoryClaim = "read:agent-memory" | "write:agent-memory";

/**
 * Surface 2 (Reflex / x402) claims. `pay:x402` gates the `pay_x402_service`
 * MCP action, which (in the real Day 3+ implementation) debits an on-chain
 * Solana vault and settles a payment on Base via the CDP Facilitator. It is
 * deliberately a separate, write-side claim — `read:vault` MUST NOT be
 * conflated with spend authority. See docs/aep-reflex-tech-spec.md
 * §"Surface 2 — pay_x402_service MCP tool" + IC-3 (lines 109–137).
 *
 * The scaffold action carries this claim today even though it doesn't
 * actually settle anything yet — that way capability tests pin the gating
 * surface from day one and Day-3 can flip `requiresSigner` + wire the real
 * client without re-litigating the auth model.
 */
export type X402Claim = "pay:x402";

export type Capability =
  | `read:${Domain}`
  | `sign:${Domain}`
  | `sign:cross_program:${ProgramSet}`
  | `admin:${Domain}`
  | GovernanceClaim
  | AgentMemoryClaim
  | X402Claim;

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
