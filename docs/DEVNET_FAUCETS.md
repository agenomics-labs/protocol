# Devnet & Testnet Faucets

Token faucets used for Agenomics Protocol development and testing.

## Solana Devnet

### SOL (Native Gas Token)

| Detail | Value |
|--------|-------|
| **CLI** | `solana airdrop 1` |
| **Web Faucet** | [Google Cloud Solana Devnet Faucet](https://cloud.google.com/application/web3/faucet/solana/devnet) |
| **Rate Limit** | ~1-2 requests/hour per IP (CLI), varies (web) |
| **Decimals** | 9 |

### PYUSD (PayPal USD Stablecoin)

| Detail | Value |
|--------|-------|
| **Mint Address** | `CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM` |
| **Token Program** | Token-2022 (Token Extensions) |
| **Decimals** | 6 |
| **Web Faucet** | [Google Cloud PYUSD Faucet](https://cloud.google.com/application/web3/faucet/solana/devnet/pyusd) |
| **Alt Faucet** | [Paxos Faucet](https://faucet.paxos.com) |

**Create token account:**

```bash
spl-token create-account CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM
```

**Check balance:**

```bash
spl-token balance CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM
```

> **Note:** PYUSD uses Token-2022 (Token Extensions), which includes transfer fees, confidential transfers, freeze authority, and a permanent delegate. The settlement program currently uses legacy `token::Transfer` — integration with PYUSD would require migrating to `token_interface` or `token_2022`.

## Midnight Testnet

### tDUST (Testnet Gas Token)

| Detail | Value |
|--------|-------|
| **Web Faucet** | [Google Cloud Midnight Faucet](https://cloud.google.com/application/web3/faucet/midnight/testnet) |
| **Alt Faucet** | [Midnight Official Faucet](https://midnight.network/test-faucet) |
| **Token** | tDUST (no real value) |
| **Mainnet Status** | Live since March 30, 2026 |

> **Note:** Midnight is a privacy-focused blockchain using zero-knowledge proofs. It uses a different key format than Solana — you cannot reuse Solana keypairs. A Midnight wallet must be set up separately using their CLI or SDK.

### Potential Use Cases for Agenomics

- Privacy-preserving agent settlements (amounts/parties hidden via ZK proofs)
- Confidential escrow operations
- Cross-chain agent coordination (Solana for speed, Midnight for privacy)

## Wallet Reference

| Network | Wallet Address | Key Path |
|---------|---------------|----------|
| Solana Devnet | `BUdXA1FiWnV7ksXYodH3uEhDUhfBJ8g4UmmWdshWjTXL` | `~/.config/solana/id.json` |
| Midnight Testnet | TBD | — |

## Google Cloud Web3 Faucet Hub

Google Cloud provides a unified faucet service covering multiple chains:

- [Solana Devnet (SOL)](https://cloud.google.com/application/web3/faucet/solana/devnet)
- [Solana Devnet (PYUSD)](https://cloud.google.com/application/web3/faucet/solana/devnet/pyusd)
- [Midnight Testnet (tDUST)](https://cloud.google.com/application/web3/faucet/midnight/testnet)

All require Google account sign-in.
