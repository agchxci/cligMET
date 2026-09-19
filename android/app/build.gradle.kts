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

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    implementation("androidx.activity:activity:1.10.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.17")
}
