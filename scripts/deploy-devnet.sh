#!/usr/bin/env bash
# Agenomics Devnet Deployment Script
# Usage: ./scripts/deploy-devnet.sh
#
# Prerequisites:
#   - solana CLI configured for devnet: solana config set --url devnet
#   - Wallet funded with devnet SOL: solana airdrop 5
#   - Programs built: anchor build --no-idl
#
# This script deploys all 3 AEAP programs to Solana devnet and verifies deployment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Program IDs (from Anchor.toml)
VAULT_PROGRAM_ID="4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN"
REGISTRY_PROGRAM_ID="8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh"
SETTLEMENT_PROGRAM_ID="GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3"

# Binary paths
VAULT_SO="$PROJECT_ROOT/target/deploy/agent_vault.so"
REGISTRY_SO="$PROJECT_ROOT/target/deploy/agent_registry.so"
SETTLEMENT_SO="$PROJECT_ROOT/target/deploy/settlement.so"

echo "=== Agenomics Devnet Deployment ==="
echo ""

# Verify binaries exist
for so in "$VAULT_SO" "$REGISTRY_SO" "$SETTLEMENT_SO"; do
    if [ ! -f "$so" ]; then
        echo "ERROR: Program binary not found: $so"
        echo "Run 'anchor build --no-idl' first."
        exit 1
    fi
done

# Verify solana config
CLUSTER=$(solana config get | grep "RPC URL" | awk '{print $NF}')
echo "RPC Cluster: $CLUSTER"

if [[ "$CLUSTER" != *"devnet"* ]]; then
    echo "WARNING: Not configured for devnet. Current cluster: $CLUSTER"
    echo "Run: solana config set --url devnet"
    read -p "Continue anyway? (y/N): " confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
        exit 1
    fi
fi

WALLET=$(solana address)
BALANCE=$(solana balance | awk '{print $1}')
echo "Wallet: $WALLET"
echo "Balance: $BALANCE SOL"
echo ""

# Check minimum balance (each program deploy costs ~3-5 SOL for rent)
MIN_BALANCE=10
if (( $(echo "$BALANCE < $MIN_BALANCE" | bc -l) )); then
    echo "WARNING: Balance below ${MIN_BALANCE} SOL. Deployments may fail."
    echo "Run: solana airdrop 5 (repeat as needed)"
fi

# Deploy programs
echo "--- Deploying Agent Vault ---"
solana program deploy \
    --program-id "$PROJECT_ROOT/target/deploy/agent_vault-keypair.json" \
    "$VAULT_SO" \
    --with-compute-unit-price 1000

echo ""
echo "--- Deploying Agent Registry ---"
solana program deploy \
    --program-id "$PROJECT_ROOT/target/deploy/agent_registry-keypair.json" \
    "$REGISTRY_SO" \
    --with-compute-unit-price 1000

echo ""
echo "--- Deploying Settlement ---"
solana program deploy \
    --program-id "$PROJECT_ROOT/target/deploy/settlement-keypair.json" \
    "$SETTLEMENT_SO" \
    --with-compute-unit-price 1000

echo ""
echo "=== Deployment Complete ==="
echo ""

# Verify deployments
echo "--- Verification ---"
for pid in "$VAULT_PROGRAM_ID" "$REGISTRY_PROGRAM_ID" "$SETTLEMENT_PROGRAM_ID"; do
    if solana program show "$pid" > /dev/null 2>&1; then
        echo "  $pid: DEPLOYED"
    else
        echo "  $pid: FAILED"
    fi
done

echo ""
echo "Next steps:"
echo "  1. Fund your wallet with devnet USDC for escrow tests"
echo "  2. Start MCP server: cd mcp-server && SOLANA_RPC_URL=https://api.devnet.solana.com npm run dev"
echo "  3. Run smoke test (legacy mocha suite, live-validator):"
echo "       cd mcp-server && npx ts-mocha -p tsconfig.test.json test/mcp-handlers.test.ts"
echo "  4. Run the Anchor integration suite against devnet (includes ADR-060"
echo "     update_manifest coverage once S-xcut-04 ships):"
echo "       anchor test --skip-deploy --skip-local-validator \\"
echo "         --provider.cluster devnet"
echo "     (Requires the Anchor tests under tests/ to be current — tracked in S-xcut-04.)"
