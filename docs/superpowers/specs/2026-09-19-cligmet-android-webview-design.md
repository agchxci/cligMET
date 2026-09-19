# cligMET Android WebView App — Design Specification

Date: 2026-09-19
Status: Approved concept; implementation pending written-spec review

## Purpose

Create an installable Android application for cligMET that presents the existing live cligMET web interface as an app without duplicating the frontend or backend. The Android app should feel native enough to install and launch from the home screen, while continuing to use https://cligmet.xyz as the single source of UI behavior.

Success means a user can install an APK on an Android phone, launch cligMET from its own icon, use the existing graphs and fullscreen crosshair interactions normally, navigate safely, and recover cleanly from temporary network failure.

## Scope

Version 1 will include:

- Android application name: `cligMET`
- Application package: `xyz.cligmet.app`
- Kotlin Android project
- Target SDK: Android 16 / API 36
- Minimum SDK: API 26 (Android 8.0)
- Single primary activity
- Full-size WebView loading `https://cligmet.xyz`
- JavaScript enabled
- DOM storage enabled
- WebView history support
- Android back-button/back-gesture integration
- cligMET-owned URLs remain inside the app
- External URLs open in the user's default browser
- Native splash screen
- Native launcher icon
- Network/offline error state with Retry
- HTTPS-only navigation for the cligMET origin
- Build automation that produces a debug/installable APK artifact
- Repository documentation with local build and sideload instructions

Version 1 will not include:

- Push notifications
- Home-screen widgets
- Native weather data polling
- Background services
- Location permissions
- User accounts
- Native chart reimplementation
- Native JavaScript bridges
- Google Play publishing
- Analytics SDKs

These may be added later as independent features.

## Repository Structure

The Android app will live in a separate repository:

`agchxci/cligMET_android`

The existing `agchxci/cligMET` repository remains the public web frontend. The Android project must not copy the current graph implementation into native Android code.

Expected Android repository structure:

```
cligMET_android/
├── .github/
│   └── workflows/
│       └── build-apk.yml
├── app/
│   ├── build.gradle.kts
│   ├── proguard-rules.pro
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/xyz/cligmet/app/MainActivity.kt
│       └── res/
│           ├── drawable/
│           ├── mipmap-*/
│           ├── values/
│           └── xml/
├── build.gradle.kts
├── settings.gradle.kts
├── gradle.properties
└── README.md
```

## Runtime Architecture

The app is deliberately thin:

```
Android app
  └── WebView
        └── https://cligmet.xyz
              └── Render receiver / existing public data services
```

The Android application contains no weather-model logic and no duplicate historical-data store.

Updates to the live cligMET website therefore appear in the Android app automatically after the page reloads.

## WebView Behavior

The WebView will:

- load `https://cligmet.xyz` on launch;
- enable JavaScript;
- enable DOM storage;
- disable mixed-content loading;
- reject unsafe SSL errors rather than bypassing them;
- avoid `addJavascriptInterface` or equivalent JavaScript/native bridge APIs;
- allow normal touch gestures used by the current charts;
- preserve fullscreen chart interactions implemented by the website;
- use the system WebView implementation supplied by Android.

Only navigation belonging to the cligMET web origin should remain inside the WebView. HTTP URLs, non-cligMET HTTPS URLs and other external destinations should be delegated to an Android browser/activity where possible.

## Navigation

Android Back behavior:

1. If the WebView has browser history, navigate back within the WebView.
2. Otherwise allow the Activity to close normally.

The app must not unexpectedly exit when a user has navigated from one cligMET page/state to another that created WebView history.

The cligMET site's existing fullscreen graph close button remains controlled by the website. No native duplicate fullscreen UI is required.

## Offline and Error Handling

The initial page load may fail if:

- the phone is offline;
- DNS fails;
- the cligMET origin is temporarily unavailable;
- the request times out.

For these cases, the native shell will display a simple error state containing:

- cligMET branding/title;
- a short message that the live weather page could not be reached;
- a Retry button.

Retry reloads the configured start URL.

The app will not attempt to provide a separate cached weather experience in Version 1. WebView's normal resource cache may operate, but cached content must not be presented as guaranteed current weather.

## Security

Version 1 uses the following security rules:

- `INTERNET` permission only.
- No location permission.
- No storage permission.
- No microphone/camera permission.
- No JavaScript/native bridge.
- Cleartext HTTP traffic disabled.
- Mixed content disabled.
- SSL certificate errors are cancelled, never ignored.
- Only expected cligMET host navigation stays embedded.
- File access and content access should remain disabled unless Android's WebView defaults require an explicit safe setting.
- No secrets or API tokens are embedded in the APK.

The application uses the same public cligMET endpoints already accessible to the website.

## Native Presentation

The native layer will provide:

- cligMET launcher icon;
- Android splash screen using cligMET branding;
- edge-to-edge layout;
- system status/navigation bars configured for readable contrast;
- app title `cligMET`.

The webpage remains visually responsible for the application's main interface.

## Configuration

The start URL will be defined in Android code/build configuration as:

`https://cligmet.xyz`

The package identifier is:

`xyz.cligmet.app`

No production secret is required.

## Build and APK Distribution

A GitHub Actions workflow will build the Android app whenever requested manually and/or when changes are pushed to the default branch.

Initial output:

- unsigned/debug APK suitable for direct sideloading on the user's own Android device.

The workflow should expose the APK as a downloadable GitHub Actions artifact.

For direct local development, the project can also be built with the Gradle wrapper.

A future Play Store release would add:

- release signing;
- Android App Bundle (.aab);
- Play Console metadata;
- production release workflow.

Those are outside Version 1.

## Testing

Before completion, verify:

1. Gradle project builds successfully.
2. APK is produced.
3. Manifest contains only required permissions.
4. WebView launches `https://cligmet.xyz`.
5. JavaScript and DOM storage are enabled.
6. HTTP/mixed-content navigation is blocked.
7. External links are handed to Android rather than embedded.
8. Android Back navigates WebView history first.
9. Failed page loads expose the Retry UI.
10. Existing cligMET fullscreen charts and crosshair work through WebView touch interaction.
11. Rotation/resizing does not leave a blank WebView.
12. App relaunch returns to a usable cligMET view.

Where practical, logic that decides whether a URL is internal or external should be isolated and unit tested.

## Delivery

Version 1 is complete when:

- `agchxci/cligMET_android` contains the source;
- the repository build workflow succeeds;
- an installable APK artifact is produced;
- README contains sideload instructions;
- the app launches the live cligMET interface on Android;
- there are no native permissions beyond Internet access.

