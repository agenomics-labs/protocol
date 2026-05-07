package xyz.agenomics.reflex.ui

import androidx.activity.ComponentActivity
import dagger.hilt.android.AndroidEntryPoint

/**
 * Bare ComponentActivity used as the Compose host for instrumentation
 * tests. Hilt requires the host activity be `@AndroidEntryPoint` so
 * `hiltViewModel()` resolves at composition time. We do not register
 * this in `AndroidManifest.xml` directly — the AndroidJUnit `:test`
 * manifest merges in a `<activity>` declaration via `debug` source set.
 *
 * For Day-2 we declare the activity in the androidTest manifest below
 * (see `app/src/androidTest/AndroidManifest.xml`).
 */
@AndroidEntryPoint
class HiltTestActivity : ComponentActivity()
