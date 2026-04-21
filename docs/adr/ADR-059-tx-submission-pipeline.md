# ADR-059: Transaction submission pipeline — framework-kit adoption, replay protection, per-action preflight

## Status
Accepted

## Date
2026-04-21

## Context

AEAP tools build Solana transactions across Vault, Registry, and Settlement programs. Robust tx submission requires:

1. **Compute-budget sizing** from simulation (not guessing)
2. **Priority-fee estimation** that adapts to network congestion
3. **Blockhash refresh** on slot expiry (not silent poll)
4. **Replay protection** for idempotent settlement actions (prevents concurrent-verification races on milestone approval)
5. **Preflight gates** for time-sensitive submits (cluster health, account rent exemption)

Ecosystem findings:

- **`framework-kit`** (solana-foundation) ships all the helpers we planned to write: `LatestBlockhashCache` with TTL + auto-refetch, `ComputeBudgetInstruction` helpers (`getSetComputeUnitLimitInstruction`, `getSetComputeUnitPriceInstruction`), `TransactionPrepareRequest` shape with `authority: TransactionSigner | WalletSession`, `lifetime: BlockhashLifetime`, `version: 'auto'`.
- **`sendaifun/solana-agent-kit`** has a `sendTx` poll loop without blockhash refresh. This is a **known footgun**: the 90s blind poll silently fails on slot expiry.
- **`solana-mpp`** (sendaifun) ships **mutex-per-signature replay protection** — store-backed consumed-signature set + per-sig mutex lock. Exactly the pattern AEAP needs for settlement submits.
- **`solana-mcp-official`** is read-only and contributes no tx-pipeline patterns.

Companion analysis: `docs/SOLANA_ECOSYSTEM_ANALYSIS.md`, `docs/SENDAIFUN_ECOSYSTEM_ANALYSIS.md`.

## Decision

### 1. Adopt `framework-kit` blockhash cache + compute-budget helpers

Depend on `framework-kit` (or its lower-level `@solana-program/compute-budget` exports). In `mcp-server/src/solana.ts`:

- Import `LatestBlockhashCache` with configurable `blockhashMaxAgeMs` (default: 30s for settlement-critical paths, 120s otherwise)
- Import `getSetComputeUnitLimitInstruction` + `getSetComputeUnitPriceInstruction`; auto-prepend to every tx (respect caller overrides)
- Use `@solana/kit` primitives end-to-end (`createTransactionMessage`, `setTransactionMessageLifetimeUsingBlockhash`, `signTransactionMessageWithSigners`)

### 2. `getComputeBudgetInstructions(connection, tx, signer)` — simulate-then-size

```ts
async function getComputeBudgetInstructions(
    connection: Connection,
    tx: TransactionMessage,
    signer: SolanaSigner,
): Promise<ComputeBudgetInstructions> {
    const sim = await connection.simulateTransaction(tx, { sigVerify: false });
    const consumed = sim.unitsConsumed ?? 0;
    const limit = Math.max(consumed + 100_000, Math.ceil(consumed * 1.2), 200_000);
    const priority = await estimatePriorityFee(connection, writableAccounts(tx), 'mid');
    return {
        setComputeUnitLimit: getSetComputeUnitLimitInstruction({ units: limit }),
        setComputeUnitPrice: getSetComputeUnitPriceInstruction({ microLamports: priority }),
    };
}
```

Floor at 200k CU prevents anomalous simulation (0 CU consumed) from producing an under-provisioned tx.

### 3. `estimatePriorityFee(connection, writableAccounts, tier)` — Helius or percentile

```ts
async function estimatePriorityFee(
    connection: Connection,
    writableAccounts: Address[],
    tier: 'min' | 'mid' | 'max',
): Promise<bigint> {
    if (process.env.HELIUS_API_KEY) {
        return heliusPriorityFeeEstimate(writableAccounts, tier);   // Helius getPriorityFeeEstimate API
    }
    const samples = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: writableAccounts });
    const percentile = { min: 0.01, mid: 0.5, max: 0.95 }[tier];
    return percentileFee(samples, percentile);
}
```

### 4. `sendAndConfirmWithBlockhashExpiry` — fix agent-kit's footgun

```ts
async function sendAndConfirmWithBlockhashExpiry(
    tx: SignedTransaction,
    connection: Connection,
    opts: { maxRetries: number; commitment: Commitment; checkSlotLag?: boolean },
): Promise<Signature> {
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
            const confirmed = await confirmWithExpiry(connection, sig, tx.lifetime, opts.commitment);
            if (confirmed.ok) return sig;
            if (confirmed.reason === 'blockhash_expired') {
                tx = await refreshBlockhashAndResign(tx);
                continue;
            }
            throw new AeapError({ code: 'RPC_ERROR', message: confirmed.reason });
        } catch (e) {
            if (attempt === opts.maxRetries) throw e;
        }
    }
    throw new AeapError({ code: 'RPC_ERROR', message: 'max retries exceeded' });
}
```

Key differences from agent-kit's `sendTx`:
- Detects blockhash expiry (via `lastValidBlockHeight` check) and refreshes rather than silently timing out.
- Rebroadcasts on expiry instead of failing.
- Returns typed `AeapError` (per ADR-058 error shape) on exhaustion.

### 5. Mutex-per-key replay protection (port from `solana-mpp`, adapted)

Settlement-submit actions (`submit_milestone`, `approve_milestone`, `resolve_dispute`) must be idempotent against retry. Port the `solana-mpp` pattern, **keyed by explicit input-derived string rather than signature** (because PassthroughSigner is the default — see below):

- Storage: in-memory `Map<IdempotencyKey, Promise<Result>>` for single-instance deployments; Redis `SET <key> NX EX <ttl>` for multi-instance.
- Lifecycle: on request, acquire mutex for the key; if already held, await the in-flight Promise; if completed, return cached Result.
- TTL: 10 minutes post-finalization (longer than finality window).
- Gate: only applies to actions declaring `idempotent: true`.

```ts
interface Action<I, O> {
    // ...ADR-058 fields...
    idempotent?: boolean;
    idempotencyKey?: (input: I) => string;  // REQUIRED if idempotent: true (see keying rules below)
}
```

**Keying rules.** `PassthroughSigner` is the default (ADR-058 §5) — no signature exists at the MCP boundary, so signature-based keying is unavailable. Every idempotent action MUST declare an explicit `idempotencyKey` function derived purely from inputs:

| Action | Recommended key |
|---|---|
| `submit_milestone` | `${escrow_pda}:${milestone_index}:submit` |
| `approve_milestone` | `${escrow_pda}:${milestone_index}:approve` |
| `reject_milestone` | `${escrow_pda}:${milestone_index}:reject` |
| `resolve_dispute` | `${dispute_pda}:${resolution_code}` |
| `resolve_dispute_timeout` | `${dispute_pda}:timeout` |

Registration-time validation: if `idempotent: true` and `idempotencyKey` is unset, the server fails to boot. A signature-based fallback is explicitly **not** provided — requiring a real signer would force every deployment off the custody-free default, which is the wrong tradeoff for correctness of settlement submits.

### 6. Per-action preflight gates

Preflight is **opt-in per action**, not a global gate. The `PreflightGate` enum is defined canonically in **ADR-058 §2.1** — this ADR references it rather than redeclaring, so values cannot drift between the MCP action runtime and the manifest schema (ADR-060).

```ts
interface Action<I, O> {
    // ...
    preflight?: PreflightGate[];   // canonical type in ADR-058 §2.1
}
```

Examples:
- `submit_milestone`: `['cluster_health', 'account_rent_exempt']`
- `reconfigureVault` (async): no preflight
- `resolve_dispute`: `['dispute_window_open']`

Adding a new gate requires updating ADR-058 §2.1 first; this ADR and ADR-060 inherit the change.

### 7. Migration scope

- `mcp-server/src/solana.ts`: add helpers in §2–§5.
- `mcp-server/src/handlers/{settlement,vault}.ts`: add `idempotent: true` + `preflight: [...]` to state-mutating actions.
- Replace any legacy `@solana/web3.js` v1 paths with `@solana/kit` (deferred to a separate migration PR per ADR-012/033; do not block on this ADR).

## Alternatives Considered

### Alternative A: Write our own blockhash cache + compute-budget helpers
Rejected. `framework-kit` ships them, maintained by the Foundation, on `@solana/kit`. Writing our own duplicates work and diverges from the ecosystem.

### Alternative B: Global preflight gate (every action checks cluster health)
Rejected. Correct for time-sensitive settlement submit; wrong for async vault reconfig. Per-action opt-in is more precise.

### Alternative C: No replay protection, rely on Solana blockhash uniqueness
Rejected. Two concurrent MCP calls with the same settlement signature (retry, duplicate client) can both enter the verification path and race. Mutex-per-sig forces serialization. Solana's blockhash protects against double-inclusion but not against duplicate server-side verification work or dispute-timing races.

### Alternative D: Use `solana-mpp` directly as a dependency for replay protection
Rejected for now. `solana-mpp` is sendaifun's library and is coupled to their HTTP-402 payment flow. Porting the mutex-per-sig pattern (≈50 LoC) is cleaner than importing the dep. Revisit if ADR-062 (MPP canonical conformance) decides AEAP speaks MPP wire format.

### Alternative E: Redis-only mutex (no in-memory fast path)
Rejected for single-instance deployments — Redis adds a mandatory dep. In-memory for single-instance, Redis for multi-instance, determined by config.

### Alternative F: Adopt `kora` as the relayer instead of building our own pipeline
Rejected for this ADR. `kora` solves a different problem (gasless fee-paying relayer). The AEAP pipeline described here is for AEAP's own tool handlers building and submitting txs. A future ADR may add kora-style relayer integration for gasless agent UX, but that is orthogonal to this pipeline.

## Consequences

### Positive
- **~50% scope collapse** vs. building helpers from scratch.
- Closes the known agent-kit slot-expiry footgun.
- Mutex-per-sig prevents the concurrent-verification race on settlement submits.
- Per-action preflight gives the right granularity (opt-in).
- Framework-kit helpers are on `@solana/kit`, aligning AEAP with the Foundation roadmap.

### Negative
- Redis dep for multi-instance replay protection (or accepts single-instance limitation).
- Framework-kit deps pin us to a specific `@solana/kit` major version window — coordinate upgrades.
- New `idempotent` + `preflight` fields on `Action<I, O>` expand the action-author cognitive surface.
- Preflight checks add latency to every gated action (~50–150ms for cluster health). Mitigated by caching `getRecentPerformanceSamples` for 10s.

## References

- `docs/SOLANA_ECOSYSTEM_ANALYSIS.md` — `framework-kit` helpers, Foundation tx-pipeline patterns
- `docs/SENDAIFUN_ECOSYSTEM_ANALYSIS.md` — `solana-mpp` mutex-per-sig pattern; agent-kit sendTx footgun
- ADR-058 — Action shape, `SolanaSigner` adoption, error shape (paired)
- ADR-060 — capability descriptor format (paired)
- ADR-012, ADR-033 — `@solana/web3.js` v2 migration (pre-requisite for `@solana/kit` paths)
