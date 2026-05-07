package xyz.agenomics.reflex.data

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources

/**
 * Implements IC-1 (Mobile → AgentCore) from `docs/aep-reflex-tech-spec.md`.
 *
 *   POST {baseUrl}/v1/sessions          → opens a session
 *   GET  {baseUrl}/v1/sessions/{id}/stream  → SSE narration stream
 *
 * SSE event names per the spec: `reasoning`, `payment`, `result`, `done`.
 */
// `open` so the instrumentation `TestAppModule` can subclass with a
// deterministic stub. Production code does not extend it.
open class AgentCoreClient(
    private val baseUrl: String,
    private val client: OkHttpClient,
    private val json: Json,
) {

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    @Serializable
    data class CreateSessionRequest(
        val agent_address: String,
        val prompt: String,
        val budget_usdc_micros: Long,
        val vault_session_signature: String,
    )

    @Serializable
    data class CreateSessionResponse(
        val session_id: String,
        val stream_url: String,
    )

    /**
     * Open a new session. The caller must already hold a Solana-wallet-signed
     * agent JWT (issued at install time per IC-1).
     */
    open suspend fun createSession(
        agentJwt: String,
        body: CreateSessionRequest,
    ): CreateSessionResponse {
        val payload = json.encodeToString(CreateSessionRequest.serializer(), body)
        val request = Request.Builder()
            .url("$baseUrl/v1/sessions")
            .header("Authorization", "Bearer $agentJwt")
            .header("Accept", "application/json")
            .post(payload.toRequestBody(jsonMediaType))
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                error("AgentCore createSession failed: HTTP ${response.code}")
            }
            val raw = response.body?.string()
                ?: error("AgentCore createSession returned an empty body")
            return json.decodeFromString(CreateSessionResponse.serializer(), raw)
        }
    }

    /**
     * Subscribe to the SSE narration. Surface each named event as a typed
     * [SessionEvent]. The flow stays open until the server emits `done`,
     * the connection drops, or the collector cancels.
     */
    open fun streamSession(streamUrl: String, agentJwt: String): Flow<SessionEvent> =
        callbackFlow {
            val request = Request.Builder()
                .url(streamUrl)
                .header("Authorization", "Bearer $agentJwt")
                .header("Accept", "text/event-stream")
                .build()

            val factory = EventSources.createFactory(client)
            val source: EventSource = factory.newEventSource(
                request,
                object : EventSourceListener() {
                    override fun onEvent(
                        eventSource: EventSource,
                        id: String?,
                        type: String?,
                        data: String,
                    ) {
                        val event = parseEvent(type, data)
                        trySend(event)
                        if (event is SessionEvent.Done) close()
                    }

                    override fun onClosed(eventSource: EventSource) {
                        close()
                    }

                    override fun onFailure(
                        eventSource: EventSource,
                        t: Throwable?,
                        response: Response?,
                    ) {
                        close(t ?: RuntimeException("SSE failed: ${response?.code}"))
                    }
                },
            )

            awaitClose { source.cancel() }
        }

    private fun parseEvent(type: String?, data: String): SessionEvent {
        // Defensive: if the server sends malformed JSON we still surface
        // the raw payload so the UI shows *something*.
        val parsed: JsonElement? = runCatching { json.parseToJsonElement(data) }.getOrNull()
        return when (type) {
            "reasoning" -> SessionEvent.Reasoning(raw = data, payload = parsed)
            "payment" -> SessionEvent.Payment(raw = data, payload = parsed)
            "result" -> SessionEvent.Result(raw = data, payload = parsed)
            "done" -> SessionEvent.Done(raw = data, payload = parsed)
            else -> SessionEvent.Unknown(type = type ?: "message", raw = data)
        }
    }
}

sealed interface SessionEvent {
    val raw: String

    data class Reasoning(override val raw: String, val payload: JsonElement?) : SessionEvent
    data class Payment(override val raw: String, val payload: JsonElement?) : SessionEvent
    data class Result(override val raw: String, val payload: JsonElement?) : SessionEvent
    data class Done(override val raw: String, val payload: JsonElement?) : SessionEvent
    data class Unknown(val type: String, override val raw: String) : SessionEvent
}
