package xyz.agenomics.reflex.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import androidx.lifecycle.viewModelScope
import xyz.agenomics.reflex.data.WalletPreferences
import xyz.agenomics.reflex.ui.home.AgentHomeScreen
import xyz.agenomics.reflex.ui.onboarding.OnboardingScreen
import xyz.agenomics.reflex.ui.session.LiveSessionScreen
import xyz.agenomics.reflex.ui.settings.SettingsScreen

/**
 * Centralised route table for Surface 1. Each entry mirrors the master
 * spec's "Screens" table — Onboarding / Agent Home / Task Input
 * (DiscoverScreen) / Live Session / Settings — plus the NFC two-phone
 * flow (deferred; not wired here).
 */
object ReflexRoutes {
    const val ONBOARDING = "onboarding"
    const val AGENT_HOME = "agent_home"
    const val DISCOVER = "discover"
    const val SETTINGS = "settings"

    /** Live session route key. Pass the AgentCore-issued sessionId. */
    private const val LIVE_SESSION_BASE = "live_session"
    const val LIVE_SESSION_ARG = "sessionId"
    const val LIVE_SESSION = "$LIVE_SESSION_BASE/{$LIVE_SESSION_ARG}"
    fun liveSession(sessionId: String): String = "$LIVE_SESSION_BASE/$sessionId"
}

/**
 * Tracks "is a wallet currently authorised?" so the NavHost can pick
 * the right start destination on cold launch. Wraps [WalletPreferences]
 * because the route guard runs on the main thread and needs a synchronous
 * snapshot.
 */
@HiltViewModel
class RootGuardViewModel @Inject constructor(
    walletPrefs: WalletPreferences,
) : ViewModel() {
    val pubkey: StateFlow<String?> = walletPrefs.pubkey
        .stateIn(
            scope = viewModelScope,
            started = SharingStarted.Eagerly,
            initialValue = null,
        )
}

/**
 * The single NavHost for the app. The start destination depends on
 * whether a wallet pubkey is already cached:
 *   - cached → AgentHome (skip onboarding)
 *   - none   → Onboarding
 *
 * The post-onboarding redirect uses popUpTo so the back-stack does not
 * keep the welcome flow around once the user has bound a wallet.
 */
@Composable
fun ReflexNavHost(
    navController: NavHostController = rememberNavController(),
    rootGuard: RootGuardViewModel = hiltViewModel(),
) {
    val pubkey by rootGuard.pubkey.collectAsState()
    val startDestination = if (pubkey != null) ReflexRoutes.AGENT_HOME else ReflexRoutes.ONBOARDING

    NavHost(
        navController = navController,
        startDestination = startDestination,
    ) {
        composable(ReflexRoutes.ONBOARDING) {
            OnboardingScreen(
                onAuthorized = {
                    navController.navigate(ReflexRoutes.AGENT_HOME) {
                        popUpTo(ReflexRoutes.ONBOARDING) { inclusive = true }
                    }
                },
            )
        }

        composable(ReflexRoutes.AGENT_HOME) {
            AgentHomeScreen(
                onStartSession = { navController.navigate(ReflexRoutes.DISCOVER) },
                onOpenSession = { sessionId ->
                    navController.navigate(ReflexRoutes.liveSession(sessionId))
                },
                onOpenSettings = { navController.navigate(ReflexRoutes.SETTINGS) },
            )
        }

        composable(ReflexRoutes.DISCOVER) {
            DiscoverScreen(
                onSessionStarted = { sessionId ->
                    navController.navigate(ReflexRoutes.liveSession(sessionId)) {
                        // Once the session is live we don't want Back to drop
                        // the user back into the input screen mid-stream.
                        popUpTo(ReflexRoutes.DISCOVER) { inclusive = true }
                    }
                },
            )
        }

        composable(
            route = ReflexRoutes.LIVE_SESSION,
            arguments = listOf(navArgument(ReflexRoutes.LIVE_SESSION_ARG) {
                type = NavType.StringType
            }),
        ) { backStackEntry ->
            val sessionId = backStackEntry.arguments
                ?.getString(ReflexRoutes.LIVE_SESSION_ARG)
                ?: error("LiveSessionScreen requires a sessionId arg")
            LiveSessionScreen(
                sessionId = sessionId,
                onClose = {
                    // Pop back to home; if the back stack is somehow empty
                    // (deep link) navigate explicitly.
                    if (!navController.popBackStack(ReflexRoutes.AGENT_HOME, false)) {
                        navController.navigate(ReflexRoutes.AGENT_HOME) {
                            popUpTo(0)
                        }
                    }
                },
            )
        }

        composable(ReflexRoutes.SETTINGS) {
            SettingsScreen(onBack = { navController.popBackStack() })
        }
    }
}
