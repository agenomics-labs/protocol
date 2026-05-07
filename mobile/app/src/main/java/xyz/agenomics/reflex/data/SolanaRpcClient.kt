package xyz.agenomics.reflex.data

import javax.inject.Inject
import javax.inject.Singleton

/**
 * Reads on-chain balances (SOL + USDC) for the Agent Home header.
 *
 * **Stub for Day 2.** Sava (`software.sava:sava-rpc`) is already on the
 * classpath but the JSON-RPC plumbing is not wired here yet — Day 4 work
 * once the on-chain deploy authority and USDC mint per cluster are
 * locked in `BuildConfig`. Returning a deterministic placeholder lets
 * the UI render without a live network round-trip and keeps the screen
 * reviewable on the emulator.
 *
 * When wiring the real implementation:
 *   - Use `SOLANA_RPC_URL` from `BuildConfig`.
 *   - SOL balance: `getBalance(pubkey)` → lamports → divide by 1e9.
 *   - USDC balance: derive ATA for the cluster's USDC mint, then
 *     `getTokenAccountBalance(ata)`.
 *   - Surface `Result.failure` rather than swallowing — the home screen
 *     will show a "balance unavailable" banner.
 */
@Singleton
class SolanaRpcClient @Inject constructor() {

    /** Pair of (SOL float, USDC float). Replace once Sava is wired. */
    @Suppress("UnusedParameter")
    suspend fun fetchBalances(pubkey: String): Balances {
        // TODO(day-4): replace stub with Sava-driven RPC reads.
        return Balances(solUi = 0.0, usdcUi = 0.0, isStub = true)
    }

    data class Balances(
        val solUi: Double,
        val usdcUi: Double,
        val isStub: Boolean,
    )
}
