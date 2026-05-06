#!/usr/bin/env bash
# AEP SAS bootstrap ceremony driver — single-shot, no-return-channel mode.
#
# Runs the ADR-063 §5 devnet steps 6–8 end-to-end and commits a
# machine-readable status file (scripts/.sas-ceremony-status.json) +
# any updated bootstrap record (scripts/.sas-devnet.json) to main.
#
# Designed for environments where the operator can issue commands to
# this machine but cannot retrieve logs back. Outcome is published via
# git + on-chain state, both of which are readable from any other
# machine via `git pull` and a public devnet RPC.
#
# Idempotent: re-running after a successful ceremony is a no-op (the
# bootstrap script no-ops on an already-live attestation, smoke is
# read-only, and an empty git diff produces no commit).
#
# What the operator MUST have on this machine:
#   1. ~/.config/solana/id.json — pubkey MUST match a Squads multisig
#      member (BUdXA1Fi…jTXL, C1vm83…dvW5, or 8xMiCZ…ynjB).
#   2. .keys/squads-signer-2.json — different multisig member's key.
#   3. Network access to api.devnet.solana.com.
#   4. `git push origin main` configured to succeed without prompts
#      (gh auth setup-git or SSH keys already in place).
#
# What this script writes:
#   - scripts/.sas-devnet.json  (testAttestation block on success)
#   - scripts/.sas-ceremony-status.json  (terminal status + timestamp)
#   - /tmp/aep-sas-ceremony.log  (full stdout/stderr — local only)
#
# Status codes in .sas-ceremony-status.json:
#   PASS                — bootstrap + smoke both green
#   BLOCKED_PRECONDITION — keys missing or pubkey mismatch (no chain ops)
#   BOOTSTRAP_FAILED    — multisig flow errored (partial state may exist)
#   SMOKE_FAILED        — bootstrap landed but resolver round-trip mismatched
#   STATUS_WRITE_FAILED — script crashed before writing status

set -u
set -o pipefail

readonly LOG=/tmp/aep-sas-ceremony.log
readonly STATUS_FILE=scripts/.sas-ceremony-status.json

# Capture all output to log file AND mirror to stdout (for any operator
# who happens to have a console).
exec > >(tee -a "$LOG") 2>&1

ceremony_status="STATUS_WRITE_FAILED"
ceremony_detail="ceremony script started but did not reach a terminal state"

set_status() { ceremony_status="$1"; ceremony_detail="$2"; }

write_and_push_status() {
  # JSON-encode the status. python3 is in stdlib on every dev machine
  # we'd run this on; falls back to a hand-rolled JSON if missing.
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<EOF > "$STATUS_FILE"
import json, datetime, os
print(json.dumps({
    "status": os.environ.get("CER_STATUS", "STATUS_WRITE_FAILED"),
    "detail": os.environ.get("CER_DETAIL", ""),
    "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
    "logFile": "$LOG",
    "host": os.environ.get("HOSTNAME", "unknown"),
}, indent=2))
EOF
  else
    cat > "$STATUS_FILE" <<EOF
{
  "status": "${ceremony_status}",
  "detail": "${ceremony_detail//\"/\\\"}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "logFile": "${LOG}"
}
EOF
  fi

  echo
  echo "=== ceremony terminal status: ${ceremony_status} ==="
  echo "=== detail: ${ceremony_detail} ==="

  # Stage the two files we care about. .sas-devnet.json may be unchanged
  # (no-op idempotent run) or may have a fresh testAttestation block.
  git add "$STATUS_FILE" scripts/.sas-devnet.json 2>/dev/null || true

  # If nothing actually changed, skip the commit.
  if git diff --cached --quiet 2>/dev/null; then
    echo "no diff to commit; skipping push"
    return 0
  fi

  git commit -m "ceremony: ${ceremony_status} — ${ceremony_detail}" >/dev/null 2>&1 || {
    echo "commit failed; status file is on disk at $STATUS_FILE"
    return 1
  }

  # Try push. If rejected (rare — main usually only this machine pushes),
  # rebase once and retry. Don't loop forever.
  git push origin main 2>&1 && return 0
  echo "push rejected; rebasing on origin/main and retrying"
  git pull --rebase origin main 2>&1 || { echo "rebase failed; manual recovery needed"; return 1; }
  git push origin main 2>&1
}

# Always publish the final status, even on abnormal termination. The
# trap fires before set_status results are clobbered by a crash.
trap 'CER_STATUS="$ceremony_status" CER_DETAIL="$ceremony_detail" write_and_push_status' EXIT

echo "=== AEP SAS ceremony driver — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# 1. Sync repo to latest main.
git checkout main || { set_status "BLOCKED_PRECONDITION" "could not checkout main"; exit 1; }
git pull origin main || { set_status "BLOCKED_PRECONDITION" "git pull failed"; exit 1; }

# 2. Precondition checks: keys present + pubkeys are real multisig members.
if [ ! -f ~/.config/solana/id.json ]; then
  set_status "BLOCKED_PRECONDITION" "~/.config/solana/id.json missing"
  exit 1
fi
if [ ! -f .keys/squads-signer-2.json ]; then
  set_status "BLOCKED_PRECONDITION" ".keys/squads-signer-2.json missing"
  exit 1
fi

PK1=$(solana-keygen pubkey ~/.config/solana/id.json 2>/dev/null) || PK1="(decode failed)"
PK2=$(solana-keygen pubkey .keys/squads-signer-2.json 2>/dev/null) || PK2="(decode failed)"
echo "signer 1 pubkey: $PK1"
echo "signer 2 pubkey: $PK2"

VALID_MEMBERS="BUdXA1FiWnV7ksXYodH3uEhDUhfBJ8g4UmmWdshWjTXL C1vm83htBDUwbHyBn4GAzwHoKtLeyc13EPW2nc3udvW5 8xMiCZdgCTB9J244JDiPqkm2yVTQbLuGTc12Qu5AynjB"
case " $VALID_MEMBERS " in *" $PK1 "*) ;; *) set_status "BLOCKED_PRECONDITION" "signer 1 pubkey $PK1 is not a Squads multisig member"; exit 1;; esac
case " $VALID_MEMBERS " in *" $PK2 "*) ;; *) set_status "BLOCKED_PRECONDITION" "signer 2 pubkey $PK2 is not a Squads multisig member"; exit 1;; esac
if [ "$PK1" = "$PK2" ]; then
  set_status "BLOCKED_PRECONDITION" "signer 1 and signer 2 are the same pubkey ($PK1) — need two distinct multisig members for 2-of-3 threshold"
  exit 1
fi

# 3. Workspace install (idempotent). postinstall hooks build the SDK
# packages so dynamic-import in the smoke test resolves.
echo "=== npm install ==="
npm install --no-audit --no-fund || {
  set_status "BLOCKED_PRECONDITION" "npm install failed"
  exit 1
}

# 4. ADR-063 §5 step 6: issue test attestation. Idempotent — exits no-op
# if PDA already live AND .sas-devnet.json record matches.
echo "=== bootstrap-sas-attestation-devnet.ts ==="
if ! npx tsx scripts/bootstrap-sas-attestation-devnet.ts; then
  set_status "BOOTSTRAP_FAILED" "scripts/bootstrap-sas-attestation-devnet.ts exited non-zero — check $LOG; partial state may exist in scripts/.sas-devnet.json"
  exit 1
fi

# 5. ADR-063 §5 step 7-8: smoke test resolver round-trip + full smoke.
# If a pre-funded smoke wallet exists, point the harness at it — devnet
# airdrop is rate-limited and frequently fails Step 2 on fresh keypairs.
# Generate + fund one off-band:
#   solana-keygen new --outfile .keys/smoke-test-devnet.json --no-bip39-passphrase
#   solana transfer --allow-unfunded-recipient --from ~/.config/solana/id.json \
#     "$(solana-keygen pubkey .keys/smoke-test-devnet.json)" 1
if [ -f .keys/smoke-test-devnet.json ]; then
  export SMOKE_TEST_KEYPAIR_PATH=.keys/smoke-test-devnet.json
  echo "using pre-funded smoke wallet at $SMOKE_TEST_KEYPAIR_PATH ($(solana-keygen pubkey "$SMOKE_TEST_KEYPAIR_PATH" 2>/dev/null))"
fi

echo "=== smoke-test-devnet.ts ==="
if ! npx tsx scripts/smoke-test-devnet.ts; then
  set_status "SMOKE_FAILED" "smoke-test-devnet.ts exited non-zero — bootstrap landed but resolver round-trip or earlier step failed; see $LOG and the testAttestation block in scripts/.sas-devnet.json"
  exit 1
fi

# 6. Both green.
set_status "PASS" "bootstrap + smoke both green; SAS resolver round-trip confirmed against live devnet PDAs"
echo "=== ALL GREEN ==="
exit 0
