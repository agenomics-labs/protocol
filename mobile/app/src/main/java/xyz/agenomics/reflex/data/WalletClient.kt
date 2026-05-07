package xyz.agenomics.reflex.data

import android.content.Context
import android.net.Uri
import androidx.activity.ComponentActivity
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.MobileWalletAdapter
import com.solana.mobilewalletadapter.clientlib.RpcCluster
import com.solana.mobilewalletadapter.clientlib.Solana
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import xyz.agenomics.reflex.BuildConfig

/**
 * Mobile Wallet Adapter 2.0 wrapper. Per the Reflex spec (Surface 1, "MWA
 * integration points"), every state-changing AEP transaction must travel
 * through MWA → Seed Vault Wallet — never through any locally-held key.
 *
 * Day 1 surfaces only [authorize]. Day 3+ wires [signAndSendTransaction]
 * for `register_agent`, `update_vault_policy`, `create_escrow`,
 * `approve_milestone`, `pause_vault`, `update_vault_allowlist`.
 */
class WalletClient(
    @Suppress("unused") private val appContext: Context,
) {

    private val cluster: RpcCluster = when (BuildConfig.SOLANA_CLUSTER) {
        "mainnet-beta" -> RpcCluster.MainnetBeta
        "testnet" -> RpcCluster.Testnet
        else -> RpcCluster.Devnet
    }

    private val adapter: MobileWalletAdapter = MobileWalletAdapter(
        connectionIdentity = ConnectionIdentity(
            identityUri = Uri.parse("https://reflex.agenomics.xyz"),
            iconUri = Uri.parse("favicon.ico"),
            identityName = "AEP Reflex",
        ),
    ).apply {
        blockchain = Solana(cluster)
    }

    /**
     * Authorise the host app against the user's Seed Vault wallet.
     * Returns the authorised public key (base58) on success or `null`
     * if the user dismissed the wallet sheet, no wallet was found, or
     * the underlying handshake failed.
     *
     * MUST be invoked from a `ComponentActivity` — MWA bounces through an
     * Activity result for the wallet handshake. The caller wires the
     * [ActivityResultSender] in their composable (see [DiscoverScreen]).
     */
    suspend fun authorize(
        @Suppress("UnusedParameter") activity: ComponentActivity,
        sender: ActivityResultSender,
    ): String? {
        // `transact` opens a session against whichever installed wallet the
        // user picks (Seed Vault Wallet on Seeker). The lambda receives an
        // already-authorised handle; we just extract the first account.
        val result: TransactionResult<ByteArray> = adapter.transact(sender) { authResult ->
            val first = authResult.accounts.firstOrNull()
                ?: return@transact ByteArray(0)
            first.publicKey
        }

        return when (result) {
            is TransactionResult.Success -> {
                val pubkeyBytes = result.payload
                if (pubkeyBytes.isEmpty()) null else bytesToBase58(pubkeyBytes)
            }
            // 2.0.x splits failure modes; collapse them all to null for the
            // Day-1 UI. Day 3+ surfaces specific copy ("install a wallet",
            // "user declined", "auth expired").
            else -> null
        }
    }

    /**
     * Stub — Day 3+ work. Real implementation will:
     *  1. Build the AEP program instruction (e.g. `register_agent`).
     *  2. Wrap it in a v0 message with a fresh blockhash.
     *  3. Hand it to MWA's `signAndSendTransactions` so Seed Vault Wallet
     *     prompts the user with biometrics.
     *  4. Retry on `TransactionExpiredBlockheightExceededError`.
     */
    @Suppress("UnusedParameter")
    suspend fun signAndSendTransaction(
        activity: ComponentActivity,
        sender: ActivityResultSender,
        unsignedTxBytes: ByteArray,
    ): String {
        TODO(
            "Day 3+: implement signAndSendTransactions per Surface 1 spec. " +
                "Use the latest blockhash and handle expired-blockhash retries."
        )
    }
}

// --------------- helpers ---------------

private val BASE58_ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".toCharArray()

/**
 * Minimal base58 encoder. Sufficient for displaying a Solana pubkey.
 * Replace with a Sava SDK helper once the UI layer depends on it.
 */
internal fun bytesToBase58(input: ByteArray): String {
    if (input.isEmpty()) return ""
    var zeros = 0
    while (zeros < input.size && input[zeros].toInt() == 0) zeros++
    val workingCopy = input.copyOf()
    val encoded = StringBuilder()
    var startAt = zeros
    while (startAt < workingCopy.size) {
        val mod = divmod(workingCopy, startAt, 256, 58)
        if (workingCopy[startAt].toInt() == 0) startAt++
        encoded.append(BASE58_ALPHABET[mod.toInt()])
    }
    repeat(zeros) { encoded.append(BASE58_ALPHABET[0]) }
    return encoded.reverse().toString()
}

private fun divmod(number: ByteArray, firstDigit: Int, base: Int, divisor: Int): Byte {
    var remainder = 0
    for (i in firstDigit until number.size) {
        val digit = number[i].toInt() and 0xFF
        val temp = remainder * base + digit
        number[i] = (temp / divisor).toByte()
        remainder = temp % divisor
    }
    return remainder.toByte()
}
