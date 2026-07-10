# Release & build pipeline

How HearthShelf Mobile gets from source to an installable/Play-Store build.
Android first; iOS simulator builds are now wired for early native validation.

## Cutting a release (TL;DR)

A release is one command: push a version tag.

```powershell
git tag v0.1.0          # or v0.1.0-beta.1 for the Beta channel
git push origin v0.1.0
```

That single tag drives everything - no file is hand-edited to bump the version:

1. The tag sets the app `version` (and the OTA `runtimeVersion`) via
   `EXPO_PUBLIC_APP_VERSION`, so the build carries `0.1.0` with zero manual edits.
2. A **signed `.aab`** is built and **published to the Play internal track**.
3. The **changelog** for the range since the previous tag is generated and
   uploaded to `hearthshelf.com/changelog`.

Pre-release tags (`v0.1.0-beta.1`, `v0.2.0-rc.2`) normalize to `0.1.0-Beta1` /
`0.2.0-RC2` and land in the site's **Beta** channel. `versionCode` stays the CI
`run_number` (strictly increasing, which is all Google Play requires); it is
deliberately decoupled from the semver `version`.

Tags are only for native/store releases. JS-only OTA pushes ship under the
current tag's `version` via `eas update` and must **not** get a new tag.

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
- **iOS launch check** (`.github/workflows/ios-launch-check.yml`): runs on manual
  dispatch, on PRs, and on main pushes that touch native/app files. It uses a
  macOS runner to prebuild iOS, install Pods, compile an unsigned **Release**
  Simulator `.app`, then boots a simulator, launches the app, and fails on a
  startup crash or a solid-color (black) screen - catching launch regressions for
  free before any metered build. No Apple developer account, signing cert,
  provisioning profile, TestFlight, or device needed. (Replaced the old
  `build-ios-simulator.yml`, which only compiled and never launched the app.)

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

- **Via a tag (the real path):** push `v<semver>` (see "Cutting a release"
  above). `build-android-release.yml` triggers on `push: tags: ['v*']`, builds
  the signed `.aab`, publishes it to the Play **internal** track, and uploads the
  changelog. The signed artifact is also kept under `app-release-aab-<run>`.
- **Via manual dispatch (artifact only):** Actions tab -> **Build Android
  Release** -> Run workflow. Pick `aab` or `apk`. A dispatch run produces a
  signed artifact but **skips** the Play publish + changelog steps (those are
  gated on the tag event), so a manual run can never ship to the store. Dispatch
  builds carry the fallback version `0.0.1` (no tag to read).

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

The app already exists in the Play Console (package `com.hearthshelf.mobile`)
with an internal-test track. The tag build **auto-publishes** to it via
`r0adkll/upload-google-play` (`track: internal`, `status: completed`), using the
`PLAY_SERVICE_ACCOUNT_JSON` secret. To go wider, promote internal -> closed ->
open/production in the console.

Requirements for the auto-publish to succeed:
- `PLAY_SERVICE_ACCOUNT_JSON` secret set (the `play-service-account@hearthshelf`
  service account). Already set.
- The service account must have **Release to internal testing** permission in
  the Play Console (Users & permissions).
- Enroll in **Play App Signing** and register the app-signing cert SHA-256 with
  Google + Clerk (end users get that cert, not the upload key). See `AUTH_SETUP.md`.

## Changelog publishing

On a tag push the release workflow generates a structured changelog and POSTs it
to the website API at `https://hearthshelf.com/api/v1/changelogs`, where it shows
at `/changelog`.

- **How it's built:** `.github/scripts/changelog-items.sh` walks
  `git log <prev-tag>..<tag>` (full history on the first-ever tag), categorizes
  each commit subject into a section (`feature`/`fix`/`change`/`docs`/`breaking`/
  `other`) from its prefix, strips the verb prefix, and emits one structured item
  per commit. `.github/scripts/upload-changelog.sh` POSTs the JSON and renders a
  human `CHANGELOG.md` from the same items.
- **Tags:** each line item is tagged on the **website** (server-side rules) by
  content - `Android Auto`->`android-auto`, `iPhone`/`CarPlay`->`ios`, plus
  audiobook-area tags (offline, downloads, sleep-timer, player, sync, sign-in,
  series). You can force a tag from a commit subject with a trailing marker, e.g.
  `Fix chapter skip on the head unit [AA] #player`. The website filters and sorts
  large changelogs by section and tag.
- **Secret:** `CHANGELOG_API_KEY` (repo secret) must equal the website's
  `CHANGELOG_API_KEY` Pages binding. **Done:** a shared 32-byte token was set in
  all three places (production Pages secret, the website's local `.dev.vars`, and
  this repo's GitHub secret) and the auth round-trip was verified locally (correct
  token -> 201, wrong token -> 401). To rotate it later, reset all three:
  `wrangler pages secret put CHANGELOG_API_KEY` on the website +
  `gh secret set CHANGELOG_API_KEY` here + update the website `.dev.vars`.

> **Rollout order (one-time):** the website schema + API must be deployed before
> the first mobile tag push, or the upload 400s. Steps, in order:
>
> 1. **Reset the remote D1 to the new schema.** `migrations/0001_changelogs.sql`
>    was rewritten in place (the remote is empty, so no data is lost), but
>    wrangler already has `0001` marked applied and won't re-run it. Apply the new
>    schema directly from the website repo:
>    `wrangler d1 execute hearthshelf-changelog --remote --file migrations/0001_changelogs.sql`
>    (the file is self-contained: it `DROP`s the old `changelogs` table and
>    rebuilds all three tables).
> 2. **Deploy the site** (push HearthShelf-Website; CF Pages builds the new
>    functions + `/changelog` page).
> 3. **Confirm `CHANGELOG_API_KEY` matches** across the repo secret and the
>    production Pages binding (see the caveat above).
> 4. **Then cut the first tag** here.

## Crash reporting (recommended before wider testing)

Add a lightweight error reporter (e.g. Sentry's Expo plugin) so tester crashes
are visible. Defer until there's a tester pool; it's additive.

## iOS

Same RN codebase. iOS releases go to TestFlight the same way Android goes to
Play: **push a version tag** and GitHub Actions does the rest - no EAS.

### iOS release path (GitHub Actions + fastlane, no EAS Build)

`.github/workflows/build-ios-release.yml` triggers on `push: tags: ['v*']`,
runs on a GitHub-hosted macOS runner, and via `fastlane/Fastfile`:

1. Prebuilds iOS with the tag as `version` + `run_number` as the build number
   (`eas.json` is `appVersionSource=local`, so these env values win - no EAS
   remote autoIncrement).
2. Imports the distribution cert into a throwaway keychain, installs the
   provisioning profile, forces manual signing.
3. `build_app` (archive + export, `app-store` method) -> signed IPA.
4. `upload_to_testflight` via the App Store Connect **API key** (.p8).

**Why not EAS Build:** the EAS free tier caps iOS at **15 builds/month**. This
path uses GitHub's macOS runners instead (far more headroom) and the same signing
assets. The account's only 2FA is two YubiKeys, which breaks interactive Apple
login - the ASC **API key** sidesteps that entirely (no Apple login anywhere).

**EAS Update (OTA) is kept** - it's separate from EAS Build, free-tier, and still
serves JS-only OTA pushes via `updates.url` + `runtimeVersion` in `app.config.js`.
`.eas/workflows/ios-testflight.yml` is kept as a **deprecated manual fallback**
only (it ships version 0.0.1 since EAS runs don't set the version env vars).

### Required iOS secrets (all set)

| Secret | What | Source |
|---|---|---|
| `ASC_KEY_P8_BASE64` | App Store Connect API key (.p8), base64 | `AuthKey_PWB6X686S2_EAS.p8` |
| `ASC_KEY_ID` | ASC key id (`PWB6X686S2`) | key filename |
| `ASC_ISSUER_ID` | ASC issuer id | App Store Connect -> Users and Access -> Keys |
| `IOS_DIST_P12_BASE64` | Apple Distribution cert + key (.p12), base64 | `dist.p12` |
| `IOS_DIST_P12_PASSWORD` | the .p12 export password (`hearthshelf`) | you (set) |
| `IOS_PROVISION_PROFILE_BASE64` | App Store profile, base64 | `HearthShelf_App_Store.mobileprovision` |

Signing identity: `Apple Distribution: Jeremy Powers (HCU6KVPTDC)`, profile
`HearthShelf App Store`, bundle `com.hearthshelf.mobile`, team `HCU6KVPTDC`. The
fastlane lane references the profile **by name**, not UUID, so re-issuing the
profile (which mints a new UUID) needs only a re-upload of the .mobileprovision
into `IOS_PROVISION_PROFILE_BASE64` - no cert change, no Fastfile edit. A profile
scope change (e.g. new entitlement) re-signs the profile against the SAME cert;
the `dist.p12` stays valid. Cert/profile expire 2027-07-09.

> **Before the first iOS tag, one thing left to verify:**
> - **`ASC_ISSUER_ID`** is currently set from notes
>    (`8fa5bf6f-7ea5-4d8a-bbd5-c5e728baf2f9`) - confirm it against App Store
>    Connect -> Users and Access -> Keys (the issuer id shown above the key list).
>    A wrong issuer id fails the TestFlight upload.

### Other iOS notes

- Simulator launch check is a separate PR gate (`ios-launch-check.yml`, unsigned).
- iOS background audio mode is declared in `app.config.js`.
- The native iOS media controller + CarPlay browse/play surface lives in
  `plugins/hearthshelf-carplay` and is copied into the generated iOS project by
  its Expo config plugin.
- Native Google sign-in stays on browser OAuth until the Web client ID, iOS
  client ID, and iOS URL scheme env vars are all present.
- CarPlay uses Apple's `com.apple.developer.carplay-audio` entitlement
  (approved). The plugin always writes it - a signed build needs it or the app
  never appears in the CarPlay app grid. Unsigned simulator/CI builds don't
  validate entitlements, so it's harmless there.
