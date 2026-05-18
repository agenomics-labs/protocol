# ADR-145: On-chain CCTP V2 attestation source for the Reflex Hook

## Status

Accepted (verification implemented; one Surface-4 IC-4 coordination item open — see Decision)

## Date

2026-05-18

## Context

The Reflex CCTP V2 Hook (`programs/cctp-hook`, Surface 3) exposes
`auto_approve_milestone`, which releases escrowed USDC back to an agent's
Vault after a Base→Solana CCTP V2 round-trip. Audit cycle-4 finding
**C4-OB-01 (CRITICAL)** established that this instruction performs **no
on-chain verification of the Circle CCTP V2 message, attestation, or
nonce**. The handler trusted attacker-influenceable wire data:

- `base_tx_hash` was only checked `!= [0u8; 32]` — any non-zero 32 bytes
  passed, so there was no binding to a real Circle burn/attestation.
- `payload.amount_returned_micros` was stored as authoritative in the
  `ReplayRecord` / `MilestoneAutoApproved` event without reconciliation
  against the escrow.
- `escrow_token_account` / `provider_token_account` were unconstrained
  `UncheckedAccount`s.
- The `payer` was an unconstrained `Signer` — any signer could drive a
  fund release.

The canonical Circle CCTP V2 Solana receiver program ID and whether the
Hook is invoked via CPI from it or via a separate dispatcher is still an
open question (Q-S3-B in
`.kiro/specs/surface-3-cctp-hook/open-questions.md`). Without that, there
is no on-chain anchor proving the USDC mint actually occurred and that
`base_tx_hash` + `amount_returned_micros` correspond to a genuine,
attested Circle message.

The C4-OB-01 hotfix PR (`fix/c4-ob-01-cctp-hook-guard`) applied immediate
risk-containment — defense-in-depth account constraints, raw-bytes amount
reconciliation, a dispatcher `address =` pin, the `TaskEscrow`
discriminator check (C4-OB-05), and a **hard, default-OFF deploy guard**
(`cctp_attestation_verified` feature) that makes the instruction
unreachable on any fund-bearing cluster. That hotfix is containment, not
the fix; the actual authenticity verification is the subject of this ADR.

## Decision

### Researched CCTP V2 Solana model (resolves Q-S3-B)

Read of `circlefin/solana-cctp-contracts` (`programs/v2/*`) plus Circle's
published CCTP Solana programs doc establishes definitively:

- **CCTP V2 on Solana has no generic post-mint hook dispatch.**
  `MessageTransmitterV2::receive_message`
  (`message-transmitter-v2/src/instructions/receive_message.rs`) CPIs
  *only* into the program named by `message.recipient()`. For a USDC
  burn that recipient is `TokenMessengerMinterV2` itself; its
  `handle_receive_finalized_message`
  (`token-messenger-minter-v2/src/token_messenger_v2/instructions/`)
  mints to the recipient ATA and returns. It **never reads or forwards
  the BurnMessage `hook_data` field** on Solana V2. So the Reflex Hook
  can *never* be CPI-invoked by CCTP — Q-S3-B's "invoked via CPI from
  the receiver" branch does not exist on Solana.
- The sound on-chain anchor is the **`used_nonce` PDA**.
  `receive_message` calls
  `message_transmitter.verify_attestation_signatures(message.hash(),
  attestation)` against Circle's on-chain attester set and *only then*
  `init`s a PDA at `find_program_address([b"used_nonce",
  message[12..44]], CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC)` with
  `UsedNonce { is_used: true }`. The PDA's existence + ownership +
  `is_used` is unforgeable, attestation-gated proof a Circle-signed
  message with that exact nonce was consumed on this cluster.
- Canonical IDs (mainnet == devnet): MessageTransmitterV2
  `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`, TokenMessengerMinterV2
  `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`. V2 message header:
  source_domain @4, dest_domain @8, nonce[12..44], body @148. BurnMessage
  body: `amount` is a 32-byte BE field at body offset 68, low 8 bytes at
  +24. Solana CCTP domain = 5; Base = 6.

### Decided design (implemented)

The Hook consumes the **CCTP V2 `used_nonce` PDA as a witness account**
plus the full CCTP V2 `message` bytes (new `ReflexHookPayload.cctp_message`
field — a coordinated IC-4 extension). In `auto_approve_milestone`, on a
`cctp_attestation_verified` build, `cctp::verify_message_and_amount`:

1. pins `cctp_message_transmitter` to MessageTransmitterV2's ID;
2. re-derives `[b"used_nonce", message[12..44]]` under that program and
   requires the supplied `cctp_used_nonce` address equals it;
3. requires `cctp_used_nonce` is **owned by MessageTransmitterV2**;
4. requires `UsedNonce.is_used == true`;
5. checks source==Base(6) / dest==Solana(5);
6. parses the BurnMessage `amount` and requires it equals
   `payload.amount_returned_micros`, which step 2 of the handler already
   reconciled `== escrow milestone amount`. Net: **escrow milestone ==
   payload == Circle-attested mint amount** — the C4-OB-01 fabricated
   payload exploit is defeated (a forged `base_tx_hash`/amount can no
   longer pass; there is no `used_nonce` PDA for a message Circle never
   attested).

All #172 defense-in-depth (b/c/d/e) is retained unchanged.

### Open coordination item (single human decision)

`base_tx_hash` is **not in the CCTP wire message** — CCTP identifies a
transfer by `(source_domain, nonce)`, never the Base L1 tx hash. This
ADR therefore *redefines* `base_tx_hash` as
`keccak256(source_domain_BE_u32 || nonce[32])` of the verified message
(implemented + tested as `cctp::expected_base_tx_binding`). The
verification is sound on-chain without Surface 4, **but** the Base-side
burn constructor (Surface 4) must compute the identical digest for the
relayer to produce an accepted payload. That is a coordinated IC-4
contract change requiring the Surface 4 owner's written sign-off (master
IC-4 freeze rule). **This is the one item needing a human call**: it
does not weaken the on-chain trust model (a wrong `base_tx_hash` simply
fails closed), but it gates the production round-trip wiring. Q-S3-A
(who writes the Registry CDP-wallet binding) remains an independent
pre-mainnet dependency, unchanged by this ADR.

### Deploy-guard disposition

The `cctp_attestation_verified` feature is **retained as the
gating switch**, not deleted: on a feature build the path now performs
*genuine* verification (the `CCTP_RECEIVER_AUTHORITY` system-program
sentinel is superseded by the real `used_nonce`/MessageTransmitterV2
binding); on the default build the CCTP witness accounts are
`cfg`-absent and the HARD DEPLOY GUARD still fails closed first. The
guard may now be safely enabled **on a `cctp_attestation_verified`
build** because verification is real and tested. A fund-bearing mainnet
deploy additionally requires the Surface-4 IC-4 sign-off above and
Q-S3-A; until both land the default-OFF guard on the production binary
stays OFF — now by *coordination* dependency, not by absence of
verification.

## Consequences

- **Positive**: Establishes a tracked, single owner for the CCTP
  authenticity gap; the deploy guard cannot be silently removed without
  pointing at a ratified decision here.
- **Negative**: Until this ADR is `Accepted` and implemented, the Hook's
  fund-release path is hard-disabled on fund-bearing clusters — the
  Reflex auto-approval round-trip is non-functional in production by
  design.
- **Follow-ups**:
  - Q-S3-B — **resolved** (no Solana CCTP V2 hook dispatch; `used_nonce`
    PDA is the anchor; see Decision).
  - `CCTP_RECEIVER_AUTHORITY` sentinel — **superseded** on the feature
    build by the `used_nonce`/MessageTransmitterV2 binding in
    `programs/cctp-hook/src/lib.rs` (retained on the default build only
    as a guard-era no-op).
  - **Surface 4 IC-4 sign-off** on the `base_tx_hash =
    keccak(source_domain‖nonce)` redefinition (the one open human
    decision) — required before the production round-trip is wired.
  - Q-S3-A (Registry CDP-wallet binding writer) — independent
    pre-mainnet dependency, unchanged.
  - Re-audit the Hook on the `cctp_attestation_verified` build and close
    C4-OB-01 once Surface 4 confirms IC-4.

## References

- Audit finding **C4-OB-01** (cycle-4, CRITICAL) — CCTP attestation
  bypass; **C4-OB-05** — `TaskEscrow` discriminator check.
- Hotfix PR: `fix(cctp-hook): C4-OB-01 — defense-in-depth + deploy guard`.
- **ADR-002** — Settlement escrow / milestone model.
- **ADR-007** — cross-program CPI trust boundaries.
- **ADR-074** — `seeds::program` explicitness for CPI authority PDAs.
- `.kiro/specs/surface-3-cctp-hook/open-questions.md` — Q-S3-B.
- `docs/aep-reflex-tech-spec.md` — Surface 3, IC-4 contract.
