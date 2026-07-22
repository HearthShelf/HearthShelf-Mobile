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
 * The Google OAuth client IDs are NOT read here - Clerk's native Google module
 * reads them itself from `expoConfig.extra`, where app.config.js bakes committed
 * public defaults. See NATIVE_GOOGLE_ENABLED below.
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

// Sentry DSN (public by design - it only permits writing events). Baked as a
// committed default in app.config.js so CI builds report too. Empty disables
// Sentry entirely; the on-disk crash reporter (lib/crashReporter.ts) is
// independent and keeps working either way.
export const SENTRY_DSN = cfg(
  'EXPO_PUBLIC_SENTRY_DSN',
  'https://e44ed90551d4e3c3379246a5efce27c7@o4511760230907904.ingest.us.sentry.io/4511760235888640',
)

// PostHog analytics. Token is PUBLIC (phc_ keys only permit writing events).
// Committed default in app.config.js; env var overrides for a different project.
export const POSTHOG_PROJECT_TOKEN = cfg(
  'EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN',
  'phc_tvaXnSRS5CYf6fFcEDjeExjr3SZUnqYBphj36wFiDXDE',
)
export const POSTHOG_HOST = cfg('EXPO_PUBLIC_POSTHOG_HOST', 'https://us.i.posthog.com')

/**
 * Whether to offer the native Google account-picker (vs the browser-tab OAuth
 * fallback). The Google OAuth client IDs are public and baked into every build
 * as committed defaults in app.config.js, where Clerk's native Google module
 * reads them from `expoConfig.extra` - so native Google is available on both
 * platforms. Android uses Credential Manager; iOS uses the reversed-client-ID
 * URL scheme (registered in ios.infoPlist.CFBundleURLTypes, app.config.js).
 * Web has no native flow, so it stays on browser OAuth.
 */
export const NATIVE_GOOGLE_ENABLED = Platform.OS === 'android' || Platform.OS === 'ios'

/**
 * Whether to offer "Sign in with Apple". Apple only allows its button on Apple
 * platforms, so this is iOS-only. The sign-in itself runs through Clerk's
 * browser-tab OAuth flow (useSSO strategy 'oauth_apple'), which needs no native
 * module - just the `oauth_apple` strategy enabled in the Clerk dashboard.
 *
 * The native one-tap sheet (useSignInWithApple) would additionally require the
 * expo-apple-authentication module plus the `usesAppleSignIn` iOS entitlement;
 * until those are added the browser flow is the path.
 */
export const APPLE_ENABLED = Platform.OS === 'ios'
