# ADR-145: On-chain CCTP V2 attestation source for the Reflex Hook

## Status

Proposed

## Date

2026-05-17

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

**TBD.** This ADR is a placeholder for the decision to pin the Hook's
trust anchor to a verifiable on-chain Circle CCTP V2 artifact — the
intended direction is to bind `base_tx_hash` and `amount_returned_micros`
to the Circle CCTP V2 `MessageTransmitter` receiver via a CPI-caller
check and/or an attestation/used-nonce account passed into the
instruction and validated on-chain (program-ID pin + nonce
double-spend/replay guard), replacing the `cctp_attestation_verified`
deploy guard and the sentinel `CCTP_RECEIVER_AUTHORITY` with real
verification. The concrete account model depends on resolving Q-S3-B
against current Circle CCTP V2 Solana documentation and is deliberately
left undecided here; this ADR stays `Proposed` until that design is
ratified and implemented.

## Consequences

- **Positive**: Establishes a tracked, single owner for the CCTP
  authenticity gap; the deploy guard cannot be silently removed without
  pointing at a ratified decision here.
- **Negative**: Until this ADR is `Accepted` and implemented, the Hook's
  fund-release path is hard-disabled on fund-bearing clusters — the
  Reflex auto-approval round-trip is non-functional in production by
  design.
- **Follow-ups**:
  - Resolve Q-S3-B (canonical CCTP V2 Solana receiver / dispatcher
    model) against current Circle docs.
  - Replace the `cctp_attestation_verified` feature gate and the
    `CCTP_RECEIVER_AUTHORITY` sentinel in `programs/cctp-hook/src/lib.rs`
    with the verified attestation binding.
  - Re-audit the Hook once attestation verification lands; close
    C4-OB-01.

## References

- Audit finding **C4-OB-01** (cycle-4, CRITICAL) — CCTP attestation
  bypass; **C4-OB-05** — `TaskEscrow` discriminator check.
- Hotfix PR: `fix(cctp-hook): C4-OB-01 — defense-in-depth + deploy guard`.
- **ADR-002** — Settlement escrow / milestone model.
- **ADR-007** — cross-program CPI trust boundaries.
- **ADR-074** — `seeds::program` explicitness for CPI authority PDAs.
- `.kiro/specs/surface-3-cctp-hook/open-questions.md` — Q-S3-B.
- `docs/aep-reflex-tech-spec.md` — Surface 3, IC-4 contract.
