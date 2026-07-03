# Release & build pipeline

How HearthShelf Mobile gets from source to an installable/Play-Store build.
Android first; iOS simulator builds are now wired for early native validation.

## What's automated (in this repo)

- **CI** (`.github/workflows/ci.yml`): on every PR and push to main, runs
  `tsc --noEmit` + resolves the Expo config. Fast correctness gate. No build,
  no release - so a push can never accidentally ship anything.
- **Android build** (`.github/workflows/build-android.yml`): runs **on every
  push to main** (so a fresh sideloadable APK is always waiting) and on **manual
  dispatch** (Actions tab). Prebuilds (runs all config plugins incl. Android Auto
  + standalone-js), assembles a **debug** APK, uploads it as an artifact named
  `app-debug-apk-<run-number>`. Push builds are always standalone (JS embedded,
  runs untethered / in the car); manual dispatch can toggle the `standalone`
  input off. The CI run number is stamped as the Android `versionCode`
  (`EXPO_ANDROID_VERSION_CODE`, read in `app.config.js`) so every build is
  distinguishable on-device and monotonic.
- **iOS simulator build** (`.github/workflows/build-ios-simulator.yml`): runs on
  manual dispatch and on PRs that touch native/app files. It uses a macOS runner
  to prebuild iOS, install Pods, compile an unsigned Simulator `.app`, and upload
  it as an artifact. This does **not** need an Apple developer account, signing
  certificate, provisioning profile, TestFlight, or a device.

Both check out the `packages/core` submodule (`submodules: recursive`).

> The auto-build produces only a **debug-signed** APK - it never touches the
> upload keystore and never publishes to Play. Promotion to the store stays a
> deliberate manual step (below) until we wire signed uploads, so a push still
> cannot ship a release.

## Standalone (no-Metro) builds

A normal debug APK loads its JS from Metro over USB, so it dies when unplugged -
no good for a tester or the car. The `plugins/standalone-js` config plugin sets
`react { debuggableVariants = [] }` so the debug variant embeds its JS while
keeping the debug signing key. It's gated by env so normal Metro dev is
unaffected:

```bash
HEARTHSHELF_STANDALONE_DEBUG=1 npx expo prebuild --platform android
cd android && ./gradlew :app:assembleDebug
```

(Previously this was a manual edit to the gitignored `android/` dir, lost on
every prebuild - see TESTING.md. Now it survives.)

## Versioning

- User-facing version: `app.json` -> `expo.version` (e.g. `0.0.1`).
- Android build number: `expo.android.versionCode` (integer, must increase for
  every Play upload). CI overrides it with the run number via
  `EXPO_ANDROID_VERSION_CODE` (see `app.config.js`); the `app.json` value is the
  local-dev fallback.
- iOS build number (later): `expo.ios.buildNumber`.
  GitHub Actions stamps it from `EXPO_IOS_BUILD_NUMBER`; local fallback is `1`.

## Release signing (manual - needs YOUR keystore)

Not yet automated because it needs the upload keystore as encrypted secrets, and
the keystore lives with you. To do a signed release build:

1. **Create an upload keystore** (once):
   ```bash
   keytool -genkeypair -v -keystore upload.jks -alias upload \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
   Store it OUTSIDE the repo. It's `.gitignore`d (`*.jks`) as a backstop.

2. **Register its SHA-256** with Google (for the Android OAuth client) and Clerk
   - same SHA used for native Google sign-in. See `AUTH_SETUP.md` step 1.

3. **Configure Gradle signing** in `android/app/build.gradle` (or via
   `~/.gradle/gradle.properties` / EAS credentials). Because `android/` is
   gitignored and regenerated, the durable home for this is a small config
   plugin (follow `plugins/standalone-js` as the pattern) or EAS credentials.

4. **Build the release artifact**:
   ```bash
   npx expo prebuild --platform android
   cd android && ./gradlew :app:bundleRelease   # .aab for the Play Store
   ```

## Play Store - internal testing track

1. Create the app in the Play Console (package `com.hearthshelf.mobile`).
2. Enroll in **Play App Signing** (recommended) - grab the app-signing cert
   SHA-256 and register it with Google + Clerk too (end users get that cert).
3. Upload the `.aab` to the **Internal testing** track; add testers by email.
4. Once happy, promote internal -> closed -> open/production.

Automating the upload (fastlane `supply` or EAS Submit) is a follow-up; it needs
a Play service-account JSON as a CI secret.

## Crash reporting (recommended before wider testing)

Add a lightweight error reporter (e.g. Sentry's Expo plugin) so tester crashes
are visible. Defer until there's a tester pool; it's additive.

## iOS

Same RN codebase. Current state:

- Simulator compile is handled by GitHub Actions on macOS.
- iOS background audio mode is declared in `app.config.js`.
- Native Google sign-in stays on browser OAuth until the Web client ID, iOS
  client ID, and iOS URL scheme env vars are all present.
- Device/TestFlight builds still need an Apple developer account, signing
  assets, and either EAS Build/Submit or a macOS signing workflow.
- CarPlay still needs a Swift content-tree module mirroring the Android Auto
  service plus Apple's CarPlay audio entitlement approval.
