plugins {
    id("com.android.application")
}

android {
    namespace = "xyz.cligmet.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "xyz.cligmet.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
