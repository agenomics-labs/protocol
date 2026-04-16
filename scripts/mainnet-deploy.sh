#!/usr/bin/env bash
# AEAP Mainnet Deployment Script
# Usage: ./scripts/mainnet-deploy.sh [--skip-authority-transfer]
#
# Prerequisites:
#   - solana CLI configured for mainnet-beta
#   - Wallet funded with at least 20 SOL
#   - Programs built: anchor build --no-idl
#   - Audit report received and all critical findings resolved
#   - Multi-sig created via Squads (set MULTISIG_ADDRESS below or via env)
#
# Safety features:
#   - Confirms mainnet deployment intent
#   - Verifies wallet balance before each deploy
#   - Double-checks program IDs match expected values
#   - Prompts before each program deployment
#   - Optionally transfers upgrade authority to multi-sig

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ==================== CONFIGURATION ====================

# Program IDs (from Anchor.toml -- update these for mainnet if different)
VAULT_PROGRAM_ID="4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN"
REGISTRY_PROGRAM_ID="8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh"
SETTLEMENT_PROGRAM_ID="GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3"

# Multi-sig address for upgrade authority (set via env or edit here)
MULTISIG_ADDRESS="${MULTISIG_ADDRESS:-}"

# Minimum SOL balance required to proceed
MIN_BALANCE=20

# Compute unit price for priority fees (mainnet congestion)
COMPUTE_UNIT_PRICE=50000

# Binary paths
VAULT_SO="$PROJECT_ROOT/target/deploy/agent_vault.so"
REGISTRY_SO="$PROJECT_ROOT/target/deploy/agent_registry.so"
SETTLEMENT_SO="$PROJECT_ROOT/target/deploy/settlement.so"

# Keypair paths
VAULT_KEYPAIR="$PROJECT_ROOT/target/deploy/agent_vault-keypair.json"
REGISTRY_KEYPAIR="$PROJECT_ROOT/target/deploy/agent_registry-keypair.json"
SETTLEMENT_KEYPAIR="$PROJECT_ROOT/target/deploy/settlement-keypair.json"

# Parse flags
SKIP_AUTHORITY_TRANSFER=false
for arg in "$@"; do
    case "$arg" in
        --skip-authority-transfer) SKIP_AUTHORITY_TRANSFER=true ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

# ==================== HELPERS ====================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

confirm() {
    local prompt="$1"
    local response
    echo ""
    read -p "$prompt [y/N]: " response
    if [[ "$response" != "y" && "$response" != "Y" ]]; then
        log_error "Aborted by user."
        exit 1
    fi
}

check_balance() {
    local balance
    balance=$(solana balance | awk '{print $1}')
    echo "$balance"
    if (( $(echo "$balance < $MIN_BALANCE" | bc -l) )); then
        log_error "Insufficient balance: $balance SOL (minimum: $MIN_BALANCE SOL)"
        log_error "Fund your wallet before proceeding."
        exit 1
    fi
}

verify_program_id() {
    local keypair_path="$1"
    local expected_id="$2"
    local program_name="$3"
    local actual_id
    actual_id=$(solana-keygen pubkey "$keypair_path")
    if [[ "$actual_id" != "$expected_id" ]]; then
        log_error "Program ID mismatch for $program_name!"
        log_error "  Expected: $expected_id"
        log_error "  Got:      $actual_id"
        exit 1
    fi
    log_info "$program_name program ID verified: $actual_id"
}

# ==================== PRE-FLIGHT CHECKS ====================

echo ""
echo "=============================================="
echo "  AEAP MAINNET DEPLOYMENT"
echo "  THIS DEPLOYS TO SOLANA MAINNET-BETA"
echo "  REAL SOL WILL BE SPENT"
echo "=============================================="
echo ""

# 1. Verify cluster is mainnet
CLUSTER=$(solana config get | grep "RPC URL" | awk '{print $NF}')
log_info "RPC Cluster: $CLUSTER"

if [[ "$CLUSTER" != *"mainnet"* ]]; then
    log_error "Solana CLI is NOT configured for mainnet-beta."
    log_error "Current cluster: $CLUSTER"
    log_error "Run: solana config set --url https://api.mainnet-beta.solana.com"
    exit 1
fi

# 2. Verify wallet
WALLET=$(solana address)
log_info "Deployer wallet: $WALLET"

BALANCE=$(check_balance)
log_info "Wallet balance: $BALANCE SOL"

# 3. Verify binaries exist
log_info "Checking program binaries..."
for so in "$VAULT_SO" "$REGISTRY_SO" "$SETTLEMENT_SO"; do
    if [ ! -f "$so" ]; then
        log_error "Program binary not found: $so"
        log_error "Run 'anchor build --no-idl' first."
        exit 1
    fi
    log_info "  Found: $(basename "$so") ($(wc -c < "$so") bytes)"
done

# 4. Verify program IDs match keypairs
log_info "Verifying program IDs..."
verify_program_id "$VAULT_KEYPAIR" "$VAULT_PROGRAM_ID" "Agent Vault"
verify_program_id "$REGISTRY_KEYPAIR" "$REGISTRY_PROGRAM_ID" "Agent Registry"
verify_program_id "$SETTLEMENT_KEYPAIR" "$SETTLEMENT_PROGRAM_ID" "Settlement"

# 5. Print binary hashes for audit verification
echo ""
log_info "Program binary SHA-256 hashes (verify against audit report):"
echo "  agent_vault.so:    $(sha256sum "$VAULT_SO" | awk '{print $1}')"
echo "  agent_registry.so: $(sha256sum "$REGISTRY_SO" | awk '{print $1}')"
echo "  settlement.so:     $(sha256sum "$SETTLEMENT_SO" | awk '{print $1}')"

# 6. Check multi-sig address
if [[ "$SKIP_AUTHORITY_TRANSFER" == "false" ]]; then
    if [[ -z "$MULTISIG_ADDRESS" ]]; then
        log_warn "MULTISIG_ADDRESS is not set."
        log_warn "Upgrade authority will NOT be transferred to a multi-sig."
        log_warn "Set MULTISIG_ADDRESS env var or pass --skip-authority-transfer."
        confirm "Continue WITHOUT multi-sig authority transfer?"
        SKIP_AUTHORITY_TRANSFER=true
    else
        log_info "Multi-sig address: $MULTISIG_ADDRESS"
    fi
fi

# 7. Final confirmation
echo ""
echo "=============================================="
echo "  DEPLOYMENT SUMMARY"
echo "=============================================="
echo "  Cluster:     $CLUSTER"
echo "  Wallet:      $WALLET"
echo "  Balance:     $BALANCE SOL"
echo "  Programs:    3 (Vault, Registry, Settlement)"
echo "  Multi-sig:   ${MULTISIG_ADDRESS:-NONE}"
echo "=============================================="
echo ""
confirm "PROCEED WITH MAINNET DEPLOYMENT? This action is irreversible."

# ==================== DEPLOY PROGRAMS ====================

deploy_program() {
    local name="$1"
    local keypair="$2"
    local binary="$3"
    local program_id="$4"

    echo ""
    echo "--- Deploying $name ---"
    confirm "Deploy $name ($program_id) to mainnet?"

    # Re-check balance before each deploy
    local balance
    balance=$(solana balance | awk '{print $1}')
    log_info "Current balance: $balance SOL"

    solana program deploy \
        --program-id "$keypair" \
        "$binary" \
        --with-compute-unit-price "$COMPUTE_UNIT_PRICE" \
        --max-sign-attempts 5

    # Verify deployment
    if solana program show "$program_id" > /dev/null 2>&1; then
        log_info "$name deployed successfully."
    else
        log_error "$name deployment FAILED. Aborting."
        exit 1
    fi
}

# Deploy in order: Registry first (no dependencies), then Vault, then Settlement
deploy_program "Agent Registry" "$REGISTRY_KEYPAIR" "$REGISTRY_SO" "$REGISTRY_PROGRAM_ID"
deploy_program "Agent Vault" "$VAULT_KEYPAIR" "$VAULT_SO" "$VAULT_PROGRAM_ID"
deploy_program "Settlement" "$SETTLEMENT_KEYPAIR" "$SETTLEMENT_SO" "$SETTLEMENT_PROGRAM_ID"

# ==================== TRANSFER UPGRADE AUTHORITY ====================

if [[ "$SKIP_AUTHORITY_TRANSFER" == "false" && -n "$MULTISIG_ADDRESS" ]]; then
    echo ""
    echo "--- Transferring Upgrade Authority to Multi-Sig ---"
    confirm "Transfer upgrade authority for ALL 3 programs to $MULTISIG_ADDRESS?"

    for pid in "$VAULT_PROGRAM_ID" "$REGISTRY_PROGRAM_ID" "$SETTLEMENT_PROGRAM_ID"; do
        log_info "Transferring authority for $pid..."
        solana program set-upgrade-authority "$pid" \
            --new-upgrade-authority "$MULTISIG_ADDRESS"

        # Verify
        local authority
        authority=$(solana program show "$pid" | grep "Authority" | awk '{print $NF}')
        if [[ "$authority" == "$MULTISIG_ADDRESS" ]]; then
            log_info "  Authority verified: $MULTISIG_ADDRESS"
        else
            log_error "  Authority transfer FAILED for $pid. Current authority: $authority"
            exit 1
        fi
    done

    log_info "All upgrade authorities transferred to multi-sig."
fi

# ==================== POST-DEPLOYMENT VERIFICATION ====================

echo ""
echo "=== Post-Deployment Verification ==="
echo ""

for pid in "$VAULT_PROGRAM_ID" "$REGISTRY_PROGRAM_ID" "$SETTLEMENT_PROGRAM_ID"; do
    echo "--- $pid ---"
    solana program show "$pid"
    echo ""
done

FINAL_BALANCE=$(solana balance | awk '{print $1}')

echo "=============================================="
echo "  DEPLOYMENT COMPLETE"
echo "=============================================="
echo "  Agent Vault:    $VAULT_PROGRAM_ID"
echo "  Agent Registry: $REGISTRY_PROGRAM_ID"
echo "  Settlement:     $SETTLEMENT_PROGRAM_ID"
echo "  SOL spent:      $(echo "$BALANCE - $FINAL_BALANCE" | bc) SOL"
echo "  Remaining:      $FINAL_BALANCE SOL"
echo "=============================================="
echo ""
echo "Next steps:"
echo "  1. Verify binary hashes match audit report"
echo "  2. Set up Helius webhooks for monitoring"
echo "  3. Run mainnet smoke test with small amounts"
echo "  4. Update MCP server SOLANA_RPC_URL to mainnet"
echo "  5. Announce deployment to team and community"
echo "  6. Begin 72-hour monitoring period"
