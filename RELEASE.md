# Release & build pipeline

How HearthShelf Mobile gets from source to an installable/Play-Store build.
Android first; iOS is a later milestone.

## What's automated (in this repo)

- **CI** (`.github/workflows/ci.yml`): on every PR and push to main, runs
  `tsc --noEmit` + resolves the Expo config. Fast correctness gate. No build,
  no release - so a push can never accidentally ship anything.
- **Android build** (`.github/workflows/build-android.yml`): **manual dispatch
  only** (Actions tab). Prebuilds (runs all config plugins incl. Android Auto +
  standalone-js), assembles a debug APK, uploads it as an artifact. The
  `standalone` input embeds the JS bundle for untethered / in-car installs.

Both check out the `packages/core` submodule (`submodules: recursive`).

> Per repo policy these never auto-trigger a Play release. Promotion to the
> store is a deliberate manual step (below) until we wire signed uploads.

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
- Android build number: set `expo.android.versionCode` (integer, must increase
  for every Play upload). Bump it on each release; CI can be extended to derive
  it from the run number later.
- iOS build number (later): `expo.ios.buildNumber`.

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

## iOS (later milestone)

Same RN codebase. Adds: iOS Google client ID + URL scheme
(`EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME`, already plumbed), a CarPlay Swift
content-tree module mirroring the Android Auto service, the Apple CarPlay audio
**entitlement** request, and a TestFlight pipeline.
