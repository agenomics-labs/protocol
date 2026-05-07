package xyz.agenomics.reflex.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

private val Context.walletDataStore by preferencesDataStore(name = "reflex_wallet")

/**
 * Persists the most-recently-authorised wallet pubkey. Letting us short-
 * circuit Onboarding on subsequent launches without re-prompting MWA.
 *
 * NOTE: this is *not* a secret. The real authorisation hand-off lives
 * inside the MWA / Seed Vault auth-token cache; we just remember the
 * resulting pubkey for routing + greeting.
 */
// `open` so instrumentation tests can swap in an in-memory fake.
@Singleton
open class WalletPreferences @Inject constructor(
    @dagger.hilt.android.qualifiers.ApplicationContext private val context: Context,
) {
    private val pubkeyKey = stringPreferencesKey("wallet_pubkey")

    open val pubkey: Flow<String?> = context.walletDataStore.data.map { prefs ->
        prefs[pubkeyKey]?.takeIf { it.isNotBlank() }
    }

    open suspend fun set(pubkey: String?) {
        context.walletDataStore.edit { prefs ->
            if (pubkey.isNullOrBlank()) prefs.remove(pubkeyKey)
            else prefs[pubkeyKey] = pubkey
        }
    }
}
