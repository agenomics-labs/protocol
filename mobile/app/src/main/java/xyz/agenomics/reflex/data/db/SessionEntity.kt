package xyz.agenomics.reflex.data.db

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * One row per AgentCore session the user opened from this device. Written
 * when the session is created (by AgentHomeViewModel / DiscoverViewModel)
 * and updated when the SSE stream finishes. Kept intentionally lean —
 * detailed event logs are owned by AgentCore, not the phone.
 */
@Entity(tableName = "sessions")
data class SessionEntity(
    @PrimaryKey val sessionId: String,
    val prompt: String,
    val agentAddress: String,
    val createdAtEpochMs: Long,
    val finishedAtEpochMs: Long?,
    /** Cumulative USDC spent (micros) — updated on each `payment` event. */
    val totalSpentUsdcMicros: Long,
    /** Last status the UI saw: "running", "done", "error", "cancelled". */
    val status: String,
)
