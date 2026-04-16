# ADR-035: Wire Dashboard to Devnet

**Status:** Accepted
**Date:** 2026-04-15

## Context

The AEAP dashboard displays static mock data. With programs deployed on devnet, the dashboard should show live on-chain data for vault balances, agent profiles, and escrow status.

## Decision

Update `AEAPDashboard.jsx` to:

1. **Connect to devnet RPC** at `https://api.devnet.solana.com` using `@solana/web3.js`.
2. **Fetch real vault balance** for a configured wallet address via `getBalance`.
3. **Fetch agent profiles** from the registry program using `getProgramAccounts` with the registry program ID `8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh`.
4. **Fetch escrow data** from the settlement program `GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3`.
5. **Display a "Devnet" badge** to indicate the data source.
6. **Use `useEffect` hooks** for data fetching with error handling and loading states.
7. **Preserve existing UI** structure; only add data fetching and live data display.

Program IDs:
- Vault: `4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN`
- Registry: `8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh`
- Settlement: `GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3`

## Consequences

- Dashboard shows real devnet data instead of static placeholders.
- Users can verify deployed program state directly in the UI.
- Network errors are handled gracefully with fallback to cached/default values.
- The "Devnet" badge prevents confusion about which network is being displayed.
