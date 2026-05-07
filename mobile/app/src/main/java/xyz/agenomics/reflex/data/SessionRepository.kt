package xyz.agenomics.reflex.data

import kotlinx.coroutines.flow.Flow
import xyz.agenomics.reflex.data.db.SessionDao
import xyz.agenomics.reflex.data.db.SessionEntity
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Thin wrapper around [SessionDao]. Exists so view-models depend on a
 * domain-shaped surface instead of Room internals — makes Hilt test
 * doubles trivial.
 */
@Singleton
class SessionRepository @Inject constructor(
    private val dao: SessionDao,
) {
    fun recent(limit: Int = 25): Flow<List<SessionEntity>> = dao.recent(limit)

    suspend fun get(id: String): SessionEntity? = dao.get(id)

    suspend fun record(session: SessionEntity) = dao.upsert(session)

    suspend fun finalize(
        id: String,
        status: String,
        finishedAtEpochMs: Long?,
        totalSpentUsdcMicros: Long,
    ) = dao.finalize(id, status, finishedAtEpochMs, totalSpentUsdcMicros)
}
