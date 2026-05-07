import { PublicKey, Connection } from "@solana/web3.js";

export const RPC_URL = import.meta.env.VITE_RPC_URL || "https://api.devnet.solana.com";
export const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || "http://localhost:3100";
// ADR-131 trigger endpoints are served by the indexer's metrics server
// (src/indexer/metrics-server.ts), which listens on its own port (default
// 9100) separate from the Express API on port 3100. The default mirrors
// `startMetricsServer`'s default; operators can override per-environment.
export const METRICS_API_URL = import.meta.env.VITE_METRICS_API_URL || "http://localhost:9100";
export const MONITORED_VAULT = import.meta.env.VITE_MONITORED_VAULT || null;

export const connection = new Connection(RPC_URL, "confirmed");

export const PROGRAM_IDS = {
  vault: new PublicKey("28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw"),
  registry: new PublicKey("psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv"),
  settlement: new PublicKey("9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95"),
};

export const NETWORK_LABEL = RPC_URL.includes("devnet")
  ? "Devnet"
  : RPC_URL.includes("mainnet")
  ? "Mainnet"
  : "Localnet";
