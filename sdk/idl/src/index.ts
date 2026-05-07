export type Cluster = "devnet" | "mainnet-beta" | "localnet";

export interface ProgramIds {
  agentRegistry: string;
  agentVault: string;
  settlement: string;
}

const PROGRAM_IDS: Record<Cluster, ProgramIds> = {
  devnet: {
    agentRegistry: "psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv",
    agentVault:    "28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw",
    settlement:    "9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95",
  },
  "mainnet-beta": {
    agentRegistry: "psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv",
    agentVault:    "28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw",
    settlement:    "9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95",
  },
  localnet: {
    agentRegistry: "psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv",
    agentVault:    "28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw",
    settlement:    "9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95",
  },
};

export function getProgramIds(cluster: Cluster): ProgramIds {
  return PROGRAM_IDS[cluster];
}

export { PROGRAM_IDS };

// IDL JSON exports — cast to `Idl` from `@coral-xyz/anchor` at call site
export { AgentRegistryIdl } from "./idl/agent_registry.js";
export { AgentVaultIdl } from "./idl/agent_vault.js";
export { SettlementIdl } from "./idl/settlement.js";
