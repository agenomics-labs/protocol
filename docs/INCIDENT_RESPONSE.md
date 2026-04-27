# Incident Response Playbook

**Audience**: the operator paged at 3am with a partial alert payload, who
needs to know what to do in the next 60 minutes. SRE-level Solana +
Node.js familiarity assumed; deep protocol knowledge **not** assumed.

**Status**: Authoritative. Universal across the launch period — not
specific to one tenant. Operator-specific config is spelled
`<TODO: operator team to fill in>`.

**Companion docs** (read once, before you ever get paged):

- `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` — the AUD-115 entanglement
  runbook. Required reading for §1 and §2 below.
- `docs/adr/ADR-080-mainnet-deploy-safety-mandates.md` — the deploy
  gates a redeploy must re-satisfy.
- `docs/adr/ADR-122-mainnet-readiness-ci-gate.md` — the CI gate
  blocking any `v*-mainnet` tag push that does not pass readiness.
- `docs/PRE_MAINNET_ROADMAP.md` §4 (C2) — the spec this playbook
  delivers against.

Four incident classes: on-chain triage (§1), multisig rotation (§2),
indexer recovery (§3), x402-relay saturation (§4). Each section is:
triggers → decision tree → procedure → post-incident.

---

## 1. On-chain incident triage

### 1.1 Triggers

- `verify_protocol_invariants` sweep returned a non-zero count of
  inconsistent profiles.
- A user-facing report of a stuck or mis-paid escrow on mainnet.
- A program transaction is reverting in a pattern that did not exist
  before the most recent deploy.
- An auditor or security researcher reported a finding against a
  deployed program.
- A reputation score moved in a direction that contradicts the
  Settlement → Registry CPI contract.

### 1.2 Decision tree

```
Q1. Parameter setting, or program code?
    Parameter = any field on `ProtocolConfig` mutable by
    `update_protocol_config` (see §1.3). Anything else = code.
    → parameter    → §1.4 (config tweak)
    → code         → Q2

Q2. Is the code path exploitable in its current state?
    Exploitable = attacker can drain funds, mint reputation, or
    escalate authority right now without our intervention. Stuck
    escrows / wrong-but-inert deltas / UX bugs are NOT exploitable.
    → exploitable      → §1.5 (emergency redeploy)
    → not exploitable  → Q3

Q3. Is there a non-deploy operator action that mitigates?
    Examples: key rotation closes the surface (§2); pausing the
    x402-relay severs the off-chain entry point (§4).
    → yes  → execute it; schedule the code fix on the next normal
             release.
    → no   → §1.5 (planned redeploy, not emergency cadence).
```

### 1.3 What `update_protocol_config` can tweak

`programs/settlement/src/instructions/protocol_config.rs:57` accepts
five `Option<T>` fields. Anything outside this list is code, not config:

| Field | Bounds | Typical incident use |
|-------|--------|----------------------|
| `min_escrow_amount` | `> 0` | Raise to deny dust-spam. |
| `dispute_timeout_seconds` | `> 0`, `<= MAX_DISPUTE_TIMEOUT_SECONDS` | Extend during a counterparty outage so disputes do not auto-resolve against innocent agents. |
| `reputation_delta_task_completed` | `0 ..= 10` | Lower to dampen reputation inflation. |
| `reputation_delta_dispute_loss` | `-10 ..= 0` | Lower magnitude if dispute path misfires. |
| `reputation_delta_expiry_undelivered` | `-10 ..= 0` | Same — if expiry slashing is hitting wrong cohorts. |

### 1.4 Procedure: `update_protocol_config` (parameter tweak)

Pre-condition: every `update_protocol_config` call is a multisig
ceremony with the **same threshold** as a program upgrade. There is no
"lighter" governance key today — see `docs/PROTOCOL_AUTHORITY_OPERATIONS.md`
§2.

1. **Stage locally.** Build the transaction with the new values,
   dry-run against devnet first. Confirm the resulting
   `ProtocolConfigUpdated` event values are exactly what you intended.
2. **Verify each value is inside the §1.3 bounds.** Out-of-bound values
   revert; not catastrophic but wastes a coordination round.
3. **Open the multisig proposal in Squads.** Title:
   `incident-<UTC-timestamp>-update_protocol_config`. Description must
   include the alert that triggered the change, the field(s), old
   value, new value, and a one-line rationale.
4. **Coordinate signatures.** Page the on-call signer rotation
   `<TODO: operator team to fill in>`.
5. **Execute and confirm.** Read the `ProtocolConfig` PDA back:
   ```bash
   solana account <PROTOCOL_CONFIG_PDA> --output json | \
     jq -r '.account.data[0]' | base64 -d | xxd | head -20
   ```
   Cross-reference parameter bytes against
   `programs/settlement/src/state.rs`.
6. **Verify the alert clears.** The change takes effect on the next
   instruction that reads `ProtocolConfig`.

### 1.5 Procedure: program redeploy via Squads multisig

Heaviest possible response. Read this section in full before starting.

Pre-conditions:

- Code fix has landed on `main`, sitting on a signed `v*-mainnet` tag.
- `mainnet-readiness.yml` (ADR-122) passed for that tag — checklist
  clean, audit hashes populated, allowlist real, self-test green.
- `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` was followed at
  `initialize_protocol_config` time. The multisig PDA you're about to
  sign with **must equal** the upgrade authority on each program AND
  `ProtocolConfig.authority` (same key post-init by AUD-115 — see C4
  doc §1).

Steps:

1. **Capture pre-state**:
   ```bash
   for p in <REGISTRY_ID> <VAULT_ID> <SETTLEMENT_ID>; do
     solana program show "$p" >> "logs/incident-$(date -u +%Y%m%dT%H%M%SZ)-prestate.log"
   done
   ```
   The deploy script (per ADR-080 §5) writes its own log; capture
   redundantly anyway.
2. **Run `scripts/mainnet-deploy.sh --self-test` on the deploy box.**
   Re-runs the same gates the CI ran. If self-test fails, **stop** —
   diagnose offline, do not deploy.
3. **Confirm auditor's hashes match the locally-rebuilt binaries** per
   ADR-080 §2:
   ```bash
   anchor build && sha256sum --check --strict config/AUDIT_REPORT_HASHES
   ```
   Mismatch aborts. Do **not** proceed with mismatched binaries.
4. **Run the deploy script.** Transfers authority to multisig if not
   already, deploys in dependency order (registry → vault → settlement),
   and verifies each program's post-deploy upgrade authority equals
   `MULTISIG_ADDRESS`:
   ```bash
   MULTISIG_ADDRESS=<squads-vault-pda> ./scripts/mainnet-deploy.sh
   ```
   Coordinate Squads signatures as each `solana program deploy` step
   blocks. The deploy log goes to `logs/mainnet-deploy-*.log` (ADR-080
   §5) — do **not** close the terminal until the file is on disk and
   rotated to long-term storage.
5. **Post-deploy verification.** For each program:
   ```bash
   solana program show <PROGRAM_ID>
   # Authority must equal MULTISIG_ADDRESS.
   ```
6. **Confirm `ProtocolConfig.authority` is unchanged.** A redeploy does
   NOT affect this field. If the post-deploy read shows it changed, you
   have a worse problem — page on-call lead.

### 1.6 Post-incident (all paths)

- [ ] Original alert is clear in the alerting surface (not "presumed
      clear").
- [ ] `verify_protocol_invariants` was run against the affected profiles
      (16-account batches per AUD-106) and returned zero inconsistencies.
      See `docs/PROTOCOL_AUTHORITY_OPERATIONS.md` §3.2 for the multisig
      flow on this call.
- [ ] All log artifacts captured: pre-state dump, deploy log (if §1.5),
      `ProtocolConfigUpdated` event tx signature (if §1.4), Squads
      proposal URL.
- [ ] Draft post-mortem open with: trigger, decision-tree path taken,
      time-to-mitigate, time-to-resolve, what surprised you. Filed
      under `<TODO: operator team to fill in>`.

---

## 2. Multisig emergency rotation

### 2.1 Triggers

- A multisig signer reports a compromised hardware key or signing
  device.
- A signer's hardware token is lost or stolen with unknown recovery
  status.
- An internal investigation reveals a member's credentials may have
  been used without authorization.
- A maintainer departs under non-routine circumstances and held a
  signing seat.

### 2.2 Decision tree

```
Q1. Does the remaining (uncompromised) signer set still meet
    threshold?
    Example: 3-of-5 with 1 compromised → 4 clean → reachable.
    2-of-3 with 2 compromised → 1 clean → UNREACHABLE.
    → reachable     → §2.3 (in-place rotation)
    → unreachable   → §2.4 (program-redeploy escape hatch)

Q2. Is the compromise active (key currently usable by attacker) or
    contained (revoked, device wiped, no longer accessible)?
    → active     → §2.3 with Squads-only ceremony, not a member
                    round-table. Time-to-rotate is the budget.
    → contained  → §2.3 at normal pace, with written rationale.
```

### 2.3 Procedure: in-place Squads member rotation

Cleanest possible recovery. Per `docs/PROTOCOL_AUTHORITY_OPERATIONS.md`
§4 (failure-modes table, "wrong members" row): mutating membership
inside Squads keeps the multisig PDA constant, so
`ProtocolConfig.authority` does NOT change and no on-chain rotation
instruction is needed.

1. **Confirm the PDA stays constant.** This is the load-bearing
   invariant. If recovery involves creating a *new* Squads multisig
   with a different PDA, you are on §2.4, not §2.3.
2. **Disable the compromised signer's seat in Squads.** Requires
   threshold approvals from the *current* signer set — the compromised
   key may participate (it has not been removed yet). For an actively
   malicious key, weight the ceremony accordingly (Q2 active branch).
3. **Add the replacement signer.** New member generates their key
   locally per the standard flow (same as `docs/PRE_MAINNET_ROADMAP.md`
   §A2 step 3 — keys never leave the member's machine).
4. **Verify on-chain state.** Confirm `ProtocolConfig.authority` still
   equals the multisig PDA:
   ```bash
   solana account <PROTOCOL_CONFIG_PDA>
   # Bytes [8..40) must equal <MULTISIG_PDA>.
   ```
5. **Do a no-op governance call to prove the new signer set.** Smallest
   possible: a no-op `update_protocol_config` (set `min_escrow_amount`
   to its current value). If it reverts, the rotation is incomplete.
6. **Update the maintainer signing-key allowlist** if the rotated
   member also held a code-signing seat. The signing allowlist
   (`.github/allowed-signers`, per Pre-Mainnet Roadmap §A5) is a
   separate authorization surface from multisig membership; rotate
   each independently.

### 2.4 Procedure: program-redeploy escape hatch

Worst case: cannot reach threshold from clean signers. Per
`docs/PROTOCOL_AUTHORITY_OPERATIONS.md` §4 + §6, there is **no
`rotate_protocol_config_authority` instruction today** — the only
recovery is to redeploy programs at new IDs under a freshly-provisioned
multisig.

This is multi-day, not 60-minute. The 60-minute goal is to **stop
further damage**, not to complete recovery.

1. **Page on-call lead immediately.** P0 governance incident.
2. **If the attacker has not yet executed a malicious tx**: clean
   signers can flood-propose competing transactions to consume the
   multisig's nonce budget. `<TODO: operator team to fill in>` —
   Squads-specific tactics depend on multisig variant.
3. **Sever off-chain entry points.** Pausing x402-relay (§4) and
   indexer (§3) does not protect on-chain programs but reduces
   coordination surface. `<TODO: operator team to fill in>` — pause
   runbooks.
4. **Coordinate the new-multisig + redeploy plan offline.** Do NOT
   attempt the redeploy in the first hour — it requires new A2
   provisioning, new A5 code-signing flow, new `AUDIT_REPORT_HASHES`,
   integrator communication, and new program IDs in the SDK +
   dashboard.

### 2.5 Post-incident

- [ ] Compromised key cannot pass any subsequent multisig proposal
      (verify by attempting a no-op signed by it; expected: rejected).
- [ ] `ProtocolConfig.authority` and each program's upgrade authority
      all still equal the (now-rotated) multisig PDA. For the §2.4
      path, all equal the *new* multisig PDA.
- [ ] `<TODO: operator team to fill in>` security disclosure schedule
      is set: who is told what, when, by whom.
- [ ] If the rotated member had an `.github/allowed-signers` entry,
      that PR is merged before the next tag push. The mainnet-readiness
      gate (ADR-122 + Pre-Mainnet Roadmap §A5) consults the in-repo
      allowlist; a stale entry is a latent re-compromise surface.

---

## 3. Indexer DB recovery from cold backup

### 3.1 Triggers

- Indexer's `/health` endpoint returns non-200, or `event-ingest lag`
  exceeds `<TODO: operator team to fill in>` SLO.
- The SQLite file (`better-sqlite3`, per `src/indexer/index.ts`) is
  reported corrupt or missing.
- The indexer host is unreachable.
- A `cursor` table check returns a `last_processed_slot` older than
  the last alert window — silent ingest stall.

### 3.2 Decision tree

```
Q1. Is the SQLite file readable at all?
    → readable + recent (slot lag < TTL window)  → §3.3 (live patch)
    → readable but stale                          → §3.4 (catch-up)
    → unreadable / missing / host gone            → §3.5 (cold replay)

Q2. Do you have a recent cold backup?
    "Recent" = backup's `cursor.last_processed_slot` is within the
    re-derivable RPC retention window. <TODO: operator team to fill
    in> the RPC provider's advertised retention.
    → yes, recent  → §3.5 step "restore + replay from cursor"
    → no recent    → §3.5 step "rebuild from genesis-of-program."
                      Multi-day; raise to on-call lead.

Q3. Is C5 redundancy in place? (C5 had not started as of 2026-04-26.)
    → yes, secondary running  → fail over per the C5 runbook (see
                                 C5 once it lands).
    → no, single-instance     → §3.5 is your only path.
```

### 3.3 Procedure: live patch (DB readable, recent)

A specific table or row is inconsistent (e.g. an `agent_tombstones`
row missing causing a re-resurrection bug). Repair in place:

1. Stop the indexer (`<TODO: operator team to fill in>` — process
   manager / unit name).
2. Snapshot the current DB **before** mutating:
   `cp <indexer.db> logs/indexer-<UTC>-prepatch.db`.
3. Open with `sqlite3` and apply the targeted fix. Limit to the
   affected rows; do not bulk-edit.
4. Restart. Watch for the cursor advancing in the next `cursor` read.

### 3.4 Procedure: catch-up replay (DB readable, stale)

The cursor is behind the head. Restart the indexer; the backfill loop
catches up (per the `BACKFILL_PAGE_SIZE` / `BACKFILL_TX_DELAY_MS`
constants and the `cursor` table per finding #23).

1. Restart the indexer process.
2. Watch metrics (per `src/indexer/metrics-server.ts`); ingest-lag
   should monotonically decrease.
3. If lag is not closing within `<TODO: operator team to fill in>` SLO,
   escalate to §3.5 — the RPC provider may have pruned transactions
   outside the cursor range.

### 3.5 Procedure: cold replay from backup

SQLite file is gone or unreadable; you have a cold backup from slot N
(per the C5 backup-cadence plan, which had not landed as of
2026-04-26 — until C5 ships, cadence is `<TODO: operator team to fill
in>`).

1. **Restore the backup file** to the canonical indexer path
   (`<TODO: operator team to fill in>` — DB path).
2. **Confirm the cursor table is intact**:
   ```sql
   SELECT program, last_processed_slot, last_signature, updated_at
   FROM cursor;
   ```
   Three rows expected (registry, vault, settlement). If any row is
   missing, do not start the indexer — it would write a
   `last_processed_slot=0` row and re-replay from genesis (correct but
   slow, may exceed RPC retention).
3. **Verify the RPC endpoint can serve from `last_processed_slot`.**
   Pick the *oldest* of the three cursors:
   ```bash
   solana confirm <some-known-tx-near-that-slot>
   ```
   Non-zero exit means the slot is outside RPC retention; need an
   archive RPC or a more recent backup.
4. **Start the indexer.** Resumes from each cursor, processes
   oldest-first. Throughput ≈ 40 tx/s per the inline constants. A
   24-hour gap at typical launch throughput ≈ 1 hour catch-up.
5. **Data-integrity verification post-replay**:
   - Count `events` per program; cross-reference an on-chain
     `solana logs` sampling for the same slot range. The indexer is
     event-sourced (`emit!` macros); a missing event in the indexer
     that the chain emitted is a correctness bug.
   - Re-check `agent_tombstones`: any agent in `agents` whose authority
     appears in `agent_tombstones` with a higher `deregistered_at_slot`
     than the agent's `last_updated` indicates a resurrection bug (see
     the S-offchain-04 comment block in `src/indexer/index.ts`).
     Resurrection bugs MUST be resolved before exposing the indexer to
     consumers.
   - The x402-relay maintains its own `redeemedSignatures` map (§4)
     independent of the indexer; no cross-state coordination needed.

### 3.6 Post-incident

- [ ] All three cursor rows show `last_processed_slot` within the
      ingest-lag SLO of current head.
- [ ] Event-count cross-check (§3.5 step 5) returned zero gaps.
- [ ] No resurrection rows in the agents table.
- [ ] Backup of the now-recovered DB taken and pushed to cold storage.
      Recovery does not refresh backup cadence; do it explicitly.
- [ ] If C5 was incomplete: file a P1 to accelerate it. One
      cold-replay incident on a single-instance indexer is acceptable;
      two is operational debt.

---

## 4. x402-relay saturation response

### 4.1 Triggers

- `/pay` returning HTTP 503 with body
  `Relay redeemed-signature capacity exhausted; retry shortly` (the
  AUD-209 fail-closed guard at `src/x402-relay/index.ts:482-484`).
- 503 rate exceeds `<TODO: operator team to fill in>` per-minute
  threshold.
- Latency on `/pay` spikes while the redeemed-signatures map is near
  `MAX_REDEEMED_SIGNATURES` (100,000).
- Customer reports of repeated retries against `/pay`.

### 4.2 Decision tree

```
Q1. Organic or adversarial?
    Organic = legitimate paid traffic exceeded the single-instance
    ceiling (~30 sigs/sec sustained per AUD-209).
    Adversarial = attacker flooding /pay with unique signatures to
    occupy slots in `redeemedSignatures`.
    Distinguishing signal: source-IP distribution. Organic = many
    IPs, long-tail. Adversarial = small set hitting /pay repeatedly.
    → organic      → §4.4 (manual scale-out)
    → adversarial  → §4.5 (block + scale)

Q2. Has horizontal-scale (ADR-117 / AUD-028) shipped?
    The single-instance design tops out at AUD-209's cap; the
    Redis-backed dedup that lifts it is the future fix referenced at
    `src/x402-relay/index.ts:89-91`. Per Pre-Mainnet Roadmap C6, this
    had not shipped as of 2026-04-26.
    → shipped      → ADR-117 runbook is authoritative.
    → not shipped  → §4.4 manual mitigation; §4.3 lists what NOT to do.
```

### 4.3 What you MUST NOT do

Each item below has a specific correctness consequence; the §4.4 / §4.5
procedures are written so you do not need any of these.

1. **Do NOT increase `MAX_REDEEMED_SIGNATURES`** (`src/x402-relay/
   index.ts:70`). The 100,000 cap is **load-bearing for replay
   protection**, not throughput. The previous fail-OPEN behavior
   (oldest-eviction) re-opened the replay window for evicted unexpired
   signatures — exactly what AUD-209 closed. A bigger cap delays the
   failure but does not change its character.
2. **Do NOT shorten `SIGNATURE_TTL_MS`** to evict faster. The TTL is
   `TOKEN_EXPIRY_SECONDS + 300` (5-min grace). The grace exists so a
   JWT issued just before the boundary is still protected from replay
   during its own lifetime. Shortening re-opens the AUD-209 window.
3. **Do NOT add a `--skip-saturation-check` flag** or any code path
   that returns 200 from a saturated `/pay`. Same anti-pattern as
   ADR-080's rejected Alternative F — fix gates in code, not at
   runtime.
4. **Do NOT disable rate limiting on `/pay`** (separate defense at
   `src/x402-relay/index.ts:283-305`). Disabling creates an
   amplification surface for the adversarial case.
5. **Do NOT roll back to the pre-AUD-209 commit.** Pre-cycle-2 had the
   fail-OPEN eviction bug; rolling back restores throughput at the
   cost of the closed replay window.

### 4.4 Procedure: organic saturation, manual scale-out

The proper fix is ADR-117 horizontal-scale (Redis-backed dedup). Until
ADR-117 ships, the manual mitigation is to run multiple relay instances
behind a load balancer with sticky-sessions on `txSignature`. This
loses some dedup guarantees (a client retrying against a different
instance can race a duplicate JWT issue — the AUD-208 in-flight cache
spans only a single process) — emergency mitigation, not permanent fix.

1. **Stand up N additional relay instances.** `<TODO: operator team to
   fill in>` provisioning details. **All instances share `JWT_SECRET`**
   — every instance is the verifier for tokens any other instance
   issued.
2. **Configure the LB with sticky sessions on `txSignature`.** Hash the
   body's `txSignature` and route deterministically. Minimizes (does
   not eliminate) cross-instance double-issue: two retries with the
   same signature route to the same instance, where the in-flight
   cache + `redeemedSignatures` map dedup correctly.
3. **Set `TRUST_PROXY` to the LB's hop count** on each instance
   (`src/x402-relay/index.ts:41-55`). Without this, the rate limiter
   buckets every request into the LB's IP. Set the exact integer hop
   count, NOT `true` — `true` re-introduces `X-Forwarded-For` spoofing.
4. **Watch saturation drop.** Confirm 503 rate returns to baseline.
   Buys headroom but is **not** a closure; file a P1 to accelerate
   ADR-117 if not already in flight.

### 4.5 Procedure: adversarial saturation

§4.4, plus:

1. **Identify source IPs from the access log** (structured pino access
   per ADR-090 / `logger.ts`). Group by source IP, top-N.
2. **Block at the network edge, not in the relay.** Edit the firewall
   / WAF rules `<TODO: operator team to fill in>`. In-app blocking
   consumes relay CPU; edge blocking is free.
3. **Confirm legitimate traffic returns.** If 503 rate stays high after
   blocking the top sources, the attacker rotated IPs or you have a
   mixed organic+adversarial saturation; treat residual as organic
   (§4.4).
4. **Preserve evidence.** The pino access log is your only record of
   the attack pattern; rotate to long-term storage before rotation
   overwrites.

### 4.6 Post-incident

- [ ] 503 rate back to baseline (≈ 0).
- [ ] `redeemedSignatures.size` (exposed via metrics surface
      `<TODO: operator team to fill in>`) is below 80% of
      `MAX_REDEEMED_SIGNATURES`.
- [ ] If you scaled out manually (§4.4), the cross-instance
      double-issue race window was open during mitigation — grep for
      duplicate-sender JWTs in the access log; report any to on-call
      lead. (Real duplicates are privilege-escalation bugs; the
      AUD-208 fix is per-process, so cross-process is a known
      limitation pending ADR-117.)
- [ ] Post-mortem captures peak `redeemedSignatures.size`, peak 503
      rate, peak source-IP cardinality, time-to-mitigate.
- [ ] If ADR-117 was not in flight before this incident, file a P0 to
      accelerate it. The single-instance ceiling will recur.

---

## 5. Cross-cutting: post-mortem artifacts

For every incident class, capture:

1. **Timeline** — UTC timestamps for: alert fired, on-call
   acknowledged, decision-tree Q1 answered, mitigation started,
   mitigation confirmed, all-clear declared.
2. **Decision-tree path taken** — branches at each Q. If a branch was
   wrong in retrospect, note explicitly.
3. **Logs** — for §1.5: `logs/mainnet-deploy-*.log` + the pre-state
   capture. For §3: pre-patch DB snapshot, `cursor` contents at
   recovery time. For §4: pino access log slice for the saturation
   window.
4. **On-chain evidence** — relevant transaction signatures, account
   snapshots before and after.
5. **What surprised you** — the most valuable section. The playbook
   is a living document; surprises are the input that keeps it
   accurate.

Filed under `<TODO: operator team to fill in>` post-mortem destination.

---

## 6. References

- **C4 companion**: `docs/PROTOCOL_AUTHORITY_OPERATIONS.md`
  (commit `7cb4415`) — required reading for §1 and §2.
- **Spec**: `docs/PRE_MAINNET_ROADMAP.md` §4 C2.
- **Deploy gates**: `docs/adr/ADR-080-mainnet-deploy-safety-mandates.md`
  §1 (pre-flight gates), §2 (audit-hash file), §3 (`MULTISIG_ADDRESS`
  non-optional), §5 (deploy log).
- **CI gate on tag push**: `docs/adr/ADR-122-mainnet-readiness-ci-gate.md`.
- **Code-signing allowlist**: `docs/PRE_MAINNET_ROADMAP.md` §A5
  (`.github/allowed-signers`).
- **x402-relay AUD-209 saturation guard**:
  `src/x402-relay/index.ts:419-484` (`kind: "saturated"` branch + 503
  mapper); `src/x402-relay/index.ts:101-113` (why fail-CLOSED is
  correct).
- **x402-relay horizontal-scale forward reference**:
  `src/x402-relay/index.ts:89-91` (in-code pointer to ADR-117 /
  AUD-028 — note `docs/adr/ADR-117-x402-relay-error-redaction.md`
  is a different ADR; "ADR-117" here follows the roadmap §4 C6
  convention of referring to the in-flight horizontal-scale ADR).
- **Indexer schema**: `src/indexer/index.ts` `initDb()`.
- **Settlement `update_protocol_config`**:
  `programs/settlement/src/instructions/protocol_config.rs:57-122`.
