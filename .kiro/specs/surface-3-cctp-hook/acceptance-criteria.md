# Surface 3 — Acceptance Criteria

Final checklist for sign-off. The 5 master criteria are first; implicit criteria derived from the design follow.

*Source: [master spec §"Surface 3 — Acceptance criteria"](../../../docs/aep-reflex-tech-spec.md) plus design-implied items from this surface's [`spec.md`](./spec.md).*

---

## Master criteria (verbatim)

- [ ] **Hook path:** full Base → CCTP burn → Solana mint → Hook → `approve_milestone` → AEP Settlement state change in **≤ 30s**.
- [ ] **OR Relayer path:** Base x402 settle → Lambda detection → `approve_milestone` in **≤ 60s**.
- [ ] **Idempotent on retry** — verified by re-emitting the same Base tx hash; second call must fail (or no-op) atomically without double-approving.
- [ ] **Replay-protected** — verified with a malicious double-call attempt; replay PDA / DynamoDB guard rejects.
- [ ] **One demo-day rehearsal** with **$5 of real USDC** round-tripped successfully (mainnet rehearsal, not just devnet).

---

## Implicit criteria (derived from design)

### Hook program

- [ ] `programs/reflex-cctp-hook/` Anchor program scaffolded, compiles clean.
- [ ] Hook program **deployed to Solana devnet** with stable program ID committed to repo config.
- [ ] **IDL published** alongside existing program IDLs (consistent with `idl/` conventions in repo).
- [ ] Hook validates payload signer matches a registered agent's CDP wallet binding in AEP Registry (read-only Registry lookup).
- [ ] Hook calls AEP Settlement `approve_milestone` via **CPI** — no Settlement source modifications.
- [ ] **Idempotency PDA** seeded by `[b"hook-replay", escrow_pda, milestone_index, base_tx_hash]` rejects duplicates.
- [ ] Emits `MilestoneAutoApproved { escrow, milestone_index, base_tx_hash }` event on success.
- [ ] Anchor test suite passes including the integration test with simulated CCTP V2 attestation.
- [ ] Compiled binary stays in the **5–10 KB** range (per master design intent).

### Relayer fallback

- [ ] `services/reflex-relayer/` Lambda (or equivalent) deployed and watching Base.
- [ ] Filters x402 settle events by registered agent CDP wallet addresses.
- [ ] Calls `approve_milestone` directly with relayer signing key.
- [ ] Relayer signing key stored in **AgentCore Identity vault**, rotated per session — **never in git** (see R9).
- [ ] Idempotency enforced via DynamoDB conditional put (or equivalent) on `(escrow, milestone_index, base_tx_hash)`.
- [ ] Lambda retry behavior tested — no double-approve under retry storm.

### Decision rule (Day 7)

- [ ] Day 7 status check executed against both paths.
- [ ] Decision recorded (Hook vs. relayer for the demo flow) and shared with Surfaces 1 and 4.
- [ ] Whichever path is NOT chosen for the demo remains operational as a backup through Day 14.

### Observability

- [ ] Hook events flow into `app.agenomics.xyz` dashboard via Helius webhook.
- [ ] CCTP cross-links visible on **Solscan + Basescan** for any round-trip the demo executes.
- [ ] AgentCore Observability captures the `approve_milestone` CPI as the closing event for the corresponding session payment decision.

### Performance

- [ ] **CCTP round-trip (Base → Solana with Hook) ≤ 30s target**, ≤ 90s hard limit (master performance table).
- [ ] If hard limit breached at demo time, surface drops to fallback-mode and is cut from the live flow.

### Security & boundaries

- [ ] **No modifications** to `programs/agent-vault/`, `programs/agent-registry/`, or `programs/settlement/` source.
- [ ] Settlement is touched only via CPI to `approve_milestone`.
- [ ] CDP wallet ECDSA signatures and CCTP attestations are the only authentication anchors for the Hook (per master Auth boundaries table).
