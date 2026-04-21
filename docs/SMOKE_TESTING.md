# Smoke Testing — Agenomics Protocol

Three-layer confidence check before cutting `v0.1.0` of the npm packages.
Each layer has a distinct audience and cadence.

---

## 1. Always run — local unit tests (per-package)

Run on every change. No network, no validator, no keys.

```bash
# Rust program unit tests
cargo test --manifest-path programs/agent-registry/Cargo.toml

# Off-chain TS packages
cd packages/capability-manifest-validator && npm test   # 12 tests
cd packages/sas-resolver && npm test                    # 56 tests
cd mcp-server && npm test                               # 94 tests (incl. smoke-integration)

# Anchor integration (requires local validator or `anchor test`)
anchor test                                             # 99 tests
```

Expected: all four suites green. If `mcp-server` fails, run
`cd packages/capability-manifest-validator && npm run build && cd ../sas-resolver && npm run build`
first — the mcp-server's dynImports at test time resolve `@agenomics/*`
packages through their `dist/` outputs.

---

## 2. CI-enforced — mocked-RPC integration (every PR)

File: [`mcp-server/test/smoke-integration.test.ts`](../mcp-server/test/smoke-integration.test.ts)

21 tests covering:

- `validateManifest` round-trip: valid / `HASH_MISMATCH` / `SIGNATURE_MISMATCH` / `SCHEMA_INVALID` / `INVALID_INPUT`.
- `SasResolver` against a hand-built `@solana/kit` RPC stub — ADR-061 §4 failure-mode table, rows 4a–4g, each verified as its own test case (happy path, no-owner-attestation, account missing, schema mismatch, credential not allowlisted, expired, subject mismatch (hard error), data parse failure, invalid subject input).
- Cache behaviour: repeat `resolve()` hits the cache (1 RPC call for 2 requests); `maxAge: 0` bypass (2 RPC calls for 2 requests); `cacheMetrics()` hits/misses.
- Composed validator + resolver back-to-back (mirrors `handleGetAgentReputation`), plus `detectDisagreement` and `scoreFreshness` merge helpers.

The suite runs under `node --import tsx --test` as part of `cd mcp-server && npm test`. CI picks it up automatically — no extra wiring.

---

## 3. Manual devnet (pre-release)

Run this once before cutting a release. Requires a funded devnet wallet.

### Prerequisites

```bash
# Solana CLI pointed at devnet
solana config set --url devnet

# Wallet with ≥ 2 SOL on devnet
solana balance                            # confirm funds
solana airdrop 2                          # if needed (may rate-limit)

# All three programs deployed on devnet (idempotent)
./scripts/deploy-devnet.sh

# @agenomics/* dist built (the script and MCP server both need this)
cd packages/capability-manifest-validator && npm run build
cd ../sas-resolver && npm run build
cd ../../mcp-server && npm run build

# mcp-server needs its deps installed
cd mcp-server && npm install
```

### Run

```bash
SOLANA_RPC_URL=https://api.devnet.solana.com \
  npx ts-node scripts/smoke-test-devnet.ts
```

### Expected pass criteria per step

| Step | Name | Pass criteria |
|---|---|---|
| 1 | Program deployment probe | All three programs show `DEPLOYED (N bytes)` |
| 2 | Test wallet + airdrop | `Airdropped 2 SOL` |
| 3 | `initialize_vault` | `Vault created: <base58>` |
| 4 | `register_agent` | `Agent registered: <base58>` |
| 5 | On-chain state | Vault authority + agent name/category/status all match |
| 6 | `update_manifest` (ADR-060) | `manifest_hash matches local: true`; `manifest_signature matches local: true`; `manifest_version = 0x100` |
| 7 | Validator round-trip | Clean manifest `ok=true`; tampered manifest `ok=false`, code ≠ `INVALID_INPUT` (must be one of `HASH_MISMATCH` / `SCHEMA_INVALID` / `SIGNATURE_MISMATCH` depending on which byte was flipped) |
| 8 | MCP `get_agent_reputation` | `tools/list` returns `get_agent_reputation` among N tools; `tools/call` response contains `sas-not-configured` (stub signal, since no SAS env vars set) |
| 9 | v2 `vault_transfer` parity | v1 dispatch succeeds; v2 dispatch succeeds; `v2 warning emitted: true` (one-line stderr log `"routing vault_transfer through the Kit v2 pipeline"`) |
| 10 | Preflight denial proof | Response contains `PREFLIGHT_FAILED` AND `daily_cap_not_exhausted`; `CAPABILITY_MISSING` NOT present (sanity — the caller holds `sign:vault`) |
| 11-13 | SAS bootstrap (conditional) | If `AEP_SAS_SCHEMA_PDA` + `AEP_SAS_ALLOWED_CREDENTIALS` are set, the script reports the env detection. Otherwise: `"SAS not bootstrapped on devnet — skipping steps 11-13"` — this is expected until the SAS program is live on devnet |

### Troubleshooting

**Step 1 fails (`NOT FOUND`)** — Programs aren't deployed on devnet for the wallet you're using. Run `./scripts/deploy-devnet.sh` first and verify with `solana program show <program_id>`.

**Step 2 fails (`Airdrop failed`)** — Devnet faucet rate-limited. Wait 24 h or fund the test wallet manually via `solana transfer <printed-address> 2 --allow-unfunded-recipient`.

**Step 3/4 failures** — Usually insufficient lamports (need ≥ ~0.01 SOL per account creation), or a previous run left the vault/profile PDA already initialized (the script generates a fresh keypair each run, so this should not recur).

**Step 6 fails (`update_manifest`)** — Most common: IDL mismatch. The script prefers `target/idl/agent_registry.json` (fresh) and falls back to `idl/agent_registry.json` (tracked). If the registry program was redeployed with a different ABI than the checked-in IDL, run `anchor build --no-idl` to refresh and rerun. Also: verify the Ed25519 precompile is bundled in the tx (the script builds it via `Ed25519Program.createInstructionWithPublicKey`).

**Step 7 fails** — Both clean and tampered halves must report as shown. If the clean manifest reports `ok=false`, the on-chain `manifest_hash` / `manifest_signature` did not round-trip cleanly — step 6 likely persisted the wrong bytes.

**Step 8 fails (MCP request timeout)** — The script spawns `mcp-server/dist/index.js` as a subprocess; ensure `cd mcp-server && npm run build` succeeded. Check that the `WALLET_PATH` the script writes (`.smoke-test-wallet.json`) is readable and not blocked by a filesystem ACL.

**Step 9 — no v2 warning** — Either `AEP_USE_V2_VAULT_TRANSFER=1` didn't reach the subprocess (check spawn env in the script), or the `warnV2Enabled()` once-per-process flag was already flipped in that subprocess's lifetime (the script spawns a fresh process per mode, so this should not happen).

**Step 10 — `CAPABILITY_MISSING` present** — The MCP server's `buildLocalDevContext()` should grant `sign:vault` by default. If this assertion flips, the default-capability wiring regressed; bisect against `mcp-server/src/index.ts`.

**Step 11-13 — "SAS not bootstrapped"** — Expected. SAS program is not yet deployed on devnet. To unblock full SAS testing:
1. Deploy SAS to devnet (out of scope for this repo).
2. Create `AEP_AGENT_REPUTATION_v1` schema PDA (ADR-061 §2).
3. Create `AEP_PROTOCOL` / `AEP_VALIDATORS` credential PDAs (ADR-063).
4. Issue one attestation for the test agent's authority pubkey (signer must be in the credential's allowlist).
5. Re-run the smoke test with `AEP_SAS_SCHEMA_PDA=<pda> AEP_SAS_ALLOWED_CREDENTIALS=<csv>`.

---

## Layer summary

| Layer | File | Latency | Runs when |
|---|---|---|---|
| Unit (per-package) | 4 test suites | seconds | every change |
| Mocked integration | [`mcp-server/test/smoke-integration.test.ts`](../mcp-server/test/smoke-integration.test.ts) | < 1 s | every PR (CI) |
| Manual devnet | [`scripts/smoke-test-devnet.ts`](../scripts/smoke-test-devnet.ts) | 30-90 s | pre-release |

Mainnet smoke is **out of scope** until the protocol migrates off devnet.
