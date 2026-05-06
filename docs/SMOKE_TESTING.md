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

#### Optional: local IPFS (Kubo) for Step 6 / Step 8 end-to-end proof

Step 6 pins the fabricated capability manifest to an IPFS daemon and records
the real CID on chain. Step 8 then spawns the MCP server with
`AEP_IPFS_GATEWAY` pointed at that same daemon's HTTP gateway, so the
`get_agent_reputation` handler fetches the real pinned bytes, re-hashes them,
and verifies the on-chain Ed25519 signature — a true end-to-end manifest
round-trip.

If Kubo is not installed the script falls back to the synthetic
`bafy + 60*a` CID. The on-chain write still succeeds (exercising `update_manifest`),
but Step 8's handler returns an IPFS-404 when it tries to fetch. That is the
documented degraded path — not a regression — but you lose the full-stack
confidence of Step 8.

Install options (pick one):

```bash
# Option 1 — prebuilt binary (no root required)
curl -sS -o /tmp/kubo.tar.gz \
  https://dist.ipfs.tech/kubo/v0.29.0/kubo_v0.29.0_linux-amd64.tar.gz
tar xzf /tmp/kubo.tar.gz -C /tmp && mkdir -p ~/.local/bin
cp /tmp/kubo/ipfs ~/.local/bin/ipfs
export PATH="$HOME/.local/bin:$PATH"
ipfs --version                            # kubo 0.29.x

# Option 2 — snap
sudo snap install ipfs

# Option 3 — apt (Ubuntu 24.04+; may not be packaged)
sudo apt install kubo
```

Initialize and start the daemon (first time only):

```bash
ipfs init 2>/dev/null || true            # idempotent

# If port 8080 is already in use on this host, pick a free port:
#   ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8082
#   ipfs config --json Gateway.PublicGateways \
#     '{"localhost":{"UseSubdomains":false,"Paths":["/ipfs","/ipns"]}}'
# (the PublicGateways override disables subdomain redirects; without it the
# daemon 301-redirects every path request to <cid>.ipfs.localhost:<port>)

nohup ipfs daemon > /tmp/ipfs-daemon.log 2>&1 &
for i in $(seq 1 15); do
  curl -sf -X POST http://localhost:5001/api/v0/version > /dev/null 2>&1 \
    && { echo "daemon ready"; break; } || sleep 1
done

# When finished: pkill -f "ipfs daemon" (or `kill %1` if it's still a shell job)
```

The smoke script talks to the daemon via two env vars (both optional,
defaults match Kubo's out-of-the-box ports):

| Var                    | Default                    | Purpose                          |
| ---------------------- | -------------------------- | -------------------------------- |
| `AEP_IPFS_API_URL`     | `http://localhost:5001`    | Kubo HTTP API (multipart `/add`) |
| `AEP_IPFS_GATEWAY`     | `http://localhost:8080`    | Kubo HTTP gateway (manifest GET) |

A local gateway beats a public one (`ipfs.io`) for this test because:

- **No rate limits** — the smoke test runs in tight loops during development
  and hammering the public gateway trips throttling mid-run.
- **No propagation delay** — a content just pinned on a public node is not
  guaranteed to be retrievable through `ipfs.io` for tens of seconds while
  the DHT propagates; the local daemon serves from its own blockstore
  immediately.
- **Deterministic failure mode** — a local 404 clearly means "pin failed",
  not "public gateway is sad today".

### Run

```bash
SOLANA_RPC_URL=https://api.devnet.solana.com \
  npx tsx scripts/smoke-test-devnet.ts

# Or, if you picked non-default IPFS ports:
SOLANA_RPC_URL=https://api.devnet.solana.com \
AEP_IPFS_API_URL=http://localhost:5001 \
AEP_IPFS_GATEWAY=http://localhost:8082 \
  npx tsx scripts/smoke-test-devnet.ts
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
| 8 | MCP `get_agent_reputation` | `tools/list` returns `get_agent_reputation` among N tools. With local IPFS: `tools/call` response contains the manifest summary (`name`, `agentVersion`, `publishedAt`) **and** `sas-not-configured` in the `sas` field. Without local IPFS: handler hits the synthetic CID and returns an IPFS-404 — documented degraded path, expected unless Kubo is set up per the optional section above. |
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
