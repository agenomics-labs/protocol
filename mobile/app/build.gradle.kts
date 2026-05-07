import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
    id("com.google.dagger.hilt.android")
}

// Surface BuildConfig values from gradle.properties / local.properties.
val agentCoreBaseUrl: String =
    (project.findProperty("reflex.agentcore.baseUrl") as String?)
        ?: "https://reflex.agenomics.xyz"
val solanaCluster: String =
    (project.findProperty("reflex.solana.cluster") as String?) ?: "devnet"
val solanaRpcUrl: String =
    (project.findProperty("reflex.solana.rpcUrl") as String?)
        ?: "https://api.devnet.solana.com"

android {
    namespace = "xyz.agenomics.reflex"
    // Seeker ships on Android 14 (API 34); align target to match.
    compileSdk = 34

    defaultConfig {
        applicationId = "xyz.agenomics.reflex"
        minSdk = 28          // Android 9 — covers MWA 2.0 + NFC HCE
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-day1"

        // Vector drawable support for the launcher icon
        vectorDrawables.useSupportLibrary = true

        buildConfigField("String", "AGENTCORE_BASE_URL", "\"$agentCoreBaseUrl\"")
        buildConfigField("String", "SOLANA_CLUSTER", "\"$solanaCluster\"")
        buildConfigField("String", "SOLANA_RPC_URL", "\"$solanaRpcUrl\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isDebuggable = true
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    composeOptions {
        // Must match the Kotlin version above.
        kotlinCompilerExtensionVersion = "1.5.14"
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "/META-INF/DEPENDENCIES"
        )
    }
}

dependencies {
    // ---------- Jetpack Compose (BOM-pinned) ----------
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.2")
    implementation("androidx.navigation:navigation-compose:2.7.7")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    // ---------- Mobile Wallet Adapter 2.0 (Solana Mobile) ----------
    // Per spec: signAndSendTransactions through Seed Vault Wallet.
    implementation("com.solanamobile:mobile-wallet-adapter-clientlib-ktx:2.0.3")

    // ---------- Seed Vault SDK ----------
    // Seeker-specific. NOTE: not on Maven Central as of this scaffold;
    // see README under "SDK setup". Pinned here so resolution fails loudly
    // if the user hasn't configured the artifact source.
    implementation("com.solanamobile:seedvault-wallet-sdk:0.3.0")

    // ---------- Solana Web3 / RPC ----------
    // For reading on-chain state (vault balance, reputation) without going
    // through MWA. Sava is the maintained Kotlin Solana client.
    implementation("software.sava:sava-core:0.4.0")
    implementation("software.sava:sava-rpc:0.4.0")

    // ---------- Networking + SSE ----------
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-kotlinx-serialization:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // ---------- Hilt DI ----------
    implementation("com.google.dagger:hilt-android:2.51.1")
    ksp("com.google.dagger:hilt-android-compiler:2.51.1")
    implementation("androidx.hilt:hilt-navigation-compose:1.2.0")

    // ---------- DataStore ----------
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // ---------- Test ----------
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
