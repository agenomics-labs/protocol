# ProtocolConfig Authority — Operator Runbook

**Audience**: the person executing the multisig ceremony at 2am during the
launch window. SRE-level Solana familiarity assumed; deep protocol
knowledge **not** assumed.

**Status**: Authoritative. Pulled out of an inline Rust doc-comment so
operators can find it without reading program source. Source citation:
`programs/agent-registry/src/lib.rs:744-754` (commit `f77d244`).

**Read this before** the multisig signs `initialize_protocol_config`
on mainnet. Reading it after is too late — see "Failure modes" below.

---

## 1. The entanglement, in one paragraph

`ProtocolConfig.authority` is the on-chain pubkey that gates every
governance call (parameter updates, the invariant sweep, future
emergency switches). It is set **exactly once**, at the moment a signer
runs `initialize_protocol_config`. By design (audit AUD-005, PR-H), the
*only* keypair allowed to sign that call is the **upgrade authority of
the Settlement program**. Result: the moment the multisig signs
`initialize_protocol_config`, **the multisig becomes both the upgrade
authority and the protocol authority — the same key, doing two
different jobs.** There is no separate "protocol governance key" today.

---

## 2. Why it matters

The two roles look different on paper but are operationally a single
key until further notice:

| Action | Who must sign | Notes |
|--------|--------------|-------|
| Push new program bytecode (`solana program deploy`) | Upgrade authority | Standard BPF Loader flow |
| Call `update_protocol_config` (change protocol params) | `ProtocolConfig.authority` | Same key as upgrade authority post-init |
| Call `verify_protocol_invariants` (sweep up to 16 profiles) | `ProtocolConfig.authority` | Same key as upgrade authority post-init |
| Future: rotate the upgrade authority away | Upgrade authority | Affects only the bytecode-push role |
| Future: rotate the protocol authority away | `ProtocolConfig.authority` | Instruction does not exist yet — see §6 |

Coupling consequences the operator must internalize:

1. **Every governance call is a multisig ceremony.** If the upgrade
   authority is a 3-of-5 Squads multisig (per Pre-Mainnet Roadmap A2),
   then *every* `verify_protocol_invariants` invocation also needs
   3-of-5 approvals. There is no "lighter" governance key today.
2. **Rotating the upgrade authority does NOT rotate the protocol
   authority, and vice versa.** They share a key today, but they are
   two independent fields on two different account types. A
   `solana program set-upgrade-authority` call moves the bytecode-push
   role. It leaves `ProtocolConfig.authority` pointing at the old key.
   To move both, two separate transactions are required — and as of
   today, only the bytecode-push side has a built-in instruction (see §6).
3. **The init ceremony silently binds the protocol-authority role.**
   Whichever key signs `initialize_protocol_config` becomes the
   protocol authority for the lifetime of the deployment. There is no
   prompt, no confirmation banner, no "are you sure?" — the binding is
   implicit in who holds the upgrade-authority signature at that
   moment. **The deploy script will not warn you** if the wrong
   multisig is loaded.

---

## 3. Operator checklist — before the first invariant sweep

Run through this list **before** the first `verify_protocol_invariants`
call lands on mainnet. Most of it must be done **before**
`initialize_protocol_config` itself, because the bind is irreversible
without a future rotation instruction (§6).

### 3.1 Before signing `initialize_protocol_config`

- [ ] **The multisig that will sign `initialize_protocol_config` is
      the same multisig you intend to hold long-term governance
      power.** If you would not be comfortable handing this multisig
      the power to call `update_protocol_config`, **stop** — you are
      about to hand it that power for the lifetime of the deployment.
- [ ] **The multisig threshold is right for governance ops, not just
      bytecode pushes.** A 2-of-3 may be acceptable for "deploy a
      bug-fix"; it may be too low for "change the protocol-wide
      reputation cap." If those should have different thresholds,
      **stop** — no rotation instruction exists today, so picking the
      same threshold for both roles is a one-way door until §6 ships.
- [ ] **The multisig signer set is exactly the people you intend.**
      Verify member pubkeys against your records. A typo'd member
      address that happens to be valid base58 will become a permanent
      governance signer.
- [ ] **You have rehearsed the ceremony on devnet.** Per
      `docs/PRE_MAINNET_ROADMAP.md` §A2 step 4, the devnet rehearsal
      catches keyring, network, and Squads-UI surprises before they
      compound with the mainnet authority bind.
- [ ] **`scripts/mainnet-deploy.sh` pre-flight has been run with
      `--self-test` and `MULTISIG_ADDRESS` set to the real multisig
      PDA.** Per ADR-080 §1, gate #6 (`MULTISIG_ADDRESS` set + non-empty)
      and gate #8 (multisig PDA exists on the configured cluster) are
      the script's defense against a typo'd or unset multisig at
      authority-transfer time. They are **not** a defense against
      "wrong multisig signed `initialize_protocol_config`" — that one
      is on you.
- [ ] **The signer that will physically sign `initialize_protocol_config`
      is the multisig PDA, not the deployer keypair.** The deployer
      keypair is the upgrade authority *until* `set-upgrade-authority`
      transfers it to the multisig (per ADR-078). The order of
      operations matters: transfer upgrade authority to multisig
      **first**, then sign `initialize_protocol_config` from the
      multisig. If you sign `initialize_protocol_config` from the
      deployer keypair, the deployer keypair is the protocol authority
      forever.

### 3.2 After signing `initialize_protocol_config`, before the first sweep

- [ ] **Confirm `ProtocolConfig.authority` equals the multisig PDA.**
      Read the on-chain account directly:

      ```bash
      solana account <PROTOCOL_CONFIG_PDA>
      # Bytes [8..40) of the account data are the authority pubkey.
      # Decode and compare against your multisig PDA.
      ```

      A mismatch here means the wrong key signed `initialize_protocol_config`.
      See §4 "Failure modes" — the recovery path is narrow.
- [ ] **Confirm the upgrade authority of the Settlement program also
      equals the multisig PDA.**

      ```bash
      solana program show <SETTLEMENT_PROGRAM_ID>
      # "Authority:" line must match the multisig PDA.
      ```

      Same key in both roles is the **expected** post-init state. If
      these two lines disagree on mainnet, you have a worse problem
      than this runbook covers — page the on-call lead.
- [ ] **Dry-run a single-account `verify_protocol_invariants` call
      against a known-good profile.** The 16-account batch cap (per
      AUD-106) means a single-account call is cheap. Verifying that
      the multisig flow works end-to-end before running a full sweep
      saves a re-coordination if a signer's wallet is misconfigured.
- [ ] **The multisig signers all have working wallets, hardware-key
      access, and a tested `gh`/Squads UI flow.** A 3-of-5 that
      cannot reach 3 signatures within 24h is operationally a
      0-of-5.

---

## 4. Failure modes

What happens if the wrong key signed `initialize_protocol_config`?

| Failure | Recoverable? | Path |
|---------|-------------|------|
| **Deployer keypair (single key) signed `initialize_protocol_config` instead of the multisig.** Common cause: forgot to transfer upgrade authority to the multisig before running `initialize_protocol_config`. | **Recoverable, but only if the deployer keypair is still under your control AND the upgrade-authority transfer has not yet happened.** Re-deploy the program (which resets state on the new program ID), re-run the ceremony in the correct order. | If upgrade authority has already moved to the multisig, `ProtocolConfig.authority` is now the deployer key and the multisig holds bytecode-push but not governance. **No on-chain instruction can fix this today** — see §6. |
| **A typo'd multisig PDA signed `initialize_protocol_config`.** Common cause: pasted the wrong base58 string into Squads. | **Probably not recoverable.** The typo'd PDA is some other Squads multisig (or a no-op address); whoever controls it now controls protocol governance. Treat as a key-leak incident: page on-call, prepare to re-deploy the program at a new ID, communicate the cutover. | The script's gate #8 (per ADR-080 §1) catches a typo'd `MULTISIG_ADDRESS` *if* the address resolves to nothing on-chain. It does **not** catch a valid-but-wrong Squads PDA. |
| **The multisig threshold is too low for governance.** No mistake at signing time — just regret afterwards. | **Not recoverable until the rotation instruction (§6) ships.** The multisig members can still rotate the multisig threshold itself within Squads, which is usually enough — a 2-of-3 multisig can vote to become a 3-of-3, etc. The protocol-authority field still points at the same multisig PDA, so this works without an on-chain rotation. | Squads internal threshold change does not change the multisig PDA, so `ProtocolConfig.authority` is unchanged. This is the cleanest in-place fix. |
| **The multisig signer set has the wrong members.** Same — regret afterwards. | **Recoverable via Squads member rotation**, same as threshold above. The multisig PDA stays constant as long as you mutate within Squads rather than creating a new multisig. | If you create a *new* multisig (new PDA), you are back in row 1: no on-chain instruction moves `ProtocolConfig.authority` to the new PDA today (§6). |
| **You called `verify_protocol_invariants` from the wrong key and it reverted with `Unauthorized`.** | Trivially recoverable — the call reverts atomically, no state change. | Re-coordinate signatures from the actual `ProtocolConfig.authority`. |

**Single-line summary**: the only fully-recoverable failure mode is
`Unauthorized` on a sweep call (the call simply reverts). Every
*authority-bind* mistake at `initialize_protocol_config` is either
unrecoverable (re-deploy at a new program ID) or only recoverable
inside Squads (mutating membership/threshold without changing the PDA).

---

## 5. Why this runbook exists at all

The architectural design (audit AUD-005, decision recorded in
`docs/audits/DESIGN-DECISIONS-2026-04-25.md` §"AUD-005") chose to keep
`ProtocolConfig.authority` and the upgrade authority **formally
independent** — separate fields, separate accounts, separate intended
rotation paths. The cycle-2 audit (AUD-115) observed that the **post-init
operational state** has them as the same key, and will continue to until
a `rotate_protocol_config_authority` instruction ships. That gap
between architectural intent and operational reality is the entire
reason this runbook exists. Operators must treat the two roles as
**operationally one key** until §6 ships.

---

## 6. What does NOT exist today

Do not read about the future and assume it is current state:

- **`rotate_protocol_config_authority` instruction**: **does not
  exist** as of this runbook. The architectural design reserves the
  surface, but no code implements it. Until it ships, the protocol
  authority is what you bound it to at `initialize_protocol_config`,
  for the lifetime of the deployment. The launch-window deferral of
  this instruction is the authoritative decision in
  `docs/adr/ADR-125-rotate-protocol-config-authority.md` (Status:
  Accepted): Option δ (no rotation ix) for mainnet launch, Option β
  (2-step propose-then-accept) when the instruction eventually ships
  in the first post-launch governance cycle. ADR-125 is the
  authoritative deferral record; the operational guidance in this
  runbook is unchanged by the ADR.
- **A "lighter" governance key separate from the upgrade authority**:
  same — does not exist today.
- **Any in-script warning that the wrong multisig signed
  `initialize_protocol_config`**: `scripts/mainnet-deploy.sh` checks
  `MULTISIG_ADDRESS` shape and on-chain existence (per ADR-080 §1
  gates #6, #7, #8). It does **not** verify that the multisig at
  `MULTISIG_ADDRESS` is the multisig you intended. That check is on
  you, in §3.1.

---

## 7. References

- **Inline source-of-truth doc-comment**:
  `programs/agent-registry/src/lib.rs:744-754`. Commit `f77d244`
  ("docs(audits): AUD-115 + AUD-121 + AUD-122 inline architectural
  notes"). This runbook lifts that comment out where operators can
  find it.
- **Original architectural decision**:
  `docs/audits/DESIGN-DECISIONS-2026-04-25.md` §"AUD-005 — Permissionless
  governance front-run (PR-H)". Records the choice that
  `ProtocolConfig.authority` is independent post-init **by design**,
  even though the init ceremony binds them together in practice.
- **Cycle-2 finding**:
  `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-onchain.md` AUD-115 row
  (Closure-status section near the bottom) — operational note recording
  why "doc closure" is acceptable for cycle-2 and why the operator
  runbook follow-up (this file) was tracked separately.
- **Mainnet-deploy script gates**:
  `docs/adr/ADR-080-mainnet-deploy-safety-mandates.md` §1, gates #5
  (signed tag), #6 (`MULTISIG_ADDRESS` non-empty), #7 (base58 valid),
  #8 (multisig PDA exists on cluster). These are the hard gates the
  script enforces; this runbook covers the *soft* checks the script
  cannot enforce.
- **Multisig provisioning track**:
  `docs/PRE_MAINNET_ROADMAP.md` §A2 (Squads multisig for the upgrade
  authority). The devnet rehearsal in step 4 is the right place to
  exercise the §3.1 checks before mainnet.
- **Future rotation work**: `docs/adr/ADR-125-rotate-protocol-config-authority.md`
  (Status: Proposed). The ADR records the launch-window deferral
  decision (Option δ — no rotation ix shipped) on the basis that, post-A2,
  the upgrade authority IS the Squads multisig PDA, so Squads-internal
  membership/threshold mutation already covers normal-operation governance
  changes without changing the on-chain PDA. If rotation eventually ships,
  ADR-125 sketches Option β (2-step propose-then-accept) as the design.
