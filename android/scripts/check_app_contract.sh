#!/usr/bin/env bash
set -euo pipefail

manifest="app/src/main/AndroidManifest.xml"
build_file="app/build.gradle.kts"

permissions="$(grep -o 'android.permission.[A-Z_]*' "$manifest" | sort -u || true)"
[[ "$permissions" == "android.permission.INTERNET" ]] || {
  echo "Unexpected permissions: $permissions"
  exit 1
}

grep -q 'android:usesCleartextTraffic="false"' "$manifest"
grep -q 'android:networkSecurityConfig="@xml/network_security_config"' "$manifest"
grep -q 'android:icon="@mipmap/ic_launcher"' "$manifest"
grep -q 'android:roundIcon="@mipmap/ic_launcher_round"' "$manifest"
grep -q 'targetSdk = 36' "$build_file"
grep -q 'minSdk = 26' "$build_file"
grep -q 'cleartextTrafficPermitted="false"' app/src/main/res/xml/network_security_config.xml

test -f app/src/main/res/drawable/ic_cligmet.xml
test -f app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml
test -f app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml
test -f app/src/main/res/values-v31/styles.xml

if grep -R -q 'addJavascriptInterface' app/src/main/java; then
  echo "JavaScript bridge found"
  exit 1
fi

echo "Android app contract OK"
