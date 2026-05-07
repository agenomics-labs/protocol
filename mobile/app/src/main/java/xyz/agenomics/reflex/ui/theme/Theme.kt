package xyz.agenomics.reflex.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val LightColors = lightColorScheme(
    primary = ReflexIndigo,
    onPrimary = ReflexOnSurfaceDark,
    primaryContainer = ReflexIndigoLight,
    secondary = ReflexMintDark,
    onSecondary = ReflexOnSurfaceDark,
    tertiary = ReflexAmber,
    background = ReflexSurfaceLight,
    onBackground = ReflexOnSurfaceLight,
    surface = ReflexSurfaceLight,
    onSurface = ReflexOnSurfaceLight,
    error = ReflexCrimson,
)

private val DarkColors = darkColorScheme(
    primary = ReflexMint,
    onPrimary = ReflexSurfaceDark,
    primaryContainer = ReflexIndigo,
    secondary = ReflexMint,
    onSecondary = ReflexSurfaceDark,
    tertiary = ReflexAmber,
    background = ReflexSurfaceDark,
    onBackground = ReflexOnSurfaceDark,
    surface = ReflexSurfaceDark,
    onSurface = ReflexOnSurfaceDark,
    error = ReflexCrimson,
)

/**
 * App-wide Material 3 theme. Use this as the root composable in
 * MainActivity and in tests so previews / instrumentation match runtime.
 */
@Composable
fun ReflexTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = ReflexTypography,
        content = content,
    )
}
