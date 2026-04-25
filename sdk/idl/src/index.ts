export type Cluster = "devnet" | "mainnet-beta" | "localnet";

export interface ProgramIds {
  agentRegistry: string;
  agentVault: string;
  settlement: string;
}

const PROGRAM_IDS: Record<Cluster, ProgramIds> = {
  devnet: {
    agentRegistry: "8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh",
    agentVault:    "4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN",
    settlement:    "GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3",
  },
  "mainnet-beta": {
    agentRegistry: "8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh",
    agentVault:    "4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN",
    settlement:    "GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3",
  },
  localnet: {
    agentRegistry: "8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh",
    agentVault:    "4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN",
    settlement:    "GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3",
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
