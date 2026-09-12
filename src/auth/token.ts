/**
 * Handing the session to the control plane.
 *
 * The control plane authenticates callers with `Authorization: Bearer <token>`
 * and resolves that token against the auth service (see the control plane's
 * lib/betterAuth.ts). On native the session lives as a stored cookie rather
 * than a JWT the client can mint on demand, so "get a token" here means "read
 * the stored session cookie".
 *
 * WHAT A BEARER TOKEN ACTUALLY IS. `authClient.getCookie()` returns a whole
 * COOKIE HEADER - `name=value; othername=othervalue` - and that is not a token.
 * Better Auth's bearer plugin expects the bare signed value (`value.signature`)
 * and verifies it by splitting on the FIRST dot. Handed a cookie header it
 * splits `__Secure-better-auth.session_token=...` into `__Secure-better-auth` /
 * `session_token=...`, the HMAC check fails, and the request resolves to no
 * session at all.
 *
 * That failure was invisible and expensive: every control-plane call 401'd, the
 * retry 401'd too, and the session-expired handler signed the user out about
 * 250ms after a sign-in that had genuinely succeeded. On screen it looked like
 * tapping Google did nothing - the app reached the tabs and bounced straight
 * back to sign-in with no error.
 *
 * So extract the session cookie's value and send THAT. The multi-session
 * cookies (`..._multi-<id>`) that the multiSession plugin adds are deliberately
 * skipped: they are additional accounts, not this session.
 *
 * Two properties the previous implementation had to fight for, and which we
 * keep:
 *
 *  1. BOUNDED. The old provider's getToken() could hang rather than reject when
 *     its client sync was wedged on an unresolvable host, burning the entire
 *     connect race on a mint that was never going to resolve. Reading local
 *     storage should not hang, but a hang here would be just as fatal, so the
 *     ceiling stays.
 *
 *  2. NULL, NEVER THROW. Callers treat null as "no token yet" and hold at
 *     `connecting` for the re-arm paths (session effect, NetInfo edge,
 *     foreground probe) to retry. Throwing would resolve the launch to an
 *     error screen instead of waiting for a network that is about to return.
 *
 * `forceRefresh` is accepted for signature compatibility with the caller, which
 * uses it to retry a 401 that might have been a stale cached token. There is no
 * cache to skip here - the stored cookie IS the session - so it is a no-op. A
 * genuinely rejected session is handled by the sign-out path, not by re-reading
 * the same value.
 */
import { authClient } from './client'

/** Ceiling on a single token read. See (1) above. */
const TOKEN_READ_TIMEOUT_MS = 10000

/**
 * Pull the session token out of a cookie header.
 *
 * Matches the session cookie whether or not it carries the `__Secure-` prefix
 * (production is https, so it does) and whatever cookie prefix the service is
 * configured with, while refusing the `_multi-` variants - those identify other
 * signed-in accounts and would authenticate as the wrong user.
 */
function extractSessionToken(cookie: string | null | undefined): string | null {
  if (!cookie) return null
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!value) continue
    const bare = name.replace(/^__(Secure|Host)-/, '')
    if (bare.endsWith('.session_token')) return value
  }
  return null
}

export async function getSessionToken(_opts?: { forceRefresh?: boolean }): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const cookie = await Promise.race([
      authClient.getCookie(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TOKEN_READ_TIMEOUT_MS)
      }),
    ])
    return extractSessionToken(cookie)
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
