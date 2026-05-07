package xyz.agenomics.reflex

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import dagger.hilt.android.AndroidEntryPoint
import xyz.agenomics.reflex.ui.DiscoverScreen

/**
 * Single-Activity host for the Compose UI. Day 1 surfaces only the
 * Discover screen; Onboarding / Agent Home / Live Session / NFC / Settings
 * (per spec table) come online in subsequent days behind a NavHost.
 */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    DiscoverScreen()
                }
            }
        }
    }
}
