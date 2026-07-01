# Key management

Where every operational keypair lives, how it's tiered, and how it gets
backed up. Written after the 2026-07-01 incident where the devnet
deployer keypair, one Squads signer, and the self-hosted CI runner
fleet were all lost simultaneously because everything lived,
unbacked-up, on a single dev host.

This is the third time a devnet key has been lost with no recovery
path (see `docs/runbooks/SETTLEMENT_DEVNET_AUTHORITY_RECOVERY.md` for
the second, and the "Abandoned prior PDA" note in
`docs/STATUS.md` §4 for the first). The pattern each time: a key
existed in exactly one unencrypted file, on exactly one machine, with
no backup and no second holder. This doc exists to stop the pattern,
not to add process for its own sake — keep additions here practical.

## Inventory

| Key | Current holder(s) | Tier | Backup |
|---|---|---|---|
| Devnet deployer / program upgrade authority (`~/.config/solana/id.json`) | Primary dev host only | Devnet, recoverable via redeploy | Encrypted copy delivered to operator 2026-07-01 |
| Squads devnet signer 1 | = deployer above | Devnet | Same as above |
| Squads devnet signer 2/3 (`.keys/squads-signer-{2,3}.json`) | Primary dev host only | Devnet | Encrypted copy delivered to operator 2026-07-01 — **still both live on this one host; move at least one to a second holder before treating the 2-of-3 threshold as real protection** |
| Settlement `ProtocolConfig.authority` | Lost; see recovery runbook | Devnet | N/A — recover-or-redeploy per runbook |
| `NPM_TOKEN`, other CI secrets | GitHub Actions repo secrets | N/A | Already correct pattern — encrypted at rest, scoped to CI, never touches a laptop |
| Future mainnet upgrade authority | Not yet created | Mainnet | Must be a hardware wallet (Ledger) seat in the multisig, never a hot file — see ADR-063 §1.1 |

## Tiering policy

**Devnet / no real value.** A local keypair file is fine to *use*, but
losing it should never be a crisis — it should cost "run the redeploy
script and update ~6 docs," not "the protocol is stuck." That only
holds if the redeploy path is actually documented and rehearsed (it is
now, as of this incident — see `scripts/deploy-devnet.sh` and
`anchor keys sync`).

**Multisig signers, even on devnet.** A multisig only provides the
security property it claims — tolerating N-of-M loss — if the N+1th
copy isn't reachable by the same failure. Three signer keys generated
on the same laptop is a 1-of-1 with extra steps. Signers should be
distributed across genuinely separate holders (different machines,
different people, or at minimum different secret stores) before a
multisig is treated as providing real protection. `scripts/bootstrap-squads-devnet.ts`
currently generates signers 2 and 3 locally as a bootstrap
convenience — fine for getting a devnet multisig running fast, but
move at least one of those keys to a second holder before relying on
the 2-of-3 threshold for anything real.

**Mainnet / real value.** No hot keypair files. The program upgrade
authority must be a multisig (per ADR-063) with at least one hardware
wallet seat (`usb://ledger` — both the Solana CLI and Squads support
this natively). This is the point where "encrypted backup" stops
being sufficient on its own.

## Backup procedure (devnet-tier keys)

When a devnet key is worth preserving (i.e., you'd rather not redeploy
if it goes away), encrypt it and get the encrypted copy off the
primary host immediately — don't wait for "later":

```bash
# Generate a strong random passphrase (or use one you already know).
PASSPHRASE=$(openssl rand -base64 24)

# Symmetric-encrypt with AES256.
gpg --batch --yes --passphrase-file <(echo "$PASSPHRASE") \
  --symmetric --cipher-algo AES256 \
  -o keyname.json.gpg path/to/keyname.json

# Verify the round-trip before trusting the backup.
gpg --batch --yes --passphrase-file <(echo "$PASSPHRASE") \
  --decrypt keyname.json.gpg | diff - path/to/keyname.json && echo OK
```

Then get `keyname.json.gpg` and the passphrase to a durable location
**by two different paths** (e.g., the encrypted file to a cloud drive
or password-manager attachment, the passphrase into the password
manager's text field) so no single leak exposes both. Delete any
plaintext copies of the passphrase once it's stored.

This is a stopgap, not an endorsement of ad hoc encryption over a real
secrets manager — if a password-manager CLI (`op`, `bw`, `pass`) or a
cloud KMS becomes available on the primary host, prefer that over
manual `gpg`.

## Related

- `docs/adr/ADR-063-sas-credential-authority-governance.md` §1.1, §6 —
  mainnet multisig composition and compromise procedures for the
  (not-yet-bootstrapped) SAS credential authority. Governs a different
  multisig than the devnet Squads one referenced here, but the same
  distribution principle applies.
- `docs/runbooks/SETTLEMENT_DEVNET_AUTHORITY_RECOVERY.md` — recovery
  steps for the previous lost-key incident.
- `docs/runbooks/CI-runner-maintenance.md` — the self-hosted CI runner
  fleet lost in the same incident; unrelated to key material but same
  root cause (single host, no redundancy, no backup).
- `docs/STATUS.md` §4 — the first "abandoned prior PDA" incident.
