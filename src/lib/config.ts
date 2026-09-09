/**
 * App configuration.
 *
 * Values resolve from `EXPO_PUBLIC_*` env vars first (inlined at build time by
 * Metro), then from `expo-constants` `extra` (app.config.js), then a default.
 * This lets dev and prod builds point at different control planes / Clerk
 * instances without editing source. None of these are secrets - the Clerk
 * publishable key and Google *client IDs* are public by design (they ship in
 * the web bundle too); the Google client *secret* lives only in the Clerk
 * dashboard, never here.
 *
 * The Google OAuth client IDs ARE read here. Clerk used to read them itself
 * from `expoConfig.extra`; Better Auth ships no native Google module, so our own
 * code configures one and needs the ids in JS. app.config.js still bakes the
 * same committed public defaults. See NATIVE_GOOGLE_ENABLED below.
 */
import Constants from 'expo-constants'
import { Platform } from 'react-native'

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>

function cfg(envKey: string, fallback: string): string {
  return process.env[envKey] ?? extra[envKey] ?? fallback
}

// Control plane REST API (server pairing, grants). Production: api.hearthshelf.com.
export const CONTROL_PLANE_URL = cfg('EXPO_PUBLIC_CONTROL_PLANE_URL', 'https://api.hearthshelf.com')

// Clerk publishable key (public by design - same one the SPA ships).
export const CLERK_PUBLISHABLE_KEY = cfg(
  'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'pk_live_Y2xlcmsuaGVhcnRoc2hlbGYuY29tJA',
)

// HearthShelf's own auth service (passkeys, social, magic link, email OTP, 2FA).
export const AUTH_SERVICE_URL = cfg('EXPO_PUBLIC_AUTH_SERVICE_URL', 'https://auth.hearthshelf.com')

// WebAuthn Relying Party ID for passkeys. MUST match the auth service's
// PASSKEY_RP_ID and the domain in the app's associated-domains / assetlinks
// entries - a passkey is bound to its RP ID permanently and cannot be re-scoped.
export const PASSKEY_RP_ID = cfg('EXPO_PUBLIC_PASSKEY_RP_ID', 'hearthshelf.com')

// Deep-link scheme for Clerk OAuth redirects (matches app.json "scheme").
export const APP_SCHEME = 'hearthshelf'

// Clerk JWT template carrying verified email/username claims the control plane
// requires. Must match the web app's bridge. NOT the default session token.
export const CLERK_JWT_TEMPLATE = 'hearthshelf'

// Expo push project id (release notifications). Empty when not provisioned, in
// which case push registration no-ops and only in-app signals (the Home
// countdown banner) work. A real token also needs FCM credentials on the build.
export const EAS_PROJECT_ID = cfg('EXPO_PUBLIC_EAS_PROJECT_ID', '')

// The full release-tag version (e.g. '0.0.2-R2'), baked into `extra` by
// app.config.js. It CANNOT be recovered from Constants.expoConfig.version at
// runtime on iOS alone: that returns CFBundleShortVersionString, which Apple
// requires to be a plain dotted number, so any pre-release tail is gone. Prefer
// the baked value, then fall back to the plain version rather than '' - an empty
// release means Sentry records the event with NO release at all, which is
// unattributable to any build.
export const FULL_VERSION =
  (extra.fullVersion as string | undefined) || Constants.expoConfig?.version || ''

// The native build number, used as Sentry's `dist` to pair with `release`.
// nativeBuildVersion reads from the actual built binary (versionCode on Android,
// CFBundleVersion on iOS) - the same value the Sentry gradle/Xcode plugins name
// their uploaded source maps/symbols under, so events and artifacts land on the
// same (release, dist) pair. Undefined in Expo Go / bare JS-only runs, where it
// is simply omitted rather than sent as a wrong value.
export const BUILD_NUMBER = Constants.nativeBuildVersion || undefined

// Sentry DSN (public by design - it only permits writing events). Baked as a
// committed default in app.config.js so CI builds report too. Empty disables
// Sentry entirely; the on-disk crash reporter (lib/crashReporter.ts) is
// independent and keeps working either way.
export const SENTRY_DSN = cfg(
  'EXPO_PUBLIC_SENTRY_DSN',
  'https://de02a3cd2a5b81852eaabf7bf0a34459@o4511760230907904.ingest.us.sentry.io/4511924430110720',
)

// Google OAuth client IDs. Public by design - a client id ships inside every
// app bundle, and only the client SECRET is confidential (it lives on the auth
// service, never here). The env-var names keep their historical CLERK_ prefix so
// the values baked into app.config.js and set in CI keep resolving.
//
// Which id matters where:
//   WEB     - passed to the native module as `webClientId`. Google mints the id
//             token against it, so it is the `aud` the auth service verifies,
//             and it is what makes the token backend-verifiable at all.
//   IOS     - the iOS client, needed by the native module on that platform.
// The ANDROID client id is never referenced in JS: Google resolves it from the
// package name + signing certificate registered in the Google console. It still
// has to be listed in the auth service's GOOGLE_NATIVE_CLIENT_IDS, because on
// Android the token's `aud` comes back as that android client.
export const GOOGLE_WEB_CLIENT_ID = cfg('EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID', '')
export const GOOGLE_IOS_CLIENT_ID = cfg('EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID', '')

/**
 * Whether to offer the native Google account-picker (vs the browser-tab OAuth
 * fallback).
 *
 * Requires a webClientId: without one Google returns no id token, and the id
 * token IS the credential the auth service verifies - so a native sign-in with
 * no web client id cannot succeed and the browser flow is the only real path.
 *
 * Web has no native flow, so it stays on browser OAuth.
 */
export const NATIVE_GOOGLE_ENABLED =
  (Platform.OS === 'android' || Platform.OS === 'ios') && !!GOOGLE_WEB_CLIENT_ID

/**
 * Whether to offer Apple sign-in at all (iOS only - Apple's sheet does not
 * exist on Android, and the browser flow there adds a provider nobody expects).
 */
export const APPLE_ENABLED = Platform.OS === 'ios'
