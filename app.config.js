// Enables tsconfig "paths" (@/* -> ./src/*) resolution in Metro and surfaces
// public build-time config into expo-constants `extra`, so src/lib/config.ts can
// read it both from process.env (EXPO_PUBLIC_*) and from Constants.expoConfig.extra.
// (app.json is still the source of truth for the rest of the config.)
const appJson = require('./app.json')

// All values here are PUBLIC by design (see .env.example). The Google client
// SECRET is never here - it lives only in the Clerk dashboard.
const extra = {
  ...(appJson.expo.extra || {}),
  EXPO_PUBLIC_CONTROL_PLANE_URL: process.env.EXPO_PUBLIC_CONTROL_PLANE_URL,
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
  EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
  EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
  EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
  EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: process.env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME,
}

module.exports = {
  ...appJson.expo,
  extra,
  experiments: {
    ...(appJson.expo.experiments || {}),
    tsconfigPaths: true,
  },
}
