pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Solana Mobile artifacts (MWA 2.0 + Seed Vault SDK).
        // Solana Mobile publishes some artifacts here; if Seed Vault is not on
        // Maven Central yet, the user may also need to add the Solana Mobile
        // GitHub Packages registry or a local maven repo.
        maven { url = uri("https://jitpack.io") }
    }
}

rootProject.name = "AEPReflex"
include(":app")
