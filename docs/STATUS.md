# Protocol Status Snapshot

Point-in-time map of where the codebase, devnet deployment, and governance
stand. Update when shipping meaningful PRs; see the **Resume checklist**
at the bottom for restarting work after time away.

_Last updated: 2026-05-06 (5 days to Colosseum deadline; PR #76 + PR #77 closed 4 of 6 submission-readiness gaps from issue #73)_

## 1. Codebase / main

| Surface | Version / branch | Notes |
|---|---|---|
| `main` tip | `6d66cf6` | submission-readiness sweep merged 2026-05-06 |
| On-chain programs | Current with main binaries | see §3 — devnet deploy unchanged |
| TS packages | `0.1.0` unpublished | see §5 |
| Workspace licenses | All `Apache-2.0` | repo-root `LICENSE` + 6 workspace `package.json` aligned (PR #76) |
| `npm audit --omit=dev` | **0 vulnerabilities** | uuid + ip-address scoped overrides shipped (PR #77, see `docs/audits/DEPENDABOT-3-UUID-IPADDR-CLOSURE.md`) |
| CI | 16 jobs gated | all green on the two 2026-05-06 PRs; Anchor Integration job is self-hosted-runner-only |
| Tests | **547+ across packages** | 164 Anchor (51 settlement + 60 registry + 44 vault + 9 cpi-failures; 3 intentional pendings per AUD-203) + 383 mcp-server (`node:test`; gated by `pretest` workspace build hook) |
| Submission docs | `SUBMISSION.md` live on main | two `[TODO upload]` placeholders for video URLs remain |

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
| Multisig PDA | `EHdxwBkcSEcJe3E2UrRwwYozPjqZNe8HZrrBTeU6NPcz` |
| Threshold | 2-of-3 |
| Member 1 | `BUdXA1FiWnV7ksXYodH3uEhDUhfBJ8g4UmmWdshWjTXL` (current upgrade-auth wallet) |
| Member 2 | `C1vm83htBDUwbHyBn4GAzwHoKtLeyc13EPW2nc3udvW5` — devnet-v1 throwaway keypair at `.keys/squads-signer-2.json` (gitignored) |
| Member 3 | `8xMiCZdgCTB9J244JDiPqkm2yVTQbLuGTc12Qu5AynjB` — devnet-v1 throwaway keypair at `.keys/squads-signer-3.json` (gitignored) |
| Create tx | `2DNgubLNyRG5NSBd7XeZVr5KksXKok2FcCWpN2rBU6oquvSzhRxpdEnCAbgzcba7qXpZdSWBYKtcZYGn27EBfBqJ` |
| Public config | `scripts/.squads-devnet.json` |
| Operator docs | `docs/SQUADS_DEVNET.md` |

**Role scope (v1)**: intended future `AEP_PROTOCOL` SAS credential authority. Currently holds **no** authority — the SAS bootstrap ceremony hasn't run yet.

Signers 2+3 are throwaway dev keypairs. For mainnet they must be replaced with real signers per ADR-063 §1.1 (3-of-5 with role slots). Rotation procedure in ADR-063 §4.

**Abandoned prior PDA**: `6QUUP78t3mKeSroV7fTAP9WPkfWkHXbVEhHzBR3Q9Xi` (create tx `5uS1vRyqRYxGs9Gf6ite2hrAzhp23nEVY8PZcJK4LTzGh5YbLdjUGub2SioCA2cQZWXCeNVBuUdW6GkVRqWJ9235`). Original v1 bootstrap from 2026-04-22T00:29Z; signer-2/signer-3 private keys were not persisted between sessions, leaving only 1-of-3 signing capability against a 2-of-3 threshold. No authority had been transferred to it, so it stays on-chain as inert dust (~0.0025 SOL).

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

134 ADR files on main (numeric range ADR-001 .. ADR-134; ADR-TEMPLATE.md excluded). Per the 2026-05-03 backlog review (issue #71):

| Bucket | Count | Notes |
|---|---|---|
| Accepted (shipped) | majority | bulk of ADR-001..ADR-134, see individual files |
| Proposed — implementation evidence found, banner stale | 2 | ADR-126 (x402-relay redis), ADR-128 (indexer PG); regression tests exist for OFF-201/203/205/206 + OFF-200/202/204/207 but no closing commits — verify each finding closed before flipping |
| Proposed — promote to Accepted | 1 | ADR-129 (EVO memory backbone); full adapter shipped, actively maintained |
| Proposed — hold pre-hackathon | 8 | ADR-106..113 reputation/identity cluster; zero implementation evidence |
| Proposed — DX overhaul wave (PR #68) | 7 | ADR-134..140 sequenced; ADR-136 (Apache-2.0) effectively shipped via PR #76 even though that PR isn't merged |

Recent ADR trail (post-hackathon-prep):
- ADR-130 — artifact provenance (cosign)
- ADR-131 — Sybil cost calibration
- ADR-132 — MCP HTTP origin gate + container default (cycle-3 transport hardening)
- ADR-133 — handlers-v2 wave deferral
- ADR-134 — waitlist welcome-email diagnostic (closed 2026-05-02 via `8336300`)
- ADR-134..140 (PR #68) — DX overhaul wave (Codama codegen, Zod schemas, Apache-2.0 license flip [shipped via PR #76], llms.txt, `@agenomics/react`, `create-agenomics-app`, sample gallery)

## 7. Outstanding work (priority order)

### A. SAS bootstrap ceremony (blocks v0.1.0 publish confidence)
Execute ADR-063. Progress:
1. ✅ SAS program `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG` confirmed live on devnet.
2. ✅ Multisig-from-day-one chosen; `AEP_PROTOCOL` authority = Squads vault PDA `Exs7cm5dKZNr5c7rBAcq52EHUs7nxDWiZtHXzTEh3LPo` (vaultIndex=0 of multisig `EHdxwBkcS...`).
3. ✅ Hand-built SAS ix encoders (`createCredential`, `createSchema`) in `scripts/bootstrap-sas-credential-devnet.ts` — byte layouts traced against sas-lib@1.0.10 Codama codegen.
4. ✅ `AEP_AGENT_REPUTATION_v1` schema PDA `CTJevNKpYeBAfG6r5CJHb2HuwV4obJeWGeqHQVCKiUVT` live (layout `[1,2,1,8]` = U16/U32/U16/I64).
5. ✅ `AEP_PROTOCOL` credential PDA `GvDdPwwqV9wfEaRh1LjLYhjDRFkMxCDRdepVeHGMfRhS` live, signed via 2-of-3 multisig.

**Above: complete on devnet. Below: code committed in `3ebd02f`; execution requires the signing machine.**

6. ✅ Code / ⏳ Run: `scripts/bootstrap-sas-attestation-devnet.ts` (commit `3ebd02f`). Issues one test attestation under `AEP_PROTOCOL` with deterministic reputation (`score=8500, completed_tasks=42, dispute_ratio_bps=200, last_updated=1714867200`) and a fixed test-subject keypair persisted at `.keys/sas-test-subject-devnet.json` (gitignored). Multisig-wrapped (2-of-3 propose-approve-execute); idempotent (no-ops if attestation PDA already live AND record matches).
7. ✅ Code / ⏳ Run: `scripts/smoke-test-devnet.ts` Steps 11-13 now actually exercise `@agenomics/sas-resolver` against the live PDAs — env-var dance (`AEP_SAS_SCHEMA_PDA` / `AEP_SAS_ALLOWED_CREDENTIALS`) dropped; single source of truth is `scripts/.sas-devnet.json`. Asserts six fields (score, completed_tasks, dispute_ratio_bps, last_updated, credential, signer). Committed in `3ebd02f`.
8. ⏳ Re-run full smoke; PASS criterion is final line `SAS resolver round-trip: PASS`. (Folds into running step 7b.)
9. ⏳ Update ADR-063 status to Accepted; document the live PDAs (credential, schema, test attestation) in the ADR itself.

**Resume runbook (signing machine) — one-shot, no return-channel needed:**

```sh
cd ~/dev/projects/protocol            # or wherever the checkout lives
git checkout main && git pull
./scripts/run-sas-ceremony.sh         # runs everything; auto-pushes status
```

`scripts/run-sas-ceremony.sh` is the canonical driver. It:

1. Pulls latest, runs `npm install`, verifies the two signer keypairs decode to two distinct Squads multisig members.
2. Runs `bootstrap-sas-attestation-devnet.ts` (multisig propose-approve-execute, idempotent).
3. Runs `smoke-test-devnet.ts` (full 13-step smoke; PASS criterion is `SAS resolver round-trip: PASS`).
4. Writes `scripts/.sas-ceremony-status.json` with `PASS / BLOCKED_PRECONDITION / BOOTSTRAP_FAILED / SMOKE_FAILED`.
5. `git commit && git push origin main` of the status file plus any updated `.sas-devnet.json`.

After it runs, on any machine: `git pull origin main && cat scripts/.sas-ceremony-status.json` shows the outcome. On `PASS`, the next agent task (ADR-063 → Accepted, `chore(release): v0.1.0` privacy flip, release notes) is runnable purely from public on-chain state + the repo — no need to come back to the signing machine to fetch logs.

Idempotent: re-running after PASS is a no-op (no new commit, no new chain ops).

Authoritative SAS bootstrap record: `scripts/.sas-devnet.json` (the script writes a `testAttestation` block on success). Test-subject keypair: `.keys/sas-test-subject-devnet.json` (gitignored — `bootstrap-sas-attestation-devnet.ts` generates it on first run, reuses it on reruns for stable PDA derivation).

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
- **Keypair path** (on the signing machine — see note below): `~/.config/solana/id.json`
- **Balance** (verified 2026-05-06): **121.77 SOL**
- **Squads signers 2/3**: 0.02 SOL each — pubkeys in `scripts/.squads-devnet.json`. Signer 2 keypair lives at `.keys/squads-signer-2.json` on the signing machine; signer 3 was a one-time top-up source and the keypair has been retired.

Sufficient for: ADR-063 bootstrap ceremony, hundreds of devnet smoke runs, a full program redeploy if needed. Monitor with `solana balance`.

**Machine-specificity note (2026-05-06):** `~/.config/solana/id.json` is the *deployer* keypair only on the original signing machine. On other machines (e.g. fresh WSL checkout), that path holds whatever keypair Solana CLI was configured with — `solana-keygen pubkey ~/.config/solana/id.json` should return `BUdXA1Fi…jTXL` before running anything that signs as the deployer. If it doesn't, you're not on the signing machine, and the ADR-063 §5 ceremony (steps 6+) cannot proceed from here. See §7.A "Resume runbook" for the signing-machine checklist.

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
