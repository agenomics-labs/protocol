package xyz.agenomics.reflex.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface SessionDao {

    @Query("SELECT * FROM sessions ORDER BY createdAtEpochMs DESC LIMIT :limit")
    fun recent(limit: Int = 25): Flow<List<SessionEntity>>

    @Query("SELECT * FROM sessions WHERE sessionId = :id LIMIT 1")
    suspend fun get(id: String): SessionEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(session: SessionEntity)

    @Query(
        "UPDATE sessions SET status = :status, finishedAtEpochMs = :finishedAt, " +
            "totalSpentUsdcMicros = :spent WHERE sessionId = :id"
    )
    suspend fun finalize(id: String, status: String, finishedAt: Long?, spent: Long)
}
