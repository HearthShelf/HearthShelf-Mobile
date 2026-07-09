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

const extra = {
  EXPO_PUBLIC_CONTROL_PLANE_URL: process.env.EXPO_PUBLIC_CONTROL_PLANE_URL,
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
  EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
  EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID:
    process.env.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
  EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
  EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: process.env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME,
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

// CI stamps the run number as the Android versionCode (EXPO_ANDROID_VERSION_CODE)
// so every build is distinguishable on-device and monotonic. Locally / when
// unset, fall back to the static value below.
const versionCode = process.env.EXPO_ANDROID_VERSION_CODE
  ? Number(process.env.EXPO_ANDROID_VERSION_CODE)
  : 1

// iOS build numbers are strings in Expo/Apple tooling. GitHub Actions can stamp
// this with its run number; local builds fall back to the static value.
const iosBuildNumber = process.env.EXPO_IOS_BUILD_NUMBER || '1'

module.exports = {
  name: 'HearthShelf',
  slug: 'hearthshelf',
  owner: 'hearthshelf',
  version: '0.0.1',
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
    buildNumber: iosBuildNumber,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      // audio: background playback; processing: offline-progress background flush
      // (expo-background-task also adds this during prebuild).
      UIBackgroundModes: ['audio', 'processing'],
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
