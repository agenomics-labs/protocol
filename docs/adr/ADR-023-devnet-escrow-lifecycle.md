# ADR-023: Devnet Escrow Lifecycle Testing

- **Status**: Accepted
- **Date**: 2026-04-15

## Context

The settlement escrow program has been validated on localnet with native SOL, but never exercised end-to-end on devnet with SPL tokens. Before mainnet launch we need to confirm that every escrow state transition works in a live cluster environment where transaction confirmation, rent-exemption, and CPI behaviour may differ from the local validator. A devnet-compatible SPL token mint (USDC-like, 6 decimals) is required to simulate realistic payment flows.

## Decision

Create a devnet integration test suite that exercises the full settlement escrow lifecycle using a devnet USDC-like token mint:

1. **Setup**: Deploy or locate a devnet USDC-like mint (6 decimals). Airdrop SOL to test wallets for transaction fees.
2. **create_escrow**: Client creates an escrow with defined milestones, depositing SPL tokens into the escrow vault.
3. **accept_task**: Provider accepts the task, locking the escrow.
4. **submit_milestone**: Provider submits deliverable hash for a milestone.
5. **approve_milestone**: Client approves the milestone, triggering partial fund release to the provider.
6. **release_payment**: Final milestone approval releases remaining funds and closes the escrow account.
7. **CPI reputation update**: Validate that the cross-program invocation to the reputation program correctly increments the provider's completed-task counter on devnet.

All tests run against `https://api.devnet.solana.com` using keypairs from `~/.config/solana/id.json`.

## Alternatives Considered

1. **Localnet-only testing** -- Faster iteration but does not catch cluster-specific issues (e.g., blockhash expiry, rate limiting, rent reclaim timing).
2. **Mainnet-beta with micro amounts** -- Provides real-world conditions but costs real SOL and risks accidental state pollution.
3. **Bankrun / solana-program-test** -- Excellent for unit-level CPI testing but simulates the runtime rather than exercising actual validator consensus.

## Consequences

- Confirms SPL token vault creation, transfer, and close behave correctly under devnet consensus.
- Validates CPI reputation update in a multi-program deployment outside the local validator.
- Requires devnet SOL airdrop (rate-limited); CI runs should cache funded keypairs.
- Test wallets and mint authority keypairs must not be committed to the repository.

## Files Changed

- `tests/devnet/escrow-lifecycle.test.ts` -- new end-to-end devnet test suite
- `scripts/setup-devnet-mint.ts` -- helper to create or locate the devnet USDC-like mint
- `.env.devnet` -- devnet RPC URL and keypair path (git-ignored)
