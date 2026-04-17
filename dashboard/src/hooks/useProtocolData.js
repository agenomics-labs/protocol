import { useState, useEffect, useCallback } from "react";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { INDEXER_URL, MONITORED_VAULT, PROGRAM_IDS, connection } from "../config.js";

/**
 * Indexer-first data fetching hook with RPC fallback.
 * Polls every 30 seconds.
 */
export function useProtocolData() {
  const [data, setData] = useState({
    agents: [],
    events: [],
    stats: null,
    registryAccounts: [],
    settlementAccounts: [],
    vaultBalance: null,
    loading: true,
    error: null,
    indexerConnected: false,
    lastUpdated: null,
  });

  const fetchFromIndexer = useCallback(async () => {
    try {
      const [agentsRes, eventsRes, statsRes] = await Promise.all([
        fetch(`${INDEXER_URL}/agents?limit=50`),
        fetch(`${INDEXER_URL}/events?limit=20`),
        fetch(`${INDEXER_URL}/stats`),
      ]);
      if (!agentsRes.ok || !eventsRes.ok || !statsRes.ok) {
        throw new Error("Indexer returned non-OK status");
      }
      const agentsJson = await agentsRes.json();
      const eventsJson = await eventsRes.json();
      const statsJson = await statsRes.json();
      return {
        agents: agentsJson.agents || [],
        events: eventsJson.events || [],
        stats: statsJson,
        indexerConnected: true,
      };
    } catch {
      return { indexerConnected: false };
    }
  }, []);

  const fetchFromRpc = useCallback(async () => {
    const result = { registryAccounts: [], settlementAccounts: [], vaultBalance: null };

    try {
      const registryAccounts = await connection.getProgramAccounts(PROGRAM_IDS.registry, {
        commitment: "confirmed",
      });
      result.registryAccounts = registryAccounts.map((account) => ({
        pubkey: account.pubkey.toBase58(),
        dataSize: account.account.data.length,
        lamports: account.account.lamports,
      }));
    } catch (err) {
      console.warn("Failed to fetch registry accounts:", err.message);
    }

    try {
      const settlementAccounts = await connection.getProgramAccounts(PROGRAM_IDS.settlement, {
        commitment: "confirmed",
      });
      result.settlementAccounts = settlementAccounts.map((account) => ({
        pubkey: account.pubkey.toBase58(),
        dataSize: account.account.data.length,
        lamports: account.account.lamports,
      }));
    } catch (err) {
      console.warn("Failed to fetch settlement accounts:", err.message);
    }

    if (MONITORED_VAULT) {
      try {
        const balance = await connection.getBalance(new PublicKey(MONITORED_VAULT));
        result.vaultBalance = balance / LAMPORTS_PER_SOL;
      } catch (err) {
        console.warn("Failed to fetch vault balance:", err.message);
      }
    }

    return result;
  }, []);

  const fetchData = useCallback(async () => {
    setData((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const [indexerData, rpcData] = await Promise.all([fetchFromIndexer(), fetchFromRpc()]);
      setData({
        agents: indexerData.agents || [],
        events: indexerData.events || [],
        stats: indexerData.stats || null,
        registryAccounts: rpcData.registryAccounts,
        settlementAccounts: rpcData.settlementAccounts,
        vaultBalance: rpcData.vaultBalance,
        indexerConnected: !!indexerData.indexerConnected,
        loading: false,
        error: null,
        lastUpdated: new Date(),
      });
    } catch (err) {
      setData((prev) => ({ ...prev, loading: false, error: err.message }));
    }
  }, [fetchFromIndexer, fetchFromRpc]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return { ...data, refresh: fetchData };
}
