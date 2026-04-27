# Mainnet Deploy Runbook

**Audience**: the operator executing the multisig ceremony at 2am
during the launch window, who needs every step pre-decided. SRE-level
Solana + Squads familiarity assumed; deep protocol knowledge **not**
assumed.

**Status**: Authoritative. Single source-of-truth for the mainnet
deploy ceremony. Operator-specific config is spelled
`<TODO: operator team to fill in>`.

**Companion docs** (read once, before launch night):

- `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` — the AUD-115
  `ProtocolConfig.authority` entanglement runbook. **Required reading
  before §3 of this document.**
- `docs/INCIDENT_RESPONSE.md` — what to do when something goes wrong
  *after* the deploy completes. Cross-referenced from §5 (Rollback)
  and §6 (Day-1 monitoring).
- `docs/adr/ADR-080-mainnet-deploy-safety-mandates.md` — the gates
  this runbook walks the operator through.
- `docs/adr/ADR-122-mainnet-readiness-ci-gate.md` — the CI gate that
  must be green on the to-be-tagged commit before §1 starts.
- `docs/MAINNET_CHECKLIST.md` — the gated row-by-row checklist
  `mainnet-readiness.yml` enforces. Every row must be `Done`.

Sections: pre-deploy checks (§1), per-program deploy order (§2),
`initialize_protocol_config` ceremony (§3), `verify_protocol_invariants`
smoke run (§4), rollback (§5), Day-1 monitoring (§6).

Each numbered procedure step has an explicit failure-mode line. **If a
step fails and the failure-mode line says "abort the deploy," stop.**
The script's gates are designed to fail closed; an abort is always
recoverable, a partial deploy is not.

---

## 1. Pre-deploy checks

Run through this list **before** opening the multisig ceremony. Every
item maps to either an ADR-080 §1 gate, an ADR-122 workflow step, or
an A2/A5 operator dependency. None require multisig signatures —
they should be green hours before the ceremony.

### 1.1 Source-tree integrity

1. **Commit is on a signed `v*-mainnet` tag, on `main`.**
   ```bash
   git fetch --tags origin main && git checkout main && git pull --ff-only
   git tag --points-at HEAD | grep -E '^v.*-mainnet$'
   ```
   Expected: at least one match. **If empty**: HEAD is not at a tagged
   release. Either wrong branch, or the tag has not been pushed.
   Abort until the tag is on the remote.

2. **Working tree is clean.**
   ```bash
   git status --porcelain   # expected: empty
   ```
   **If non-empty**: ADR-080 §1 gate 3 will refuse. Stash or revert;
   never deploy from a dirty tree.

3. **`npm ci` reproduces the lockfile cleanly.** Expected exit 0, no
   lockfile-drift warnings. **If it warns**: do **not** `npm install`
   on the deploy box (mutates the lockfile). Abort, fix on a
   maintainer machine, retag.

4. **`anchor build` IDL diff is clean.**
   ```bash
   anchor build
   for p in agent_registry agent_vault settlement; do
     diff -u "sdk/idl/src/idl/${p}.json" "target/idl/${p}.json" \
       || { echo "IDL drift: $p"; exit 1; }
   done
   ```
   Expected: every diff empty. **If it fails**: the committed IDL
   that downstream integrators consume disagrees with the freshly
   built one. Ship the IDL update PR, retag.

### 1.2 Audit + signing inputs

5. **`config/AUDIT_REPORT_HASHES` is populated.**
   ```bash
   grep -vE '^\s*(#|$)' config/AUDIT_REPORT_HASHES
   ```
   Expected: three lines `<64 hex>  target/deploy/<name>.so`, none
   beginning with 64 zeros. The PR that landed it carries the
   audit-report ID (one PR per audit per ADR-080 §2). **If the
   placeholder zeros are still there**: the auditor has not delivered
   real hashes. The CI gate (ADR-122 step 4) would also reject this
   tag.

6. **`.github/allowed-signers` is populated (no `TODO_PLACEHOLDER_*`).**
   ```bash
   grep -vE '^\s*(#|$)' .github/allowed-signers
   ```
   Expected: every line carries a real principal, key-type, and
   base64 pubkey. No `TODO_PLACEHOLDER_` rows. Each entry was added
   via a separate PR signed by another maintainer (two-eyes per
   roadmap §A5). **If sentinels remain**: ADR-122 step 1 rejects the
   tag. Do not edit the file on the deploy box; ship enrollment PRs
   per roadmap §A5 step 4.

7. **The tag at HEAD verifies against the in-repo allowlist.**
   ```bash
   TAG=$(git tag --points-at HEAD | grep -E '^v.*-mainnet$' | head -n1)
   git -c gpg.format=ssh \
       -c gpg.ssh.allowedSignersFile=.github/allowed-signers \
       tag -v "$TAG"
   ```
   Expected: exit 0 with a `Good "git" signature` line. **If it
   fails**: see roadmap §A4 "Failure modes" table (most common: tag
   signed by an unallowlisted key, or the maintainer pushed an
   unsigned lightweight tag). Have the tagger redo `git tag -s -f
   <tag>` and re-push, or update the allowlist via PR before
   retagging.

### 1.3 Script self-test + CI gate

8. **`scripts/mainnet-deploy.sh --self-test` exits 0.**
   ```bash
   bash scripts/mainnet-deploy.sh --self-test
   ```
   Expected last line: `[INFO] self-test: PASS`. The self-test runs
   the same gate-shape assertions `mainnet-readiness.yml` runs
   (ADR-080 §6 + ADR-122 step 5). **If it fails**: the script's gate
   logic is broken or its inputs are malformed. Abort. Never run the
   full script if `--self-test` does not pass.

9. **`mainnet-readiness.yml` is green on the tagged commit.**
   ```bash
   gh run list --workflow mainnet-readiness.yml \
     --branch refs/tags/"$TAG" --limit 1
   ```
   Expected: most recent run for the tag is `success`. The workflow
   chains the same five gates this runbook walks. **If red**: read
   the failure message and fix the source. Do not "force tag past"
   the workflow — it is designed to fail closed.

### 1.4 Multisig + signers

10. **All `<TODO: operator team to fill in>` of the threshold-required
    multisig signers are reachable**, with hardware wallets present
    and unlocked, and have tested their Squads UI within the last
    7 days (per `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` §3.1). **If
    any signer is unreachable**: a `<threshold>-of-N` that cannot
    reach `<threshold>` signatures is operationally a `0-of-N`.
    Postpone the ceremony.

11. **`MULTISIG_ADDRESS` is the Squads vault PDA from A2 provisioning,
    verified offline.** Cross-reference against your A2 records
    (Squads UI vault page, screenshots, maintainer sign-off thread).
    A typo'd-but-charset-valid address that resolves to *some other*
    multisig becomes upgrade authority and `ProtocolConfig.authority`
    forever — see `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` §4 "typo'd
    multisig PDA" row. The script's gate 8 only verifies the address
    resolves on-chain, **not** that it is the multisig you intended.
    ```bash
    echo "$MULTISIG_ADDRESS"           # eyeball-compare to A2 records.
    solana account "$MULTISIG_ADDRESS" # must succeed; non-empty owner.
    ```
    **If anything mismatches**: abort. Reconcile with A2 records before
    proceeding.

12. **Solana CLI is mainnet-beta and the deployer keypair has ≥ 20 SOL.**
    ```bash
    solana config get   # RPC URL must contain "mainnet"
    solana balance       # ≥ 20 SOL
    ```
    Script gates 9 + 10 (ADR-080 §1) refuse otherwise. **If low**:
    top up from cold storage before starting; deploy + 3 authority
    transfers consume real SOL.

Once items 1–12 are green, you are ready for §2. Open
`<TODO: operator team to fill in>` ceremony comms channel where
signers will coordinate.

---

## 2. Per-program deploy order

The three programs have a strict ordering imposed by their CPI
dependencies. The script (`scripts/mainnet-deploy.sh:689-691`) enforces
it; this section explains why and how to verify post-deploy.

### 2.1 Dependency rationale

| Order | Program | CPI dependencies |
|-------|---------|------------------|
| 1st | `agent-registry` | None on-chain. Receives CPI from Settlement (`propose_reputation_delta`); read by Vault. |
| 2nd | `agent-vault` | Vendors Registry's `MANIFEST_HASH_DOMAIN` precompile pattern as `VAULT_IDENTITY_BIND_DOMAIN` (ADR-124, compile-time only). No CPI to other AEP programs. |
| 3rd | `settlement` | CPI to Registry for reputation deltas, to Vault for transfers. Owns `ProtocolConfig` PDA (read by Registry's `verify_protocol_invariants`). |

A Settlement deploy that lands before Registry would CPI into a
missing program at first `propose_reputation_delta`. Keep
registry-first to match the CPI graph.

### 2.2 Use the script — do not hand-run `solana program deploy`

```bash
MULTISIG_ADDRESS="<squads-vault-pda-from-§1.4-step-11>" \
  ./scripts/mainnet-deploy.sh
```

The script: (1) re-runs every §1 gate (defense in depth — your local
checks may have drifted from CI in the intervening minutes); (2)
opens `logs/mainnet-deploy-<UTC>.log` and writes pre-state (commit
SHA, tags, audit hashes, actual binary hashes, multisig account
dump); (3) prompts once for `PROCEED WITH MAINNET DEPLOYMENT?`, then
`tee`s all subsequent output; (4) deploys Registry → Vault →
Settlement with a `confirm` between each; (5) transfers upgrade
authority for all three to `MULTISIG_ADDRESS` (ADR-080 §3
unconditional, no skip flag); (6) reads back `solana program show`
and asserts authority equals `MULTISIG_ADDRESS` (ADR-080 §4); (7)
writes post-state to the log.

**If the script fails at any §1-style gate**: it exits non-zero before
side effects. Read the gate name, fix the input, re-run from the top.

**If it fails mid-deploy** (between Registry and Settlement): see §5.
Do **not** re-run blindly — the second deploy at the same program ID
is an upgrade, not an initial deploy. Read §5 first.

### 2.3 Per-program post-deploy verification

After the script reports `DEPLOYMENT COMPLETE`, run these
verifications by hand. They cross-check what the script logged
against what an independent client would see.

```bash
# 1. Each program is on mainnet, executable, owned by the multisig.
for pid in <REGISTRY_ID> <VAULT_ID> <SETTLEMENT_ID>; do
  echo "=== $pid ===" && solana program show "$pid"
done
```
Expected for each: `Authority: <MULTISIG_ADDRESS>`, recent `Last
Deployed In Slot`, `Data Length` matching the `.so` artifact size in
the deploy log. **If `Authority:` is the deployer keypair**: the
authority transfer did not complete. Re-run only the transfer
manually: `solana program set-upgrade-authority "$pid"
--new-upgrade-authority "$MULTISIG_ADDRESS"`. **If `Authority:` is
some other address**: see §5 — this is a key-bind incident.

```bash
# 2. The program IDs in sdk/idl/src/index.ts mainnet-beta block match
#    the on-chain IDs we just deployed.
grep -A 4 '"mainnet-beta"' sdk/idl/src/index.ts
```
**Critical surface gap (per AUD-207, roadmap §C3)**: as of this
runbook, `sdk/idl/src/index.ts` ships with **identical IDs across
`devnet`, `mainnet-beta`, and `localnet`**. Pre-mainnet state — real
mainnet keypairs are produced inside the A2 ceremony, then committed
in the C3 PR. **Before invoking the script, confirm the
`"mainnet-beta"` block holds the real mainnet program keypair pubkeys**.
If they still equal the devnet placeholders, abort and ship C3 first.

```bash
# 3. The deployed bytecode matches the audited bytecode byte-for-byte.
for p in agent_registry agent_vault settlement; do
  solana program dump "<MAINNET_ID_FOR_$p>" "/tmp/${p}-deployed.so"
  sha256sum "/tmp/${p}-deployed.so"
done
```
Cross-reference against `config/AUDIT_REPORT_HASHES`. **If a hash
mismatches**: P0 incident. Either the on-chain buffer write was
corrupted (rare; retry the program-only deploy) or `sha256sum` is
reading a different `.so` than the deploy consumed. Reconcile against
the deploy log's `--- actual binary hashes ---` section. **Do not
announce the deploy until reconciled.**

---

## 3. `initialize_protocol_config` ceremony

This is the load-bearing step of the launch. Per AUD-115 + the C4
companion runbook, **whoever signs `initialize_protocol_config`
becomes `ProtocolConfig.authority` for the lifetime of the
deployment.** No on-chain instruction can rotate it (ADR-125 defers
the rotation ix to the first post-launch governance cycle). If the
wrong key signs, the only recovery is a full program redeploy at new
IDs — see §5.4.

### 3.1 Required reading before opening the Squads proposal

**Read `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` §1–§4 in full.** One-line
summary: the multisig PDA that signs `initialize_protocol_config`
becomes the protocol authority, the binding is silent, and there is
no in-script warning if the wrong multisig is loaded.

Walk C4 §3.1 before opening the proposal. The most common mis-bind is
signing from the deployer keypair rather than the multisig PDA —
because the upgrade-authority transfer ran in §2 above and the
operator forgets that the *signer* of the next ix must also be the
multisig PDA. The Settlement context
(`programs/settlement/src/contexts.rs:595-622`) constrains `payer`
to equal the Settlement program's upgrade authority — that constraint
is what binds the protocol authority to whoever signs.

### 3.2 Squads proposal

1. **Open Squads at `<TODO: operator team to fill in>` ceremony URL.**
   Confirm the active vault is the mainnet vault, not the devnet
   rehearsal vault (eyeball-compare PDA against §1.4 step 11 record).

2. **Compose the `initialize_protocol_config` transaction.** No
   arguments; context:
   - `payer`: **the multisig PDA** (this is the signer that becomes
     `ProtocolConfig.authority`).
   - `protocol_config`: derived as
     `findProgramAddressSync([Buffer.from("protocol_config")],
     SETTLEMENT_PROGRAM_ID)` (matches
     `mcp-server/src/solana.ts:380` `deriveProtocolConfigPDA`).
   - `program_data`: the BPF Upgradeable Loader's `ProgramData` PDA
     for Settlement; Squads' Anchor-aware tx builder derives it from
     the IDL automatically.
   - `system_program`: `11111111111111111111111111111111`.

   Proposal title: `mainnet-launch-<UTC-timestamp>-initialize_protocol_config`.
   Description must include mainnet program IDs, `MULTISIG_ADDRESS`,
   the expected `ProtocolConfig.authority` post-init (=
   `MULTISIG_ADDRESS`), and a link to the deploy log.

3. **Coordinate threshold signatures.** Page the on-call signer
   rotation `<TODO: operator team to fill in>`.

4. **Execute the proposal** and **capture the signature**:
   ```bash
   echo "initialize_protocol_config tx: <SIGNATURE>" >> "$LOG_FILE"
   solana confirm -v <SIGNATURE>     # expected: Finalized
   ```
   **If `solana confirm` returns not-found after 60s**: broadcast
   failed. Re-execute via Squads (the proposal stays approved; only
   the on-chain submission re-fires).

### 3.3 Capture artifacts (mandatory)

Three artifacts must be persisted before announcing:

1. **The transaction signature.** Cross-reference on
   `https://explorer.solana.com/tx/<sig>`.

2. **The on-chain `ProtocolConfig.authority` field readback** (per
   C4 §3.2):
   ```bash
   solana account <PROTOCOL_CONFIG_PDA>
   # Bytes [8..40) of the account data are the authority pubkey.
   # Decode and assert equality with MULTISIG_ADDRESS.
   ```
   **If the readback does not equal `MULTISIG_ADDRESS`**: see C4 §4
   "Failure modes." Most common cause: step 3.2.2 used the deployer
   keypair as `payer` instead of the multisig PDA. **Stop the launch.**
   Treat as §5.4 (full redeploy at new program IDs — there is no
   in-place fix).

3. **The Squads proposal URL.** Append to the deploy log so future
   incident responders can audit the multisig vote trail.

### 3.4 Why this section is short

The entanglement explanation, failure-mode table, and recovery paths
all live in C4. This runbook gives the ceremony's mechanics; C4 gives
the why. **Both must be on the operator's screen during this section.**

---

## 4. `verify_protocol_invariants` smoke run

Use the cycle-3 B2 MCP wrapper
(`mcp-server/src/actions/governance.ts`, commit `e9de93e`,
`name: "verify_protocol_invariants"`). The wrapper enforces the
AUD-106 batch cap at the schema layer and produces a structured
response that survives operator copy-paste; raw Anchor RPC does
neither.

The smoke run has two purposes: (1) confirm the multisig flow works
end-to-end for non-deploy governance calls (this is the first
post-launch ceremony); (2) confirm zero invariant violations on a
representative sample.

### 4.1 16-account sample selection criteria

The on-chain `MAX_INVARIANT_BATCH = 16`
(`programs/agent-registry/src/lib.rs:31`) is the per-call cap. For
the launch sample:

- **At least one agent per role** (per `<TODO: operator team to fill
  in>` launch-agent inventory). If launch-day has e.g. five
  archetypes, pick one of each, then fill the remaining slots with
  the highest-balance / highest-reputation accounts (largest
  blast-radius if invariants violated).
- **Exclude any agent registered in the last 60 seconds** (small
  window where the indexer may not yet show a freshly-registered
  profile; the on-chain sweep is independent of indexer readiness
  but operator coordination is easier with indexer-visible accounts).
- **Include at least one agent that was the target of a
  Settlement-side reputation update** during devnet rehearsal
  (validates the Registry-Settlement CPI shape end-to-end).

### 4.2 Invocation via the MCP wrapper

The mcp-server must be configured with `ANCHOR_WALLET` /
`SOLANA_KEYPAIR_PATH` pointing at the **multisig signer flow** (not
the deployer keypair) — for Squads this typically means the
mcp-server submits via a Squads proposal rather than direct RPC. See
`<TODO: operator team to fill in>` for the team's
mcp-server-to-Squads adapter config. Tool call:
```json
{
  "name": "verify_protocol_invariants",
  "arguments": {
    "accounts": [
      "<agent-profile-pda-1>", "<agent-profile-pda-2>", "...",
      "<agent-profile-pda-16>"
    ]
  }
}
```
The wrapper enforces: `accounts.length >= 1` (zero-account sweeps are
operator errors); `accounts.length <= 16`; each entry is a valid
base58 pubkey; capability `gov:invariant:check` is in the operator's
mcp-server capability set (default-deny per ADR-058 §4).

### 4.3 Expected outputs + how to read failures

**On success**, the wrapper returns:
```json
{
  "success": true,
  "protocolConfigAddress": "<PROTOCOL_CONFIG_PDA>",
  "authority": "<MULTISIG_ADDRESS>",
  "batchSize": 16,
  "transactionSignature": "<sig>"
}
```
`authority` must equal §3's `MULTISIG_ADDRESS`. Confirm on Explorer
that program logs end with `Program <REGISTRY_PROGRAM_ID> success`.

**On a failed invariant**, the on-chain handler reverts the entire
transaction (`programs/agent-registry/src/lib.rs:820-823` —
`Account::try_from` + `assert_valid_profile` per remaining account;
any failure bubbles up). The wrapper returns `code: "PROGRAM_ERROR"`
with an Anchor message naming the offending zero-based index in the
`remaining_accounts` slice — cross-reference against your `accounts`
array.

**On `Unauthorized` revert**: `ProtocolConfig.authority` does not
equal the signer. Either §3 was not completed, or the wrong keypair
signed. See C4 §3.2's `solana account <PROTOCOL_CONFIG_PDA>` readback
to diagnose.

### 4.4 What to do if any invariant fails

**Treat any non-success result as a deploy abort.** The launch
sequence assumes a clean invariant baseline. Failure means either a
program bug the audit missed (rare on cycle-2-corpus code), corrupted
profile data in transit, or a silent bypass of `MAX_INVARIANT_BATCH`
(would indicate the wrapper schema check was bypassed — investigate
the mcp-server deployment).

In each case, **do not announce the launch.** Page on-call lead and
pivot to `docs/INCIDENT_RESPONSE.md` §1 (on-chain incident triage).
The §1.3 table tells you whether the failure is a parameter tweak
(`update_protocol_config`) or a code-level bug (redeploy required —
see §5 below).

If the smoke succeeds, run a second 16-account batch covering a
non-overlapping slice. Two clean batches across ~30 distinct accounts
is the launch-window confidence baseline.

---

## 5. Rollback procedure

Rollback semantics depend on **which step failed**. There is no
single "rollback button"; the recovery surface is per-stage. For
broader incident handling once you are past the initial freeze, see
`docs/INCIDENT_RESPONSE.md` §1.

### 5.1 When to roll back

| Failure point | Recovery |
|---------------|----------|
| Pre-deploy gate (§1) fails | **Not a rollback** — nothing happened on-chain. Fix source, retag, restart. |
| Script aborts before `transfer_authority_to_multisig` (§2) | Some programs deployed but authority is still the deployer keypair. **Recoverable in-place** — see §5.2. |
| Script aborts during or after `transfer_authority_to_multisig` (§2) | At least one program is now under multisig control. **Recovery requires multisig** — see §5.3. |
| `initialize_protocol_config` signed by the wrong key (§3) | **Not recoverable in-place** (ADR-125 deferred rotation ix; C4 §4). Full redeploy at new program IDs — §5.4. |
| `verify_protocol_invariants` smoke fails (§4) | **Not a rollback** — the smoke is read-only and atomically reverts. Pivot to `docs/INCIDENT_RESPONSE.md` §1 and decide whether to roll back §2/§3. |

### 5.2 Recovery: partial deploy, no authority transfer yet

Symptoms: one or two programs show as deployed, the third does not,
all that did deploy still have the deployer keypair as `Authority:`.

1. Capture partial state into a timestamped log:
   ```bash
   for pid in <REGISTRY_ID> <VAULT_ID> <SETTLEMENT_ID>; do
     solana program show "$pid" \
       >> "logs/incident-$(date -u +%Y%m%dT%H%M%SZ)-partial.log"
   done
   ```
2. Diagnose via the script's `logs/mainnet-deploy-*.log` last
   `[ERROR]` line. Common: out-of-SOL (top up, retry); RPC timeout
   (transient, retry); keypair file missing mid-script (repair, retry).
3. Re-run the script. It is idempotent at the gate layer and a
   `solana program deploy` against an already-deployed ID becomes
   an upgrade — correct behavior here. Confirm post-state via §2.3.
4. **If re-run is not viable** (irreparable keypair issue), abandon
   those program IDs and redeploy at fresh IDs per §5.4.

### 5.3 Recovery: authority transfer succeeded, downstream step failed

Symptoms: all three programs have `Authority: <MULTISIG_ADDRESS>` but
`initialize_protocol_config` (§3) failed or has not run.

The programs are fine; the remaining work is a multisig ceremony.
Re-do §3 from scratch. The `init` constraint reverts with
`already-initialized` if §3 already partially succeeded — itself a
useful signal that you don't need to redo it. If init succeeded but
bound the wrong key, see §5.4.

### 5.4 Recovery: wrong key bound to `ProtocolConfig.authority`

Per `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` §4 and ADR-125 (Proposed,
deferred), there is **no `rotate_protocol_config_authority`
instruction.** If §3 bound the wrong key, the only on-chain recovery is:

1. **Generate fresh program keypairs** for all three programs. New
   program IDs; the bound `ProtocolConfig` PDA on the *current* IDs
   becomes orphaned but is irrelevant (a fresh `ProtocolConfig` will
   live under the new Settlement program).
2. **Update program-ID constants** (`scripts/mainnet-deploy.sh:40-42`,
   `sdk/idl/src/index.ts` `"mainnet-beta"` block) in a PR; retag.
3. **Redeploy** via the same script + gates.
4. **Re-do §3** under the correct multisig.
5. **Communicate the cutover** to integrators. Set `--final` on the
   orphaned IDs to prevent any subsequent upgrade confusion.

This is multi-day work. The 60-minute goal once you discover the
mis-bind is to **stop further damage** (announce nothing, do not
direct any user funds to the orphaned IDs). See
`docs/INCIDENT_RESPONSE.md` §1.5 for broader incident-handling.

### 5.5 What state survives a rollback

| Artifact | Survives full redeploy? |
|----------|------------------------|
| `config/AUDIT_REPORT_HASHES` | Yes (same source tree, same audit). |
| `.github/allowed-signers` | Yes (orthogonal to deploy). |
| Multisig membership (Squads PDA) | Yes — same PDA controls new program IDs. |
| Deploy log artifacts | Yes — each redeploy writes a new log; old logs are evidence. |
| Orphaned program IDs | Permanently abandoned. Cannot be reused. |
| `ProtocolConfig` on the orphaned Settlement | Frozen on-chain forever. New `ProtocolConfig` lives under the new Settlement's PDA. |
| Indexer cursor state | Must be reset for new program IDs (`docs/INCIDENT_RESPONSE.md` §3 cold-replay). |

---

## 6. Day-1 monitoring checklist

The first 24 hours are the highest-signal window for any latent
failure mode the audit did not surface.

### 6.1 First hour (T+0 to T+1h)

- [ ] **`mainnet-readiness.yml` stays green.** `gh run list
      --workflow mainnet-readiness.yml --limit 5`. Late-firing red
      runs (e.g. an accidental `v*-mainnet`-matching tag push) must
      be investigated immediately.
- [ ] **First `verify_protocol_invariants` smoke at T+1h.** Re-run §4
      with a fresh 16-account sample. Goal: confirm no invariant
      drift in the first hour of real traffic.
- [ ] **All three programs still show `Authority: <MULTISIG_ADDRESS>`.**
      ```bash
      for pid in <REGISTRY_ID> <VAULT_ID> <SETTLEMENT_ID>; do
        solana program show "$pid" | grep "Authority"
      done
      ```
      Any drift (authority became `None`, or a new pubkey) is P0 — see
      `docs/INCIDENT_RESPONSE.md` §2 (multisig rotation).
- [ ] **No multisig signer reports a lost device or compromised key.**
      Page rotation `<TODO: operator team to fill in>` if any signer
      is unreachable.

### 6.2 First 6 hours (T+1h to T+6h)

- [ ] **x402-relay error rate at baseline.** Watch for the AUD-209
      fail-closed 503 (`Relay redeemed-signature capacity exhausted;
      retry shortly` — `src/x402-relay/index.ts:482-484`). Per ADR-126
      (Proposed), the single-instance relay tops out at ~30 sigs/sec
      sustained; above that, follow `docs/INCIDENT_RESPONSE.md` §4.4
      (manual scale-out). Signals: `/pay` 503 rate > `<TODO: operator
      team to fill in>` per minute; `redeemedSignatures.size` near
      80% of 100,000; repeated retries from same IP (adversarial —
      see INCIDENT §4.5).
- [ ] **Indexer event-ingest lag stays bounded.**
      ```sql
      -- Against the indexer's better-sqlite3 file:
      SELECT program, last_processed_slot, last_signature, updated_at
      FROM cursor;
      ```
      All three rows must show `updated_at` advancing. A frozen cursor
      is the signal `docs/INCIDENT_RESPONSE.md` §3 was written for.
      Lag SLO: `<TODO: operator team to fill in>`.

      ADR-127 (Proposed; indexer redundancy + cursor-anchored
      backfill) is the architectural target for the secondary-instance
      design. **Until the ADR-127 implementation ships**, the single
      indexer instance is the only ingest path; treat any health-check
      failure as P1. Once the cold-spare lands, this section will be
      updated to reference the secondary's health endpoint.
- [ ] **`verify_protocol_invariants` smoke at T+6h.** Same procedure
      as T+1h, ideally including any agent that was the target of a
      Settlement-side reputation update in the first 6 hours.

### 6.3 First 24 hours (T+6h to T+24h)

- [ ] **`verify_protocol_invariants` smoke at T+24h.** Three clean
      smokes (T+1h, T+6h, T+24h) across non-overlapping samples gives
      ~48 distinct profiles validated — the launch-week confidence
      baseline.
- [ ] **Multisig signer health survey.** Each signer confirms (in
      `<TODO: operator team to fill in>` channel) hardware wallet is
      operational and they have not had a signing-device incident. A
      3-of-5 that loses 3 keys in 24h is unrecoverable; surface
      partial-loss early.
- [ ] **Indexer DB backed up.** Per the C5 redundancy plan (ADR-127
      Proposed), cadence is `<TODO: operator team to fill in>`. The
      first 24h of mainnet data is precious; take an explicit cold
      backup at T+24h regardless of whether the cron has fired.
- [ ] **Audit hash file integrity at T+24h.** Re-run the §2.3 step-3
      binary diff:
      ```bash
      for p in agent_registry agent_vault settlement; do
        solana program dump "<MAINNET_ID>" "/tmp/${p}-t24.so"
        sha256sum "/tmp/${p}-t24.so"
      done
      ```
      Compare against `config/AUDIT_REPORT_HASHES`. **A divergence at
      T+24h that was not present at T+0 means a malicious upgrade has
      landed** — page on-call lead immediately.

### 6.4 Handoff to steady-state

After T+24h, hand off to the steady-state on-call rotation
`<TODO: operator team to fill in>`. Handoff artifact: deploy log +
three smoke-run tx signatures (T+1h, T+6h, T+24h) + any incident
records. Steady-state monitoring continues per
`docs/INCIDENT_RESPONSE.md` §5 and `docs/MAINNET_CHECKLIST.md` §6
(Helius webhooks, dashboards); the Day-1 checklist does not recur.

---

## 7. References

- `docs/INCIDENT_RESPONSE.md` (commit `bbeb240`, C2) — incident
  handling; referenced from §5 + §6.
- `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` (commit `7cb4415`, C4) —
  AUD-115 entanglement runbook; required reading before §3.
- `docs/PRE_MAINNET_ROADMAP.md` §4 C1 — spec.
- `docs/MAINNET_CHECKLIST.md` — the gated checklist; every row must
  be `Done` before §1.
- `docs/adr/ADR-080-mainnet-deploy-safety-mandates.md` — §1
  pre-flight gates, §2 audit-hash lifecycle, §3 `MULTISIG_ADDRESS`
  non-optional, §5 deploy log, §6 `--self-test`.
- `docs/adr/ADR-122-mainnet-readiness-ci-gate.md` — workflow this
  runbook expects green before §1.
- `docs/adr/ADR-125-rotate-protocol-config-authority.md` (Proposed) —
  why §5.4 is the only recovery from an authority mis-bind.
- `docs/adr/ADR-126-x402-relay-horizontal-scale.md` (Proposed) —
  saturation behavior referenced in §6.2.
- `docs/adr/ADR-127-indexer-redundancy-backfill.md` (Proposed) —
  indexer cold-spare design referenced in §6.2 + §6.3.
- Pre-Mainnet Roadmap §A5 + `.github/allowed-signers` —
  source-controlled signing allowlist consumed by §1.2.
- `mcp-server/src/actions/governance.ts` (commit `e9de93e`,
  AUD-206 / roadmap §B2) — typed MCP wrapper used in §4.
- `programs/agent-registry/src/lib.rs:744-826` — on-chain
  `verify_protocol_invariants` (lines 744–754 are the AUD-115 inline
  note C4 lifts from).
- `programs/settlement/src/instructions/protocol_config.rs:16-36`
  + `programs/settlement/src/contexts.rs:595-622` — on-chain
  `initialize_protocol_config`; the context's
  `program_data.upgrade_authority_address == Some(payer.key())`
  constraint is what binds the protocol authority at signing time.
- `sdk/idl/src/index.ts` — per-cluster program IDs (AUD-207, roadmap
  §C3); §2.3 step 2 is the load-bearing operator check.
