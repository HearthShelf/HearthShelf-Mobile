/**
 * The session as stored on this device - read without the network, and
 * without the auth client's idea of when it runs out.
 *
 * The auth client persists its session cookie in expo-secure-store under a
 * prefixed key (see the `expoClient` plugin config in ./client.ts), plus a
 * cached copy of the session payload. Both carry a LOCAL expiry, and the client
 * acts on it: past that time it stops sending the cookie and stops restoring
 * the cached session. That local expiry is only a copy of the server's, taken
 * the last time the phone itself renewed - so it is the wrong thing to trust in
 * two cases:
 *
 *  - Offline for longer than the session lasts (a cruise). The phone cannot
 *    ask the service, so its stored copy simply runs out and the user reads as
 *    signed out with no way to sign back in until they are online again.
 *  - Online, but the session was renewed by someone else. The control plane
 *    resolves every bearer call through the auth service, which slides the
 *    server-side expiry, but only the phone's own get-session updates its
 *    local copy. A phone used mostly through the car could see its local copy
 *    lapse while the real session was alive and well.
 *
 * So the session is treated as PAUSED rather than expired locally: the token
 * keeps being offered until the auth service itself answers. A genuinely dead
 * session is then refused there, and the service's reply (a cookie with
 * Max-Age=0) is what removes it from this device. Revocation is unaffected:
 * it deletes the session server-side, so a paused token stops working the
 * first time it is used.
 *
 * Reads go through the Expo plugin's own storage adapter, not SecureStore
 * directly, because the plugin splits large values across several keys; its
 * adapter reassembles them and shares the plugin's per-key queue, so a read
 * here cannot interleave with a write there.
 */
import * as SecureStore from 'expo-secure-store'
import { storageAdapter } from '@better-auth/expo/client'

/**
 * Keys the Expo plugin derives from `storagePrefix` (see ./client.ts, where the
 * prefix is set): it stores the session cookie under `${prefix}_cookie` and a
 * cached copy of the session payload under `${prefix}_session_data`. Verified
 * against @better-auth/expo 1.7.7's client source; they must be changed together.
 */
export const STORAGE_PREFIX = 'hearthshelf'
const SESSION_COOKIE_KEY = `${STORAGE_PREFIX}_cookie`
const SESSION_DATA_KEY = `${STORAGE_PREFIX}_session_data`

const store = storageAdapter(SecureStore)

export interface StoredSessionCookie {
  /** Cookie name as the service set it, e.g. `__Secure-better-auth.session_token`. */
  name: string
  /** The signed token value - also what the bearer plugin accepts. */
  value: string
}

function parseJSON(raw: string | null | undefined): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * The stored session cookie, whatever its local expiry says.
 *
 * Skips the multi-session cookies (`..._multi-<id>`): those are other signed-in
 * accounts and would authenticate as the wrong user.
 */
export async function readStoredSessionCookie(): Promise<StoredSessionCookie | null> {
  let raw: string | null
  try {
    raw = await store.getItemAsync(SESSION_COOKIE_KEY)
  } catch {
    return null
  }
  const parsed = parseJSON(raw)
  if (!parsed || typeof parsed !== 'object') return null
  for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const value = (entry as { value?: unknown } | null)?.value
    if (typeof value !== 'string' || !value) continue
    const bare = name.replace(/^__(Secure|Host)-/, '')
    if (bare.endsWith('.session_token')) return { name, value }
  }
  return null
}

/** True if a session is stored on this device (i.e. it was signed in before). */
export async function hasCachedSession(): Promise<boolean> {
  return (await readStoredSessionCookie()) !== null
}

/**
 * The cached session payload (user and session), whatever its expiry says.
 *
 * Only returned while a session cookie is still stored: once the service has
 * removed that, the cached user is someone who has signed out.
 */
export async function readStoredSessionData(): Promise<{ user: { id: string } } | null> {
  if (!(await readStoredSessionCookie())) return null
  let raw: string | null
  try {
    raw = await store.getItemAsync(SESSION_DATA_KEY)
  } catch {
    return null
  }
  const parsed = parseJSON(raw) as { user?: { id?: unknown }; session?: { id?: unknown } } | null
  if (!parsed?.user || typeof parsed.user.id !== 'string' || !parsed.session?.id) return null
  return parsed as { user: { id: string } }
}

/**
 * Forget the stored session.
 *
 * Sign-out normally clears this through the auth client; this exists for the
 * paths that must not depend on the service being reachable - a forced local
 * sign-out, or recovering a device whose stored session the service has already
 * rejected. Without it a stale cookie would keep `hasCachedSession()` true
 * forever, and the gate would treat a signed-out user as a returning one.
 */
export async function clearCachedSession(): Promise<void> {
  // Both keys: leaving the cached session payload behind would let the client
  // hydrate a signed-out user's details on the next launch. Written as an empty
  // object (what the plugin itself writes on sign-out) so the adapter also
  // clears any chunks a large value was split across.
  for (const key of [SESSION_COOKIE_KEY, SESSION_DATA_KEY]) {
    try {
      await store.setItemAsync(key, '{}')
    } catch {
      // Best-effort: a failed write just leaves a stale key that the next
      // sign-in overwrites.
    }
  }
}
