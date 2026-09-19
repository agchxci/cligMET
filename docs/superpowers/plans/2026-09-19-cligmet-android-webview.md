# cligMET Android WebView App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an installable Android APK named cligMET that securely hosts the existing live `https://cligmet.xyz` interface in a thin native WebView shell.

**Architecture:** Create a separate `agchxci/cligMET_android` repository containing one Android app module. The native layer owns only launch/splash, WebView security and navigation policy, Android back handling, and a native retry state; the website remains the sole UI/data implementation.

**Tech Stack:** Kotlin, Android SDK 36, Android Gradle Plugin 9.4.0, Gradle 9.6.0, JDK 17, platform WebView, JUnit 4.13.2, Robolectric 4.17, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-19-cligmet-android-webview-design.md`

## Global Constraints

- Application name: `cligMET`.
- Application ID/package: `xyz.cligmet.app`.
- Start URL: `https://cligmet.xyz`.
- Target SDK: API 36.
- Compile SDK: API 36.
- Minimum SDK: API 26.
- AGP: `9.4.0`; Gradle: `9.6.0`; JDK: `17`.
- Use AGP 9 built-in Kotlin; do not apply `org.jetbrains.kotlin.android`.
- Internet permission only; no location, storage, camera, microphone, notification, or background-service permissions.
- Cleartext traffic disabled.
- Mixed content disabled.
- No `addJavascriptInterface` or native JavaScript bridge.
- No duplicated weather/chart logic.
- cligMET-owned HTTPS URLs remain in WebView; external safe URLs leave the app.
- Version 1 produces a sideloadable debug APK, not a Play release.
- No notifications, widgets, background polling, analytics SDKs, or user accounts.

## Review Focus

- A malformed or unsupported URI must not crash the app; it should be blocked rather than loaded in WebView.
- A deceptive hostname such as `cligmet.xyz.evil.example` must be treated as external, not internal.
- A main-frame TLS error must cancel loading and reveal the native Retry state rather than bypass certificate validation.
- Back navigation with WebView history must go back in the page; with no WebView history it must finish the Activity normally.
- A configuration/orientation recreation must restore a usable WebView instead of stacking duplicate WebViews or showing a permanently blank state.

---

### Task 1: Create the Android repository and tested URL policy

**Files:**
- Create repository: `agchxci/cligMET_android`
- Create: `settings.gradle.kts`
- Create: `build.gradle.kts`
- Create: `gradle.properties`
- Create: `app/build.gradle.kts`
- Create: `app/src/main/AndroidManifest.xml`
- Create: `app/src/main/java/xyz/cligmet/app/UrlPolicy.kt`
- Create: `app/src/test/java/xyz/cligmet/app/UrlPolicyTest.kt`
- Create via Gradle: `gradlew`, `gradlew.bat`, `gradle/wrapper/*`

**Interfaces:**
- Consumes: none.
- Produces: `UrlPolicy.classify(Uri): NavigationDecision` and `NavigationDecision.INTERNAL | EXTERNAL | BLOCKED`.

- [ ] **Step 1: Create the repository and build scaffold**

Create `agchxci/cligMET_android` as a private repository initially, default branch `main`.

`settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "cligMET"
include(":app")
```

Top-level `build.gradle.kts`:

```kotlin
plugins {
    id("com.android.application") version "9.4.0" apply false
}
```

`gradle.properties`:

```properties
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
```

`app/build.gradle.kts`:

```kotlin
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
        testInstrumentationRunner = "android.test.InstrumentationTestRunner"
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.17")
}
```

Generate the wrapper:

```bash
gradle wrapper --gradle-version 9.6.0
```

Expected: Gradle wrapper files are generated and `./gradlew help` exits 0.

- [ ] **Step 2: Write the failing URL-policy tests**

Create `app/src/test/java/xyz/cligmet/app/UrlPolicyTest.kt`:

```kotlin
package xyz.cligmet.app

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Test

class UrlPolicyTest {
    @Test
    fun cligmetHttpsIsInternal() {
        assertEquals(
            NavigationDecision.INTERNAL,
            UrlPolicy.classify(Uri.parse("https://cligmet.xyz/forecast"))
        )
    }

    @Test
    fun deceptiveCligmetHostnameIsExternal() {
        assertEquals(
            NavigationDecision.EXTERNAL,
            UrlPolicy.classify(Uri.parse("https://cligmet.xyz.evil.example/"))
        )
    }

    @Test
    fun otherHttpsHostIsExternal() {
        assertEquals(
            NavigationDecision.EXTERNAL,
            UrlPolicy.classify(Uri.parse("https://example.com/"))
        )
    }

    @Test
    fun mailtoAndTelAreExternal() {
        assertEquals(NavigationDecision.EXTERNAL, UrlPolicy.classify(Uri.parse("mailto:test@example.com")))
        assertEquals(NavigationDecision.EXTERNAL, UrlPolicy.classify(Uri.parse("tel:+441234567890")))
    }

    @Test
    fun cleartextAndUnknownSchemesAreBlocked() {
        assertEquals(NavigationDecision.BLOCKED, UrlPolicy.classify(Uri.parse("http://cligmet.xyz/")))
        assertEquals(NavigationDecision.BLOCKED, UrlPolicy.classify(Uri.parse("javascript:alert(1)")))
        assertEquals(NavigationDecision.BLOCKED, UrlPolicy.classify(Uri.parse("file:///etc/passwd")))
    }
}
```

- [ ] **Step 3: Run the URL-policy test and verify RED**

Run:

```bash
./gradlew testDebugUnitTest --tests xyz.cligmet.app.UrlPolicyTest
```

Expected: FAIL because `UrlPolicy` and `NavigationDecision` do not yet exist.

- [ ] **Step 4: Implement the minimum URL policy**

Create `app/src/main/java/xyz/cligmet/app/UrlPolicy.kt`:

```kotlin
package xyz.cligmet.app

import android.net.Uri

enum class NavigationDecision {
    INTERNAL,
    EXTERNAL,
    BLOCKED
}

object UrlPolicy {
    private const val CLIGMET_HOST = "cligmet.xyz"

    fun classify(uri: Uri): NavigationDecision {
        val scheme = uri.scheme?.lowercase() ?: return NavigationDecision.BLOCKED
        val host = uri.host?.lowercase()

        return when {
            scheme == "https" && host == CLIGMET_HOST -> NavigationDecision.INTERNAL
            scheme == "https" -> NavigationDecision.EXTERNAL
            scheme == "mailto" || scheme == "tel" -> NavigationDecision.EXTERNAL
            else -> NavigationDecision.BLOCKED
        }
    }
}
```

- [ ] **Step 5: Run the test and verify GREEN**

Run:

```bash
./gradlew testDebugUnitTest --tests xyz.cligmet.app.UrlPolicyTest
```

Expected: PASS.

- [ ] **Step 6: Add the minimum manifest**

Create `app/src/main/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:allowBackup="true"
        android:label="@string/app_name"
        android:theme="@style/Theme.Cligmet"
        android:usesCleartextTraffic="false">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

The missing Activity/resources are intentionally supplied in Task 2; this task's acceptance criterion is the unit-tested policy and a valid Gradle project, not a complete APK.

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat: scaffold cligMET Android app and URL policy"
```

---

### Task 2: Build the secure WebView shell and native Retry state

**Files:**
- Create: `app/src/main/java/xyz/cligmet/app/MainActivity.kt`
- Create: `app/src/main/java/xyz/cligmet/app/CligmetWebViewClient.kt`
- Create: `app/src/main/res/layout/activity_main.xml`
- Create: `app/src/main/res/values/strings.xml`
- Create: `app/src/main/res/values/styles.xml`
- Create: `app/src/main/res/xml/network_security_config.xml`
- Modify: `app/src/main/AndroidManifest.xml`
- Create: `app/src/test/java/xyz/cligmet/app/MainActivityTest.kt`

**Interfaces:**
- Consumes: `UrlPolicy.classify(Uri)`.
- Produces: `MainActivity.showError()`, `MainActivity.showWebContent()`, and `CligmetWebViewClient` callbacks used only by the Activity.

- [ ] **Step 1: Write failing Robolectric tests for WebView configuration, retry UI, and Back behavior**

Create `app/src/test/java/xyz/cligmet/app/MainActivityTest.kt`:

```kotlin
package xyz.cligmet.app

import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.TextView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class MainActivityTest {
    @Test
    fun webViewUsesRequiredSecuritySettings() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val webView = activity.findViewById<WebView>(R.id.webView)

        assertTrue(webView.settings.javaScriptEnabled)
        assertTrue(webView.settings.domStorageEnabled)
        assertFalse(webView.settings.allowFileAccess)
        assertFalse(webView.settings.allowContentAccess)
        assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, webView.settings.mixedContentMode)
    }

    @Test
    fun errorStateCanReplaceAndRestoreWebContent() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val webView = activity.findViewById<WebView>(R.id.webView)
        val errorPanel = activity.findViewById<android.view.View>(R.id.errorPanel)

        activity.showError()
        assertEquals(android.view.View.GONE, webView.visibility)
        assertEquals(android.view.View.VISIBLE, errorPanel.visibility)

        activity.showWebContent()
        assertEquals(android.view.View.VISIBLE, webView.visibility)
        assertEquals(android.view.View.GONE, errorPanel.visibility)
    }

    @Test
    fun retryButtonLoadsStartUrl() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        activity.showError()

        activity.findViewById<Button>(R.id.retryButton).performClick()

        val webView = activity.findViewById<WebView>(R.id.webView)
        assertEquals(MainActivity.START_URL, org.robolectric.Shadows.shadowOf(webView).lastLoadedUrl)
    }
}
```

- [ ] **Step 2: Run the Activity tests and verify RED**

Run:

```bash
./gradlew testDebugUnitTest --tests xyz.cligmet.app.MainActivityTest
```

Expected: FAIL because `MainActivity`, resource IDs and Retry behavior do not yet exist.

- [ ] **Step 3: Create strings and layout**

`app/src/main/res/values/strings.xml`:

```xml
<resources>
    <string name="app_name">cligMET</string>
    <string name="offline_title">cligMET</string>
    <string name="offline_message">The live weather page could not be reached.</string>
    <string name="retry">Retry</string>
</resources>
```

`app/src/main/res/layout/activity_main.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:fitsSystemWindows="true">

    <WebView
        android:id="@+id/webView"
        android:layout_width="match_parent"
        android:layout_height="match_parent" />

    <LinearLayout
        android:id="@+id/errorPanel"
        android:layout_width="match_parent"
        android:layout_height="match_parent"
        android:gravity="center"
        android:orientation="vertical"
        android:padding="32dp"
        android:visibility="gone">

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/offline_title"
            android:textSize="42sp"
            android:textStyle="bold" />

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginTop="12dp"
            android:gravity="center"
            android:text="@string/offline_message" />

        <Button
            android:id="@+id/retryButton"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginTop="20dp"
            android:text="@string/retry" />
    </LinearLayout>
</FrameLayout>
```

- [ ] **Step 4: Implement the WebView client**

Create `app/src/main/java/xyz/cligmet/app/CligmetWebViewClient.kt`:

```kotlin
package xyz.cligmet.app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

class CligmetWebViewClient(
    private val activity: MainActivity
) : WebViewClient() {

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        return when (UrlPolicy.classify(request.url)) {
            NavigationDecision.INTERNAL -> false
            NavigationDecision.EXTERNAL -> {
                try {
                    activity.startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (_: ActivityNotFoundException) {
                    activity.showError()
                }
                true
            }
            NavigationDecision.BLOCKED -> true
        }
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
        activity.showWebContent()
    }

    override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError
    ) {
        if (request.isForMainFrame) activity.showError()
    }

    override fun onReceivedHttpError(
        view: WebView,
        request: WebResourceRequest,
        errorResponse: WebResourceResponse
    ) {
        if (request.isForMainFrame && errorResponse.statusCode >= 400) {
            activity.showError()
        }
    }

    override fun onReceivedSslError(
        view: WebView,
        handler: SslErrorHandler,
        error: SslError
    ) {
        handler.cancel()
        activity.showError()
    }
}
```

- [ ] **Step 5: Implement MainActivity with secure settings, retry and Back handling**

Create `app/src/main/java/xyz/cligmet/app/MainActivity.kt`:

```kotlin
package xyz.cligmet.app

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button

class MainActivity : Activity() {
    companion object {
        const val START_URL = "https://cligmet.xyz"
    }

    private lateinit var webView: WebView
    private lateinit var errorPanel: View

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        errorPanel = findViewById(R.id.errorPanel)

        configureWebView()

        findViewById<Button>(R.id.retryButton).setOnClickListener {
            showWebContent()
            webView.loadUrl(START_URL)
        }

        if (savedInstanceState == null) {
            webView.loadUrl(START_URL)
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    private fun configureWebView() {
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        webView.webViewClient = CligmetWebViewClient(this)
    }

    fun showError() {
        webView.visibility = View.GONE
        errorPanel.visibility = View.VISIBLE
    }

    fun showWebContent() {
        errorPanel.visibility = View.GONE
        webView.visibility = View.VISIBLE
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("Platform callback retained for minSdk 26 compatibility")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
```

- [ ] **Step 6: Add cleartext network policy and app theme**

`app/src/main/res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
</network-security-config>
```

`app/src/main/res/values/styles.xml`:

```xml
<resources>
    <style name="Theme.Cligmet" parent="android:style/Theme.Material.Light.NoActionBar">
        <item name="android:fontFamily">sans</item>
        <item name="android:windowLightStatusBar">true</item>
        <item name="android:navigationBarColor">#FFFFFF</item>
        <item name="android:statusBarColor">#FFFFFF</item>
        <item name="android:windowActionModeOverlay">true</item>
    </style>
</resources>
```

Update `<application>` in the manifest to include:

```xml
android:networkSecurityConfig="@xml/network_security_config"
```

- [ ] **Step 7: Pin TLS-error behavior with a testable helper**

Add this internal helper to `CligmetWebViewClient`:

```kotlin
internal fun cancelSslError(cancel: () -> Unit) {
    cancel()
}
```

Change `onReceivedSslError` to call `cancelSslError(handler::cancel)` before `activity.showError()`.

Add to `CligmetWebViewClientTest.kt`:

```kotlin
@Test
fun sslErrorsAreAlwaysCancelled() {
    var cancelled = false
    val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
    val client = CligmetWebViewClient(activity)

    client.cancelSslError { cancelled = true }

    assertTrue(cancelled)
}
```

Run:

```bash
./gradlew testDebugUnitTest --tests xyz.cligmet.app.CligmetWebViewClientTest.sslErrorsAreAlwaysCancelled
```

Expected: PASS.

- [ ] **Step 8: Run Activity and full unit tests and verify GREEN**

Run:

```bash
./gradlew testDebugUnitTest
```

Expected: all unit/Robolectric tests PASS.

- [ ] **Step 9: Add deterministic WebView-client navigation tests**

Add `app/src/test/java/xyz/cligmet/app/CligmetWebViewClientTest.kt`. The test uses Robolectric's `WebView` plus a small test implementation of `WebResourceRequest` whose `url` is supplied explicitly. For each request, call `shouldOverrideUrlLoading` and assert the return value:

```kotlin
@Test
fun internalHttpsStaysInWebView() {
    val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
    val webView = activity.findViewById<WebView>(R.id.webView)
    val client = CligmetWebViewClient(activity)

    val handled = client.shouldOverrideUrlLoading(
        webView,
        TestWebResourceRequest(Uri.parse("https://cligmet.xyz/forecast"))
    )

    assertFalse(handled)
}

@Test
fun blockedCleartextIsConsumed() {
    val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
    val webView = activity.findViewById<WebView>(R.id.webView)
    val client = CligmetWebViewClient(activity)

    val handled = client.shouldOverrideUrlLoading(
        webView,
        TestWebResourceRequest(Uri.parse("http://cligmet.xyz/"))
    )

    assertTrue(handled)
}
```

`TestWebResourceRequest` must implement all `WebResourceRequest` getters with stable test values: `isForMainFrame = true`, `isRedirect = false`, `hasGesture = true`, method `GET`, and empty request headers.

Also add a test proving `https://cligmet.xyz.evil.example/` returns `true` (the request is consumed for external dispatch rather than allowed into the WebView).

Run:

```bash
./gradlew testDebugUnitTest
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add app
git commit -m "feat: add secure cligMET WebView shell"
```

---

### Task 3: Add branding, splash, CI APK build and delivery documentation

**Files:**
- Create: `app/src/main/res/drawable/ic_cligmet.xml`
- Create: `app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`
- Create: `app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml`
- Create: `app/src/main/res/values/colors.xml`
- Create: `app/src/main/res/values-v31/styles.xml`
- Modify: `app/src/main/AndroidManifest.xml`
- Create: `.github/workflows/build-apk.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: working `:app` project from Tasks 1–2.
- Produces: GitHub Actions artifact `cligMET-debug-apk` containing `app-debug.apk`.

- [ ] **Step 1: Write the branding resources**

`app/src/main/res/values/colors.xml`:

```xml
<resources>
    <color name="cligmet_white">#FFFFFF</color>
    <color name="cligmet_black">#111111</color>
</resources>
```

Create `app/src/main/res/drawable/ic_cligmet.xml` as a simple black-on-white vector mark using the cligMET wordmark/initial treatment, with no external bitmap dependency.

Create adaptive launcher icon XML files referencing that foreground and a white background.

- [ ] **Step 2: Add Android 12+ native splash**

Create `app/src/main/res/values-v31/styles.xml` using only platform splash attributes:

```xml
<resources>
    <style name="Theme.Cligmet" parent="android:style/Theme.Material.Light.NoActionBar">
        <item name="android:windowSplashScreenBackground">@color/cligmet_white</item>
        <item name="android:windowSplashScreenAnimatedIcon">@drawable/ic_cligmet</item>
        <item name="android:windowLightStatusBar">true</item>
        <item name="android:navigationBarColor">@color/cligmet_white</item>
        <item name="android:statusBarColor">@color/cligmet_white</item>
    </style>
</resources>
```

Do not use `postSplashScreenTheme`; Version 1 deliberately has no AndroidX splash dependency. Refactor base `values/styles.xml` so `Theme.Cligmet` remains a valid pre-API-31 launch theme with white `android:windowBackground`.

Update the manifest application icon fields:

```xml
android:icon="@mipmap/ic_launcher"
android:roundIcon="@mipmap/ic_launcher_round"
```

- [ ] **Step 3: Add a manifest-permission regression check**

Create `scripts/check_manifest_permissions.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
manifest="app/src/main/AndroidManifest.xml"

permissions="$(grep -o 'android.permission.[A-Z_]*' "$manifest" | sort -u || true)"
expected="android.permission.INTERNET"

if [[ "$permissions" != "$expected" ]]; then
  echo "Unexpected manifest permissions:"
  echo "$permissions"
  exit 1
fi

if ! grep -q 'android:usesCleartextTraffic="false"' "$manifest"; then
  echo "Cleartext traffic is not explicitly disabled"
  exit 1
fi
```

Make executable and run:

```bash
chmod +x scripts/check_manifest_permissions.sh
./scripts/check_manifest_permissions.sh
```

Expected: exit 0.

- [ ] **Step 4: Add GitHub Actions build workflow**

Create `.github/workflows/build-apk.yml`:

```yaml
name: Build Android APK

on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "17"

      - uses: gradle/actions/setup-gradle@v4

      - name: Verify manifest policy
        run: ./scripts/check_manifest_permissions.sh

      - name: Run unit tests
        run: ./gradlew testDebugUnitTest

      - name: Build debug APK
        run: ./gradlew assembleDebug

      - uses: actions/upload-artifact@v4
        with:
          name: cligMET-debug-apk
          path: app/build/outputs/apk/debug/app-debug.apk
          if-no-files-found: error
```

- [ ] **Step 5: Create README with build and sideload instructions**

README must state:

```text
Build:
./gradlew testDebugUnitTest assembleDebug

APK:
app/build/outputs/apk/debug/app-debug.apk

Sideload:
1. Download app-debug.apk to Android.
2. Open the APK.
3. Allow "Install unknown apps" for the file/browser app if Android asks.
4. Install cligMET.
5. Open it from the launcher.
```

Also explain that the app loads the live `https://cligmet.xyz` UI and therefore website UI updates do not require a new APK.

- [ ] **Step 6: Run complete local verification**

Run:

```bash
./scripts/check_manifest_permissions.sh
./gradlew testDebugUnitTest
./gradlew assembleDebug
```

Expected:

- manifest script exit 0;
- all tests PASS;
- `app/build/outputs/apk/debug/app-debug.apk` exists.

Also run:

```bash
./gradlew lintDebug
```

Expected: no fatal lint errors.

- [ ] **Step 7: Inspect the built manifest**

Run Android build tools against the APK, for example:

```bash
apkanalyzer manifest permissions app/build/outputs/apk/debug/app-debug.apk
```

Expected: only `android.permission.INTERNET` plus any platform-generated install-time metadata that is not a requested runtime capability. If an unexpected requested permission appears, stop and remove its source before delivery.

- [ ] **Step 8: Commit branding/CI/docs**

```bash
git add .
git commit -m "build: add branded APK workflow and sideload docs"
```

- [ ] **Step 9: Push and verify GitHub Actions**

Push `main` or open/merge the implementation PR, then wait for `Build Android APK`.

Expected:

- workflow status: success;
- artifact name: `cligMET-debug-apk`;
- artifact contains `app-debug.apk`.

- [ ] **Step 10: Download and verify the artifact**

Download the workflow artifact and confirm:

```bash
unzip -l cligMET-debug-apk.zip
```

Expected: APK present.

Compute and record SHA-256:

```bash
sha256sum app-debug.apk
```

The final delivery message must include the workflow/run reference, APK filename, SHA-256, and sideload instructions.

---

## Final Acceptance Checklist

- [ ] `agchxci/cligMET_android` exists and contains the complete source.
- [ ] Package is exactly `xyz.cligmet.app`.
- [ ] App label is exactly `cligMET`.
- [ ] Target/compile SDK are 36; min SDK is 26.
- [ ] AGP 9.4.0 / Gradle 9.6.0 / JDK 17 build succeeds.
- [ ] URL policy tests pass.
- [ ] Robolectric WebView/security/retry tests pass.
- [ ] Lint has no fatal errors.
- [ ] Only Internet permission is requested.
- [ ] Cleartext and mixed content are disabled.
- [ ] SSL errors are cancelled.
- [ ] No JavaScript/native bridge exists.
- [ ] cligMET HTTPS navigation remains embedded.
- [ ] external HTTPS/mailto/tel navigation leaves the app.
- [ ] malformed, file, JavaScript and HTTP URIs are blocked.
- [ ] Back navigation uses WebView history first.
- [ ] native Retry state works.
- [ ] launcher icon and splash are present.
- [ ] GitHub Actions build succeeds.
- [ ] downloadable `app-debug.apk` artifact exists.
- [ ] APK SHA-256 is recorded for the user.
