# ADR-079: Operator key hygiene and KMS migration trigger

## Status
Proposed

## Date
2026-04-22

## Context

Operator-key hygiene across the protocol is uneven. Deep-Audit 2026-04-22 surfaced the concrete shape:

- **Signer 1** (`BUdXA1Fi…jTXL`, per STATUS §4, §8) is the operator's personal CLI wallet at `~/.config/solana/id.json`, single copy, no rotation plan. It simultaneously holds: (i) program upgrade authority on all three programs on both devnet and mainnet, (ii) member-1 slot on the Squads v4 2-of-3 devnet multisig, (iii) the deployer role for `mainnet-deploy.sh`, (iv) the ~22 SOL operational wallet balance.
- **Signers 2 and 3** are devnet-v1 throwaway keypairs at `.keys/squads-signer-2.json` and `.keys/squads-signer-3.json`, gitignored, with no backup policy. Audit 3 gap #10: "Signer-2/3 key-loss already happened once; devnet 'throwaway' policy hides the real problem."
- The `.keys/` directory is explicitly documented as "throwaway, losable." That policy **works for devnet today** only because the multisig has no authority. The moment it gains authority — even on devnet with real smoke-test funds — key-loss becomes an operational outage.
- No hardware-wallet path exists anywhere in the codebase or docs. No HSM, no KMS, no YubiKey.

Gaps from the audit:
- **Gap #10 (GOV-10)** — devnet throwaway policy hides the real problem; same policy crossing over to mainnet = re-learn the lesson with real funds.
- **Gap #11 (GOV-11)** — no recovery procedure for signer-1 on devnet; machine death = simultaneous loss of member-1 slot and current upgrade authority on all 3 programs.

The protocol cannot avoid having keys. The question is: **at what operational threshold does the key-custody policy change from `~/.config/solana/id.json` to hardware-or-KMS?**

This ADR is **DOCS-only**. No code changes; the backup/rotation actions it mandates happen in operational procedure, not in committed code.

## Decision

### 1. Bright-line trigger

**The day the multisig touches real upgrade authority is the day every signer key on that multisig moves to hardware or KMS.**

"Real upgrade authority" means any of the three production programs (`agent-registry`, `agent-vault`, `settlement`) on any cluster (devnet or mainnet) where the multisig is listed as the authority per `solana program show`. The trigger does **not** care about balance or TVL; authority alone is sufficient.

The rule is intentionally absolute: it has no threshold dollar value, no "after two weeks of stability" grace period, no "unless devnet." Hardware-or-KMS is the precondition for that on-chain state change, not a follow-up to it.

**Out of scope for the trigger**: SAS credential authority by itself. A multisig holding only SAS credential authority (not program upgrade authority) is required to follow §2 / §3 but is not subject to the bright-line rule — the blast radius of SAS authority is scoped to attestation validity, not protocol execution. In practice the two authorities are held by different multisigs per ADR-063 and Audit 3 gap #16, so the distinction is operational, not theoretical.

### 2. Signer-1 backup (cold storage, procedure)

Independent of §1's trigger — applies today, pre-multisig-authority — signer-1 must be backed up to cold storage because its single-copy state is itself an operational risk (Audit 3 gap #11 — GOV-11).

Procedure:

1. On the operator's primary machine, `solana-keygen recover` or direct export of the 64-byte secret from `~/.config/solana/id.json`.
2. On an air-gapped or offline machine (old laptop with network removed, disk wiped before each use), write the 64-byte secret to a single plain-text file.
3. Print the file via a USB-connected printer; no network path.
4. Stamp two copies on tamper-evident paper. Seal each in a separate tamper-evident bag labeled with date, purpose (`aep-operator-signer-1`), and pubkey (`BUdXA1Fi…jTXL`).
5. Distribute: one copy to the operator's primary physical custody (home safe or safety-deposit box); one copy to a secondary trusted custodian (named in `docs/governance/custody.md`, private-repo pointer acceptable).
6. Offline machine's disk wiped and powered off. Paper originals are the only persistent artifact.
7. Recovery test: in a scheduled annual drill, one of the two custodians unseals their copy, imports the key into an ephemeral Solana CLI config on an air-gapped machine, signs a dust-amount devnet transaction, verifies the transaction landed. Re-seal into a fresh bag. Record drill date in `docs/governance/custody.md`.

No digital copy exists outside the primary machine's `~/.config/solana/id.json`. No cloud backup, no password-manager entry, no encrypted-file-in-git. The paper+seal+two-custodian model is the entire backup story until §3 kicks in.

### 3. Devnet `.keys/` policy (explicit, documented losable)

The existing devnet `.keys/` policy — gitignored, no backup, documented as throwaway — is **preserved for devnet-only, multisig-has-no-authority state**. Concretely:

- `.keys/squads-signer-2.json` and `.keys/squads-signer-3.json` are generated once, funded with ~0.02 SOL each for rent, used only to approve ceremonies, and **expected to be lost** between sessions.
- When they are lost, the recovery procedure is "generate new keypairs, update the multisig's signer set via a 2-of-3 ceremony (member-1 + one surviving member or the founder-fallback path), commit the new pubkeys to `scripts/.squads-devnet.json`." This is already the pattern exercised once this session.
- **The `.keys/` policy is explicitly documented in `docs/SQUADS_DEVNET.md` as "losable — do not use for any multisig that holds authority."** That sentence is load-bearing; it is the only thing preventing the policy from silently crossing over to mainnet.
- On §1's trigger, the `.keys/` policy **does not carry over** to the newly-authoritative signers. Every multisig signer on an authority-holding multisig is on hardware/KMS at minimum per §4. The throwaway keypairs stay around only for non-authority ceremonies that may still run on devnet.

### 4. Mainnet signer requirements

At the §1 trigger, every signer on the authority-holding multisig meets all of:

- **Hardware-backed private-key material**: YubiKey 5 series (FIDO2 or PIV mode), Ledger Nano S Plus / X with the Solana app, or a KMS-provided key (AWS KMS with a Solana signer shim, GCP Cloud KMS equivalent, or HashiCorp Vault with the Solana transit engine). No raw keypair files on disk for authority-holding signers.
- **Attested custody**: the signer publishes a one-line attestation in `docs/governance/signers.md` naming their custody method (hardware make/model or KMS provider, not the specific device serial), the date of custody initiation, and a pubkey-possession Ed25519 signature over `"AEP-signer-custody:<pubkey>:<custody-method>:<YYYY-MM-DD>"`.
- **Recovery procedure**: each hardware signer has a recovery-seed backup using the hardware wallet's native recovery mechanism (BIP-39 seed phrase for Ledger; PIV rescue token for YubiKey with a separate PIV card), stored independently from the primary device, following the two-custodian paper-and-seal pattern in §2.
- **No shared devices**: one hardware device per signer. A signer holding multiple slots on the same multisig is forbidden (would collapse the threshold guarantee to the threshold of devices they control). A signer holding slots on different multisigs (e.g., `AEP_PROTOCOL` signer-1 and program-upgrade signer-1 being the same human with the same YubiKey) is forbidden by Audit 3 gap #16 at the multisig level; this ADR extends the rule to the device level.

**KMS permitted for at most two slots of any five-slot multisig.** KMS offers operational convenience (CI signing paths, programmatic rotation) but concentrates key material in one provider's control plane. Capping KMS at two slots preserves the Byzantine-fault-tolerance intent of the multisig threshold — a KMS compromise cannot cross the signing threshold by itself.

### 5. Rotation cadence

- **Hardware-backed signer keys**: rotated every 24 months or on key-compromise, whichever is sooner. Routine rotation runs the ADR-063 §4 procedure (14-day notice, possession proof, on-chain signer swap).
- **KMS-backed signer keys**: rotated every 12 months or on provider security event. KMS allows programmatic rotation; still runs the full ADR-063 §4 notice window for auditability.
- **Operator wallet (signer-1 equivalent on mainnet)**: rotated every 12 months or on operator change. The physical paper backups from §2 are re-generated during rotation; old backups destroyed and the destruction witnessed.
- **Devnet `.keys/` throwaways**: no cadence — lost and regenerated as they are, which is the whole point of the throwaway policy.

### 6. Compromise response

Triggered when a signer's hardware device, KMS credentials, or paper backup is believed lost, stolen, or coerced.

1. **T+0 to T+1h**: suspected-compromise signer notifies the rest of the multisig via the designated out-of-band channel (documented per-multisig in `docs/governance/signers.md`; acceptable channels are Signal or a pre-shared phone tree).
2. **T+1h to T+3h**: authority suspension proposal posted and executed per ADR-063 §3 emergency thresholds. The credential or program upgrade the compromised key gates is suspended until rotation completes.
3. **T+3h to T+24h**: emergency rotation per ADR-063 §3 threshold (simple majority + auditor co-sign). New signer pubkey comes from a freshly-provisioned hardware device; the old device is physically destroyed (shredded or incinerated) with the destruction witnessed by a second custodian and logged in `docs/governance/custody.md`.
4. **T+24h to T+7d**: retroactive audit per ADR-063 §6.1 — enumerate all on-chain signatures from the compromised pubkey in the preceding 180 days, flag any suspicious signings in the transparency log.
5. **T+7d**: resumption proposal posted per ADR-063 §3 resumption thresholds.

**Paper-backup-only compromise** (no hardware-device compromise): the paper is destroyed and re-generated from the live hardware device. No on-chain rotation unless the paper was known to leave the custody chain. If the custody chain is ambiguous, treat as full compromise.

## Alternatives Considered

### Alternative A: Hardware keys from day one (devnet too)
**Rejected for devnet-only signers.** Hardware wallets cost hundreds of dollars per slot and take days to ship; imposing them on devnet-only throwaway signers for a multisig that will be rotated or discarded at mainnet-ceremony time is pure friction. The §1 bright-line rule is the correct trigger — friction lands exactly when the value at stake justifies it.

### Alternative B: Password-managed encrypted keys (no hardware, no KMS)
**Rejected for authority-holding signers.** Password managers keep key material accessible to anything that can read the manager's decrypted state — a malware-compromised browser, a screen-sharing session, an abusive extension. Hardware or KMS forces the attacker onto a path that specifically targets the custody mechanism, not an incidental compromise of the operator's general computing environment.

### Alternative C: Single-slot KMS for convenience
**Rejected.** KMS at a single slot is fine per §4's two-slot cap. The rejection here is the proposal to make KMS the primary path for all signers — it would put all protocol signing in one provider's control plane and make a provider-level compromise catastrophic.

### Alternative D: Allow devnet throwaway policy to continue once multisig takes authority
**Rejected.** GOV-10 explicit: "the policy works for devnet only because the multisig has no authority." Authority-holding multisig + throwaway signers = guaranteed outage on first key loss. The §1 trigger is tight precisely because the failure mode is immediate.

### Alternative E: Trigger at mainnet-only, leave devnet-with-authority unchanged
**Rejected.** Devnet-with-authority is still real operational surface — smoke tests consume it, operators rehearse against it, live SOL funds flow through it at ceremony time. Losing a signer during a live rehearsal is the same class of outage as losing one on mainnet, just with different blast radius. The trigger is authority, not cluster.

### Alternative F: Delay §2 signer-1 backup to the same trigger as §1
**Rejected.** Signer-1 is already a production-relevant key *today* (current upgrade authority on all three programs on both clusters). Its single-copy state is the hot gap, not a future gap. The backup lands now regardless of when the multisig takes over.

## Consequences

### Positive
- **Bright-line rule is unambiguous.** "The day the multisig touches upgrade authority" is a discrete observable event, not a policy judgment call.
- **Closes GOV-10 and GOV-11 with one decision.** Signer-1 gets backup procedure today; multisig signers get hardware-or-KMS at the trigger.
- **Blast radius of a compromised signer bounded by hardware.** Even with a fully compromised host machine, authority-signing requires physical device interaction.
- **KMS cap preserves Byzantine-fault-tolerance intent.** Two-slots-max ensures no provider compromise can single-handedly cross a three-of-five threshold.
- **Recovery procedures rehearsed, not theoretical.** §2's annual drill and §4's recovery-seed pattern are load-bearing operational habits, not paper policy.

### Negative
- **Hardware cost.** Five hardware devices per multisig at ~$80-250 each = $400-1250 per multisig. Across the three multisigs implied by the full governance stack (program upgrade, `AEP_PROTOCOL`, `AEP_VALIDATORS`) — up to $3750 one-time, before routine rotation.
- **Coordination friction at ceremony time.** Hardware devices fail, batteries die, firmware updates break signing apps mid-ceremony. Operators need redundancy at signer-availability level, not just key-material level. This ADR does not solve that; it relies on ADR-063 §4's 14-day notice + possession-proof window to absorb the friction.
- **KMS adds a vendor dependency.** Up to two slots on any multisig can be KMS — that is a vendor relationship, subject to vendor outages, account suspensions, and compliance reviews. Operators choosing KMS accept the dependency.
- **Compromise response §6 requires witnessed device destruction.** That is a real logistical step — two humans, physical destruction, documented. Non-trivial at 2 AM when the compromise is first suspected.
- **§2's annual drill takes operator time.** One afternoon per year per critical key, across multiple custodians who must be physically co-present (or at least mutually-verifiable). This is a real ongoing cost.

### Neutral
- **No protocol code change.** Every rule in this ADR is an operational procedure; code does not enforce it, people do. This is correct for key custody (the code cannot enforce hardware-backed signing beyond "the signature verified" — it is the operators' responsibility to make signature-verification mean something about custody).
- **Compatible with future ADRs.** ADR-063's multisig composition, ADR-078's program-upgrade transfer procedure, and any future ADR about SAS authority delegation all compose with this ADR without conflict.
- **Devnet iteration stays cheap pre-trigger.** Until the multisig takes real upgrade authority, devnet development is unchanged from today.

## References
- `docs/adr/ADR-063-sas-credential-authority-governance.md` §3, §4, §6 — governance thresholds, rotation procedure, emergency response template
- `docs/adr/ADR-078-program-upgrade-authority-transfer.md` §5 — mainnet prerequisites checklist (this ADR is one of the items)
- `docs/adr/DEEP-AUDIT-2026-04-22.md` Audit 3 gaps #10, #11 — the two operator-key hygiene gaps this ADR closes
- `docs/STATUS.md` §4, §8 — current single-key signer-1 state, devnet throwaway signers 2/3
- `docs/SQUADS_DEVNET.md` — devnet operator runbook (to be updated with §3's load-bearing "losable" sentence)
- `docs/governance/custody.md` — (to be created) custody drill log, secondary-custodian roster, device-destruction record
- `docs/governance/signers.md` — (referenced by ADR-063 §7, to be created alongside ADR-063's acceptance) per-signer custody attestations per §4
