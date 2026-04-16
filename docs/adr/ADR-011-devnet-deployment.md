# ADR-011: Devnet Deployment and End-to-End Smoke Test

## Status
Accepted

## Date
2026-04-15

## Context
All three AEAP programs were only tested against a local validator (`solana-test-validator`). Devnet deployment is a prerequisite for:
- External testers and integrators to interact with the protocol
- Validating program behavior under real network conditions (latency, slot timing)
- Testing the MCP server against a persistent environment
- Demonstrating the protocol to potential partners

## Decision
Create deployment and smoke test tooling:

1. **`scripts/deploy-devnet.sh`** — Bash script that:
   - Verifies program binaries exist and Solana CLI is configured for devnet
   - Deploys all 3 programs using `solana program deploy` with compute-unit pricing
   - Verifies deployment via `solana program show`
   - Prints next-steps instructions

2. **`scripts/smoke-test-devnet.ts`** — TypeScript script that:
   - Verifies all 3 programs are deployed and executable
   - Creates a test wallet with airdropped SOL
   - Creates a vault, registers an agent, and verifies on-chain state
   - Reports pass/fail for each operation

### Deployment Process
```bash
solana config set --url devnet
solana airdrop 5  # repeat until ~15 SOL
anchor build --no-idl
./scripts/deploy-devnet.sh
npx ts-node scripts/smoke-test-devnet.ts
```

## Alternatives Considered

### Alternative: Use `anchor deploy`
Anchor's deploy command bundles build + deploy but doesn't provide the same level of verification and error handling. A custom script gives more control.

### Alternative: Deploy to mainnet-beta directly
Premature — devnet is the appropriate environment for integration testing before security audit.

## Consequences

### Positive
- Repeatable deployment process
- Automated verification catches deployment failures
- Smoke test validates end-to-end functionality

### Negative
- Devnet programs are publicly accessible (anyone can interact)
- Devnet airdrop has rate limits that may slow deployment

## Files Changed
- `scripts/deploy-devnet.sh` — Deployment script
- `scripts/smoke-test-devnet.ts` — Smoke test script
