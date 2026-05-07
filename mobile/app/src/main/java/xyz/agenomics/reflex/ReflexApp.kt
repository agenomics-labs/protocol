package xyz.agenomics.reflex

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

/**
 * Hilt entry point. Lives at the package root so generated [Hilt_ReflexApp]
 * is visible to the manifest declaration.
 */
@HiltAndroidApp
class ReflexApp : Application()
