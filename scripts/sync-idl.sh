#!/usr/bin/env bash
#
# S-xcut-03: regenerate committed IDL from the current program source.
#
# Run this locally whenever you change anything in `programs/**` that affects
# the IDL (new instruction, new event, renamed field, changed enum variant).
# Review `git diff idl/` and commit the update alongside the program change —
# CI enforces that `idl/*.json` matches the output of `anchor build`.
#
# Usage: ./scripts/sync-idl.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v anchor > /dev/null 2>&1; then
  echo "error: anchor CLI not found in PATH" >&2
  echo "install: cargo install --git https://github.com/coral-xyz/anchor --tag v0.31.1 anchor-cli --locked" >&2
  exit 1
fi

anchor build

mkdir -p idl
for f in target/idl/*.json; do
  cp "$f" "idl/$(basename "$f")"
done

echo "IDL synced into idl/. Review with 'git diff idl/' and commit."
