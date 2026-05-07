package xyz.agenomics.reflex.ui.onboarding

import androidx.activity.ComponentActivity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import xyz.agenomics.reflex.data.WalletClient
import xyz.agenomics.reflex.data.WalletPreferences
import javax.inject.Inject

data class OnboardingUiState(
    val isAuthorizing: Boolean = false,
    val authorizedPubkey: String? = null,
    val errorMessage: String? = null,
)

/**
 * Drives the first-launch flow described by the Surface 1 "Onboarding"
 * row of the spec. Real `register_agent` tx + Genesis-Token detection
 * land in a follow-up; Day 2 only authorises the wallet through MWA so
 * the rest of the app can read a stable pubkey.
 *
 * NOTE: [WalletClient] needs an `Activity` + `ActivityResultSender`,
 * neither of which Hilt can inject. The composable layer hands them in
 * via [authorize].
 */
@HiltViewModel
class OnboardingViewModel @Inject constructor(
    private val walletClient: WalletClient,
    private val walletPrefs: WalletPreferences,
) : ViewModel() {

    private val _state = MutableStateFlow(OnboardingUiState())
    val state: StateFlow<OnboardingUiState> = _state.asStateFlow()

    fun authorize(
        activity: ComponentActivity,
        sender: ActivityResultSender,
        onSuccess: (String) -> Unit,
    ) {
        if (_state.value.isAuthorizing) return
        _state.update { it.copy(isAuthorizing = true, errorMessage = null) }
        viewModelScope.launch {
            try {
                val pubkey = walletClient.authorize(activity, sender)
                if (pubkey.isNullOrBlank()) {
                    _state.update {
                        it.copy(
                            isAuthorizing = false,
                            errorMessage = "Wallet authorisation cancelled or unavailable.",
                        )
                    }
                    return@launch
                }
                walletPrefs.set(pubkey)
                _state.update {
                    it.copy(isAuthorizing = false, authorizedPubkey = pubkey)
                }
                onSuccess(pubkey)
            } catch (t: Throwable) {
                _state.update {
                    it.copy(
                        isAuthorizing = false,
                        errorMessage = t.message ?: "Wallet handshake failed",
                    )
                }
            }
        }
    }
}
