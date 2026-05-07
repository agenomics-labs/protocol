package xyz.agenomics.reflex

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import dagger.hilt.android.AndroidEntryPoint
import xyz.agenomics.reflex.ui.ReflexNavHost
import xyz.agenomics.reflex.ui.theme.ReflexTheme

/**
 * Single-Activity host for the Compose UI. Day 2 wires a NavHost so
 * Onboarding / Agent Home / Task Input / Live Session / Settings all
 * live behind navigation; the route guard in [ReflexNavHost] picks the
 * cold-start destination based on whether a wallet is already
 * authorised.
 */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ReflexTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    ReflexNavHost()
                }
            }
        }
    }
}
