package xyz.agenomics.reflex.di

import android.content.Context
import androidx.room.Room
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dagger.hilt.testing.TestInstallIn
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import xyz.agenomics.reflex.data.AgentCoreClient
import xyz.agenomics.reflex.data.SessionEvent
import xyz.agenomics.reflex.data.WalletClient
import xyz.agenomics.reflex.data.WalletPreferences
import xyz.agenomics.reflex.data.db.ReflexDatabase
import xyz.agenomics.reflex.data.db.SessionDao
import javax.inject.Singleton

/**
 * Replaces [AppModule] for instrumentation tests. Stubs the AgentCore
 * + Wallet clients with deterministic implementations so navigation
 * tests never hit the network.
 */
@Module
@TestInstallIn(
    components = [SingletonComponent::class],
    replaces = [AppModule::class],
)
object TestAppModule {

    @Provides
    @Singleton
    fun provideJson(): Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }

    @Provides
    @Singleton
    fun provideOkHttpClient(): OkHttpClient = OkHttpClient.Builder().build()

    @Provides
    @Singleton
    fun provideAgentCoreClient(
        client: OkHttpClient,
        json: Json,
    ): AgentCoreClient = FakeAgentCoreClient(client, json)

    @Provides
    @Singleton
    fun provideWalletClient(
        @ApplicationContext context: Context,
    ): WalletClient = FakeWalletClient(context)

    @Provides
    @Singleton
    fun provideReflexDatabase(
        @ApplicationContext context: Context,
    ): ReflexDatabase = Room.inMemoryDatabaseBuilder(
        context,
        ReflexDatabase::class.java,
    ).allowMainThreadQueries().build()

    @Provides
    fun provideSessionDao(db: ReflexDatabase): SessionDao = db.sessionDao()

    @Provides
    @Singleton
    fun provideWalletPreferences(
        @ApplicationContext context: Context,
    ): WalletPreferences = FakeWalletPreferences(context)
}

/**
 * In-memory fake. The test app context is real so the parent constructor
 * is happy; we override the public surface so the real DataStore is
 * never touched.
 */
class FakeWalletPreferences(context: Context) : WalletPreferences(context) {
    private val state = MutableStateFlow<String?>(null)
    override val pubkey: Flow<String?> get() = state
    override suspend fun set(pubkey: String?) {
        state.value = pubkey
    }
}

/** Stand-in for the WalletClient — tests drive [authorize] return value. */
class FakeWalletClient(context: Context) : WalletClient(context) {
    @Volatile var nextAuthorizeResult: String? = "FAKEpubkey1111111111111111111111111111111111"

    override suspend fun authorize(
        activity: androidx.activity.ComponentActivity,
        sender: com.solana.mobilewalletadapter.clientlib.ActivityResultSender,
    ): String? = nextAuthorizeResult
}

/**
 * Implements [AgentCoreClient]'s public surface deterministically.
 * Returns a fixed sessionId and a two-event stream (reasoning → done).
 */
class FakeAgentCoreClient(
    client: OkHttpClient,
    json: Json,
) : AgentCoreClient(baseUrl = "http://fake", client = client, json = json) {

    override suspend fun createSession(
        agentJwt: String,
        body: CreateSessionRequest,
    ): CreateSessionResponse = CreateSessionResponse(
        session_id = "fake-session-1",
        stream_url = "http://fake/v1/sessions/fake-session-1/stream",
    )

    override fun streamSession(
        streamUrl: String,
        agentJwt: String,
    ): Flow<SessionEvent> = kotlinx.coroutines.flow.flow {
        emit(SessionEvent.Reasoning(raw = "fake reasoning", payload = null))
        emit(SessionEvent.Done(raw = "{}", payload = null))
    }
}
