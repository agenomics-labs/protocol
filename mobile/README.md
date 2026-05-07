# AEP Reflex — Surface 1 (Seeker mobile app)

Kotlin + Jetpack Compose Android app that runs on the Solana Seeker phone.
Implements the mobile half of `docs/aep-reflex-tech-spec.md` (Surface 1).

- **Day-1 scope:** project skeleton plus a working **Discover services**
  screen that opens an AgentCore session over IC-1 and streams the
  agent's narration over SSE.
- **Day 2-3 scope (this iteration):** NavHost + three new screens
  (Onboarding, Agent Home, Live Session), Material 3 theme, Room-backed
  session history, and a Hilt-driven Compose UI test for the Onboarding
  → Agent Home navigation hop.

## Layout

```
mobile/
├── settings.gradle.kts
├── build.gradle.kts
├── gradle.properties
├── gradle/wrapper/gradle-wrapper.properties
└── app/
    ├── build.gradle.kts
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/xyz/agenomics/reflex/
        │   ├── ReflexApp.kt              (Hilt @HiltAndroidApp)
        │   ├── MainActivity.kt           (Compose host → NavHost)
        │   ├── di/AppModule.kt           (OkHttp, JSON, clients, Room)
        │   ├── data/
        │   │   ├── AgentCoreClient.kt    (IC-1: POST /v1/sessions + SSE)
        │   │   ├── WalletClient.kt       (MWA 2.0 + Seed Vault wrapper)
        │   │   ├── WalletPreferences.kt  (DataStore — cached pubkey)
        │   │   ├── SolanaRpcClient.kt    (SOL/USDC balance — STUB)
        │   │   ├── SessionRepository.kt  (Room wrapper)
        │   │   └── db/                   (Room database, DAO, entity)
        │   ├── ui/
        │   │   ├── Navigation.kt         (NavHost + route guard)
        │   │   ├── DiscoverScreen.kt     (Task-input surface)
        │   │   ├── DiscoverViewModel.kt
        │   │   ├── onboarding/           (OnboardingScreen + VM)
        │   │   ├── home/                 (AgentHomeScreen + VM)
        │   │   ├── session/              (LiveSessionScreen + VM)
        │   │   ├── settings/             (SettingsScreen — STUB)
        │   │   └── theme/                (Color, Type, Theme)
        │   └── nfc/AgentHandshakeHceService.kt  (HCE stub — Day-1)
        └── res/                          (manifest XML, strings, icons)
```

## Build

```bash
cd mobile
./gradlew assembleDebug
```

The first build will download the Android SDK Manager components and the
Gradle 8.7 distribution (declared in `gradle/wrapper`). You will need to
provide the Gradle wrapper JAR and the `gradlew` shell script — both
are produced automatically by running `gradle wrapper` once with a
locally installed Gradle 8.7+ (they are intentionally not committed to
this skeleton).

## Install on a Seeker

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

For dApp Store submission, sign the release build with the Solana Mobile
dApp Store CLI then upload the AAB.

## Required local setup before `assembleDebug` succeeds

1. **Android SDK 34** (`compileSdk = 34`) and JDK 17. Set `sdk.dir` in
   `mobile/local.properties` (auto-created on first Android Studio
   import) or export `ANDROID_HOME`.
2. **Gradle wrapper bootstrap.** Run `gradle wrapper` once from the
   `mobile/` directory with a system Gradle 8.7+ to materialise the
   `gradlew` script and `gradle/wrapper/gradle-wrapper.jar`.
3. **Seed Vault SDK artifact source.** `com.solanamobile:seedvault-wallet-sdk`
   is **not** on Maven Central yet. Until Solana Mobile publishes it
   there, do one of:
   - Clone <https://github.com/solana-mobile/seed-vault-sdk> and run
     `./gradlew publishToMavenLocal`, then add `mavenLocal()` to
     `settings.gradle.kts → dependencyResolutionManagement.repositories`.
   - Or, drop a pre-built `seedvault-wallet-sdk-0.3.0.aar` into
     `mobile/app/libs/` and replace the dependency with
     `implementation(files("libs/seedvault-wallet-sdk-0.3.0.aar"))`.

   Day 2-3 added the following Maven-Central dependencies (no special
   resolution needed):

   | Dep                                                      | Version |
   |---------------------------------------------------------|---------|
   | `androidx.room:room-runtime`                             | 2.6.1   |
   | `androidx.room:room-ktx`                                 | 2.6.1   |
   | `androidx.room:room-compiler` (ksp)                      | 2.6.1   |
   | `androidx.navigation:navigation-testing` (androidTest)   | 2.7.7   |
   | `com.google.dagger:hilt-android-testing` (androidTest)   | 2.51.1  |
4. **AgentCore endpoint.** Override `reflex.agentcore.baseUrl` in
   `gradle.properties` (or per-machine `local.properties`) if you point
   at a staging deployment. Default is `https://reflex.agenomics.xyz`.
5. **Solana cluster.** `reflex.solana.cluster` defaults to `devnet`.
   Flip to `mainnet-beta` for production builds.
6. **Signing config.** No release signing config is wired yet. Add a
   `signingConfigs.release { ... }` block in `app/build.gradle.kts`
   pointing at your keystore before running `./gradlew assembleRelease`.

## Discover screen — user flow

1. User opens app, lands on Discover (single screen Day 1).
2. (Optional) Taps **Connect Wallet** — MWA 2.0 launches Seed Vault
   Wallet sheet; user authorises the dApp; pubkey rendered on the
   button.
3. User types a natural-language goal into the prompt field.
4. User taps **Run agent** — `AgentCoreClient.createSession` POSTs
   IC-1 with a stub `vault_session_signature` (real Seed Vault sign
   lands Day 3+).
5. The returned `stream_url` is consumed via OkHttp SSE; each
   `reasoning` / `payment` / `result` / `done` event is appended to
   the on-screen log with a kind tag, auto-scrolled.
6. `done` flips `isStreaming = false` and re-enables the Run button;
   errors surface in red below the log.

## Stubs you should expect to revisit

- **`vault_session_signature`** in `DiscoverViewModel.submit()` —
  hard-coded `"stub-signature"`. Day 3+ replaces with a Seed Vault
  signature over the budget-delegation message.
- **Agent JWT** — derived as `"stub.<pubkey>.jwt"`. Day 3+ replaces
  with the real install-time JWT signed by the user's wallet.
- **`WalletClient.signAndSendTransaction`** — currently `TODO()`. Day
  3+ wires `register_agent`, `update_vault_policy`, `create_escrow`,
  `approve_milestone`, `pause_vault`, `update_vault_allowlist`.
- **NFC AID** in `res/xml/aep_handshake_aid_list.xml` is a placeholder
  in the AEP-private range. Replace once the protocol team locks the
  canonical AID.
- **`AgentHandshakeHceService.processCommandApdu`** returns the
  "file not found" status for every APDU until the TLV protocol is
  implemented.
- **Onboarding / Agent Home / Live Session** are wired (Day 2-3) but
  several pieces inside them are deliberately stubs:
  - `SolanaRpcClient.fetchBalances` returns hard-coded zeros until Sava
    JSON-RPC is wired (Day 4+). The Agent Home header shows a
    "balances are stubbed" hint when this is the case.
  - Onboarding does **not** yet read the Genesis Token NFT or call the
    AEP `register_agent` instruction — it only authorises the wallet
    against MWA. `register_agent` lands when `WalletClient
    .signAndSendTransaction` is implemented.
  - LiveSession's "Cancel" CTA closes the SSE connection client-side;
    AgentCore IC-1 has no server-side cancel endpoint, so the agent
    keeps running. Tracked as `TODO(reflex/IC-2)` in the view-model.
- **Settings** is a "Coming soon" placeholder. Vault-policy editor /
  allowlist / pause-vault UI lands in a later iteration.
- **NFC two-phone handshake** is still the Day-1 stub.

## Day 2-3 navigation graph

```
                +-----------------+
   cold start →  |   Onboarding   |  (no wallet)
                +-----------------+
                        | authorize() OK
                        v
                +-----------------+    +-----------+
                |   AgentHome    | →  |  Settings |
                +-----------------+    +-----------+
                        | "Start session"
                        v
                +-----------------+
                |   Discover     |  (task input)
                +-----------------+
                        | submit() → sessionId
                        v
                +-----------------+
                |  LiveSession   |  (3 panes + SSE)
                +-----------------+
```

Cold-start guard in `ReflexNavHost` picks Onboarding vs. Agent Home
based on whether `WalletPreferences.pubkey` already has a value.
