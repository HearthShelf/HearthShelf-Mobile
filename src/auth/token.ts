/**
 * Handing the session to the control plane.
 *
 * The control plane authenticates callers with `Authorization: Bearer <token>`
 * and resolves that token against the auth service (see the control plane's
 * lib/betterAuth.ts). On native the session lives as a stored cookie rather
 * than a JWT the client can mint on demand, so "get a token" here means "read
 * the stored session cookie", which is what `authClient.getCookie()` returns.
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

export async function getSessionToken(_opts?: { forceRefresh?: boolean }): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const cookie = await Promise.race([
      authClient.getCookie(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TOKEN_READ_TIMEOUT_MS)
      }),
    ])
    return cookie || null
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
