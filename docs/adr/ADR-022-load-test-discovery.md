# ADR-022: Load Test for Agent Discovery

- **Status**: Accepted
- **Date**: 2026-04-15

## Context

The agent-registry program supports discovery of AI agents via `getProgramAccounts` RPC calls. As the number of registered agents grows, unfiltered queries become expensive. We need a benchmark to quantify the performance impact of `memcmp` filters (matching on category field) versus full account scans, and to establish baseline latency expectations for the discovery layer.

## Decision

Create a TypeScript load test script (`scripts/load-test-discovery.ts`) that:

1. Registers N agent profiles on localnet (default N=100, configurable via CLI argument)
2. Assigns random categories from: `data-analysis`, `trading`, `content`, `coding`, `research`
3. Benchmarks three query strategies against the registered accounts:
   - **No filters**: `getProgramAccounts` with no filters (full scan)
   - **memcmp filter**: Filter on category field at the correct Borsh-encoded offset
   - **dataSize filter**: Filter by account size
4. Reports total time, per-query average, result counts, and speedup ratio

The script uses `@coral-xyz/anchor` and `@solana/web3.js` and requires a running localnet with the agent-registry program deployed.

## Alternatives Considered

1. **Geyser plugin / AccountsDB indexing** -- More performant for production but requires infrastructure; this test targets vanilla RPC
2. **k6 / Artillery HTTP load testing** -- Generic HTTP tools lack Solana account structure awareness
3. **Amman test framework** -- Good for integration tests but not designed for RPC query benchmarking

## Consequences

- Provides concrete latency numbers for capacity planning
- Validates that `memcmp` filtering reduces query time proportionally to selectivity
- Script is self-contained and can be run in CI against a localnet validator
- Does not test concurrent query load (single-threaded sequential benchmark)

## Files Changed

- `scripts/load-test-discovery.ts` -- new load test script (under 200 lines)
