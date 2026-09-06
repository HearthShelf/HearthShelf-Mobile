/**
 * "Was this device signed in?" - answered without the network.
 *
 * The auth client persists its session cookie in expo-secure-store under a
 * prefixed key (see the `expoClient` plugin config in ./client.ts). We only
 * ever read it, and only to answer that one question.
 *
 * WHY THIS MATTERS. Offline, a session cannot be *confirmed* - the auth service
 * is unreachable, so `useSession` stays pending indefinitely. Without a local
 * signal the app would sit on the splash forever for a user who is perfectly
 * well signed in and just wants their downloaded book. The presence of a stored
 * session proves they were signed in on a previous run, which is enough to let
 * them into offline mode.
 *
 * It is deliberately NOT proof of a *valid* session: it can be stale after a
 * sign-out elsewhere or an expiry. Everything gated on it is either offline-only
 * or re-checked once the service answers.
 */
import * as SecureStore from 'expo-secure-store'

/**
 * Keys the Expo plugin derives from `storagePrefix` (see ./client.ts, where the
 * prefix is set): it stores the session cookie under `${prefix}_cookie` and a
 * cached copy of the session payload under `${prefix}_session_data`. Verified
 * against @better-auth/expo's client source; they must be changed together.
 */
const STORAGE_PREFIX = 'hearthshelf'
const SESSION_COOKIE_KEY = `${STORAGE_PREFIX}_cookie`
const SESSION_DATA_KEY = `${STORAGE_PREFIX}_session_data`

/** True if a session is stored on this device (i.e. it was signed in before). */
export async function hasCachedSession(): Promise<boolean> {
  try {
    const cookie = await SecureStore.getItemAsync(SESSION_COOKIE_KEY)
    return !!cookie
  } catch {
    return false
  }
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
  // hydrate a signed-out user's details on the next launch.
  for (const key of [SESSION_COOKIE_KEY, SESSION_DATA_KEY]) {
    try {
      await SecureStore.deleteItemAsync(key)
    } catch {
      // Best-effort: a failed delete just leaves a stale key that the next
      // sign-in overwrites.
    }
  }
}
