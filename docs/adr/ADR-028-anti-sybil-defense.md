# ADR-028: Anti-Sybil Defense for Reputation Farming

## Status
Accepted

## Date
2026-04-15

## Context
An attacker with two keypairs can create and complete escrows between them to inflate reputation at minimal cost. The original protocol had no economic barriers: a 1-token escrow could generate the same reputation boost as a 1M-token escrow. This makes reputation scores unreliable for high-value task selection.

## Decision
Implement three anti-sybil mechanisms:

1. **Minimum escrow amount** (`MIN_ESCROW_AMOUNT = 10,000` base units): Escrows below this threshold are rejected. At USDC 6-decimal precision, this equals 0.01 USDC per task — making large-scale farming require measurable capital commitment.

2. **Self-dealing prohibition**: `create_escrow` now checks `client != provider`. Prevents the most trivial farming vector (same keypair on both sides).

3. **Reputation staking** (implemented in ADR-020): Agents must stake SOL to register, and slashing on disputes creates real economic consequence for fraudulent behavior.

These are economic defenses, not cryptographic ones — a determined attacker with two funded wallets can still slowly farm. But the cost is now non-trivial and the rate is limited by the minimum escrow amount and transaction fees.

## Alternatives Considered

### Alternative: Proof-of-unique-human (World ID, Civic)
Too restrictive — autonomous AI agents don't have human identities. The protocol is designed for agent-to-agent commerce.

### Alternative: Quadratic reputation scoring
Diminishing returns on reputation per task. More complex but could be added later as an enhancement.

## Consequences

### Positive
- Minimum escrow makes farming economically costly at scale
- Self-dealing check prevents trivial same-keypair attacks
- Combined with reputation staking (ADR-020), creates meaningful skin-in-the-game

### Negative
- Minimum escrow may exclude legitimate micro-tasks
- Two-wallet farming still possible (mitigated by economic cost, not eliminated)

## Files Changed
- `programs/settlement/src/lib.rs` — MIN_ESCROW_AMOUNT constant, self-dealing check, error variants
