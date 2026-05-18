# ADR-078: Program upgrade-authority transfer procedure — devnet rehearsal, sealed rollback, per-program order

## Status
Proposed

## Date
2026-04-22

## Maintainer Decision Required

**Decision-ready — awaiting maintainer input on:** the real mainnet Squads V4 3-of-5 signer principals (per ADR-063 §1.1, distinct human set from the SAS credential authority per Audit-3 gap #16) and the two physical custodians of the §2 sealed rollback keypair.

**⚠️ This ADR is the mainnet gate.** It blocks SDK-F1 / AUD-207 mainnet program IDs: no mainnet IDs can be published until the three upgrade authorities have transferred off the single operator CLI key onto the multisig. It is the first ADR in this set that must be decided.

The recommended *mechanism* is fully specified: **Squads V4 multisig as upgrade authority** (not a hardware-wallet single key — alternative E rejected; Squads V4 natively provides member roles, time locks, and the executor/voter/initiator separation this needs), with a devnet throwaway-program rehearsal first (§1), a sealed two-custodian offline rollback key (§2), and a per-program Vault→Registry→Settlement staged transfer with 48h windows (§3). Single-ceremony transfer, reverse order, skip-rehearsal, no-rollback-key, and hardware-wallet variants are all enumerated and rejected in *Alternatives Considered*. The transfer order and window lengths are decided here (not open).

The single irreducible human inputs are **trust-custody decisions only**: which humans hold the 3-of-5 mainnet signing keys and which two custodians hold the sealed rollback key. No protocol-economic parameter is open. The §5 mainnet-prerequisites checklist (audit engaged, `mainnet-deploy.sh` hardened, ADR-063 seated, rehearsal complete, rollback sealed-and-tested) gates promotion; Status stays **Proposed** until those land and the principals are chosen.

**Dependency ordering:** ADR-078 is the head of the governance chain — it requires ADR-063's multisig to be seated (slots populated) and gates ADR-077's T (mainnet launch day) and ADR-113's stage-1 program-upgrade transfer. Decide ADR-063's principals → ADR-078's custody → then 077/113 follow.

## Context

The three on-chain programs — `agent-registry`, `agent-vault`, `settlement` — currently have a **single-key upgrade authority** on both devnet and mainnet (`BUdXA1Fi…jTXL`, the operator's personal CLI wallet per `docs/STATUS.md §3, §8`). The Squads v4 2-of-3 devnet multisig (`6QUUP78…` per STATUS §4) exists but holds no real authority — it has executed two SAS-credential ceremonies (credential create, schema create) and never a `set-upgrade-authority`-class instruction.

Deep-Audit 2026-04-22 (Audit 3) flagged this across three interlocking gaps:

- **Gap #1 (GOV-1)** — single-key upgrade auth on all three programs. Key loss or compromise = total protocol capture.
- **Gap #6 (GOV-6)** — no multisig-signed program-upgrade rehearsal on devnet. First-time-ever exercise of that path on mainnet with real funds is the same class of failure that cost signers 2/3 this session.
- **Gap #4 (GOV-4)** — `mainnet-deploy.sh` safety gates are partly theatre: `MULTISIG_ADDRESS` unset triggers a skip-prompt, `AUDIT_REPORT_HASHES` comparison is not enforced, multisig-PDA-live-on-mainnet is not asserted.

Related context:
- Three programs have interdependencies: Registry is called by Settlement via CPI (reputation writes); Settlement calls Vault via CPI (transfer drains during dispute resolution); Vault is standalone. A bad upgrade on any one breaks the chain differently.
- Rollback today is "redeploy from pre-deploy commit SHA" — but no deployment log file is actually written (Audit 3 gap #15), so the SHA + binary-hash pair to rebuild from must be captured during the transfer ceremony itself.
- ADR-031 (mainnet deployment) and ADR-036 (external audit) set the policy scaffolding but do not script the transfer itself.

This ADR is **DOCS + procedure** — no program code changes. Hardening `mainnet-deploy.sh` per §5 is scoped as a follow-up PR; a script-only change, no protocol logic.

## Decision

### 1. Devnet rehearsal first — throwaway program

Before any transfer on the three production programs (devnet or mainnet), a **throwaway devnet program** is deployed specifically to rehearse the multisig-signed upgrade path end-to-end.

Procedure:

1. Build a trivial `rehearsal-program` (empty `lib.rs` with one `no_op` instruction; lives outside `programs/` in an ephemeral branch).
2. Deploy to devnet with single-key upgrade auth `BUdXA1Fi…`.
3. Run `solana program set-upgrade-authority <rehearsal-program-id> --new-upgrade-authority <squads-vault-pda>` signed by the current single key.
4. Verify `solana program show` now reports the Squads vault PDA as upgrade authority.
5. Build a no-op patch to the rehearsal program (change version string, recompile).
6. Construct a `write-buffer + deploy` transaction that upgrades the rehearsal program. Wrap it in a Squads vault transaction per the same flow `bootstrap-sas-credential-devnet.ts` uses.
7. Propose → approve (2-of-3) → execute.
8. Confirm the rehearsal program's binary hash matches the new build.
9. **Signer 2 must be a different human on a different machine** (closes Audit 3 gap #7 — GOV-7). Local-operator-only rehearsal does not clear this gate.

Rehearsal outcomes are committed to `docs/governance/upgrade-rehearsal-2026-XX-XX.md`: transaction signatures, timing, friction notes, and a "go/no-go for production transfer" verdict.

### 2. Rollback keypair sealed offline before transfer

For each of the three production programs, before its authority transfer, a **rollback keypair** is generated offline and sealed:

1. On an air-gapped machine: `solana-keygen new --no-bip39-passphrase -o <program>-rollback.json`.
2. The rollback pubkey is **not** added to the Squads multisig; it stays external. Its sole role: if the multisig becomes inoperable (at-or-above-threshold signer loss — ADR-063 §6.2 analog for program upgrade), `solana program set-upgrade-authority` can be signed by the rollback key to restore a known-good binary.
3. The rollback keypair is printed on paper, sealed in tamper-evident bags, and distributed to **two** separate physical custodians (not the same person who holds the operator wallet). No digital copy exists after sealing.
4. The rollback pubkey is published in `docs/governance/program-rollback.md` alongside the program ID and the pre-transfer binary hash.
5. **Pre-condition to (3)**: confirm on devnet via a dedicated rehearsal (extension of §1) that the rollback key can actually re-take authority from the multisig. Specifically: multisig transfers to rollback pubkey (3-signer ceremony), rollback key upgrades the program (single-key signature), verify. This closes "sealed rollback that was never tested" as an operational gap.

The rollback key is a **one-shot recovery mechanism**. Its use is itself a declared emergency (ADR-063 §6.2 process) and triggers a post-incident re-ceremony to generate a new rollback key and re-seal.

### 3. Per-program transfer order

Order: **Vault → Registry → Settlement.**

Rationale:

- **Vault first.** Vault is standalone (no inbound CPIs from the other two programs); a broken Vault upgrade only affects agents interacting with Vault directly, not the Registry→Settlement reputation chain. It is the narrowest blast radius.
- **Registry second.** Registry is called by Settlement via CPI. Upgrading Registry after Vault means the Settlement→Registry CPI is the last thing exercised, so if the Registry upgrade breaks `update_reputation`'s account layout, the failure surfaces in Settlement tests before Settlement itself is transferred.
- **Settlement last.** Settlement calls both Registry (reputation) and Vault (transfer). Upgrading it last means the caller of every CPI boundary is the most recently upgraded program — the call graph's entry points are newest, not oldest. Historically, CPI breaks tend to be caller-side issues (discriminator mismatch, account list length drift) more often than callee-side, so upgrading the common callee first (Registry) and the common caller last (Settlement) maximizes the surface area tested by the interim state.

**Between each transfer**: minimum 48-hour observation window on mainnet. Smoke-test suite runs against each program individually. If any of the three fails, the transfer sequence pauses, the rollback key does **not** come out of seal (rollback is for catastrophic multisig loss, not for a CPI bug — for a bug, the multisig itself signs the repair deploy). Governance proposal is posted; next program's transfer awaits explicit unblock.

**Explicitly rejected**: Settlement → Registry → Vault (reverse order). The justification above is: Settlement is the most-integrated program; transferring it first means the upgrade path that depends on the most callee contracts is exercised when the fewest callee contracts have been transferred. The asymmetry favors late-transferring the most-integrated program.

### 4. Post-transfer verification checklist

Per-program, after each transfer, all items must be true before the 48-hour clock starts:

1. `solana program show <program-id>` reports the Squads multisig vault PDA as upgrade authority.
2. `solana program show <program-id>` reports no pending writable buffers.
3. Binary hash of the currently-deployed `.so` matches the hash committed to `docs/governance/program-rollback.md` (the pre-transfer hash — the transfer itself does **not** deploy a new binary, only changes the authority field).
4. `mcp-server` smoke test against mainnet passes end-to-end for instructions routed through that program.
5. Devnet parity: the same program on devnet is **also** multisig-owned (order: devnet-then-mainnet per program, not mainnet-then-devnet; devnet is rehearsal for the mainnet ceremony, never trails behind it).
6. Transparency-log entry published (ADR-063 §7 publisher — blocks on Audit 3 gap #9 shipping first). Entry records program ID, old authority, new authority, transaction signature, binary hash, timestamp.

### 5. Mainnet prerequisites checklist

All must be true before the mainnet ceremony opens. Each is a separate blocker; none is optional.

- [ ] **External audit engaged** per ADR-036 (Audit 3 gap #3 — GOV-3). Audit vendor selected, contract signed, `docs/AUDIT_SCOPE.md` actually submitted, audit in progress or complete.
- [ ] **`mainnet-deploy.sh` hardened** per §6 of this ADR (closes Audit 3 gap #4 — GOV-4). Required `MULTISIG_ADDRESS`, enforced `AUDIT_REPORT_HASHES` comparison, asserted multisig-PDA-live check.
- [ ] **ADR-063 Accepted** with slots 4-5 populated and `docs/governance/signers.md` live (Audit 3 gap #2 — GOV-2).
- [ ] **Devnet rehearsal §1 complete** with a second human on signer 2 (GOV-7).
- [ ] **Rollback key §2 sealed and witnessed**, with the rollback-re-takes-authority devnet test passing.
- [ ] **Transparency-log publisher live** (Audit 3 gap #9). Hourly writes to `governance/attestation-log/YYYY-MM/`; zero publication gap > 6h for the preceding 14 days.
- [ ] **ADR-063 §6.1 emergency runbook scripted** (`scripts/emergency-suspend-credential.ts` and a program-emergency-rollback analog). Rehearsed on devnet in the preceding 30 days (Audit 3 gap #8).
- [ ] **Operator key hygiene per ADR-079** — the day multisig touches upgrade authority is the day the operator key moves to hardware/KMS. No overlap.
- [ ] **Signer 2/3 of the multisig are real mainnet signers** per ADR-063 §1.1, not the devnet throwaways.
- [ ] **Cross-multisig non-overlap asserted** (Audit 3 gap #16). Program-upgrade multisig signer set ≠ SAS credential-authority signer set (structurally guaranteed, not merely by convention).

### 6. `mainnet-deploy.sh` hardening (follow-up PR, not this ADR)

This ADR mandates — but does not itself ship — the following changes to `scripts/mainnet-deploy.sh`:

- `MULTISIG_ADDRESS` environment variable **required**; remove the skip-prompt entirely.
- `AUDIT_REPORT_HASHES` file path required; script fails if the committed hash file is missing or if any built `.so` hash mismatches.
- Assert multisig PDA is live on mainnet (`solana account $MULTISIG_ADDRESS` returns data; owner is the Squads program ID) before any deploy step.
- `tee` pre-deploy binary hashes + current commit SHA + timestamp to `logs/mainnet-deploy-<timestamp>.log` automatically. Commit the log to the repo post-ceremony as `docs/governance/deploy-log-mainnet-<timestamp>.md`.

## Alternatives Considered

### Alternative A: Transfer all three programs in a single ceremony
**Rejected.** A single-ceremony transfer amortizes coordination overhead but collapses three independent blast-radius bets into one. If the Vault transfer breaks, the Registry and Settlement transfers are still in flight with no rollback opportunity. Staged transfer with 48h between lets operational reality surface before the next commitment.

### Alternative B: Transfer Settlement first (reverse order)
**Rejected.** See §3 rationale. Settlement is the most-integrated program; transferring it first means the program that depends on the most callee contracts is upgraded when the fewest callee contracts have been transferred. The surface area tested by the interim state is smaller than Vault-first.

### Alternative C: Skip devnet rehearsal (§1), go straight to mainnet
**Rejected.** GOV-6 explicitly: "first time ever exercising that path on mainnet with real funds is the same class of failure that cost us signers 2/3 this session." The throwaway rehearsal program costs ~0.5 SOL devnet rent and an afternoon; the alternative cost on mainnet is open-ended.

### Alternative D: No rollback keypair (trust the multisig fully)
**Rejected.** ADR-063 §6.2 already carves out the "at-or-above-threshold signer loss" scenario for SAS credential authorities; the same scenario applies to program upgrade authority and has worse consequences. A sealed, offline, two-custodian rollback key is the analog of §6.2 for program upgrades. The rollback key is never used in the normal course; its existence is insurance against the case the multisig itself cannot sign.

### Alternative E: Hardware wallet for upgrade authority instead of multisig
**Rejected.** A hardware-wallet-signed single key concentrates recovery risk on one physical device; hardware wallets fail, get lost, get destroyed. The multisig distributes authority across multiple signers and already exists on devnet. Hardware protection applies at the signer-key level (ADR-079), not at the authority level.

### Alternative F: Transfer devnet first as a live rehearsal (not a throwaway program)
**Rejected.** Devnet transfers of the real programs are fine and already implied by §4.5 — but they are not a substitute for the throwaway-program rehearsal. The throwaway program lets the rehearsal fail without consequence; the real devnet program's failure costs rent-recovery time and leaves public on-chain artifacts in a half-transferred state. Both rehearsals happen; the throwaway one is cheaper to fail and runs first.

## Consequences

### Positive
- **Blast radius bounded.** Vault-first means the narrowest-impact transfer is the one that surfaces any procedural bug.
- **Rollback path is real, not theoretical.** §2's sealed-and-tested rollback closes ADR-063 §6.2's analog for program upgrades.
- **Rehearsal is cheap.** §1's throwaway program costs ~0.5 SOL and an afternoon; it closes GOV-6 and GOV-7 simultaneously.
- **`mainnet-deploy.sh` hardening is mechanical once §5 lands.** No policy debate, just script edits.
- **Per-program 48h windows give operational reality time to surface bugs.** Three transfers over ~7 calendar days is slower than a single-shot but fail-forward-safe.

### Negative
- **Long wall-clock.** Devnet rehearsal (2-3 days including second-human coordination) + three staged mainnet transfers (7 days minimum for 48h windows + pre-transfer binary verification) + pre-conditions (§5) means 3-4 weeks from "ready to start" to "all three transferred" in the best case.
- **Coordination overhead is real.** §1 requires a second human on signer 2; §2 requires two physical custodians; §3 requires mainnet availability across 7 days. Single-operator mode cannot complete this ADR.
- **Rollback key is a separate key to not lose.** It is sealed and unused, but its existence adds a secret-material slot to operational hygiene. ADR-079 documents the custody expectations.

### Neutral
- **Does not change program code.** Upgrade authority transfer is purely an on-chain account-field update; the programs themselves are unchanged.
- **ADR-063 multisig infrastructure is reused.** No new multisig is stood up for this ADR; the existing devnet 2-of-3 (during rehearsal) and the future mainnet 3-of-5 (for the real transfer) cover both SAS credential governance and program upgrade governance — per Audit 3 gap #16's expectation that the signer sets are *different humans* across the two roles even though the multisig *type* is identical.

## References
- `docs/adr/ADR-031-mainnet-deployment.md` — mainnet deployment scaffolding
- `docs/adr/ADR-036-external-audit.md` — audit gate; prerequisite §5.a
- `docs/adr/ADR-063-sas-credential-authority-governance.md` — multisig composition model, §6 emergency procedures (template for the rollback-key doctrine)
- `docs/adr/ADR-079-operator-key-hygiene.md` — operator-key / KMS migration triggered by this ADR
- `docs/adr/DEEP-AUDIT-2026-04-22.md` Audit 3 gaps #1, #4, #6, #7, #8, #9, #16 — governance preconditions
- `scripts/mainnet-deploy.sh` — target of §6's hardening follow-up
- `docs/STATUS.md` §3, §4 — current single-key authority state + devnet multisig PDA
- `docs/SQUADS_DEVNET.md` — devnet operator runbook (also targeted for §1's "common failure modes" section per Audit 3 gap #13)

## Concrete Proposal (decision-ready — maintainer fills bracketed blanks)

> **Status note:** Non-normative until accepted. Does **not** change Status
> (stays **Proposed**) and does not alter any canonical section above. It
> mirrors the `## Maintainer Decision Required` precedent from PR #186 and
> is appended after `## References` so the ADR-lint section-order check
> (Status → Date → Context → Decision → Consequences) never backtracks on
> `## Decision`. Cross-reads with **ADR-063 §Concrete Proposal** (the 3-of-5
> seats this ceremony consumes — they MUST exist first), **ADR-079**
> (Accepted — every signer below is bound by its §1 bright-line
> hardware/KMS trigger and §4 custody rules), and **SDK-F1 / AUD-207**
> (cycle-4: mainnet program IDs stay placeholders until this transfer
> completes — this ADR is the gate that unblocks publishing real IDs).

### CP-1. Recommended option (maintainer confirms)

**Squads V4 quorum holds the upgrade authority**, architected so a
**timelock + guardian-pause can layer on before material TVL** without a
re-ceremony. Mechanics confirmed by research:

- `solana program set-upgrade-authority <program-id> --new-upgrade-authority <squads-vault-pda> --skip-new-upgrade-authority-signer-check` — the `--skip-*` flag is **required** because the Squads vault PDA cannot itself sign the set-authority transaction. The *current* single key signs the transfer; thereafter every upgrade is a Squads proposal→approve(threshold)→execute against `BPFLoaderUpgradeable`.
- Squads V4 exposes a per-multisig **`time_lock`** config field (seconds): set it to **0 at bootstrap** (no TVL yet — operational agility during the §1 rehearsal and §3 staged transfers), then raise it to **48–72h** via a Squads config transaction *before material TVL* — no authority re-transfer needed. Industry norm for high-value upgradeable systems is a 48–72h delay (Compound-class precedent); guardian-pause sits *outside* the timelock so emergencies are not delayed.
- **Guardian-pause** layers on as a low-threshold Squads spending-limit/role-scoped fast path (or the existing ADR-063 §6 / ADR-081 emergency-suspend rail) that can halt without waiting out the timelock — recommended target, not bootstrapped on day 1.

### CP-2. Sealed two-custodian rollback (custodians DISTINCT from upgrade signers)

Per §2: one offline-generated rollback keypair **per program**, printed,
sealed in tamper-evident bags, split across **two physical custodians who
are NOT any of the 3-of-5 upgrade signers and NOT the operator wallet
holder**. The rollback pubkey is external to the multisig; its only role is
re-taking authority if the multisig is inoperable (at-or-above-threshold
loss — ADR-063 §6.2 analog). Its use is a declared emergency and triggers
a re-seal ceremony. **Irreversibility warning:** `set-upgrade-authority`
performs **zero validation** — a fat-fingered or malicious new authority is
**unrecoverable** (authority set to a wrong/None pubkey permanently bricks
upgradability). Every address in CP-4 is therefore verified by two humans
reading it aloud against the sealed record before broadcast.

### CP-3. Ceremony checklist (TEMPLATE — bracketed values are NOT runnable)

Order: **Vault → Registry → Settlement** (§3). Dependency gate: ADR-063
3-of-5 seats seated (CP-1/CP-5 there) **and** ADR-079 §1 trigger satisfied
(all signers on hardware/KMS) **before step 1**.

1. **Air-gapped keygen** (rollback, per program): `solana-keygen new --no-bip39-passphrase -o [program]-rollback.json` on a wiped offline machine; print; seal; split to `[rollback custodian A]` / `[rollback custodian B]`; wipe disk.
2. **Witnesses present**: the 5 `AEP_PROTOCOL`/upgrade prospective signers + ≥1 named external researcher; record roster + timestamps.
3. **Devnet dry-run** (throwaway program, §1) then **devnet real-program** transfer (§4.5) — second human on signer 2 (closes GOV-7); rollback-re-takes-authority devnet test passes (§2.5).
4. **Mainnet transfer (per program, repeat ×3 in order)** — TEMPLATE:
   ```
   # Pre: verify [squads-vault-pda] aloud against sealed record (two humans)
   solana program show [program-id]                       # confirm current authority = [operator-key]
   solana program set-upgrade-authority [program-id] \
     --new-upgrade-authority [squads-vault-pda] \
     --skip-new-upgrade-authority-signer-check \
     --keypair [operator-key]                              # current authority signs
   solana program show [program-id]                       # confirm authority == [squads-vault-pda]
   ```
5. **Post-transfer verification** (§4): authority==vault PDA; no pending buffers; deployed `.so` hash == pre-transfer hash in `program-rollback.md`; mcp-server mainnet smoke green; devnet parity; transparency-log entry published.
6. **48h observation window** before the next program. On failure: pause sequence, post governance proposal, rollback key **stays sealed** (a CPI bug is repaired by the multisig signing a fix-deploy, NOT by the rollback key).

### CP-4. Rollback runbook (catastrophic multisig loss ONLY)

1. Declare ADR-063 §6.2 emergency; confirm multisig is genuinely inoperable (≥threshold signer loss), not merely a bad upgrade.
2. Both custodians convene; unseal `[program]-rollback.json`; verify pubkey == published `docs/governance/program-rollback.md` value.
3. On air-gapped machine: `solana program set-upgrade-authority [program-id] --new-upgrade-authority [known-good-recovery-authority] --keypair [program]-rollback.json` then redeploy the pre-incident binary (SHA + hash from the deploy log).
4. Verify deployed `.so` hash == sealed pre-transfer hash. Re-key: generate a fresh rollback keypair, re-seal, re-split to two custodians; document in `custody.md`.

### CP-5. Alternatives table (with irreversibility warning)

| Option | Verdict | Why |
|---|---|---|
| Single hardware-wallet key | **Reject** | One device = total-capture / total-loss risk; concentrates the irreversible `set-upgrade-authority` on one fallible device (alt E). |
| Burn upgrade authority (set to None) | **Premature — reject now** | With cycle-4 CRITICALs (SDK-F1/AUD-207) still open, immutability locks in unaudited bugs **permanently** — `set-upgrade-authority None` is irreversible. Revisit only post-audit-clean + post-stability. |
| Squads V4 quorum, timelock 0 now → 48–72h before TVL + guardian-pause | **Recommended target** | Distributes authority, agile during transfer, hardens before value is at risk, emergency path not delayed by timelock. |

⚠️ **Irreversibility warning (applies to all rows):** `set-upgrade-authority`
is unvalidated and one-way. A wrong new authority or a premature burn is
**not recoverable**. This is why the rollback key (CP-2) is sealed, the
addresses are double-verified (CP-3 step 4), and burn is deferred.

### CP-6. The bracketed blanks the maintainer must fill

- `[3-of-5 mainnet principals]` — the five upgrade-authority signer pubkeys + custody attestations (sourced from ADR-063 §Concrete Proposal CP-4; **distinct human set** from the SAS credential authority per Audit-3 gap #16)
- `[2 rollback custodians]` — custodian A + custodian B identities (NOT any upgrade signer, NOT the operator wallet holder)
- `[timelock duration confirm]` — confirm the pre-TVL target (recommended 48–72h) and the trigger event ("before material TVL"); confirm guardian-pause is exempt from it

### CP-7. Decide-first ordering

ADR-078 is the head of the chain but its inputs are *downstream* of
ADR-063: **decide ADR-063's independent auditor seat → the rest of the
3-of-5 → then ADR-078's 2 rollback custodians + timelock confirm → then
ADR-077/ADR-113 follow.** ADR-078 cannot open its §5 checklist until the
ADR-063 seats exist (§5: "ADR-063 Accepted with slots populated") and
ADR-079 §1 trigger is satisfied.

**Decision reduces to: 3 bracketed inputs — the 3-of-5 mainnet principals
(inherited from ADR-063), the 2 rollback custodians, and the timelock
duration confirm.**
