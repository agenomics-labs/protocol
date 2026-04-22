# Protocol Status Snapshot

Point-in-time map of where the codebase, devnet deployment, and governance
stand. Update when shipping meaningful PRs; see the **Resume checklist**
at the bottom for restarting work after time away.

_Last updated: 2026-04-21, main @ `aa399f3`_

## 1. Codebase / main

| Surface | Version / branch | Notes |
|---|---|---|
| `main` tip | `aa399f3` | 25 PRs merged this session |
| On-chain programs | Current with main binaries | see §3 |
| TS packages | `0.1.0` unpublished | see §5 |
| CI | All 11 jobs green | incl. Anchor Integration (99/99 tests) |
| Tests | ~191 across packages | 96 mcp-server + 12 validator + 56 sas-resolver + 99 Anchor integration + 9 Squads config |

## 2. Acronym / brand

- **Brand / product / homepage**: _Agenomics_, _Agenomics Labs_, _Agenomics Protocol_, agenomics.xyz
- **Code / protocol acronym**: **AEP** (Agent Economy Protocol). Used everywhere in code: env vars `AEP_*`, types `AepError`, PDA seeds `AEP_PROTOCOL` / `AEP_VALIDATORS` / `AEP_AGENT_REPUTATION`, bin `aep-mcp`
- **npm scope**: `@agenomics/*` (not `@aep/*` — ecosystem contention; see PR #19)
- **GitHub**: agenomics-labs/protocol

## 3. Devnet deployment

| Program | Program ID | Binary matches main? | Upgrade authority |
|---|---|---|---|
| Agent Vault | `4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN` | ✓ | `BUdXA1Fi...jTXL` (single key) |
| Agent Registry | `8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh` | ✓ | same |
| Settlement | `GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3` | ✓ | same |

- Upgrade authority transfer to Squads multisig: **deferred** (see §4). Single key keeps devnet iteration cheap.
- ADR-060 (manifest fields, `update_manifest` IX) is live on all programs.

## 4. Squads multisig (devnet)

| | |
|---|---|
| Multisig PDA | `6QUUP78t3mKeSroV7fTAP9WPkfWkHXbVEhHzBR3Q9Xi` |
| Threshold | 2-of-3 |
| Member 1 | `BUdXA1FiWnV7ksXYodH3uEhDUhfBJ8g4UmmWdshWjTXL` (current upgrade-auth wallet) |
| Member 2 | devnet-v1 throwaway keypair at `.keys/squads-signer-2.json` (gitignored) |
| Member 3 | devnet-v1 throwaway keypair at `.keys/squads-signer-3.json` (gitignored) |
| Create tx | `5uS1vRyqRYxGs9Gf6ite2hrAzhp23nEVY8PZcJK4LTzGh5YbLdjUGub2SioCA2cQZWXCeNVBuUdW6GkVRqWJ9235` |
| Public config | `scripts/.squads-devnet.json` |
| Operator docs | `docs/SQUADS_DEVNET.md` |

**Role scope (v1)**: intended future `AEP_PROTOCOL` SAS credential authority. Currently holds **no** authority — the SAS bootstrap ceremony hasn't run yet.

Signers 2+3 are throwaway dev keypairs. For mainnet they must be replaced with real signers per ADR-063 §1.1 (3-of-5 with role slots). Rotation procedure in ADR-063 §4.

## 5. npm publishing state

Both packages ready at `0.1.0`, **not yet published**:

- `@agenomics/capability-manifest-validator` — ADR-060 manifest validator (Zod + RFC-8785 canonical JSON + Ed25519)
- `@agenomics/sas-resolver` — ADR-061 SAS attestation resolver with ADR-065 caching

### Infrastructure already in place

- npm org `@agenomics` claimed at https://www.npmjs.com/org/agenomics
- `NPM_TOKEN` repo secret configured
- `.github/workflows/publish.yml` live — triggers on `v*` tag push
- `RELEASE.md` documents the cut-release flow

### Why not yet cut

Holding until the SAS bootstrap ceremony (§6) proves the resolver's full real-chain path. Current confidence:
- 21 mocked-integration tests exercise the 7 ADR-061 §4 failure modes end-to-end
- Unit coverage: 12 validator + 56 sas-resolver tests
- Manifest validator proven on real devnet data (smoke Step 6+7)
- Resolver's `absent: true` fallback proven in smoke Step 8
- SAS attestation path unexercised on real SAS account (requires bootstrap)

## 6. ADR status (as of session end)

| Status | Count | ADRs |
|---|---|---|
| Accepted | 33 | 001–060 (except 057), 061 |
| Proposed | 2 | 063 (SAS governance), 065 (caching — implementation merged but ADR text still Proposed) |
| Not written | 3 | 062 (MPP wire-format), 066 (on-chain governance migration), 067 (cross-protocol credential trust) |

Recent ADR trail:
- ADR-058/059/060 — MCP architecture track (Action shape, tx pipeline, manifest)
- ADR-061 — SAS integration model (Accepted, option B: manifest-references-SAS)
- ADR-063 — SAS credential authority governance (Proposed; bootstrap ceremony hasn't run)
- ADR-064 — `@agenomics/sas-resolver` TS package (implemented in PR #12)
- ADR-065 — Caching strategy (implemented in PR #15; ADR text still Proposed)

## 7. Outstanding work (priority order)

### A. SAS bootstrap ceremony (blocks v0.1.0 publish confidence)
Actually execute ADR-063. Requires:
1. Confirm SAS program `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG` behavior on devnet (deployed, verified)
2. Decide: use Squads multisig (`6QUUP7...`) as `AEP_PROTOCOL` credential authority from day one, or bootstrap as single-sig + rotate. **Recommendation**: multisig from day one since it's already live.
3. Hand-build SAS instruction builders (sas-lib pins `@solana/kit@^5` incompatible with our `@solana/kit@^6.8`; resolver already uses manual decoder for reads)
4. Create `AEP_AGENT_REPUTATION_v1` schema PDA
5. Create `AEP_PROTOCOL` credential PDA signed by multisig
6. Issue one test attestation
7. Update `scripts/smoke-test-devnet.ts` Steps 11-13 to use the real PDAs
8. Re-run full smoke to prove resolver's on-chain path
9. Update ADR-063 status to Accepted; document the live PDAs

### B. Publish `v0.1.0`
After (A) succeeds:
```
cd packages/capability-manifest-validator && npm version 0.1.0 --no-git-tag-version
cd ../sas-resolver                       && npm version 0.1.0 --no-git-tag-version
git add -A && git commit -m "chore(release): v0.1.0"
git push origin main
git tag v0.1.0 && git push origin v0.1.0
```
Workflow publishes both, creates GitHub Release. See `RELEASE.md`.

### C. Deferred-but-tracked

- **v2 `vault_transfer` devnet parity**: env-gated (`AEP_USE_V2_VAULT_TRANSFER=1`), proven end-to-end in smoke Step 9b. Flipping the default from v1 to v2 needs (a) a period of shadow-running both, (b) removing the env gate, (c) deprecation notice. No hard blocker; cosmetic migration.
- **Squads takes program upgrade authority**: currently single-sig. Transfer via `solana program set-upgrade-authority <program-id> --new-upgrade-authority <multisig-pda>` for each of the 3 programs. Only do this when devnet iteration is stable and mainnet cutover is imminent.
- **Smoke Steps 3-4 re-run noise resolved** in PR #25. Re-runs now show "Vault already exists at X — skipping init".
- **IPFS real pin** works via local Kubo daemon; env var `AEP_IPFS_GATEWAY` configurable. Production operators may run their own gateway.
- **Registry `capabilities: Vec<String>`** stays per ADR-060 §1 as on-chain discovery index; a future ADR may retire once an indexer service replaces on-chain discovery.

### D. Mainnet path (not for this quarter)
- External audit (ADR-036) — vendor + scope not yet chosen
- 3-of-5 real-signer Squads on mainnet with role slots per ADR-063 §1.1
- `AEP_PROTOCOL` + `AEP_VALIDATORS` credential bootstrap on mainnet
- Mainnet deploy via `scripts/mainnet-deploy.sh` (already has safety gates)
- Bump TS packages to `1.0.0` (strict semver post-mainnet)

### E. Speculative / deferred until driven by concrete need
- ADR-062 (MPP wire-format) — draft if AEP ever speaks HTTP-402
- ADR-066 (on-chain governance upgrade path) — if/when protocol outgrows multisig proposals
- ADR-067 (cross-protocol credential trust) — if/when external protocols want to consume AEP SAS attestations
- sendaifun distribution (SENDAIFUN_ECOSYSTEM_ANALYSIS Tier 1.B)

## 8. Wallet / funding state (devnet)

- **Deployer + upgrade-auth wallet**: `BUdXA1FiWnV7ksXYodH3uEhDUhfBJ8g4UmmWdshWjTXL`
- **Keypair path**: `~/.config/solana/id.json`
- **Balance at session end**: ~22.24 SOL
- **Squads signers 2/3**: tiny balances from the 0.02 SOL top-up

Sufficient for: ADR-063 bootstrap ceremony, several dozen devnet smoke runs, a full program redeploy if needed. Monitor with `solana balance`.

## 9. Resume checklist (after time away)

When picking up later:

```sh
# 1. Sync
cd /home/neo/dev/projects/protocol
git checkout main && git pull

# 2. Re-install (lockfiles gitignored)
npm install                                      # root
cd packages/capability-manifest-validator && npm install && npm run build
cd ../sas-resolver && npm install && npm run build
cd ../../mcp-server && npm install && npm run build

# 3. Verify devnet state
solana config get                                # should be devnet
solana balance                                   # should be > 10 SOL for full smoke
for id in 4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN \
          8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh \
          GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3; do
  solana program show "$id" | head -6
done

# 4. Verify multisig still live
cat scripts/.squads-devnet.json                  # public config committed

# 5. Smoke test (skips SAS steps until bootstrap)
ipfs daemon &> /tmp/ipfs-daemon.log &            # optional; only needed for Step 8 real-pin path
SMOKE_TEST_KEYPAIR_PATH=$HOME/.config/solana/id.json \
  AEP_USE_V2_VAULT_TRANSFER=1 \
  npx --prefix mcp-server tsx scripts/smoke-test-devnet.ts

# 6. If resuming the SAS bootstrap, see §7.A + ADR-063 + SQUADS_DEVNET.md
```

## 10. Recently-answered architectural questions

For future-me: these were debated this session; the answer is now baked in and shouldn't be relitigated unless new evidence.

- **Brand vs protocol acronym**: Agenomics (brand) builds AEP (protocol). Don't collapse.
- **npm scope**: `@agenomics/*`, not `@aep/*` (ecosystem contention on `aep`).
- **SAS integration depth**: ADR-061 option B (manifest-references-SAS, off-chain resolution). Registry stays authoritative for protocol-logic reputation.
- **PreflightGate source of truth**: ADR-058 §2.1. ADR-059 + ADR-060 reference, don't redeclare.
- **Capability taxonomy stringified in manifest**: validator crate enforces string-matches-ADR-058-literal at parse time.
- **v1 vs v2 vault_transfer**: env-gated dispatcher, both paths functional, default v1 until devnet parity stable enough to flip.
- **Idempotency key for settlement submits**: explicit input-derived, not signature-based (PassthroughSigner default means no signature at MCP boundary).
- **Mocha vs node:test**: new tests use `node:test` + `tsx`. Chai v6 ESM broke mocha-based integration tests with `.js` CJS imports.
