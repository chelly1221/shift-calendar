plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "kr.shiftcalendar.voice"
    compileSdk = 36
    defaultConfig {
        applicationId = "kr.shiftcalendar.voice"
        minSdk = 26
        targetSdk = 35
        versionCode = 13
        versionName = "0.2.11"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildTypes {
        release { isMinifyEnabled = false }
    }
}

// Historical Vosk benchmark assets are kept in the repository, outside the installed app.
android.sourceSets.getByName("main").assets.setSrcDirs(emptyList<String>())

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
}
