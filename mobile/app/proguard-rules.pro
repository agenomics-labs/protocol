# Keep MWA 2.0 reflective entrypoints
-keep class com.solana.mobilewalletadapter.** { *; }
-keep class com.solanamobile.seedvault.** { *; }

# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class * {
    @kotlinx.serialization.Serializable <fields>;
}

# OkHttp / SSE
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Hilt
-keep,allowobfuscation,allowshrinking class dagger.hilt.android.internal.managers.** { *; }
