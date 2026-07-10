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

## Release signing

Signed releases are built by **GitHub Actions**
(`.github/workflows/build-android-release.yml`), **manual dispatch only** - never
on push, so a merge can never ship to the store. The upload keystore lives with
you (backed up on Unraid) and in GitHub as encrypted secrets; it is never in the
repo.

How the wiring works: the `plugins/hearthshelf-signing` config plugin injects a
release `signingConfig` into `android/app/build.gradle` at prebuild (because
`android/` is gitignored and regenerated, a hand edit wouldn't survive - same
durability pattern as `standalone-js`). It reads the keystore path + passwords as
Gradle properties, so **no secret is ever written into build.gradle**. The plugin
is inert unless `HEARTHSHELF_RELEASE_SIGNING=1`, so normal debug dev is
unaffected.

### One-time setup

1. **Create an upload keystore** (once, on your machine):
   ```powershell
   keytool -genkeypair -v -keystore upload.jks -alias upload `
     -keyalg RSA -keysize 2048 -validity 10000
   ```
   Answer the prompts; remember the **store password**, **alias** (`upload`), and
   **key password**. Store `upload.jks` OUTSIDE the repo and back it up (Unraid).
   It's `.gitignore`d (`*.jks`) as a backstop. **Losing it is not fatal under
   Play App Signing** (you can request an upload-key reset from Google), but keep
   it safe anyway.

2. **Add the GitHub Actions secrets** (repo Settings -> Secrets and variables ->
   Actions):
   - `ANDROID_KEYSTORE_BASE64` - base64 of the keystore:
     ```powershell
     [Convert]::ToBase64String([IO.File]::ReadAllBytes("upload.jks")) | Set-Content upload.jks.b64
     ```
     Paste the contents of `upload.jks.b64` (then delete that file).
   - `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

3. **Register the right SHA-256 for native Google sign-in.** With **Play App
   Signing** (recommended, see below) Google re-signs the app, so end users get
   **Google's** app-signing cert - NOT your upload key. Register the
   **Play Console app-signing key SHA-256** (Play Console -> Setup -> App
   integrity -> App signing), plus your **debug** SHA for dev builds. Your
   *upload* key SHA is not what users receive, so it is not the one to register
   for production sign-in. See `AUTH_SETUP.md`.

### Building a release

- **Via CI (the real path):** Actions tab -> **Build Android Release** ->
  Run workflow. Pick `aab` (Play upload) or `apk` (signed sideload test). The
  signed artifact is uploaded under `app-release-aab-<run>` / `app-release-apk-<run>`.

- **Locally (to test the pipeline before trusting CI):** set the signing env
  vars (see `.env.example` "Android RELEASE signing"), then:
  ```powershell
  $env:HEARTHSHELF_RELEASE_SIGNING = '1'
  npx expo prebuild --platform android
  cd android
  ./gradlew :app:bundleRelease `
    "-PHEARTHSHELF_RELEASE_KEYSTORE_PATH=C:\path\to\upload.jks" `
    "-PHEARTHSHELF_RELEASE_KEYSTORE_PASSWORD=..." `
    "-PHEARTHSHELF_RELEASE_KEY_ALIAS=upload" `
    "-PHEARTHSHELF_RELEASE_KEY_PASSWORD=..."
  ```
  (Or put those four as `HEARTHSHELF_RELEASE_*` in `gradle.properties`.) The
  `.aab` lands in `android/app/build/outputs/bundle/release/`.

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
- The native iOS media controller + CarPlay browse/play surface lives in
  `plugins/hearthshelf-carplay` and is copied into the generated iOS project by
  its Expo config plugin.
- Native Google sign-in stays on browser OAuth until the Web client ID, iOS
  client ID, and iOS URL scheme env vars are all present.
- Device/TestFlight builds still need an Apple developer account, signing
  assets, and either EAS Build/Submit or a macOS signing workflow.
- CarPlay uses Apple's `com.apple.developer.carplay-audio` entitlement
  (approved). The plugin writes that entitlement by default - a signed build
  needs it or the app never appears in the CarPlay app grid. Unsigned
  simulator/CI builds set `HEARTHSHELF_IOS_CARPLAY_ENTITLEMENT=0` to skip it,
  since their provisioning has no CarPlay capability.
