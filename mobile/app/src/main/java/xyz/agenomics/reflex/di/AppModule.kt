package xyz.agenomics.reflex.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import xyz.agenomics.reflex.BuildConfig
import xyz.agenomics.reflex.data.AgentCoreClient
import xyz.agenomics.reflex.data.WalletClient
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideJson(): Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }

    @Provides
    @Singleton
    fun provideOkHttpClient(): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.HEADERS
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
        }
        return OkHttpClient.Builder()
            // SSE streams are long-lived; disable read timeout.
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .connectTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .addInterceptor(logging)
            .build()
    }

    @Provides
    @Singleton
    fun provideAgentCoreClient(
        client: OkHttpClient,
        json: Json,
    ): AgentCoreClient = AgentCoreClient(
        baseUrl = BuildConfig.AGENTCORE_BASE_URL,
        client = client,
        json = json,
    )

    @Provides
    @Singleton
    fun provideWalletClient(
        @ApplicationContext context: android.content.Context,
    ): WalletClient = WalletClient(context)
}
