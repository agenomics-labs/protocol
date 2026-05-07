package xyz.agenomics.reflex.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import xyz.agenomics.reflex.data.AgentCoreClient
import xyz.agenomics.reflex.data.SessionRepository
import xyz.agenomics.reflex.data.WalletPreferences
import xyz.agenomics.reflex.ui.session.newSessionEntity

data class DiscoverUiState(
    val prompt: String = "",
    val walletPubkey: String? = null,
    val isOpening: Boolean = false,
    val errorMessage: String? = null,
)

/**
 * Day 2 redesign: this view-model now opens an AgentCore session and
 * surfaces the resulting `sessionId` through [navigationEvents] so the
 * navigation layer can hop into [xyz.agenomics.reflex.ui.session.LiveSessionScreen].
 *
 * The actual SSE streaming has moved to LiveSessionViewModel — Discover
 * is back to being a "type a prompt and submit" surface, matching the
 * "Task Input" row of the Surface 1 screens table.
 */
@HiltViewModel
class DiscoverViewModel @Inject constructor(
    private val agentCore: AgentCoreClient,
    private val sessions: SessionRepository,
    private val walletPrefs: WalletPreferences,
) : ViewModel() {

    private val _state = MutableStateFlow(DiscoverUiState())
    val state: StateFlow<DiscoverUiState> = _state.asStateFlow()

    private val _navigationEvents = MutableSharedFlow<DiscoverNavEvent>(extraBufferCapacity = 1)
    val navigationEvents: SharedFlow<DiscoverNavEvent> = _navigationEvents.asSharedFlow()

    private var submitJob: Job? = null

    init {
        // Mirror the persisted pubkey into UI state so the "Connect" button
        // shows the right copy on cold launch.
        viewModelScope.launch {
            walletPrefs.pubkey.collect { pubkey ->
                _state.update { it.copy(walletPubkey = pubkey) }
            }
        }
    }

    fun onPromptChange(value: String) {
        _state.update { it.copy(prompt = value) }
    }

    fun onWalletConnected(pubkey: String?) {
        _state.update { it.copy(walletPubkey = pubkey) }
        viewModelScope.launch { walletPrefs.set(pubkey) }
    }

    fun submit() {
        val current = _state.value
        if (current.prompt.isBlank() || current.isOpening) return

        submitJob?.cancel()
        submitJob = viewModelScope.launch {
            _state.update { it.copy(isOpening = true, errorMessage = null) }
            val pubkey = walletPrefs.pubkey.first() ?: current.walletPubkey
            val agentJwt = pubkey?.let { "stub.$it.jwt" } ?: "stub.unauthenticated.jwt"

            try {
                val response = agentCore.createSession(
                    agentJwt = agentJwt,
                    body = AgentCoreClient.CreateSessionRequest(
                        agent_address = pubkey ?: "stub-pubkey",
                        prompt = current.prompt,
                        budget_usdc_micros = DEFAULT_BUDGET_USDC_MICROS,
                        // Day 3+: real signature from Seed Vault over the
                        // budget-delegation message. Stub keeps IC-1 shape.
                        vault_session_signature = "stub-signature",
                    ),
                )

                sessions.record(
                    newSessionEntity(
                        sessionId = response.session_id,
                        prompt = current.prompt,
                        agentAddress = pubkey ?: "stub-pubkey",
                    ),
                )

                _state.update { it.copy(isOpening = false, prompt = "") }
                _navigationEvents.tryEmit(DiscoverNavEvent.OpenLiveSession(response.session_id))
            } catch (t: Throwable) {
                _state.update {
                    it.copy(isOpening = false, errorMessage = t.message ?: "Session failed to open")
                }
            }
        }
    }

    sealed interface DiscoverNavEvent {
        data class OpenLiveSession(val sessionId: String) : DiscoverNavEvent
    }

    private companion object {
        // 0.50 USDC default daily budget. Real value comes from the
        // Task Input budget slider once it lands.
        const val DEFAULT_BUDGET_USDC_MICROS = 500_000L
    }
}
