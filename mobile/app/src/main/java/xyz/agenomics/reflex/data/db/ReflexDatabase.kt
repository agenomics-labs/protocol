package xyz.agenomics.reflex.data.db

import androidx.room.Database
import androidx.room.RoomDatabase

/**
 * Single Room database for the Reflex app. Bumped per the contract:
 * v1 covers the Day-2 session history feature on Agent Home; future
 * migrations land alongside new entities (e.g. saved agent allowlist,
 * NFC handshake history).
 */
@Database(
    entities = [SessionEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class ReflexDatabase : RoomDatabase() {
    abstract fun sessionDao(): SessionDao
}
