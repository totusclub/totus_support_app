#!/bin/sh
# Дополняет android/ бинарными файлами, которых нет в git:
#   gradlew, gradlew.bat, gradle/wrapper/gradle-wrapper.jar — Gradle Wrapper 8.13 (как в шаблоне RN 0.79);
#   app/debug.keystore — стандартный отладочный ключ Android.
# Запускается автоматически после `npm install` (postinstall) и вручную: npm run bootstrap:android-wrapper
set -e
QUIET=0
[ "$1" = "--quiet" ] && QUIET=1
say() { [ $QUIET -eq 1 ] || echo "$@"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID="$ROOT/android"
PLUGIN="$ROOT/node_modules/@react-native/gradle-plugin"

# 1) Gradle Wrapper
if [ ! -f "$ANDROID/gradle/wrapper/gradle-wrapper.jar" ] || [ ! -f "$ANDROID/gradlew" ]; then
  if [ -f "$PLUGIN/gradle/wrapper/gradle-wrapper.jar" ] && [ -f "$PLUGIN/gradlew" ]; then
    mkdir -p "$ANDROID/gradle/wrapper"
    cp "$PLUGIN/gradle/wrapper/gradle-wrapper.jar" "$ANDROID/gradle/wrapper/gradle-wrapper.jar"
    cp "$PLUGIN/gradlew" "$ANDROID/gradlew"
    [ -f "$PLUGIN/gradlew.bat" ] && cp "$PLUGIN/gradlew.bat" "$ANDROID/gradlew.bat"
    chmod +x "$ANDROID/gradlew"
    say "✅ Gradle Wrapper скопирован из @react-native/gradle-plugin"
  elif command -v gradle >/dev/null 2>&1; then
    (cd "$ANDROID" && gradle wrapper --gradle-version 8.13 --distribution-type bin)
    say "✅ Gradle Wrapper создан командой gradle wrapper"
  else
    say "⚠️  Gradle Wrapper не найден: откройте android/ в Android Studio (создаст wrapper) или установите gradle и повторите."
  fi
fi

# 2) debug.keystore
if [ ! -f "$ANDROID/app/debug.keystore" ]; then
  if command -v keytool >/dev/null 2>&1; then
    keytool -genkeypair -v -keystore "$ANDROID/app/debug.keystore" -storepass android -alias androiddebugkey \
      -keypass android -keyalg RSA -keysize 2048 -validity 10000 \
      -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1 && say "✅ android/app/debug.keystore создан"
  else
    say "⚠️  keytool не найден (нужен JDK 17) — debug.keystore не создан"
  fi
fi
exit 0
