// Single source of truth for Expo config (app.json was folded in here).
//
// Using app.config.js lets us:
//  - enable tsconfig "paths" (@/* -> ./src/*) resolution in Metro,
//  - surface public build-time config into expo-constants `extra` so
//    src/lib/config.ts can read it from both process.env (EXPO_PUBLIC_*)
//    and Constants.expoConfig.extra,
//  - stamp the CI run number as the Android versionCode.
//
// New Architecture is the only architecture on SDK 57, so there is no
// `newArchEnabled` field - it is always on.

// All values here are PUBLIC by design (see .env.example). The Google client
// SECRET is never here - it lives only in the Clerk dashboard.
// EAS project id for the HearthShelf org project. Public identifier (safe to
// commit); an env var overrides it if you ever point at a different project.
const EAS_PROJECT_ID =
  process.env.EXPO_PUBLIC_EAS_PROJECT_ID || '90f5f764-46e9-4caa-aa2a-dc5b78be191c'

// Public client identifiers, committed as defaults so EVERY build path bakes
// them - local deploy.ps1, the APK workflow, and the release workflow. None of
// these reach CI via .env (it's gitignored), and they are PUBLIC by design: an
// OAuth *client ID* and a Clerk *publishable* key are meant to ship in the app
// bundle. The Google client SECRET is never here - it lives only in the Clerk
// dashboard. An env var still overrides each one (e.g. to point a dev build at a
// different Clerk instance). Without these baked in, NATIVE_GOOGLE_ENABLED was
// false in every shipped build, so all users fell back to browser-tab Google.
const CONTROL_PLANE_URL =
  process.env.EXPO_PUBLIC_CONTROL_PLANE_URL || 'https://api.hearthshelf.com'
const CLERK_PUBLISHABLE_KEY =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY || 'pk_live_Y2xlcmsuaGVhcnRoc2hlbGYuY29tJA'
const GOOGLE_WEB_CLIENT_ID =
  process.env.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID ||
  '177026646968-b8rc4r5gf2u4tc9vde7tpjiii8gbdpfs.apps.googleusercontent.com'
const GOOGLE_ANDROID_CLIENT_ID =
  process.env.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID ||
  '177026646968-r13c46b7ia9dgvsbjoq8c7aom9137ust.apps.googleusercontent.com'
const GOOGLE_IOS_CLIENT_ID =
  process.env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID ||
  '177026646968-rprkhf1i7dbdcfqgf717dgp0d7g06f4l.apps.googleusercontent.com'
const GOOGLE_IOS_URL_SCHEME =
  process.env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME ||
  'com.googleusercontent.apps.177026646968-rprkhf1i7dbdcfqgf717dgp0d7g06f4l'

const extra = {
  EXPO_PUBLIC_CONTROL_PLANE_URL: CONTROL_PLANE_URL,
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: CLERK_PUBLISHABLE_KEY,
  EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: GOOGLE_WEB_CLIENT_ID,
  EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: GOOGLE_ANDROID_CLIENT_ID,
  EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: GOOGLE_IOS_CLIENT_ID,
  EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: GOOGLE_IOS_URL_SCHEME,
  // Expo push (release notifications). The EAS project id is PUBLIC (not a
  // secret), so it's hardcoded here per Expo's dynamic-config guidance - that
  // also lets the `eas` CLI resolve it without trying (and failing) to write to
  // this dynamic config. An env var can still override it for a different
  // project. Delivery additionally needs FCM credentials on the build (see
  // docs/PUSH_SETUP.md); without them push just stays off and the in-app
  // countdown still works.
  EXPO_PUBLIC_EAS_PROJECT_ID: EAS_PROJECT_ID,
  eas: { projectId: EAS_PROJECT_ID },
}

// The release tag is the single source of version truth. The tag-driven CD
// workflow exports EXPO_PUBLIC_APP_VERSION from the pushed tag (leading "v"
// stripped and the pre-release label normalized, e.g. v0.1.0-beta.1 ->
// 0.1.0-Beta1). runtimeVersion.policy is `appVersion`, so this value keys OTA
// compatibility: it MUST change on every native/store release, which a distinct
// release tag guarantees. Locally / off-tag it falls back to the static value
// below so `expo start` and debug builds keep working with no manual bump.
// 0.0.2: EAS previously published 0.0.1 up to build 12. The GitHub iOS pipeline
// stamps its run_number as the iOS buildNumber, which would collide with those
// EAS builds under 0.0.1 once run_number passes 12 (App Store Connect rejects a
// duplicate version+build). Bumping the fallback version gives the GitHub pipeline
// a clean build-number namespace. A release tag still overrides this.
const appVersion = process.env.EXPO_PUBLIC_APP_VERSION || '0.0.2'

// iOS CFBundleShortVersionString must be a plain dotted number (max 3 integers,
// no letters/suffix) or App Store Connect rejects the upload. A pre-release tag
// like v0.1.0-beta.1 normalizes to `0.1.0-Beta1` for the changelog/Play channel,
// but iOS needs just `0.1.0`. Strip any pre-release tail for the iOS marketing
// version; the "beta-ness" is expressed by the TestFlight track, not the string.
// (Android versionName and the OTA runtimeVersion keep the full appVersion.)
const iosMarketingVersion = appVersion.replace(/-.*$/, '')

// The full tag version (with any pre-release tail, e.g. 0.0.2-R2) for display in
// the app's More menu. It CANNOT be read back from Constants.expoConfig.version
// at runtime: on iOS that returns CFBundleShortVersionString, which is the plain
// iosMarketingVersion (Apple rejects a lettered marketing string), so the "-R2"
// is gone. Baking it into `extra` surfaces the true tag version on both platforms.
extra.fullVersion = appVersion

// CI stamps the run number as the Android versionCode (EXPO_ANDROID_VERSION_CODE)
// so every build is distinguishable on-device and strictly monotonic (Play's
// hard requirement). It is deliberately decoupled from the semver `version` -
// Play only needs versionCode to increase, not to encode the version.
//
// The offset clears versionCodes from earlier manual Android Studio uploads
// (the first internal release was code 6). Without it, a fresh workflow whose
// run_number is <= that would produce a code Play rejects with "existing users
// cannot upgrade". run_number + 10 stays strictly increasing and always wins.
// Locally / when unset, fall back to the static value below.
const VERSION_CODE_OFFSET = 10
const versionCode = process.env.EXPO_ANDROID_VERSION_CODE
  ? Number(process.env.EXPO_ANDROID_VERSION_CODE) + VERSION_CODE_OFFSET
  : 1

// iOS build numbers are strings in Expo/Apple tooling. GitHub Actions can stamp
// this with its run number; local builds fall back to the static value.
const iosBuildNumber = process.env.EXPO_IOS_BUILD_NUMBER || '1'

module.exports = {
  name: 'HearthShelf',
  slug: 'hearthshelf',
  owner: 'hearthshelf',
  version: appVersion,
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: 'hearthshelf',
  userInterfaceStyle: 'automatic',
  // EAS Update: JS/asset-only changes ship over-the-air (no build slot, no CI
  // minutes). runtimeVersion is tied to the app version - it MUST change on any
  // native change (new native dep, config-plugin/native config edit) so an OTA
  // bundle never lands on an incompatible binary. Bump `version` for those.
  runtimeVersion: { policy: 'appVersion' },
  updates: {
    url: 'https://u.expo.dev/90f5f764-46e9-4caa-aa2a-dc5b78be191c',
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.hearthshelf.mobile',
    // Plain dotted marketing version (pre-release tail stripped) - see
    // iosMarketingVersion above. App Store Connect rejects a suffixed
    // CFBundleShortVersionString.
    version: iosMarketingVersion,
    buildNumber: iosBuildNumber,
    // Universal Links: lets https://app.hearthshelf.com/invite open the app
    // directly (verified against the apple-app-site-association file hosted at
    // that domain's /.well-known/). Team ID HCU6KVPTDC + this bundle id make the
    // appID in that file. Invite links resolve in-app instead of the browser.
    associatedDomains: ['applinks:app.hearthshelf.com'],
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      // audio: background playback; processing: offline-progress background flush
      // (expo-background-task also adds this during prebuild).
      UIBackgroundModes: ['audio', 'processing'],
      // Reversed-client-ID URL scheme for Clerk's native Google sign-in on iOS.
      // The native Google flow redirects back to the app via this scheme; without
      // it registered here the redirect has nowhere to land and native Google
      // can't complete on iOS. (Android uses Credential Manager, no scheme needed.)
      CFBundleURLTypes: [{ CFBundleURLSchemes: [GOOGLE_IOS_URL_SCHEME] }],
    },
  },
  android: {
    package: 'com.hearthshelf.mobile',
    versionCode,
    // FCM credentials for Expo push (release notifications). Optional: point
    // GOOGLE_SERVICES_JSON at a Firebase google-services.json to enable Android
    // push. Without it the build has no FCM sender and push tokens won't mint;
    // the in-app countdown still works. See docs/push-setup.md.
    ...(process.env.GOOGLE_SERVICES_JSON
      ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON }
      : {}),
    adaptiveIcon: {
      backgroundColor: '#1B1A18',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    // App Links: verified https://app.hearthshelf.com/invite deep links open the
    // app directly. autoVerify makes Android check the assetlinks.json hosted at
    // that domain against this package's signing cert. Until the real signing
    // SHA-256 is in that file (see public/.well-known/assetlinks.json), the OS
    // still opens the link via the app chooser; verification just makes it
    // automatic and removes the "open with" prompt.
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: 'app.hearthshelf.com', pathPrefix: '/invite' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
    permissions: ['FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MEDIA_PLAYBACK', 'WAKE_LOCK'],
    // expo-sensors ships ACTIVITY_RECOGNITION for its Pedometer module, which we
    // don't use (only DeviceMotion for shake-to-extend). Play flags it under the
    // Health apps policy, so strip it from the merged manifest.
    blockedPermissions: ['android.permission.ACTIVITY_RECOGNITION'],
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: './assets/favicon.png',
  },
  plugins: [
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        backgroundColor: '#1B1A18',
        imageWidth: 200,
        dark: {
          image: './assets/splash-icon.png',
          backgroundColor: '#1B1A18',
        },
      },
    ],
    '@clerk/expo',
    '@react-native-community/datetimepicker',
    [
      // Embed static font faces at build time with weight/style metadata so
      // fontWeight resolves natively on iOS and Android. Variable fonts crash
      // iOS CoreText at registration (expo-font FontUtils), so we ship static
      // Regular/Bold faces per family. Family names match src/ui/theme.ts.
      'expo-font',
      {
        // expo-font v57 takes different shapes per platform: iOS wants flat
        // string paths (it resolves fontWeight from each file's embedded weight
        // metadata), Android wants family objects that build the weight->file
        // XML mapping. Family names match src/ui/theme.ts.
        ios: {
          fonts: [
            './assets/fonts/Inter-Regular.ttf',
            './assets/fonts/Inter-Bold.ttf',
            './assets/fonts/GeistMono-Regular.ttf',
            './assets/fonts/GeistMono-Bold.ttf',
            './assets/fonts/LibreBaskerville-Regular.ttf',
            './assets/fonts/LibreBaskerville-Bold.ttf',
            './assets/fonts/LibreBaskerville-Italic.ttf',
          ],
        },
        android: {
          fonts: [
            {
              fontFamily: 'Inter 18pt',
              fontDefinitions: [
                { path: './assets/fonts/Inter-Regular.ttf', weight: 400 },
                { path: './assets/fonts/Inter-Bold.ttf', weight: 700 },
              ],
            },
            {
              fontFamily: 'Geist Mono',
              fontDefinitions: [
                { path: './assets/fonts/GeistMono-Regular.ttf', weight: 400 },
                { path: './assets/fonts/GeistMono-Bold.ttf', weight: 700 },
              ],
            },
            {
              fontFamily: 'Libre Baskerville',
              fontDefinitions: [
                { path: './assets/fonts/LibreBaskerville-Regular.ttf', weight: 400 },
                { path: './assets/fonts/LibreBaskerville-Bold.ttf', weight: 700 },
                { path: './assets/fonts/LibreBaskerville-Italic.ttf', weight: 400, style: 'italic' },
              ],
            },
          ],
        },
      },
    ],
    'expo-notifications',
    'expo-secure-store',
    'expo-router',
    'expo-background-task',
    'expo-sqlite',
    // Plays the sleep-timer warning beeps on iOS (the Android beep runs natively
    // in the media service). Configured to mix so the cue never ducks the book.
    'expo-audio',
    [
      'react-native-video',
      {
        enableBackgroundAudio: true,
        enableNotificationControls: false,
      },
    ],
    [
      'expo-build-properties',
      {
        android: {
          minSdkVersion: 26,
          // R8/ProGuard: shrinks + obfuscates the release build so Play Console
          // gets a real mapping.txt (crashReporter stack traces stay readable)
          // instead of "no deobfuscation file" on every upload. Shrink resources
          // rides along with it (requires minify, see expo-build-properties docs).
          enableMinifyInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
          // Everything else here (RN/Expo/Clerk native SDK/media3-exoplayer/etc.)
          // ships its own consumer proguard rules, auto-applied by AGP - these
          // three are the only gaps found in a full dependency audit:
          //  - media3-session 1.10.1 ships NO proguard.txt at all (unlike
          //    media3-exoplayer/common, which do). Defensive keep for the
          //    documented R8/MediaSessionStub interaction, androidx/media#1407.
          //  - expo-secure-store ships no consumer rules either; an unconfirmed
          //    but plausible community report (expo/expo discussion #43567) ties
          //    R8 to a "cannot be cast to SecureStoreOptions" crash. Auth-critical
          //    (stores the Clerk JWT), so keep it defensively - cheap insurance.
          //  - reanimated's own bundled rules (already auto-applied) additionally
          //    keep com.facebook.react.fabric.**; duplicated here so this app's
          //    own file is self-documenting for New Architecture/Fabric.
          extraProguardRules: [
            '-keep class androidx.media3.session.** { *; }',
            '-keep class expo.modules.securestore.** { *; }',
            '-keep class com.facebook.react.fabric.** { *; }',
            // Confirmed on-device: AndroidManifest.xml carries the headless-JS
            // app loader as a <meta-data> STRING
            // ("expo.modules.adapters.react.apploader.RNHeadlessAppLoader"),
            // resolved via Class.forName() at runtime by expo-modules-core. R8
            // has no static reference to trace, so it stripped the whole
            // apploader package and every headless task (expo-background-task /
            // expo-notifications background handling) threw
            // ClassNotFoundException on launch. Neither expo-modules-core's nor
            // expo's own bundled proguard rules cover this package - real gap,
            // not a defensive guess.
            '-keep class expo.modules.adapters.react.apploader.** { *; }',
            '-keep class expo.modules.apploader.** { *; }',
            // Dependency-version skew: kotlinx-io 0.9.0 (pulled in transitively)
            // is compiled against Kotlin 2.2's stdlib, which added the
            // @MustUseReturnValues annotation class. Other transitive deps still
            // pull older kotlin-stdlib (down to 1.9.0), so R8 sees a reference to
            // an annotation class that isn't on this build's classpath. It's a
            // compile-time-only marker (never read at runtime) - safe to silence
            // rather than keep.
            '-dontwarn kotlin.MustUseReturnValues',
          ].join('\n'),
        },
      },
    ],
    './plugins/hearthshelf-auto/index.js',
    './plugins/hearthshelf-carplay/index.js',
    './plugins/standalone-js/index.js',
    './plugins/hearthshelf-signing/index.js',
  ],
  extra,
  experiments: {
    tsconfigPaths: true,
  },
}
