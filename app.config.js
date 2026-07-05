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
const extra = {
  EXPO_PUBLIC_CONTROL_PLANE_URL: process.env.EXPO_PUBLIC_CONTROL_PLANE_URL,
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
  EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
  EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID:
    process.env.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
  EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
  EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: process.env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME,
  // Expo push (release notifications). Optional: without a project id + FCM
  // credentials, getExpoPushTokenAsync no-ops and remote pushes are simply off;
  // the rest of the notifications feature (Home countdown banner) still works.
  EXPO_PUBLIC_EAS_PROJECT_ID: process.env.EXPO_PUBLIC_EAS_PROJECT_ID,
  // Also expose it in the EAS-conventional slot so expo-notifications and EAS
  // tooling can resolve the project id without the explicit arg.
  ...(process.env.EXPO_PUBLIC_EAS_PROJECT_ID
    ? { eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID } }
    : {}),
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
  slug: 'hearthshelf-mobile',
  version: '0.0.1',
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: 'hearthshelf',
  userInterfaceStyle: 'automatic',
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
    'expo-notifications',
    'expo-secure-store',
    'expo-router',
    'expo-background-task',
    'expo-sqlite',
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
