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
 */
import Constants from 'expo-constants'

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

/**
 * Native "Sign in with Google" (Android Credential Manager) needs Google OAuth
 * client IDs registered in the Clerk dashboard's custom-credentials config. The
 * client IDs themselves are public; they're surfaced here only so the UI can
 * decide whether to offer the native button or fall back to browser OAuth.
 *
 * Provision these in Google Cloud Console and register them in Clerk:
 *   - Web client ID + SECRET  -> Clerk dashboard (token verification)
 *   - Android client ID       -> needs the signing keystore's SHA-256
 *   - iOS client ID           -> later (iOS milestone)
 * See PROJECT_PLAN.md "Milestone 1" for the full checklist.
 */
export const GOOGLE_WEB_CLIENT_ID = cfg('EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID', '')
export const GOOGLE_ANDROID_CLIENT_ID = cfg('EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID', '')
export const GOOGLE_IOS_CLIENT_ID = cfg('EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID', '')

/**
 * Whether to offer the native Google account-picker. Clerk's native flow needs
 * the dashboard credentials configured; until the Web client ID is provisioned
 * we fall back to the browser-tab OAuth flow (useSSO), which needs no client ID
 * here. Flipping this on is a config change, not a code change.
 */
export const NATIVE_GOOGLE_ENABLED = GOOGLE_WEB_CLIENT_ID.length > 0
