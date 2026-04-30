# AEP Mainnet Deployment Checklist

**Protocol**: Agenomics Protocol
**Date**: 2026-04-15
**Target Network**: Solana Mainnet-Beta

---

## 1. Pre-Deployment Checklist

### 1.1 Code Freeze

| Item | Status | Owner | Notes |
|------|--------|-------|-------|
| Feature freeze declared | Pending | Lead Dev | No new instructions after freeze date |
| All ADR changes merged (ADR-001 through ADR-027) | Done | Team | Security and feature improvements |
| Program IDs finalized for mainnet | Pending | Lead Dev | Generate new keypairs for mainnet deployment |
| Anchor version pinned in `Cargo.toml` | Done | Team | `=0.31.1` exact-pinned across all three programs (commit `<this-batch>`) |
| Rust toolchain pinned in `rust-toolchain.toml` | Done | Team | Ensures reproducible builds |
| All `Cargo.lock` dependencies reviewed for known CVEs | Done | Security | `cargo audit` 2026-04-30: 0 CVEs; 3 unmaintained-crate warnings (`bincode`, `libsecp256k1`, `rand`), all transitive through Solana SDK — no upstream fix until Solana ships replacements; documented as accepted |
| No `TODO`, `FIXME`, or `HACK` comments in program source | Done | Team | `grep -rn 'TODO\|FIXME\|HACK' programs/` returns 0 matches as of 2026-04-30 (last TODO at `agent-registry/src/state.rs:184` cleaned up in commit `635c061` — was a stale reference to PR-I which has since landed) |

### 1.2 Audit Complete

| Item | Status | Notes |
|------|--------|-------|
| External audit firm engaged | Pending | See `docs/AUDIT_SCOPE.md` |
| Audit report received | Pending | All Critical and High findings must be resolved |
| All Critical findings remediated | Pending | Requires re-audit or auditor sign-off |
| All High findings remediated or accepted with risk documentation | Pending | Document accepted risks in ADR |
| Audit report hash published on-chain or IPFS | Pending | Transparency for users |

### 1.3 All Tests Passing

| Item | Status | Notes |
|------|--------|-------|
| `anchor test` passes (all unit + integration tests) | Done | 2026-04-30: 164 passing / 3 pending (intentional skips for test-scaffold-limited paths; coverage at `programs/settlement/src/contexts.rs::aud_117_seeds_parity` per AUD-203). Re-verify on each pre-deploy clean build. |
| Fuzz tests completed (ADR-021) | Pending | Trident or honggfuzz |
| Load tests completed (ADR-022) | Pending | Discovery and settlement stress tests |
| Devnet smoke test passes (`scripts/smoke-test-devnet.ts`) | Pending | End-to-end lifecycle on devnet |
| MCP server test suite passes | Done | 2026-04-30: 383/383 pass via `cd mcp-server && npm test`. Re-verify on each pre-deploy clean build. |
| No test flakiness (3 consecutive green runs) | Done | 2026-04-30: anchor test 3× green (164/164 each, ~4m each), mcp-server test 3× green (383/383 each, 1.5–3.0s). No flakes observed. |

### 1.4 Devnet Validation

| Item | Status | Notes |
|------|--------|-------|
| All 3 programs deployed to devnet with final code | Pending | Use `scripts/deploy-devnet.sh` |
| Full escrow lifecycle tested on devnet (ADR-023) | Pending | Create, accept, submit, approve, complete |
| CPI flows verified (Settlement -> Registry reputation) | Pending | ADR-007 pattern |
| Edge cases tested on devnet (expiry, dispute, cancel) | Pending | ADR-009 scenarios |
| MCP server connected to devnet programs | Pending | Verify all tool handlers work |

### 1.5 MCP transport posture (ADR-083, ADR-132)

The MCP server runs in one of three transport modes; each has a
distinct trust boundary. Pick deliberately — the container default
auto-flipped from `stdio` to `unix` in cycle-3 (ADR-132 / MCP-322), so
a checklist-only operator can be surprised on rolling deploy.

| Item | Status | Notes |
|------|--------|-------|
| Transport mode chosen | Pending | `stdio` (parent-process trust), `http` (bearer + origin allowlist + rate limit), or `unix` (socket-mode 0600 + optional peer-uid) |
| `AEP_MCP_TRANSPORT` set explicitly OR container auto-flip understood | Pending | In a container without explicit `AEP_MCP_TRANSPORT` the default is **`unix`** (auto-path `/run/aep-mcp/mcp.sock`). Confirm this is intended. |
| `AEP_MCP_ALLOWED_UID` set when using `unix` | Pending | `AEP_MCP_ALLOWED_UID=$(id -u <mcp-service-user>)` enables the optional peer-uid check. |
| `AEP_MCP_HTTP_ALLOWED_ORIGINS` set when using `http` | Pending | CSV; required for browser callers. See ADR-083 §"Origin gate". |
| `AEP_MCP_AUTH_TOKEN` ≥ 16 bytes when using `http` | Pending | Generate with `openssl rand -hex 32`. Server refuses to bind below this floor. |
| `AEP_MCP_TRUSTED_PROXY_HOPS` set when behind a reverse proxy | Pending | Integer hop count; default 0 = ignore `X-Forwarded-For`. Misconfigure too low → trust attacker-prepended XFF. CYCLE4 hardening; legacy `AEP_MCP_TRUST_PROXY=1` retained as deprecated alias for hops=1. |
| Parent dir of unix socket is mode 0700 | Pending | Defense-in-depth; the socket file itself is chmod'd 0600 by the server. |

> See also: ADR-083 (transport security model), ADR-132 (container
> auto-flip), `mcp-server/src/transport/auth-gate.ts`,
> `mcp-server/src/transport/rate-limit.ts`.

---

## 2. Key Management Procedures

### 2.1 Upgrade Authority

Each deployed program has an **upgrade authority** that can push new bytecode. For mainnet, upgrade authority must be a multi-sig.

| Program | Devnet Upgrade Authority | Mainnet Upgrade Authority |
|---------|------------------------|--------------------------|
| Agent Vault | Deployer wallet | Multi-sig (Squads) |
| Agent Registry | Deployer wallet | Multi-sig (Squads) |
| Settlement | Deployer wallet | Multi-sig (Squads) |

### 2.2 Multi-Sig Setup via Squads

1. **Create a Squads multisig** at [app.squads.so](https://app.squads.so):
   - Minimum 3 members (recommended: 3-of-5 or 4-of-7)
   - Include at least one non-developer member (ops or security)
   - Store the Squads vault address as `MULTISIG_ADDRESS`

2. **Transfer upgrade authority** after deployment:
   ```bash
   solana program set-upgrade-authority <PROGRAM_ID> \
     --new-upgrade-authority <MULTISIG_ADDRESS> \
     --keypair <DEPLOYER_KEYPAIR>
   ```

3. **Verify transfer**:
   ```bash
   solana program show <PROGRAM_ID>
   # Confirm "Authority: <MULTISIG_ADDRESS>"
   ```

4. **Test upgrade flow** on devnet first:
   - Create a Squads multisig on devnet
   - Transfer upgrade authority to devnet multisig
   - Execute a test upgrade through Squads to verify the flow works

### 2.3 Key Storage

| Key | Storage | Access |
|-----|---------|--------|
| Deployer keypair | Hardware wallet (Ledger) or air-gapped machine | Deploy only, revoke after authority transfer |
| Multisig member keys | Individual hardware wallets per member | Each member holds their own key |
| MCP server wallet | Encrypted file on server, rotated quarterly | Operational use only |
| Program keypairs | Source-controlled (public keys only) | Used for deterministic program IDs |

---

## 3. Program Deployment Steps

### 3.1 Pre-Deployment

```bash
# 1. Verify you are on the correct commit (audit-approved tag)
git log --oneline -1
git tag -v v1.0.0-mainnet  # Verify signed tag

# 2. Clean build from scratch
cargo clean
anchor build --no-idl

# 3. Verify program binary hashes match audit report
sha256sum target/deploy/agent_vault.so
sha256sum target/deploy/agent_registry.so
sha256sum target/deploy/settlement.so

# 4. Verify program IDs match Anchor.toml
solana-keygen pubkey target/deploy/agent_vault-keypair.json
solana-keygen pubkey target/deploy/agent_registry-keypair.json
solana-keygen pubkey target/deploy/settlement-keypair.json
```

### 3.2 Deployment

Use `scripts/mainnet-deploy.sh` for automated deployment with safety checks. The script:

1. Verifies cluster is mainnet-beta
2. Checks deployer wallet balance (minimum 20 SOL)
3. Confirms program IDs match expected values
4. Deploys programs one at a time with confirmation prompts
5. Verifies each deployment before proceeding
6. Transfers upgrade authority to multi-sig

### 3.3 Manual Deployment (if needed)

```bash
# Set cluster
solana config set --url https://api.mainnet-beta.solana.com

# Deploy each program (order matters: Registry first, then Vault, then Settlement)
solana program deploy \
  --program-id target/deploy/agent_registry-keypair.json \
  target/deploy/agent_registry.so \
  --with-compute-unit-price 50000 \
  --max-sign-attempts 5

solana program deploy \
  --program-id target/deploy/agent_vault-keypair.json \
  target/deploy/agent_vault.so \
  --with-compute-unit-price 50000 \
  --max-sign-attempts 5

solana program deploy \
  --program-id target/deploy/agent_settlement-keypair.json \
  target/deploy/settlement.so \
  --with-compute-unit-price 50000 \
  --max-sign-attempts 5
```

---

## 4. Post-Deployment Verification

### 4.1 On-Chain Verification

```bash
# Verify all programs are deployed and executable
for pid in <VAULT_ID> <REGISTRY_ID> <SETTLEMENT_ID>; do
  echo "--- $pid ---"
  solana program show "$pid"
done

# Verify upgrade authority is set to multi-sig
solana program show <VAULT_ID> | grep "Authority"
solana program show <REGISTRY_ID> | grep "Authority"
solana program show <SETTLEMENT_ID> | grep "Authority"

# Verify IDL matches (if IDLs are published on-chain)
anchor idl fetch <VAULT_ID> --provider.cluster mainnet
```

### 4.2 Functional Verification

| Test | Command | Expected Result |
|------|---------|-----------------|
| Initialize vault | MCP: `initialize_vault` | Vault PDA created, policies set |
| Register agent | MCP: `register_agent` | Agent profile PDA created |
| Create escrow | MCP: `create_escrow` | Escrow PDA created, funds locked |
| Full lifecycle | `scripts/smoke-test-devnet.ts` (pointed at mainnet) | All operations succeed |

### 4.3 Binary Verification

After deployment, anyone can verify the deployed bytecode matches the audited source:

```bash
# Download deployed program
solana program dump <PROGRAM_ID> deployed.so

# Compare hash with build artifact
sha256sum deployed.so
sha256sum target/deploy/agent_vault.so
# Hashes must match
```

---

## 5. Emergency Procedures

### 5.1 Pause Vault (Immediate)

If a vulnerability is discovered in the Agent Vault program:

```bash
# Any vault authority can pause their own vault immediately
# via MCP server or direct transaction
# Instruction: pause_vault
# Signer: vault authority

# To pause ALL known vaults, enumerate via getProgramAccounts and notify authorities
```

**Response time**: Immediate (single transaction, no multi-sig required per vault).

### 5.2 Freeze Upgrades

To prevent malicious program upgrades:

```bash
# Option A: Set upgrade authority to None (IRREVERSIBLE - program becomes immutable)
solana program set-upgrade-authority <PROGRAM_ID> \
  --final \
  --keypair <CURRENT_AUTHORITY>

# Option B: Revoke Squads member access (requires Squads threshold)
# Use Squads UI to remove compromised member keys
```

**Decision matrix**:

| Scenario | Action |
|----------|--------|
| Single key compromised | Revoke member via Squads, rotate keys |
| Multiple keys compromised | Freeze upgrades (Option A) on affected program |
| Active exploit in progress | Pause all vaults + freeze upgrades |
| Vulnerability found pre-exploit | Deploy patch via Squads upgrade |

### 5.3 Emergency Upgrade

If a patch is needed:

1. Develop and test fix on devnet
2. Get auditor sign-off on patch (expedited review)
3. Build new binary, verify hash
4. Create Squads upgrade proposal
5. Collect required signatures (threshold)
6. Execute upgrade
7. Verify deployment

### 5.4 Incident Response Contacts

| Role | Responsibility | Escalation Time |
|------|---------------|-----------------|
| On-call engineer | Initial triage, pause affected vaults | < 15 min |
| Security lead | Assess severity, coordinate fix | < 1 hour |
| Squads signers | Approve emergency upgrade | < 4 hours |
| Auditor (on retainer) | Review emergency patch | < 24 hours |

---

## 6. Monitoring Setup

### 6.1 Helius Webhooks

Set up [Helius](https://helius.dev) webhooks to monitor all program events in real-time:

```bash
# Webhook configuration for each program
curl -X POST https://api.helius.xyz/v0/webhooks?api-key=<API_KEY> \
  -H "Content-Type: application/json" \
  -d '{
    "webhookURL": "https://your-server.com/webhooks/aep",
    "transactionTypes": ["Any"],
    "accountAddresses": [
      "<VAULT_PROGRAM_ID>",
      "<REGISTRY_PROGRAM_ID>",
      "<SETTLEMENT_PROGRAM_ID>"
    ],
    "webhookType": "enhanced"
  }'
```

### 6.2 Events to Monitor

| Event | Program | Alert Level | Action |
|-------|---------|-------------|--------|
| `VaultPaused` | Agent Vault | Warning | Investigate why vault was paused |
| `TransferExecuted` (large amount) | Agent Vault | Info | Log for audit trail |
| `EscrowCreated` (large amount) | Settlement | Info | Monitor for completion |
| `DisputeRaised` | Settlement | Warning | Track resolution |
| `ReputationUpdated` (rapid changes) | Registry | Warning | Check for farming |
| Program upgrade detected | Any | Critical | Verify authorized upgrade |
| Failed transactions (spike) | Any | Warning | Check for attack attempts |

### 6.3 Dashboard Metrics

| Metric | Source | Threshold |
|--------|--------|-----------|
| Total Value Locked (TVL) in escrows | Settlement accounts | Track trend |
| Active vaults | Vault program accounts | Track growth |
| Registered agents | Registry program accounts | Track growth |
| Disputes per day | Settlement events | Alert if > 10/day |
| Failed tx rate | RPC logs | Alert if > 5% |
| Program upgrade events | Helius webhook | Alert on any |

### 6.4 Alerting Channels

- **Critical**: PagerDuty + SMS to on-call
- **Warning**: Slack `#aep-alerts` channel
- **Info**: Logged to monitoring dashboard (Grafana/Datadog)

---

## 7. Post-Launch Operations

### 7.1 First 72 Hours

- [ ] Monitor all webhooks continuously
- [ ] Verify first real vault creation succeeds
- [ ] Verify first real escrow lifecycle completes
- [ ] Check program account sizes are within expected bounds
- [ ] Confirm no unexpected program interactions

### 7.2 First 30 Days

- [ ] Publish audit report publicly
- [ ] Launch bug bounty program (Immunefi recommended)
- [ ] Gather user feedback on MCP server reliability
- [ ] Review monitoring thresholds based on real traffic
- [ ] Plan first protocol upgrade (if needed)

### 7.3 Ongoing

- [ ] Quarterly dependency audits (`cargo audit`)
- [ ] Rotate MCP server wallet keys quarterly
- [ ] Review and update Squads member list as team changes
- [ ] Annual re-audit of on-chain programs
