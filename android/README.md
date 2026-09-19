# cligMET Android

Thin Android WebView shell for the live cligMET weather interface.

## Build

The GitHub Actions workflow builds and tests the app automatically.

Local build:

```bash
gradle testDebugUnitTest lintDebug assembleDebug
```

APK output:

```text
app/build/outputs/apk/debug/app-debug.apk
```

## Install on Android

1. Download the `cligMET-debug-apk` workflow artifact.
2. Extract `app-debug.apk`.
3. Open the APK on the phone.
4. If Android asks, allow **Install unknown apps** for the browser or Files app you used.
5. Install and launch **cligMET**.

The app loads the live `https://cligmet.xyz` interface, so normal website UI updates appear in the app without rebuilding the APK.
