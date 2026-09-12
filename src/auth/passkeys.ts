/**
 * Passkeys on the phone, using the OS credential sheet.
 *
 * WHY THIS FILE EXISTS. Better Auth's passkey client is browser-only: it calls
 * `@simplewebauthn/browser`, which reaches for `navigator.credentials`. That
 * object does not exist in React Native, so every attempt from the app failed
 * with "WebAuthn is not supported on this browser" - an error that is both
 * impossible to act on and confusing, since there is no browser in sight.
 *
 * The fix is not to wrap that client but to replace its middle step. A WebAuthn
 * ceremony is three parts, and only ONE of them is browser-bound:
 *
 *   1. ask the server for options        - a plain authenticated GET
 *   2. hand those options to the         - `navigator.credentials` on the web,
 *      authenticator, get a signed         the OS credential sheet on a phone
 *      response back                       (react-native-passkeys)
 *   3. post the response back to verify  - a plain authenticated POST
 *
 * Steps 1 and 3 are the same endpoints the web app already uses, unchanged, so
 * this is genuinely the same feature rather than a parallel implementation -
 * a passkey created here works on the web and vice versa.
 *
 * THE DOMAIN IS THE HARD PART, not the code. A passkey is bound for life to its
 * Relying Party ID (`hearthshelf.com`, see PASSKEY_RP_ID in the auth service),
 * and before a phone will create or offer one it fetches a file from that exact
 * domain to check this app is allowed to speak for it:
 *   - Android: /.well-known/assetlinks.json, needing a `get_login_creds`
 *     statement naming this package and its signing certificate. The
 *     `handle_all_urls` statement that powers deep links is NOT enough.
 *   - iOS: /.well-known/apple-app-site-association, needing a `webcredentials`
 *     section naming `<teamID>.<bundleID>`, plus a matching
 *     `webcredentials:hearthshelf.com` entry in `associatedDomains`. Again, the
 *     `applinks` section that powers universal links is a different grant.
 * Both are published. A failure here almost always means one of those files is
 * stale or the signing certificate differs from the one it names - the OS
 * reports that as a generic cancellation, which is why `describe()` below spells
 * the possibilities out rather than passing the raw message through.
 */
import { Platform } from 'react-native'
import * as passkeys from 'react-native-passkeys'
import * as Sentry from '@sentry/react-native'
import { authClient } from './client'
import { getSessionToken } from './token'
import { AUTH_SERVICE_URL } from '@/lib/config'

/**
 * What an attempt did.
 *
 * `unsupported` is separate from `error` on purpose: a device too old for
 * passkeys, or a simulator without a screen lock, is not a fault to report - the
 * caller should say "not on this device" and offer another route in, exactly as
 * the native social sign-in does.
 */
export type PasskeyResult =
  | { status: 'ok' }
  | { status: 'cancelled' }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; message: string }

/** Whether this device can do passkeys at all. Cheap and synchronous. */
export function passkeysSupported(): boolean {
  try {
    return passkeys.isSupported()
  } catch {
    return false
  }
}

function trace(step: string, data?: Record<string, unknown>): void {
  Sentry.addBreadcrumb({ category: 'auth.passkey', level: 'info', message: step, data })
}

/** The auth service, with any trailing slash removed so paths join cleanly. */
const base = AUTH_SERVICE_URL.replace(/\/$/, '')

/**
 * Call the auth service with the stored session.
 *
 * The bearer token is the session cookie's VALUE, not the cookie header - see
 * getSessionToken, where sending the whole header silently broke every
 * authenticated call.
 */
async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getSessionToken()
  const headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(`${base}/api/auth${path}`, { ...init, headers })
}

/** Pull a useful message out of an error body, falling back to the status. */
async function failureMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string }
    return body.message || body.error || fallback
  } catch {
    return fallback
  }
}

/**
 * Register a passkey for the signed-in user.
 *
 * `name` is what tells two passkeys apart in the list; the caller supplies
 * something the user will recognise, like the phone's own name.
 */
export async function registerPasskey(name: string): Promise<PasskeyResult> {
  if (!passkeysSupported()) {
    return {
      status: 'unsupported',
      reason:
        Platform.OS === 'android'
          ? 'This device cannot use passkeys. Add a screen lock, or use another sign-in method.'
          : 'This device cannot use passkeys. Use another sign-in method.',
    }
  }

  try {
    trace('register: requesting options')
    const optionsRes = await authFetch(
      `/passkey/generate-register-options?name=${encodeURIComponent(name)}`,
    )
    if (!optionsRes.ok) {
      return { status: 'error', message: await failureMessage(optionsRes, 'Could not start') }
    }
    const options = (await optionsRes.json()) as Parameters<typeof passkeys.create>[0]

    trace('register: opening the credential sheet')
    const created = await passkeys.create(options)
    // A null return is the user dismissing the sheet - not a failure, and it
    // must not be reported as one.
    if (!created) return { status: 'cancelled' }

    trace('register: verifying with the server')
    // `clientExtensionResults` is stripped for the same reason the web client
    // strips it: the verify endpoint's schema does not accept it.
    const { clientExtensionResults: _ignored, ...response } = created
    // Through the auth client, NOT a bare fetch: the client's own hook is what
    // stores the session cookie the response sets. A raw fetch bypasses it, and
    // the session would be created server-side but never persisted here.
    const verified = await authClient.$fetch('/passkey/verify-registration', {
      method: 'POST',
      body: { response, name },
    })
    if (verified?.error) {
      return {
        status: 'error',
        message: verified.error.message || 'That passkey could not be saved',
      }
    }
    trace('register: done')
    return { status: 'ok' }
  } catch (e) {
    return describe(e, 'add')
  }
}

/**
 * Sign in with a passkey.
 *
 * Unauthenticated by definition - the whole point is that there is no session
 * yet - so the options request carries no token and the verify response is what
 * establishes one.
 */
export async function signInWithPasskey(): Promise<PasskeyResult> {
  if (!passkeysSupported()) {
    return { status: 'unsupported', reason: 'This device cannot use passkeys.' }
  }

  try {
    trace('sign-in: requesting options')
    const optionsRes = await fetch(`${base}/api/auth/passkey/generate-authenticate-options`)
    if (!optionsRes.ok) {
      return { status: 'error', message: await failureMessage(optionsRes, 'Could not start') }
    }
    const options = (await optionsRes.json()) as Parameters<typeof passkeys.get>[0]

    trace('sign-in: opening the credential sheet')
    const assertion = await passkeys.get(options)
    if (!assertion) return { status: 'cancelled' }

    trace('sign-in: verifying with the server')
    const { clientExtensionResults: _ignored, ...response } = assertion
    // Same reason as registration: this response carries the new session, and
    // only the auth client's hook stores it. Going around it would sign the user
    // in on the server and leave the app still signed out.
    const verified = await authClient.$fetch('/passkey/verify-authentication', {
      method: 'POST',
      body: { response },
    })
    if (verified?.error) {
      return {
        status: 'error',
        message: verified.error.message || 'That passkey was not accepted',
      }
    }
    // Pull the session so useSession() reflects it before anyone navigates -
    // the same step the native social flow needs for the same reason.
    await authClient.getSession({ query: { disableCookieCache: true } })
    trace('sign-in: done')
    return { status: 'ok' }
  } catch (e) {
    return describe(e, 'sign in with')
  }
}

/**
 * Turn a thrown value into a verdict.
 *
 * The OS reports almost everything - no passkey for this account, a domain it
 * could not verify, a user who backed out - as the same generic cancellation
 * with little or no message. Passing that straight through produces a dead end,
 * so a bare cancellation is treated as exactly that, and anything with a message
 * keeps it.
 */
function describe(e: unknown, verb: string): PasskeyResult {
  const err = e as { message?: string; code?: string } | undefined
  const message = err?.message ?? ''
  trace('failed', { verb, code: err?.code, message })

  if (/cancel|abort|user denied|NotAllowed/i.test(`${err?.code ?? ''} ${message}`)) {
    return { status: 'cancelled' }
  }
  if (!message) {
    return {
      status: 'error',
      message: `Could not ${verb} a passkey on this device.`,
    }
  }
  return { status: 'error', message }
}
