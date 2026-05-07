package xyz.agenomics.reflex.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import xyz.agenomics.reflex.data.AgentCoreClient
import xyz.agenomics.reflex.data.SessionEvent

data class DiscoverUiState(
    val prompt: String = "",
    val walletPubkey: String? = null,
    val isStreaming: Boolean = false,
    val log: List<LogEntry> = emptyList(),
    val errorMessage: String? = null,
) {
    data class LogEntry(val kind: String, val text: String)
}

@HiltViewModel
class DiscoverViewModel @Inject constructor(
    private val agentCore: AgentCoreClient,
) : ViewModel() {

    private val _state = MutableStateFlow(DiscoverUiState())
    val state: StateFlow<DiscoverUiState> = _state.asStateFlow()

    private var streamJob: Job? = null

    fun onPromptChange(value: String) {
        _state.update { it.copy(prompt = value) }
    }

    fun onWalletConnected(pubkey: String?) {
        _state.update { it.copy(walletPubkey = pubkey) }
    }

    /**
     * Day-1 happy path:
     *   1. Call AgentCore createSession (IC-1).
     *   2. Subscribe to the SSE stream.
     *   3. Append every event to the on-screen log.
     *
     * The vault-session-signature and JWT are stubbed — Day 3+ pulls them
     * from Seed Vault. Wired so the call shape matches IC-1 today.
     */
    fun submit() {
        val current = _state.value
        if (current.prompt.isBlank() || current.isStreaming) return

        streamJob?.cancel()
        streamJob = viewModelScope.launch {
            _state.update {
                it.copy(
                    isStreaming = true,
                    errorMessage = null,
                    log = it.log + DiscoverUiState.LogEntry(
                        kind = "system",
                        text = "Opening session…",
                    ),
                )
            }

            val agentJwt = current.walletPubkey?.let { "stub.$it.jwt" }
                ?: "stub.unauthenticated.jwt"

            try {
                val session = agentCore.createSession(
                    agentJwt = agentJwt,
                    body = AgentCoreClient.CreateSessionRequest(
                        agent_address = current.walletPubkey ?: "stub-pubkey",
                        prompt = current.prompt,
                        budget_usdc_micros = DEFAULT_BUDGET_USDC_MICROS,
                        // Day 3+: real signature from Seed Vault over the
                        // budget-delegation message. Stub keeps IC-1 shape.
                        vault_session_signature = "stub-signature",
                    ),
                )

                _state.update {
                    it.copy(
                        log = it.log + DiscoverUiState.LogEntry(
                            kind = "system",
                            text = "Streaming session ${session.session_id}",
                        ),
                    )
                }

                agentCore.streamSession(session.stream_url, agentJwt)
                    .catch { throwable ->
                        _state.update {
                            it.copy(
                                isStreaming = false,
                                errorMessage = throwable.message,
                                log = it.log + DiscoverUiState.LogEntry(
                                    kind = "error",
                                    text = throwable.message ?: "Stream failed",
                                ),
                            )
                        }
                    }
                    .collect { event ->
                        _state.update { it.copy(log = it.log + event.toLogEntry()) }
                        if (event is SessionEvent.Done) {
                            _state.update { it.copy(isStreaming = false) }
                        }
                    }
            } catch (t: Throwable) {
                _state.update {
                    it.copy(
                        isStreaming = false,
                        errorMessage = t.message,
                        log = it.log + DiscoverUiState.LogEntry(
                            kind = "error",
                            text = t.message ?: "Session failed to open",
                        ),
                    )
                }
            }
        }
    }

    private fun SessionEvent.toLogEntry(): DiscoverUiState.LogEntry = when (this) {
        is SessionEvent.Reasoning ->
            DiscoverUiState.LogEntry(kind = "reasoning", text = raw)
        is SessionEvent.Payment ->
            DiscoverUiState.LogEntry(kind = "payment", text = raw)
        is SessionEvent.Result ->
            DiscoverUiState.LogEntry(kind = "result", text = raw)
        is SessionEvent.Done ->
            DiscoverUiState.LogEntry(kind = "done", text = raw)
        is SessionEvent.Unknown ->
            DiscoverUiState.LogEntry(kind = type, text = raw)
    }

    private companion object {
        // 0.50 USDC default daily budget. Real value comes from the
        // Task Input screen (Day 2+) once the budget slider lands.
        const val DEFAULT_BUDGET_USDC_MICROS = 500_000L
    }
}
