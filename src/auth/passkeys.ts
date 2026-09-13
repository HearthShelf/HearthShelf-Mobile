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

/**
 * Report a passkey failure, with the trail that led to it.
 *
 * WHY BREADCRUMBS ALONE ARE NOT ENOUGH. `addBreadcrumb` only ATTACHES to an
 * event - it never sends anything by itself. Every failure here is a value we
 * return rather than an exception we throw, so nothing else was ever going to
 * file one: the trail was being written and then discarded, and a failure on a
 * real phone would be exactly as silent as it was on the emulator.
 *
 * ONLY REAL FAILURES ARE EVENTS. Someone closing the sheet, and a device
 * without passkey support, are both ordinary - they stay breadcrumbs. An event
 * means the ceremony genuinely broke, which is the case worth waking up to.
 *
 * `fingerprint` groups by the step that failed rather than the message, so a
 * domain that stops verifying is one issue rather than one per device.
 */
function report(step: string, detail: Record<string, unknown>): void {
  // `captureMessage` titles the issue after the CALLING FUNCTION, so every one
  // of these arrived in the list as "describe" - identical, and useless to scan.
  // A synthetic exception puts the step in the title where it belongs.
  const err = new Error(`passkey ${step}`)
  err.name = 'PasskeyFailure'
  Sentry.captureException(err, {
    level: 'error',
    tags: { feature: 'passkey', step, platform: Platform.OS },
    extra: detail,
    fingerprint: ['passkey', step],
  })
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
    // BOTH halves go through the auth client, and that is load-bearing. The
    // server hands out a signed CHALLENGE COOKIE with these options and demands
    // it back on verification (CHALLENGE_NOT_FOUND otherwise). Only the client's
    // own fetch hook stores and replays that cookie - a bare fetch drops it, so
    // the OS creates a perfectly good credential that the server then refuses.
    const optionsRes = await authClient.$fetch<Parameters<typeof passkeys.create>[0]>(
      '/passkey/generate-register-options',
      { method: 'GET', query: { name } },
    )
    if (optionsRes?.error || !optionsRes?.data) {
      report('options-failed', { message: optionsRes?.error?.message ?? null })
      return {
        status: 'error',
        message: optionsRes?.error?.message || 'Could not start adding a passkey',
      }
    }
    const options = optionsRes.data
    // The Relying Party ID the phone will try to verify. It is THE field that
    // decides whether the OS accepts this app for the domain, and a mismatch
    // between it and the published association files is the most likely real
    // failure - so every report below carries it.
    const rpId = (options as { rp?: { id?: string } })?.rp?.id ?? null

    trace('register: opening the credential sheet')
    const created = await passkeys.create(options)
    // A null return is the user dismissing the sheet - not a failure, and it
    // must not be reported as one.
    if (!created) {
      // On Android a null here is ALSO what an incomplete system flow looks
      // like - the credential is made, the OS logs success, and nothing comes
      // back - so record it rather than treating every null as a user tapping
      // away. The two are indistinguishable from here.
      trace('register: no credential returned')
      // Indistinguishable from a dismissal at this layer, so it is reported
      // rather than assumed: on the emulator this exact shape was the system
      // creating the credential and never handing it back, which looked like
      // the button doing nothing at all.
      report('create-returned-nothing', { rpId, hasOptions: !!options })
      return { status: 'cancelled' }
    }

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
      // The server's own words, verbatim - CHALLENGE_NOT_FOUND and an origin
      // mismatch are different problems with different fixes, and a generic
      // message hides which one this is.
      trace('register: server rejected', { message: verified.error.message ?? null })
      // The server's own words. CHALLENGE_NOT_FOUND (the challenge cookie did
      // not come back) and an origin mismatch are different faults with
      // different fixes, and both are invisible without this.
      report('verify-rejected', {
        message: verified.error.message ?? null,
        status: (verified.error as { status?: number })?.status ?? null,
        code: (verified.error as { code?: string })?.code ?? null,
        rpId,
      })
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
    // Through the client for the challenge cookie - see registerPasskey.
    const optionsRes = await authClient.$fetch<Parameters<typeof passkeys.get>[0]>(
      '/passkey/generate-authenticate-options',
      { method: 'GET' },
    )
    if (optionsRes?.error || !optionsRes?.data) {
      report('signin-options-failed', { message: optionsRes?.error?.message ?? null })
      return { status: 'error', message: optionsRes?.error?.message || 'Could not start' }
    }
    const options = optionsRes.data

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
      report('signin-verify-rejected', {
        message: verified.error.message ?? null,
        status: (verified.error as { status?: number })?.status ?? null,
      })
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

  // A dismissal is ordinary and stays a breadcrumb - reporting it would file an
  // issue describing someone changing their mind.
  //
  // `NotAllowedError` is deliberately NOT treated as one. WebAuthn uses it as a
  // catch-all: the spec mandates it for a genuine failure as well as a
  // dismissal, precisely so a site cannot tell which happened. Matching it here
  // classified every real break as "the user changed their mind" and returned
  // before reporting - the exact reason a failed ceremony looked like the button
  // doing nothing. A dismissal that reaches this function instead carries an
  // explicit cancellation code, which is what this matches now.
  const cancelText = `${err?.code ?? ''} ${message}`
  if (/cancel|abort|user denied/i.test(cancelText)) {
    return { status: 'cancelled' }
  }

  // Everything else is a genuine break, and this is where a thrown OS error
  // lands - the domain refusing to validate arrives here as a DomError. It is
  // the single most likely real-device failure, so it reports with the raw
  // message intact rather than being flattened into friendly text and lost.
  // NotAllowedError keeps its own step so the catch-all case stays legible in
  // the issue list: it is the shape a domain that will not verify arrives as.
  report(/NotAllowed/i.test(cancelText) ? 'rejected-by-os' : 'threw', {
    verb,
    code: err?.code ?? null,
    message: message || null,
  })

  if (!message) {
    return {
      status: 'error',
      message: `Could not ${verb} a passkey on this device.`,
    }
  }
  return { status: 'error', message }
}
