package xyz.agenomics.reflex.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import xyz.agenomics.reflex.data.SessionRepository
import xyz.agenomics.reflex.data.SolanaRpcClient
import xyz.agenomics.reflex.data.WalletPreferences
import xyz.agenomics.reflex.data.db.SessionEntity
import javax.inject.Inject

data class AgentHomeUiState(
    val pubkey: String? = null,
    val solUi: Double = 0.0,
    val usdcUi: Double = 0.0,
    val balancesAreStub: Boolean = true,
    val recentSessions: List<SessionEntity> = emptyList(),
    val balancesLoading: Boolean = false,
    val balancesError: String? = null,
)

@HiltViewModel
class AgentHomeViewModel @Inject constructor(
    private val walletPrefs: WalletPreferences,
    private val rpcClient: SolanaRpcClient,
    private val sessions: SessionRepository,
) : ViewModel() {

    private val _balanceState = MutableStateFlow(BalanceState())

    val state: StateFlow<AgentHomeUiState> = combine(
        walletPrefs.pubkey,
        sessions.recent(limit = 25),
        _balanceState,
    ) { pubkey, recent, balances ->
        AgentHomeUiState(
            pubkey = pubkey,
            solUi = balances.solUi,
            usdcUi = balances.usdcUi,
            balancesAreStub = balances.isStub,
            balancesLoading = balances.loading,
            balancesError = balances.error,
            recentSessions = recent,
        )
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = AgentHomeUiState(),
    )

    init {
        // Refresh balances whenever the cached pubkey changes. The
        // RpcClient is currently a stub — see SolanaRpcClient KDoc.
        viewModelScope.launch {
            walletPrefs.pubkey.collect { pubkey ->
                if (pubkey.isNullOrBlank()) {
                    _balanceState.update {
                        it.copy(solUi = 0.0, usdcUi = 0.0, isStub = true, loading = false)
                    }
                    return@collect
                }
                _balanceState.update { it.copy(loading = true, error = null) }
                runCatching { rpcClient.fetchBalances(pubkey) }
                    .onSuccess { result ->
                        _balanceState.update {
                            BalanceState(
                                solUi = result.solUi,
                                usdcUi = result.usdcUi,
                                isStub = result.isStub,
                                loading = false,
                                error = null,
                            )
                        }
                    }
                    .onFailure { t ->
                        _balanceState.update {
                            it.copy(loading = false, error = t.message ?: "RPC failed")
                        }
                    }
            }
        }
    }

    fun signOut() {
        viewModelScope.launch { walletPrefs.set(null) }
    }

    private data class BalanceState(
        val solUi: Double = 0.0,
        val usdcUi: Double = 0.0,
        val isStub: Boolean = true,
        val loading: Boolean = false,
        val error: String? = null,
    )
}
