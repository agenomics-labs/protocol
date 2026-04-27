#!/usr/bin/env bash
# AEP Mainnet Deployment Script
#
# Usage:
#   MULTISIG_ADDRESS=<squads-vault-pda> ./scripts/mainnet-deploy.sh
#   ./scripts/mainnet-deploy.sh --self-test     # gate-logic smoke test, no I/O
#   ./scripts/mainnet-deploy.sh --help
#
# Environment:
#   MULTISIG_ADDRESS   (REQUIRED) base58 pubkey for upgrade-authority transfer.
#                      No skip flag; no in-script default. See ADR-080 §3.
#   AEP_DEPLOY_DRY_RUN (optional, =1) bypasses cluster + tagged-HEAD + signed-tag
#                      gates so the script logic can be rehearsed against devnet.
#                      Does NOT bypass the hash-check (rehearsals are expected
#                      to fail at the hash gate; that's the test). See ADR-080
#                      §1 gate 4-5 + §2.
#
# What this script does (in order):
#   1. Pre-flight gates (refuse-to-run, never warn-and-continue).
#   2. Print and log pre-deploy state to logs/mainnet-deploy-<UTC>.log.
#   3. Deploy: Registry → Vault → Settlement.
#   4. Transfer upgrade authority on all three programs to MULTISIG_ADDRESS.
#   5. Post-deploy verification + final summary.
#
# Exit codes:
#   0   success
#   1   pre-flight failure or runtime failure
#   2   --help requested
#
# Authoritative reference: docs/adr/ADR-080-mainnet-deploy-safety-mandates.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ==================== CONFIGURATION ====================

# Program IDs (from Anchor.toml — keep in sync with the on-chain expected IDs).
VAULT_PROGRAM_ID="4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN"
REGISTRY_PROGRAM_ID="8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh"
SETTLEMENT_PROGRAM_ID="GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3"

# Multi-sig address (REQUIRED — no in-script default; see ADR-080 §3).
MULTISIG_ADDRESS="${MULTISIG_ADDRESS:-}"

# Dry-run flag (devnet rehearsal of script logic; see ADR-080 §1).
AEP_DEPLOY_DRY_RUN="${AEP_DEPLOY_DRY_RUN:-0}"

# Minimum SOL balance required to proceed.
MIN_BALANCE=20

# Compute unit price for priority fees (mainnet congestion).
COMPUTE_UNIT_PRICE=50000

# Audit-report hash file (committed; populated by the auditor per ADR-080 §2).
AUDIT_HASH_FILE="$PROJECT_ROOT/config/AUDIT_REPORT_HASHES"

# Source-controlled SSH allowed-signers file consumed by `git tag -v`
# (Pre-Mainnet Roadmap §2 A5, closing A4). Replaces the implicit
# runner-host keyring with a reviewable in-repo allowlist.
ALLOWED_SIGNERS_FILE="$PROJECT_ROOT/.github/allowed-signers"

# Binary paths (must match the relative paths inside AUDIT_REPORT_HASHES).
VAULT_SO="$PROJECT_ROOT/target/deploy/agent_vault.so"
REGISTRY_SO="$PROJECT_ROOT/target/deploy/agent_registry.so"
SETTLEMENT_SO="$PROJECT_ROOT/target/deploy/settlement.so"

# Keypair paths.
VAULT_KEYPAIR="$PROJECT_ROOT/target/deploy/agent_vault-keypair.json"
REGISTRY_KEYPAIR="$PROJECT_ROOT/target/deploy/agent_registry-keypair.json"
SETTLEMENT_KEYPAIR="$PROJECT_ROOT/target/deploy/settlement-keypair.json"

# Required tools (checked at preflight_tooling).
REQUIRED_TOOLS=(solana solana-keygen sha256sum awk bc git tee)

# ==================== HELPERS ====================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { printf "%b[INFO]%b %s\n"  "$GREEN"  "$NC" "$1"; }
log_warn()  { printf "%b[WARN]%b %s\n"  "$YELLOW" "$NC" "$1"; }
log_error() { printf "%b[ERROR]%b %s\n" "$RED"    "$NC" "$1" >&2; }

confirm() {
    local prompt="$1"
    local response=""
    printf "\n"
    read -r -p "$prompt [y/N]: " response
    if [[ "$response" != "y" && "$response" != "Y" ]]; then
        log_error "Aborted by user."
        exit 1
    fi
}

print_help() {
    sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ==================== PRE-FLIGHT GATES ====================

# Each gate returns 0 on pass, non-zero on fail. The driver
# `run_preflight` invokes them in order and exits on first failure.

preflight_tooling() {
    local missing=()
    local tool
    for tool in "${REQUIRED_TOOLS[@]}"; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            missing+=("$tool")
        fi
    done
    if (( ${#missing[@]} > 0 )); then
        log_error "Required tools missing from PATH: ${missing[*]}"
        return 1
    fi
    return 0
}

preflight_clean_tree() {
    local dirty
    dirty=$(cd "$PROJECT_ROOT" && git status --porcelain)
    if [[ -n "$dirty" ]]; then
        log_error "git working tree is not clean. Refusing to deploy from an uncommitted state."
        log_error "Run \`git status\` and either commit, stash, or revert before retrying."
        return 1
    fi
    return 0
}

preflight_tagged_head() {
    if [[ "$AEP_DEPLOY_DRY_RUN" == "1" ]]; then
        log_warn "AEP_DEPLOY_DRY_RUN=1: skipping tagged-HEAD check."
        return 0
    fi
    local tags
    tags=$(cd "$PROJECT_ROOT" && git tag --points-at HEAD | grep -E '^v.*-mainnet$' || true)
    if [[ -z "$tags" ]]; then
        log_error "HEAD is not pointed at a v*-mainnet tag."
        log_error "Tag the release commit (e.g. \`git tag -s v0.1.0-mainnet -m 'mainnet release'\`) before deploying."
        return 1
    fi
    return 0
}

preflight_allowed_signers() {
    # Per Pre-Mainnet Roadmap §2 A5 (closing A4): the in-repo
    # `.github/allowed-signers` file is the source-controlled allowlist
    # consumed by `git tag -v` in preflight_signed_tag. It ships with
    # `TODO_PLACEHOLDER_*` principals so this gate fails closed until
    # the A2 multisig provisioning ceremony populates real keys.
    # Mirrors preflight_audit_hashes' placeholder-rejection semantics.
    if [[ ! -f "$ALLOWED_SIGNERS_FILE" ]]; then
        log_error "Allowed-signers file not found: $ALLOWED_SIGNERS_FILE"
        log_error "Per Pre-Mainnet Roadmap §2 A5, the source-controlled allowlist must be committed before deploy."
        return 1
    fi
    local stripped
    stripped=$(grep -Ev '^\s*(#|$)' "$ALLOWED_SIGNERS_FILE")
    if [[ -z "$stripped" ]]; then
        log_error "Allowed-signers file is empty after stripping comments: $ALLOWED_SIGNERS_FILE"
        return 1
    fi
    if printf '%s\n' "$stripped" | grep -qE '^TODO_PLACEHOLDER_'; then
        log_error "$ALLOWED_SIGNERS_FILE still contains TODO_PLACEHOLDER_ sentinel principals."
        log_error "Populate with real maintainer SSH signing keys via the lifecycle in the file header (Pre-Mainnet Roadmap §2 A5) before deploying."
        return 1
    fi
    log_info "Allowed-signers file populated with non-placeholder maintainer keys."
    return 0
}

preflight_signed_tag() {
    if [[ "$AEP_DEPLOY_DRY_RUN" == "1" ]]; then
        log_warn "AEP_DEPLOY_DRY_RUN=1: skipping signed-tag verification."
        return 0
    fi
    local tag
    local any_verified=0
    while IFS= read -r tag; do
        [[ -z "$tag" ]] && continue
        # Per Pre-Mainnet Roadmap §2 A5: bind `git tag -v` to the
        # in-repo allowlist, NOT the runner-host keyring. The
        # `gpg.format=ssh` + `gpg.ssh.allowedSignersFile=…` pair makes
        # the committed file the authoritative source for which keys
        # may sign a `v*-mainnet` tag.
        if (cd "$PROJECT_ROOT" && \
            git -c gpg.format=ssh \
                -c gpg.ssh.allowedSignersFile="$ALLOWED_SIGNERS_FILE" \
                tag -v "$tag" >/dev/null 2>&1); then
            any_verified=1
            log_info "Signed tag verified against $ALLOWED_SIGNERS_FILE: $tag"
        else
            log_error "Tag $tag at HEAD is not signed by a key in $ALLOWED_SIGNERS_FILE."
            log_error "Either the tag is unsigned, the signature is invalid, or the signing key is not on the in-repo allowlist (Pre-Mainnet Roadmap §2 A5)."
            return 1
        fi
    done < <(cd "$PROJECT_ROOT" && git tag --points-at HEAD | grep -E '^v.*-mainnet$' || true)
    if (( any_verified == 0 )); then
        log_error "No verifiable signed v*-mainnet tag at HEAD."
        return 1
    fi
    return 0
}

preflight_multisig_set() {
    if [[ -z "$MULTISIG_ADDRESS" ]]; then
        log_error "MULTISIG_ADDRESS is unset or empty."
        log_error "Per ADR-080 §3, this variable is REQUIRED. There is no skip flag."
        log_error "Re-invoke as: MULTISIG_ADDRESS=<squads-vault-pda> $0"
        return 1
    fi
    return 0
}

preflight_multisig_format() {
    # Solana base58 pubkeys are 32-44 chars from the base58 alphabet
    # (no 0, O, I, l). A length+charset check is sufficient pre-RPC; the
    # account-existence check below catches malformed-but-charset-valid input.
    if ! [[ "$MULTISIG_ADDRESS" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]]; then
        log_error "MULTISIG_ADDRESS does not look like a valid base58 Solana pubkey: $MULTISIG_ADDRESS"
        return 1
    fi
    return 0
}

preflight_multisig_exists() {
    if [[ "$AEP_DEPLOY_DRY_RUN" == "1" ]]; then
        log_warn "AEP_DEPLOY_DRY_RUN=1: skipping on-chain multisig existence check."
        return 0
    fi
    if ! solana account "$MULTISIG_ADDRESS" >/dev/null 2>&1; then
        log_error "Multisig account $MULTISIG_ADDRESS does not exist on the configured cluster."
        log_error "Verify with: solana account $MULTISIG_ADDRESS"
        return 1
    fi
    log_info "Multisig account exists on cluster: $MULTISIG_ADDRESS"
    return 0
}

preflight_cluster_mainnet() {
    if [[ "$AEP_DEPLOY_DRY_RUN" == "1" ]]; then
        log_warn "AEP_DEPLOY_DRY_RUN=1: skipping mainnet cluster check."
        return 0
    fi
    local cluster
    cluster=$(solana config get | grep "RPC URL" | awk '{print $NF}')
    log_info "RPC Cluster: $cluster"
    if [[ "$cluster" != *"mainnet"* ]]; then
        log_error "Solana CLI is NOT configured for mainnet-beta."
        log_error "Current cluster: $cluster"
        log_error "Run: solana config set --url https://api.mainnet-beta.solana.com"
        return 1
    fi
    return 0
}

preflight_balance() {
    if [[ "$AEP_DEPLOY_DRY_RUN" == "1" ]]; then
        log_warn "AEP_DEPLOY_DRY_RUN=1: skipping wallet-balance check."
        return 0
    fi
    local balance
    balance=$(solana balance | awk '{print $1}')
    log_info "Wallet balance: $balance SOL"
    if (( $(echo "$balance < $MIN_BALANCE" | bc -l) )); then
        log_error "Insufficient balance: $balance SOL (minimum: $MIN_BALANCE SOL)"
        return 1
    fi
    return 0
}

preflight_binaries_present() {
    local so
    for so in "$VAULT_SO" "$REGISTRY_SO" "$SETTLEMENT_SO"; do
        if [[ ! -f "$so" ]]; then
            log_error "Program binary not found: $so"
            log_error "Run 'anchor build --no-idl' first."
            return 1
        fi
        log_info "  Found: $(basename "$so") ($(wc -c < "$so") bytes)"
    done
    return 0
}

preflight_program_ids() {
    if [[ "$AEP_DEPLOY_DRY_RUN" == "1" ]]; then
        # Keypair files may be absent in CI dry-run; allow but warn.
        log_warn "AEP_DEPLOY_DRY_RUN=1: skipping program-ID/keypair match check."
        return 0
    fi
    verify_program_id "$VAULT_KEYPAIR"      "$VAULT_PROGRAM_ID"      "Agent Vault"      || return 1
    verify_program_id "$REGISTRY_KEYPAIR"   "$REGISTRY_PROGRAM_ID"   "Agent Registry"   || return 1
    verify_program_id "$SETTLEMENT_KEYPAIR" "$SETTLEMENT_PROGRAM_ID" "Settlement"       || return 1
    return 0
}

preflight_audit_hashes() {
    if [[ ! -f "$AUDIT_HASH_FILE" ]]; then
        log_error "Audit-report hash file not found: $AUDIT_HASH_FILE"
        log_error "Per ADR-080 §2, the auditor's hash list must be committed before deploy."
        return 1
    fi
    # Strip comments and blank lines; feed the rest to sha256sum --check.
    local stripped
    stripped=$(grep -Ev '^\s*(#|$)' "$AUDIT_HASH_FILE")
    if [[ -z "$stripped" ]]; then
        log_error "Audit-report hash file is empty after stripping comments: $AUDIT_HASH_FILE"
        return 1
    fi
    log_info "Verifying program binaries against $AUDIT_HASH_FILE ..."
    if ! (cd "$PROJECT_ROOT" && printf '%s\n' "$stripped" | sha256sum --check --strict -); then
        log_error "Binary hash verification FAILED. Refusing to deploy."
        log_error "The deployable binaries do not match the auditor-reviewed hashes."
        log_error "If this is an intentional re-audit, update $AUDIT_HASH_FILE in a dedicated PR."
        return 1
    fi
    log_info "All program binaries match the audit-report hashes."
    return 0
}

verify_program_id() {
    local keypair_path="$1"
    local expected_id="$2"
    local program_name="$3"
    local actual_id
    if [[ ! -f "$keypair_path" ]]; then
        log_error "Keypair file not found for $program_name: $keypair_path"
        return 1
    fi
    actual_id=$(solana-keygen pubkey "$keypair_path")
    if [[ "$actual_id" != "$expected_id" ]]; then
        log_error "Program ID mismatch for $program_name!"
        log_error "  Expected: $expected_id"
        log_error "  Got:      $actual_id"
        return 1
    fi
    log_info "$program_name program ID verified: $actual_id"
    return 0
}

run_preflight() {
    local gate
    local gates=(
        preflight_tooling
        preflight_clean_tree
        preflight_tagged_head
        preflight_allowed_signers
        preflight_signed_tag
        preflight_multisig_set
        preflight_multisig_format
        preflight_multisig_exists
        preflight_cluster_mainnet
        preflight_balance
        preflight_binaries_present
        preflight_program_ids
        preflight_audit_hashes
    )
    for gate in "${gates[@]}"; do
        log_info "Pre-flight: $gate"
        if ! "$gate"; then
            log_error "Pre-flight gate failed: $gate"
            return 1
        fi
    done
    return 0
}

# ==================== DEPLOY ====================

deploy_program() {
    local name="$1"
    local keypair="$2"
    local binary="$3"
    local program_id="$4"

    printf "\n--- Deploying %s ---\n" "$name"
    confirm "Deploy $name ($program_id) to mainnet?"

    local balance
    balance=$(solana balance | awk '{print $1}')
    log_info "Current balance: $balance SOL"

    solana program deploy \
        --program-id "$keypair" \
        "$binary" \
        --with-compute-unit-price "$COMPUTE_UNIT_PRICE" \
        --max-sign-attempts 5

    if solana program show "$program_id" >/dev/null 2>&1; then
        log_info "$name deployed successfully."
    else
        log_error "$name deployment FAILED. Aborting."
        return 1
    fi
}

# ==================== AUTHORITY TRANSFER ====================

# verify_authority and transfer_authority_to_multisig are wrapped in
# functions so `local` is a legal declaration. See ADR-080 §4.

verify_authority() {
    local pid="$1"
    local authority
    authority=$(solana program show "$pid" | grep "Authority" | awk '{print $NF}')
    if [[ "$authority" != "$MULTISIG_ADDRESS" ]]; then
        log_error "Authority transfer FAILED for $pid. Current authority: $authority"
        return 1
    fi
    log_info "  Authority verified: $authority"
    return 0
}

transfer_authority_to_multisig() {
    printf "\n--- Transferring Upgrade Authority to Multi-Sig ---\n"
    confirm "Transfer upgrade authority for ALL 3 programs to $MULTISIG_ADDRESS?"

    local pid
    for pid in "$VAULT_PROGRAM_ID" "$REGISTRY_PROGRAM_ID" "$SETTLEMENT_PROGRAM_ID"; do
        log_info "Transferring authority for $pid..."
        solana program set-upgrade-authority "$pid" \
            --new-upgrade-authority "$MULTISIG_ADDRESS"
        verify_authority "$pid" || return 1
    done

    log_info "All upgrade authorities transferred to multi-sig."
}

# ==================== DEPLOY LOG ====================

write_deploy_log_header() {
    local logfile="$1"
    {
        printf "AEP mainnet-deploy log\n"
        printf "======================\n"
        printf "UTC time:        %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf "Commit SHA:      %s\n" "$(cd "$PROJECT_ROOT" && git rev-parse HEAD)"
        printf "Tags at HEAD:    %s\n" "$(cd "$PROJECT_ROOT" && git tag --points-at HEAD | tr '\n' ' ')"
        printf "git describe:    %s\n" "$(cd "$PROJECT_ROOT" && git describe --dirty --always --tags 2>/dev/null || echo '(none)')"
        printf "solana version:  %s\n" "$(solana --version 2>/dev/null || echo '(missing)')"
        printf "anchor version:  %s\n" "$(anchor --version 2>/dev/null || echo '(missing)')"
        printf "MULTISIG:        %s\n" "$MULTISIG_ADDRESS"
        printf "AEP_DRY_RUN:     %s\n" "$AEP_DEPLOY_DRY_RUN"
        printf "\n--- solana config ---\n"
        solana config get 2>/dev/null || true
        printf "\n--- deployer wallet ---\n"
        printf "address: %s\n" "$(solana address 2>/dev/null || echo '(missing)')"
        printf "balance: %s\n" "$(solana balance 2>/dev/null || echo '(missing)')"
        printf "\n--- audit-report hashes (committed) ---\n"
        cat "$AUDIT_HASH_FILE" 2>/dev/null || echo "(missing)"
        printf "\n--- actual binary hashes (must match above) ---\n"
        (cd "$PROJECT_ROOT" && sha256sum target/deploy/agent_vault.so target/deploy/agent_registry.so target/deploy/settlement.so 2>/dev/null) || echo "(binaries missing)"
        printf "\n--- multisig account on cluster ---\n"
        solana account "$MULTISIG_ADDRESS" 2>/dev/null || echo "(unavailable)"
        printf "\n--- begin deploy ---\n"
    } >> "$logfile"
}

write_deploy_log_footer() {
    local logfile="$1"
    local final_balance="$2"
    local pid
    {
        printf "\n--- post-deploy program show ---\n"
        for pid in "$VAULT_PROGRAM_ID" "$REGISTRY_PROGRAM_ID" "$SETTLEMENT_PROGRAM_ID"; do
            printf "\n[program %s]\n" "$pid"
            solana program show "$pid" 2>/dev/null || echo "(unavailable)"
        done
        printf "\n--- final state ---\n"
        printf "final balance:   %s SOL\n" "$final_balance"
        printf "completed UTC:   %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } >> "$logfile"
}

# ==================== SELF-TEST ====================

# `--self-test` verifies the script's gate logic without invoking any
# Solana CLI command, without requiring a wallet, and without network.
# It is the smoke test referenced in ADR-080 §6.

self_test() {
    local failures=0
    log_info "self-test: parse + function-presence checks"

    # Required functions exist.
    local fn
    local required_fns=(
        confirm verify_program_id verify_authority transfer_authority_to_multisig
        deploy_program write_deploy_log_header write_deploy_log_footer
        preflight_tooling preflight_clean_tree preflight_tagged_head
        preflight_allowed_signers preflight_signed_tag
        preflight_multisig_set preflight_multisig_format
        preflight_multisig_exists preflight_cluster_mainnet preflight_balance
        preflight_binaries_present preflight_program_ids preflight_audit_hashes
        run_preflight self_test
    )
    for fn in "${required_fns[@]}"; do
        if ! declare -F "$fn" >/dev/null; then
            log_error "self-test: function missing: $fn"
            failures=$((failures + 1))
        fi
    done

    # set -euo pipefail in effect.
    case "$-" in
        *e*u*) : ;;
        *u*e*) : ;;
        *)
            log_error "self-test: set -euo pipefail not in effect"
            failures=$((failures + 1))
            ;;
    esac

    # AUDIT_HASH_FILE present and well-formed.
    if [[ ! -f "$AUDIT_HASH_FILE" ]]; then
        log_error "self-test: $AUDIT_HASH_FILE missing"
        failures=$((failures + 1))
    else
        local body
        body=$(grep -Ev '^\s*(#|$)' "$AUDIT_HASH_FILE")
        local lines
        lines=$(printf '%s\n' "$body" | wc -l)
        if (( lines != 3 )); then
            log_error "self-test: AUDIT_REPORT_HASHES expected 3 entries, got $lines"
            failures=$((failures + 1))
        fi
        if ! printf '%s\n' "$body" | grep -Eq '^[0-9a-f]{64}  target/deploy/agent_vault\.so$'; then
            log_error "self-test: AUDIT_REPORT_HASHES missing well-formed agent_vault.so entry"
            failures=$((failures + 1))
        fi
        if ! printf '%s\n' "$body" | grep -Eq '^[0-9a-f]{64}  target/deploy/agent_registry\.so$'; then
            log_error "self-test: AUDIT_REPORT_HASHES missing well-formed agent_registry.so entry"
            failures=$((failures + 1))
        fi
        if ! printf '%s\n' "$body" | grep -Eq '^[0-9a-f]{64}  target/deploy/settlement\.so$'; then
            log_error "self-test: AUDIT_REPORT_HASHES missing well-formed settlement.so entry"
            failures=$((failures + 1))
        fi
    fi

    # ALLOWED_SIGNERS_FILE present and well-formed (Pre-Mainnet
    # Roadmap §2 A5). Mirrors the AUDIT_HASH_FILE shape check above:
    # we assert the file exists, has at least one non-comment line,
    # and that every non-comment line parses as the SSH allowed-signers
    # format (`<principal> [namespaces=...] <key-type> <base64-blob> ...`).
    # We do NOT require non-placeholder content here — the placeholder
    # rejection lives in preflight_allowed_signers, exactly mirroring
    # the AUDIT_REPORT_HASHES placeholder/preflight split.
    if [[ ! -f "$ALLOWED_SIGNERS_FILE" ]]; then
        log_error "self-test: $ALLOWED_SIGNERS_FILE missing"
        failures=$((failures + 1))
    else
        local signers_body
        signers_body=$(grep -Ev '^\s*(#|$)' "$ALLOWED_SIGNERS_FILE")
        if [[ -z "$signers_body" ]]; then
            log_error "self-test: $ALLOWED_SIGNERS_FILE has no non-comment signer lines"
            failures=$((failures + 1))
        else
            # Each non-comment line must be: <principal> [namespaces="..."]
            # <ssh-key-type> <base64-blob> [comment]. The base64 blob has no
            # whitespace; allowed key types per `ssh-keygen` are sk-ssh-ed25519,
            # ssh-ed25519, ssh-rsa, ecdsa-sha2-*, ssh-dss. Match permissively
            # but require at least principal + key-type + blob.
            local bad_line
            bad_line=$(printf '%s\n' "$signers_body" | \
                grep -Ev '^\S+( +namespaces="[^"]+")? +(sk-)?(ssh-(ed25519|rsa|dss)|ecdsa-sha2-\S+) +[A-Za-z0-9+/=]+( +.*)?$' || true)
            if [[ -n "$bad_line" ]]; then
                log_error "self-test: $ALLOWED_SIGNERS_FILE has malformed signer line(s):"
                log_error "$bad_line"
                failures=$((failures + 1))
            fi
        fi
    fi

    # preflight_multisig_set: empty input must fail.
    local saved="$MULTISIG_ADDRESS"
    MULTISIG_ADDRESS=""
    if preflight_multisig_set >/dev/null 2>&1; then
        log_error "self-test: preflight_multisig_set passed on empty input"
        failures=$((failures + 1))
    fi
    # preflight_multisig_format: garbage input must fail.
    MULTISIG_ADDRESS="not-a-pubkey-0OIl"
    if preflight_multisig_format >/dev/null 2>&1; then
        log_error "self-test: preflight_multisig_format passed on invalid charset"
        failures=$((failures + 1))
    fi
    # preflight_multisig_format: well-formed pubkey must pass (use a known dummy).
    MULTISIG_ADDRESS="11111111111111111111111111111111"
    if ! preflight_multisig_format >/dev/null 2>&1; then
        log_error "self-test: preflight_multisig_format rejected a well-formed pubkey"
        failures=$((failures + 1))
    fi
    MULTISIG_ADDRESS="$saved"

    # preflight_audit_hashes against the placeholder file: in self-test mode
    # we don't actually want to run the sha256sum check (binaries may not
    # exist in CI), so we only assert the file existence + well-formedness
    # path covered above.

    # Run the shell-linter (if available) on the script itself.
    if command -v shellcheck >/dev/null 2>&1; then
        if ! shellcheck --severity=warning "${BASH_SOURCE[0]}"; then
            log_warn "self-test: shellcheck reported issues (non-fatal here; CI gate is authoritative)"
        else
            log_info "self-test: shellcheck clean"
        fi
    else
        log_warn "self-test: shellcheck not on PATH (CI gate enforces it)"
    fi

    if (( failures > 0 )); then
        log_error "self-test: $failures check(s) failed"
        return 1
    fi
    log_info "self-test: PASS"
    return 0
}

# ==================== ARGUMENT PARSING ====================

for arg in "$@"; do
    case "$arg" in
        --help|-h)
            print_help
            exit 2
            ;;
        --self-test)
            self_test
            exit $?
            ;;
        *)
            log_error "Unknown argument: $arg"
            log_error "Usage: $0 [--help|--self-test]"
            exit 1
            ;;
    esac
done

# ==================== MAIN ====================

printf "\n"
printf "==============================================\n"
printf "  AEP MAINNET DEPLOYMENT\n"
printf "  THIS DEPLOYS TO SOLANA MAINNET-BETA\n"
printf "  REAL SOL WILL BE SPENT\n"
printf "==============================================\n"
printf "\n"

if [[ "$AEP_DEPLOY_DRY_RUN" == "1" ]]; then
    log_warn "AEP_DEPLOY_DRY_RUN=1 IS SET. Cluster, tagged-HEAD, and signed-tag gates will be bypassed."
    log_warn "This mode is for devnet rehearsals only. The hash-check gate is NOT bypassed."
fi

run_preflight

# Open deploy log AFTER preflight passes.
mkdir -p "$PROJECT_ROOT/logs"
LOG_TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG_FILE="$PROJECT_ROOT/logs/mainnet-deploy-${LOG_TIMESTAMP}.log"
log_info "Deploy log: $LOG_FILE"
write_deploy_log_header "$LOG_FILE"

# Capture deployer state for the final-summary echo.
DEPLOYER_WALLET=$(solana address)
START_BALANCE=$(solana balance | awk '{print $1}')

printf "\n"
printf "==============================================\n"
printf "  DEPLOYMENT SUMMARY\n"
printf "==============================================\n"
printf "  Deployer:    %s\n" "$DEPLOYER_WALLET"
printf "  Balance:     %s SOL\n" "$START_BALANCE"
printf "  Programs:    3 (Registry, Vault, Settlement)\n"
printf "  Multi-sig:   %s\n" "$MULTISIG_ADDRESS"
printf "  Log file:    %s\n" "$LOG_FILE"
printf "==============================================\n"

confirm "PROCEED WITH MAINNET DEPLOYMENT? This action is irreversible."

# Mirror remaining stdout/stderr to the log file.
exec > >(tee -a "$LOG_FILE") 2>&1

# Deploy in order: Registry first (no dependencies), then Vault, then Settlement.
deploy_program "Agent Registry" "$REGISTRY_KEYPAIR" "$REGISTRY_SO" "$REGISTRY_PROGRAM_ID"
deploy_program "Agent Vault"    "$VAULT_KEYPAIR"    "$VAULT_SO"    "$VAULT_PROGRAM_ID"
deploy_program "Settlement"     "$SETTLEMENT_KEYPAIR" "$SETTLEMENT_SO" "$SETTLEMENT_PROGRAM_ID"

# Authority transfer is unconditional (no skip flag; see ADR-080 §3).
transfer_authority_to_multisig

# ==================== POST-DEPLOY VERIFICATION ====================

printf "\n=== Post-Deployment Verification ===\n\n"

for pid in "$VAULT_PROGRAM_ID" "$REGISTRY_PROGRAM_ID" "$SETTLEMENT_PROGRAM_ID"; do
    printf "\n--- %s ---\n" "$pid"
    solana program show "$pid"
done

FINAL_BALANCE=$(solana balance | awk '{print $1}')

write_deploy_log_footer "$LOG_FILE" "$FINAL_BALANCE"

printf "\n==============================================\n"
printf "  DEPLOYMENT COMPLETE\n"
printf "==============================================\n"
printf "  Agent Vault:    %s\n" "$VAULT_PROGRAM_ID"
printf "  Agent Registry: %s\n" "$REGISTRY_PROGRAM_ID"
printf "  Settlement:     %s\n" "$SETTLEMENT_PROGRAM_ID"
printf "  Multi-sig:      %s\n" "$MULTISIG_ADDRESS"
printf "  SOL spent:      %s SOL\n" "$(echo "$START_BALANCE - $FINAL_BALANCE" | bc)"
printf "  Remaining:      %s SOL\n" "$FINAL_BALANCE"
printf "  Deploy log:     %s\n" "$LOG_FILE"
printf "==============================================\n"

cat <<EOF

Next steps:
  1. Verify binary hashes in $LOG_FILE match config/AUDIT_REPORT_HASHES.
  2. Set up Helius webhooks for monitoring.
  3. Run mainnet smoke test with small amounts:
       a. MCP handler suite: cd mcp-server && npx ts-mocha -p tsconfig.test.json \\
            test/mcp-handlers.test.ts
       b. Anchor integration suite: anchor test --skip-deploy --skip-local-validator \\
            --provider.cluster mainnet
       c. Exercise ADR-060 update_manifest with a sub-cent test manifest.
  4. Update MCP server SOLANA_RPC_URL to mainnet.
  5. Announce deployment to team and community.
  6. Begin 72-hour monitoring period.

Rollback plan if integration tests fail:
  - Program binaries are upgradable by $MULTISIG_ADDRESS.
  - Pre-deploy commit SHA, tag, audit hashes, and per-program post-deploy state
    are recorded in $LOG_FILE.
  - Rebuild from the pre-deploy commit SHA per ADR-013's pinned toolchain
    and re-run this script with the rollback build's AUDIT_REPORT_HASHES merged.
  - For multisig-inoperable scenarios, see ADR-078 §2 (sealed rollback keypair).
EOF
