export type Cluster = "devnet" | "mainnet-beta" | "localnet";

export interface ProgramIds {
  agentRegistry: string;
  agentVault: string;
  settlement: string;
}

const DEVNET_PROGRAM_IDS: ProgramIds = {
  agentRegistry: "psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv",
  agentVault:    "28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw",
  settlement:    "9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95",
};

/**
 * Program IDs per cluster.
 *
 * `mainnet-beta` is **deliberately `null`**: distinct, governance-controlled
 * program IDs (one keypair per cluster, upgrade authority held by the Squads
 * multisig) have NOT been provisioned yet (AUD-207 / ADR-083, Track A2 of
 * `docs/PRE_MAINNET_ROADMAP.md`). Returning the devnet/test addresses for
 * `mainnet-beta` would silently point production integrators at programs whose
 * upgrade authority is a test key — a fund-loss path. `getProgramIds` therefore
 * fails closed (throws) for any cluster whose IDs are not genuinely
 * provisioned, rather than handing back placeholders.
 *
 * `devnet` and `localnet` resolve to the real test deployment (correct for
 * their intended use); they intentionally share the same on-chain binaries.
 */
const PROGRAM_IDS: Record<Cluster, ProgramIds | null> = {
  devnet: DEVNET_PROGRAM_IDS,
  "mainnet-beta": null,
  localnet: DEVNET_PROGRAM_IDS,
};

/**
 * Resolve the `{ agentRegistry, agentVault, settlement }` triple for a cluster.
 *
 * @throws if `cluster` has no genuinely-provisioned program IDs (currently
 *   `mainnet-beta`, until the ADR-083 keypair ceremony lands). Fail-closed by
 *   design: a placeholder ID on a production cluster is a fund-loss path
 *   (AUD-207). The thrown error names the cluster and the tracking ADR so the
 *   failure is actionable at the call boundary.
 */
export function getProgramIds(cluster: Cluster): ProgramIds {
  const ids = PROGRAM_IDS[cluster];
  if (ids === null || ids === undefined) {
    throw new Error(
      `@agenomics/idl: program IDs for cluster "${cluster}" are not yet ` +
        `provisioned. The governance-controlled keypair ceremony (one keypair ` +
        `per cluster, upgrade authority held by the Squads multisig) has not ` +
        `landed — see AUD-207 / ADR-083 and Track A2 of ` +
        `docs/PRE_MAINNET_ROADMAP.md. Refusing to return placeholder devnet ` +
        `addresses for "${cluster}" (returning them would build transactions ` +
        `against programs whose upgrade authority is a test key). Use ` +
        `"devnet" or "localnet" until "${cluster}" is provisioned.`,
    );
  }
  return ids;
}

export { PROGRAM_IDS };

// IDL JSON exports — cast to `Idl` from `@coral-xyz/anchor` at call site
export { AgentRegistryIdl } from "./idl/agent_registry.js";
export { AgentVaultIdl } from "./idl/agent_vault.js";
export { SettlementIdl } from "./idl/settlement.js";
