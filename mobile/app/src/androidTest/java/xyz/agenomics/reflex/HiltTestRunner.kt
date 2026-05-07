package xyz.agenomics.reflex

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner
import dagger.hilt.android.testing.HiltTestApplication

/**
 * Swap [ReflexApp] for [HiltTestApplication] when running instrumentation
 * tests so Hilt builds a test component instead of the production graph.
 * Wired into `app/build.gradle.kts` via `defaultConfig.testInstrumentationRunner`.
 */
class HiltTestRunner : AndroidJUnitRunner() {
    override fun newApplication(
        cl: ClassLoader?,
        className: String?,
        context: Context?,
    ): Application {
        return super.newApplication(cl, HiltTestApplication::class.java.name, context)
    }
}
