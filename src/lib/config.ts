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
