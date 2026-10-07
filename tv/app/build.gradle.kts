plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// -PversionName=1.2.3 (CI passes the release tag); versionCode is derived so it always increases.
val appVersion = (project.findProperty("versionName") as String?) ?: "1.0.0"
val (major, minor, patch) = appVersion.split(".").map { it.toIntOrNull() ?: 0 } + listOf(0, 0, 0)

android {
    namespace = "cc.animeon.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "cc.animeon.tv.unofficial"
        minSdk = 24
        targetSdk = 35
        versionName = appVersion
        versionCode = major * 1_000_000 + minor * 1_000 + patch
    }

    // CI signs releases with a fixed key (secrets), so installed copies can be updated in place. Without the
    // environment variables (local or fork builds) the debug key is used instead.
    val keystore = System.getenv("TV_KEYSTORE_FILE")
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("TV_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TV_KEY_ALIAS")
                keyPassword = System.getenv("TV_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystore != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    // The fonts (and their @font-face sheet) are shared with the desktop app.
    sourceSets {
        getByName("main") {
            assets.srcDirs("src/main/assets", "../../src/renderer/fonts")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
