# Building & testing the spike locally

The build toolchain is installed on this machine (no EAS needed):

- **Android Studio** (winget `Google.AndroidStudio`) - bundles JDK 21 (JBR).
- **Android SDK** at `%LOCALAPPDATA%\Android\Sdk` - platform-tools (adb),
  platform 35, build-tools. `ANDROID_HOME` / `JAVA_HOME` persisted to the user env.
- **JDK 21** (winget `EclipseAdoptium.Temurin.21.JDK`) at
  `C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot` - the build uses
  this. RN 0.85 / AGP 9 require a Java 21 toolchain; JDK 17 fails with
  `Cannot find a Java installation ... matching {languageVersion=21}`.
- **Android Auto Desktop Head Unit (DHU)** at
  `%LOCALAPPDATA%\Android\Sdk\extras\google\auto\desktop-head-unit.exe`.

## iOS from Windows

Local iOS native generation/builds are not available on Windows; Expo refuses to
generate the iOS project here and Xcode only runs on macOS. Use the GitHub
Actions workflow **Build iOS Simulator** instead. It runs on a macOS runner,
prebuilds the iOS project, installs Pods, compiles an unsigned Simulator `.app`,
and uploads it as an artifact.

This does not require an Apple developer account or a physical device. It proves
the native iOS project compiles, but it does not prove device signing,
TestFlight, push/entitlement behavior, or CarPlay.

The iOS media controller and CarPlay source of truth is
`plugins/hearthshelf-carplay/`. It owns AVPlayer playback, lock-screen media
commands, and `MPPlayableContentManager` browse/play callbacks. A real CarPlay
launcher will not show the app until Apple grants the playable-content
entitlement; set `HEARTHSHELF_IOS_CARPLAY_ENTITLEMENT=1` only for signed builds
using an Apple profile that actually includes that entitlement.

## Gradle gotcha (already fixed in `android/gradle.properties`)

RN 0.85 / AGP 9 need a JDK 21 toolchain, and toolchain auto-download is off, so
Gradle must be pointed at an installed JDK 21 explicitly. Without the pin the
build fails with `Cannot find a Java installation ... matching {languageVersion=21}`.
`scripts/deploy.ps1` re-asserts this after every prebuild.

```properties
org.gradle.java.installations.auto-download=false
org.gradle.java.installations.paths=C:/Program Files/Eclipse Adoptium/jdk-21.0.11.10-hotspot
```

## Peer deps that must be installed (Clerk + expo-router)

`create-expo-app` + ad-hoc installs don't pull every transitive native peer, so
these had to be added explicitly (all at SDK-57 versions; `expo install --check`
stays green):

- expo-router needs: `expo-linking`, `expo-constants`, `expo-status-bar`
- @clerk/clerk-expo needs: `expo-web-browser`, `expo-auth-session`,
  `expo-crypto`, and `react-dom` (Clerk transitively imports `@clerk/clerk-react`)
- Metro transform needs `babel-preset-expo` present

These ship **native** code, so after adding them you must **re-run prebuild and
rebuild the APK** - a JS-only reload throws `Cannot find native module
'ExpoLinking'` because the old APK lacks the native side. Lesson: add native deps
*before* building, or rebuild after.

> Do NOT run `ncu -u` here. This is an Expo SDK 57 app; `expo install --check`
> is the source of truth for versions. `ncu` wants to bump react-native, gesture-
> handler, and async-storage past what SDK 56 supports, which breaks the native
> build. "Up to date" for an Expo app = "matches the SDK," and it already does.

## Quick loop: boot the emulator, then build + install + launch

`scripts/boot-emulator.ps1` starts the AVD ("hs_auto") and waits until it's ready.
`scripts/deploy.ps1` then wraps the whole build/install/launch loop (x86_64-only build
~= 4x faster than all-arch, auto-uninstall on version downgrade, then launch). Pinned to
`emulator-5554` so a plugged-in phone is never touched.

```powershell
npm run emulator            # boot the AVD (no build)
npm run deploy              # JS-only change: build + install + launch
npm run deploy:native       # native (Kotlin / config-plugin) change - runs prebuild first
# deploy flags: -Clean (wipe CMake caches for the libworklets.so ninja error), -NoLaunch, -Serial <id>
./scripts/deploy.ps1 -Prebuild -Clean
```

## Build the debug APK (manual)

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot"
cd C:\code\HearthShelf\mobile\android
.\gradlew.bat assembleDebug
# APK -> android/app/build/outputs/apk/debug/app-debug.apk
```

## Install on a device / emulator

```powershell
adb devices                 # confirm a device/emulator is attached
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

Start the Metro bundler (the debug build loads JS from it):

```powershell
cd C:\code\HearthShelf\mobile
npx expo start --dev-client
```

Sign in on the phone, confirm a book plays (NowPlayingBar shows title + transport).

## Standalone (no-Metro) build for the truck

A normal debug APK loads its JS from Metro over USB, so it breaks the moment you
unplug from the PC. For an untethered in-car test, embed the JS in the APK by
setting `debuggableVariants = []` in `android/app/build.gradle`'s `react {}`
block, then `assembleDebug`. This keeps the **debug signing key** (which Clerk's
assetlinks already trusts) while bundling the JS so the app runs on its own.

> This edit is in the gitignored generated `android/` dir, so it's lost on
> re-prebuild. For a permanent setup it belongs in an Expo config plugin.

## Emulator is NOT viable for the Android Auto test

The Play emulator images ship only `AndroidAutoStubPrebuilt` - a stub, not the
real Android Auto. The DHU can't connect to it without installing real Android
Auto from the Play Store (Google sign-in + setup), which is historically flaky.
**Use a real phone + a real car** instead - it's easier and more authoritative.

## Desk-test the native media service (predicts the truck, no driving)

Confirm Android Auto can DISCOVER the app as a media app and the token bridge
worked, before going to the car:

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
# 1. Android Auto's own discovery query must return our service:
& $adb shell cmd package query-services --brief -a android.media.browse.MediaBrowserService | Select-String hearthshelf
#   -> com.hearthshelf.mobile/.HearthShelfAutoService
# 2. The JS->native bridge must have written the ABS server URL + token:
& $adb shell run-as com.hearthshelf.mobile cat /data/data/com.hearthshelf.mobile/shared_prefs/hearthshelf_auto.xml
#   -> <string name="serverUrl">...</string> <string name="token">...</string>
```

If both pass, the only untested mile is a real browser client connecting and
calling onGetChildren - which is what the car does. (A nav-category app like the
old @iternio build would NOT appear in query #1 at all.)

## Test Android Auto in your car (the real test)

1. On the phone, open **Android Auto** settings (Settings > Connected devices >
   Android Auto). Scroll to the bottom > tap **Version** ~10x > developer mode.
2. Open the **(three-dot menu) > Developer settings** and enable **"Unknown
   sources"** - without it, Android Auto hides sideloaded apps from the car.
3. Plug the phone into the car via USB; let Android Auto start.
4. Open the car's app launcher; **HearthShelf** should appear. Tap it - you get
   Continue Listening + your libraries > a book > tap to play through the car.

If HearthShelf doesn't appear in the car launcher, it's the sideload/category
gate (Unknown sources, or @iternio's nav-category default), not a code fault.

## Test Android Auto in the DHU (only if you install real Android Auto)

1. On the phone/emulator, enable Android Auto **head-unit server**:
   - Install "Android Auto" (it's built into modern Android; on an emulator use a
     Play-enabled image).
   - Android Auto > Settings > tap the version 10x to unlock Developer mode >
     overflow menu > **Start head unit server**.
2. Forward the port and launch the DHU:
   ```powershell
   adb forward tcp:5277 tcp:5277
   & "$env:LOCALAPPDATA\Android\Sdk\extras\google\auto\desktop-head-unit.exe"
   ```
3. The DHU window opens the car UI. Launch HearthShelf from the car launcher -
   you should see the root list (Continue Listening + libraries), drill into a
   library, tap a book, and get playback + transport on the car screen.

### Notes / current limits

- **Covers in the car need HTTPS** - `@iternio` blocks `http://` images (ATS).
- `@iternio`'s service is nav-category by default; the app advertises the
  `template` capability via `res/xml/automotive_app_desc.xml`. If the car
  launcher doesn't list the app, that file + the merged `CarAppService` manifest
  entry are what Android Auto keys off of.
- Spike scope: one linked server, first page per library, no in-car search /
  chapters / sleep timer yet.
