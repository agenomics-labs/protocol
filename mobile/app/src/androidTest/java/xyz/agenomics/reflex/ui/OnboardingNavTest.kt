package xyz.agenomics.reflex.ui

import androidx.compose.material3.Surface
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.navigation.compose.rememberNavController
import androidx.navigation.testing.TestNavHostController
import androidx.test.platform.app.InstrumentationRegistry
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import xyz.agenomics.reflex.ui.home.AgentHomeTestTags
import xyz.agenomics.reflex.ui.onboarding.OnboardingTestTags
import xyz.agenomics.reflex.ui.theme.ReflexTheme

/**
 * Day-2 navigation smoke test.
 *
 * The instrumentation framework is `androidx.compose.ui:ui-test-junit4`
 * (already on the test classpath) plus `hilt-android-testing` for the
 * fake module wiring in `TestAppModule`.
 *
 * Flow exercised:
 *   1. Render `ReflexNavHost` with a wallet pubkey unset → start
 *      destination is Onboarding.
 *   2. Assert the "Connect Seed Vault Wallet" button is visible.
 *   3. Tap it → `FakeWalletClient.authorize()` resolves with a stub
 *      pubkey synchronously → NavHost pops to AgentHome.
 *   4. Assert the AgentHome root is visible.
 *
 * **Not run on this box** — there is no Android SDK locally. The test is
 * source-only; CI on a Seeker / emulator will execute it.
 */
@HiltAndroidTest
class OnboardingNavTest {

    @get:Rule(order = 0)
    val hiltRule = HiltAndroidRule(this)

    @get:Rule(order = 1)
    val composeRule = createAndroidComposeRule<HiltTestActivity>()

    @Before
    fun setUp() {
        hiltRule.inject()
    }

    @Test
    fun onboarding_renders_connect_button_then_navigates_to_agent_home() {
        composeRule.setContent {
            ReflexTheme {
                Surface {
                    val navController: TestNavHostController = TestNavHostController(
                        InstrumentationRegistry.getInstrumentation().targetContext,
                    ).also {
                        it.navigatorProvider.addNavigator(
                            androidx.navigation.compose.ComposeNavigator(),
                        )
                    }
                    // The production NavHost binds its own NavController via
                    // rememberNavController(); we still rely on that here
                    // because TestNavHostController is only useful for
                    // assertions on the current route. The "fake authorize"
                    // path is asserted via the AgentHome root being visible.
                    @Suppress("UNUSED_VARIABLE")
                    val unused = navController // kept to document intent
                    val realController = rememberNavController()
                    ReflexNavHost(navController = realController)
                }
            }
        }

        composeRule
            .onNodeWithTag(OnboardingTestTags.CONNECT_BUTTON)
            .assertIsDisplayed()

        composeRule
            .onNodeWithTag(OnboardingTestTags.CONNECT_BUTTON)
            .performClick()

        // FakeWalletClient.authorize() resolves on the same dispatcher;
        // wait until the AgentHome composition appears.
        composeRule.waitUntil(timeoutMillis = 5_000) {
            composeRule.onAllNodes(
                androidx.compose.ui.test.hasTestTag(AgentHomeTestTags.ROOT),
            ).fetchSemanticsNodes().isNotEmpty()
        }

        composeRule
            .onNodeWithTag(AgentHomeTestTags.ROOT)
            .assertIsDisplayed()
    }
}
