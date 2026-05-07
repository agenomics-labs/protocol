# ADR-035: Wire Dashboard to Devnet

## Status

Accepted

## Date

2026-04-15

## Context

The AEP dashboard displays static mock data. With programs deployed on devnet, the dashboard should show live on-chain data for vault balances, agent profiles, and escrow status.

## Decision

Update `AEPDashboard.jsx` to:

1. **Connect to devnet RPC** at `https://api.devnet.solana.com` using `@solana/web3.js`.
2. **Fetch real vault balance** for a configured wallet address via `getBalance`.
3. **Fetch agent profiles** from the registry program using `getProgramAccounts` with the registry program ID `psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv`.
4. **Fetch escrow data** from the settlement program `9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95`.
5. **Display a "Devnet" badge** to indicate the data source.
6. **Use `useEffect` hooks** for data fetching with error handling and loading states.
7. **Preserve existing UI** structure; only add data fetching and live data display.

Program IDs:
- Vault: `28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw`
- Registry: `psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv`
- Settlement: `9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95`

## Consequences

- Dashboard shows real devnet data instead of static placeholders.
- Users can verify deployed program state directly in the UI.
- Network errors are handled gracefully with fallback to cached/default values.
- The "Devnet" badge prevents confusion about which network is being displayed.

## Revisions

- 2026-04-25 — Files Changed citation refers to a pre-ADR-049 mono-program
  layout (`programs/aep/...` / `programs/vault/...`); the dashboard root is
  `dashboard/src/App.jsx` + `dashboard/src/components/` (the legacy
  `AEPDashboard.jsx` filename no longer exists at that path). AUD-2026-04-25 /
  drift matrix §5.
