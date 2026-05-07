package xyz.agenomics.reflex.ui.session

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import xyz.agenomics.reflex.data.AgentCoreClient
import xyz.agenomics.reflex.data.SessionEvent
import xyz.agenomics.reflex.data.SessionRepository
import xyz.agenomics.reflex.data.WalletPreferences
import xyz.agenomics.reflex.data.db.SessionEntity
import xyz.agenomics.reflex.ui.ReflexRoutes
import javax.inject.Inject

data class LiveSessionUiState(
    val sessionId: String = "",
    val isStreaming: Boolean = true,
    val elapsedSeconds: Long = 0,
    val totalSpentUsdcMicros: Long = 0,
    val reasoning: List<PaneEntry> = emptyList(),
    val payments: List<PaneEntry> = emptyList(),
    val results: List<PaneEntry> = emptyList(),
    val errorMessage: String? = null,
) {
    data class PaneEntry(val text: String, val timestamp: Long)
}

/**
 * Streams a single AgentCore session and routes events into three panes:
 * Reasoning / Payments / Result. Replaces the auto-scrolling log on
 * DiscoverScreen for in-progress sessions (DiscoverScreen now navigates
 * here on submit).
 *
 * Cancel is best-effort: we close the SSE source. AgentCore exposes no
 * server-side cancel endpoint in IC-1; revisit when the protocol team
 * adds one.
 */
@HiltViewModel
class LiveSessionViewModel @Inject constructor(
    private val agentCore: AgentCoreClient,
    private val sessions: SessionRepository,
    private val walletPrefs: WalletPreferences,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    private val sessionId: String = savedStateHandle[ReflexRoutes.LIVE_SESSION_ARG]
        ?: error("LiveSessionViewModel requires sessionId in SavedStateHandle")

    private val _state = MutableStateFlow(LiveSessionUiState(sessionId = sessionId))
    val state: StateFlow<LiveSessionUiState> = _state.asStateFlow()

    private var streamJob: Job? = null
    private var elapsedJob: Job? = null

    init {
        startStream()
        startElapsedClock()
    }

    private fun startElapsedClock() {
        elapsedJob = viewModelScope.launch {
            val started = System.currentTimeMillis()
            while (isActive && _state.value.isStreaming) {
                _state.update {
                    it.copy(elapsedSeconds = (System.currentTimeMillis() - started) / 1000)
                }
                delay(1_000)
            }
        }
    }

    private fun startStream() {
        streamJob?.cancel()
        streamJob = viewModelScope.launch {
            // Snapshot the latest cached pubkey; we use the same stub JWT
            // shape as DiscoverViewModel so the wire shape matches IC-1.
            val pubkey = walletPrefs.pubkey.first()
            val agentJwt = pubkey?.let { "stub.$it.jwt" } ?: "stub.unauthenticated.jwt"
            val streamUrl = sessions.get(sessionId)?.let {
                // The AgentCore stream URL was *not* persisted in
                // SessionEntity (IC-1 considers it derivable). Reconstruct.
                deriveStreamUrl(sessionId)
            } ?: deriveStreamUrl(sessionId)

            agentCore.streamSession(streamUrl, agentJwt)
                .catch { t ->
                    _state.update {
                        it.copy(
                            isStreaming = false,
                            errorMessage = t.message ?: "Stream failed",
                        )
                    }
                    sessions.finalize(
                        id = sessionId,
                        status = "error",
                        finishedAtEpochMs = System.currentTimeMillis(),
                        totalSpentUsdcMicros = _state.value.totalSpentUsdcMicros,
                    )
                }
                .collect { event ->
                    handleEvent(event)
                }
        }
    }

    private fun handleEvent(event: SessionEvent) {
        val now = System.currentTimeMillis()
        when (event) {
            is SessionEvent.Reasoning -> _state.update {
                it.copy(reasoning = it.reasoning + LiveSessionUiState.PaneEntry(event.raw, now))
            }
            is SessionEvent.Payment -> {
                val micros = paymentMicros(event.payload)
                _state.update {
                    it.copy(
                        payments = it.payments + LiveSessionUiState.PaneEntry(event.raw, now),
                        totalSpentUsdcMicros = it.totalSpentUsdcMicros + micros,
                    )
                }
            }
            is SessionEvent.Result -> _state.update {
                it.copy(results = it.results + LiveSessionUiState.PaneEntry(event.raw, now))
            }
            is SessionEvent.Done -> {
                _state.update { it.copy(isStreaming = false) }
                viewModelScope.launch {
                    sessions.finalize(
                        id = sessionId,
                        status = "done",
                        finishedAtEpochMs = now,
                        totalSpentUsdcMicros = _state.value.totalSpentUsdcMicros,
                    )
                }
            }
            is SessionEvent.Unknown -> {
                // Stash unknown events into the reasoning pane so we don't
                // silently drop server-emitted protocol changes.
                _state.update {
                    it.copy(reasoning = it.reasoning + LiveSessionUiState.PaneEntry(
                        "[${event.type}] ${event.raw}", now,
                    ))
                }
            }
        }
    }

    /**
     * Best-effort cancel. AgentCore IC-1 does not yet expose a server-
     * side cancel endpoint; once it does, fire that and await ack here.
     */
    fun cancel() {
        // TODO(reflex/IC-2): call AgentCore /v1/sessions/{id}/cancel once
        //   the spec lands a cancel endpoint. Until then we just close
        //   the SSE collection — the agent keeps running server-side.
        streamJob?.cancel()
        elapsedJob?.cancel()
        viewModelScope.launch {
            sessions.finalize(
                id = sessionId,
                status = "cancelled",
                finishedAtEpochMs = System.currentTimeMillis(),
                totalSpentUsdcMicros = _state.value.totalSpentUsdcMicros,
            )
        }
        _state.update { it.copy(isStreaming = false) }
    }

    override fun onCleared() {
        streamJob?.cancel()
        elapsedJob?.cancel()
        super.onCleared()
    }

    private fun paymentMicros(payload: JsonElement?): Long {
        // Defensive parse — IC-1 documents the kind tag but the schema of
        // the inner object is not frozen; try a couple of likely shapes.
        return runCatching {
            val obj = payload?.jsonObject ?: return 0L
            (obj["amount_usdc_micros"] ?: obj["amount_micros"])
                ?.jsonPrimitive
                ?.content
                ?.toLongOrNull()
                ?: 0L
        }.getOrDefault(0L)
    }

    private fun deriveStreamUrl(sessionId: String): String =
        // AgentCore's stream_url is conventionally
        // {baseUrl}/v1/sessions/{id}/stream. The base URL is owned by
        // AgentCoreClient and not exposed; this helper only runs when the
        // upstream createSession response was lost (e.g. process death
        // during a deep link). Worst case the SSE call fails and we
        // surface the error in the UI.
        "/v1/sessions/$sessionId/stream"
}

/**
 * Factory used by the screens that *create* sessions (DiscoverViewModel)
 * before navigating to LiveSession. Centralises the "running" status and
 * timestamp so callers do not drift on field defaults.
 */
fun newSessionEntity(
    sessionId: String,
    prompt: String,
    agentAddress: String,
): SessionEntity = SessionEntity(
    sessionId = sessionId,
    prompt = prompt,
    agentAddress = agentAddress,
    createdAtEpochMs = System.currentTimeMillis(),
    finishedAtEpochMs = null,
    totalSpentUsdcMicros = 0L,
    status = "running",
)
