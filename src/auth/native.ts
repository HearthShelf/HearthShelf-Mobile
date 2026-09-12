/**
 * Native social sign-in (the OS account picker, not a browser tab).
 *
 * WHY THIS FILE EXISTS. Better Auth ships no native social module - its
 * `signIn.social({ provider })` is purely the web flow: it opens a browser tab,
 * runs the OAuth redirect, and deep-links back. That works, but it is a visibly
 * worse experience than the OS sheet, and it is what people notice first after
 * a provider migration.
 *
 * The native shape inverts the flow. Instead of the server driving a redirect,
 * the OS hands US a signed id token and we post it to the same `signIn.social`
 * endpoint as `idToken`. Better Auth then verifies the JWT itself - signature
 * against the provider's JWKS, issuer, expiry, max age, and audience - and
 * issues a session with no browser involved.
 *
 * THE AUDIENCE TRAP. The token's `aud` is the client that minted it, which for
 * a native sign-in is the PLATFORM client (Android / iOS), not the web one. The
 * auth service therefore has to accept those ids too (GOOGLE_NATIVE_CLIENT_IDS,
 * APPLE_APP_BUNDLE_ID). Without that, verification rejects every native token
 * while the browser flow keeps working - which makes it look like a client bug.
 *
 * EVERY ENTRY POINT FALLS BACK. Native sign-in has many ways to be unavailable
 * that are nobody's fault: no Play Services, a build without the client ids, a
 * platform with no native flow. None of those should read as "sign-in is
 * broken", so each returns a verdict the caller acts on rather than throwing.
 */
import { Platform } from 'react-native'
import * as AppleAuthentication from 'expo-apple-authentication'
import * as Crypto from 'expo-crypto'
import * as Sentry from '@sentry/react-native'
import { authClient } from './client'
import {
  APPLE_ENABLED,
  GOOGLE_IOS_CLIENT_ID,
  GOOGLE_WEB_CLIENT_ID,
  NATIVE_GOOGLE_ENABLED,
} from '@/lib/config'

/**
 * What a native attempt did.
 *
 * `unavailable` is the important one: it means "this device/build cannot do the
 * native flow", and the caller should fall through to the browser flow. It is
 * NOT an error and must never surface as one. `cancelled` is the user closing
 * the sheet - also not an error, and it must NOT fall through to a browser tab,
 * or dismissing the picker would pop one open, which reads as a bug.
 */
export type NativeResult =
  | { status: 'signed-in' }
  | { status: 'cancelled' }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string }

/** Google's module is configured lazily and exactly once per app run. */
let googleConfigured = false

/**
 * Record a step of native sign-in.
 *
 * This path had NO logging at all, which is why a failure here looked like the
 * button doing nothing: Google's own errors arrive with an empty message, the
 * result is classified as `unavailable`, and the fallback runs silently. The
 * trail rides along on whatever is eventually reported, and `console` makes it
 * visible in `adb logcat` while debugging on a device.
 */
function trace(step: string, data?: Record<string, unknown>): void {
  Sentry.addBreadcrumb({ category: 'auth.native', level: 'info', message: step, data })
  console.log(`[auth.native] ${step}`, data ? JSON.stringify(data) : '')
}

async function configureGoogle() {
  if (googleConfigured) return
  const { GoogleSignin } = await import('@react-native-google-signin/google-signin')
  GoogleSignin.configure({
    // The id token comes back addressed to THIS client, which is what makes it
    // verifiable by our auth service. Without it Google returns no id token at
    // all and there is nothing to send.
    webClientId: GOOGLE_WEB_CLIENT_ID,
    ...(Platform.OS === 'ios' && GOOGLE_IOS_CLIENT_ID ? { iosClientId: GOOGLE_IOS_CLIENT_ID } : {}),
    // We want identity, not delegated API access - so no refresh token and no
    // server-side offline access to arrange.
    offlineAccess: false,
    scopes: ['email', 'profile'],
  })
  googleConfigured = true
}

/**
 * Google via the OS account picker (Credential Manager on Android).
 *
 * Note there is no nonce: the free tier of the native module exposes no way to
 * pass one, and Better Auth only compares a nonce when it is given one. The
 * token is still fully verified (signature, issuer, audience, 1h max age), so
 * what is lost is replay hardening inside that window, not authenticity.
 */
export async function signInWithGoogleNatively(): Promise<NativeResult> {
  if (!NATIVE_GOOGLE_ENABLED) {
    return { status: 'unavailable', reason: 'No native Google flow on this platform or build' }
  }
  try {
    await configureGoogle()
    const { GoogleSignin } = await import('@react-native-google-signin/google-signin')

    if (Platform.OS === 'android') {
      // Google's own UI cannot run without Play Services, so a device lacking
      // them has to take the browser flow.
      const ok = await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true })
      if (!ok) return { status: 'unavailable', reason: 'Google Play Services unavailable' }
    }

    trace('google: opening picker')
    const res = await GoogleSignin.signIn()
    trace('google: picker returned', { type: res?.type })
    if (res.type === 'cancelled') return { status: 'cancelled' }

    const idToken = res.data.idToken
    if (!idToken) {
      // Reachable when webClientId is wrong for this project: the picker
      // succeeds, but Google has nothing to address the token to.
      trace('google: NO id token in response')
      return { status: 'unavailable', reason: 'Google returned no identity token' }
    }

    trace('google: got id token, posting to auth service')
    return await postIdToken('google', idToken)
  } catch (e) {
    return classify(e, 'Google sign-in')
  }
}

/**
 * Apple via the native sheet.
 *
 * Unlike Google, this one supports a nonce. Apple embeds the SHA-256 of what we
 * pass into the token, and Better Auth's Apple provider compares
 * `exact-or-sha256`, so sending the raw value is what lets it match.
 */
export async function signInWithAppleNatively(): Promise<NativeResult> {
  if (!APPLE_ENABLED) {
    return { status: 'unavailable', reason: 'Apple sign-in is iOS only' }
  }
  try {
    // False on a simulator with no iCloud account, and on any iOS too old for
    // the API - both want the browser flow rather than a dead button.
    const available = await AppleAuthentication.isAvailableAsync()
    if (!available) return { status: 'unavailable', reason: 'Apple sign-in unavailable' }

    const nonce = randomNonce()

    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce,
    })

    if (!credential.identityToken) {
      return { status: 'unavailable', reason: 'Apple returned no identity token' }
    }

    // Apple sends the name and email ONLY on the very first authorization for
    // this app, and never again. Forward them so the account is created with
    // them; on every later sign-in they are legitimately absent.
    const fullName = credential.fullName
    const hasProfile = !!(credential.email || fullName?.givenName || fullName?.familyName)
    const name =
      fullName?.givenName || fullName?.familyName
        ? {
            ...(fullName.givenName ? { firstName: fullName.givenName } : {}),
            ...(fullName.familyName ? { lastName: fullName.familyName } : {}),
          }
        : undefined

    return await postIdToken('apple', credential.identityToken, {
      nonce,
      user: hasProfile
        ? {
            ...(credential.email ? { email: credential.email } : {}),
            ...(name ? { name } : {}),
          }
        : undefined,
    })
  } catch (e) {
    return classify(e, 'Apple sign-in')
  }
}

/**
 * Hand a provider's id token to the auth service for verification.
 *
 * This is the same `signIn.social` endpoint the browser flow uses; supplying
 * `idToken` is what tells the server to verify a token we already hold instead
 * of starting a redirect.
 */
async function postIdToken(
  provider: 'google' | 'apple',
  token: string,
  extra?: {
    nonce?: string
    user?: { email?: string; name?: { firstName?: string; lastName?: string } }
  },
): Promise<NativeResult> {
  const res = await authClient.signIn.social({
    provider,
    idToken: {
      token,
      ...(extra?.nonce ? { nonce: extra.nonce } : {}),
      ...(extra?.user ? { user: extra.user } : {}),
    },
  })
  if (res?.error) {
    trace('postIdToken: auth service rejected', {
      provider,
      message: res.error.message,
      status: (res.error as { status?: number })?.status,
    })
    return { status: 'error', message: res.error.message || 'The sign-in could not be verified' }
  }
  trace('postIdToken: session created', { provider })

  // Pull the session so `useSession()` reflects it before anyone navigates.
  //
  // The browser flow ends in a redirect, which remounts the app and refetches
  // the session on the way past. This path never leaves the screen: the request
  // succeeds, the cookie is stored, and the session atom still holds its old
  // null. The caller then navigates to the tabs, the auth gate reads
  // `isSignedIn === false`, and bounces straight back to sign-in - a dashboard
  // that flashes for one frame and disappears.
  const cookie = await authClient.getCookie()
  const after = await authClient.getSession({ query: { disableCookieCache: true } })
  trace('postIdToken: session after refetch', {
    // The whole question this answers: did the session cookie survive the
    // sign-in response, and does the client now see a user? A created session
    // that the client cannot read looks exactly like a sign-in that failed.
    hasCookie: !!cookie,
    cookieNames: cookie ? cookie.split(';').map((c) => c.split('=')[0].trim()) : [],
    hasUser: !!after?.data?.user,
    error: after?.error?.message ?? null,
  })
  return { status: 'signed-in' }
}

/**
 * A high-entropy nonce for Apple.
 *
 * Hex rather than base64 so there is no padding or URL-safety question when
 * Apple round-trips it.
 */
function randomNonce(): string {
  const bytes = Crypto.getRandomBytes(32)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Sort a thrown native error into a verdict.
 *
 * The distinction that matters: a user dismissing the sheet is `cancelled` (do
 * nothing at all), while a device that cannot show the sheet is `unavailable`
 * (quietly take the browser flow). Only a genuine failure becomes an error the
 * user is told about.
 */
function classify(e: unknown, label: string): NativeResult {
  const err = e as { code?: string; message?: string }
  const code = err?.code || ''
  const message = err?.message || ''
  // The raw code is the whole diagnosis here and it is otherwise discarded:
  // Google surfaces DEVELOPER_ERROR, SIGN_IN_FAILED and friends with an empty
  // message, so without this the reason a sign-in died is simply lost.
  trace('native error', { label, code, message })

  // Apple's cancellation arrives as a code; Google's normal cancel is the
  // `cancelled` result handled above, but its older surfaces still throw one.
  if (code === 'ERR_REQUEST_CANCELED' || code === 'SIGN_IN_CANCELLED' || code === '-5') {
    return { status: 'cancelled' }
  }
  if (code === 'PLAY_SERVICES_NOT_AVAILABLE') {
    return { status: 'unavailable', reason: 'Google Play Services unavailable' }
  }
  // DEVELOPER_ERROR (Google status 10): the request is rejected before any UI
  // is shown, so from the outside the picker "never opens" - it launches and
  // closes in a few hundred ms with an empty message, which used to fall
  // through to a blank error and look like nothing happened at all.
  //
  // It always means the app's signing certificate is not registered against the
  // Android OAuth client for this project. Debug builds are signed with the
  // shared Expo debug keystore, whose SHA-1 differs from a release build's, so
  // BOTH fingerprints have to be on the client. Falling back to the browser tab
  // keeps sign-in working on a machine whose debug key was never registered.
  if (code === 'DEVELOPER_ERROR' || code === '10') {
    return {
      status: 'unavailable',
      reason:
        "This build's signing certificate is not registered with Google - add its SHA-1 to the Android OAuth client",
    }
  }
  // The native module is missing from this binary - the case after adding these
  // packages without a rebuild. Falling back keeps sign-in usable in a stale
  // build instead of hard-failing.
  if (/native module|RNGoogleSignin|requireNativeModule|doesn't exist/i.test(message)) {
    return { status: 'unavailable', reason: 'Native sign-in is not in this build' }
  }
  return { status: 'error', message: message || `${label} failed` }
}
