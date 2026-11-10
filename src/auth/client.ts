/**
 * HearthShelf auth client (Better Auth) for the mobile app.
 *
 * Talks to the auth service at AUTH_SERVICE_URL. Everything the app needs to
 * sign someone in lives here: passkeys, Google / Apple / Discord, magic links,
 * email OTP, and TOTP two-factor.
 *
 * The session is persisted with expo-secure-store via the Expo plugin, so it
 * survives app restarts the same way the previous provider's cache did.
 *
 * WHY SEVERAL METHODS. Magic link and email OTP both depend on mail delivery,
 * so they fail together if that breaks; passkeys and social sign-in do not.
 * Keeping all of them means no single dependency can lock everyone out.
 *
 * IMPORTANT: `user.id` here is the stable account id the control plane puts in
 * the `sub` of every grant, and which every self-hosted box uses as its
 * per-user primary key. For accounts carried over from the previous provider it
 * is that provider's original user id, seeded deliberately. Never treat it as
 * opaque-and-regenerable.
 */
import { createAuthClient } from 'better-auth/react'
import type { BetterAuthClientPlugin } from 'better-auth/client'
import { expoClient } from '@better-auth/expo/client'
import { passkeyClient } from '@better-auth/passkey/client'
import {
  emailOTPClient,
  magicLinkClient,
  twoFactorClient,
  usernameClient,
} from 'better-auth/client/plugins'
import * as SecureStore from 'expo-secure-store'
import { APP_SCHEME, AUTH_SERVICE_URL } from '@/lib/config'
import { readStoredSessionCookie, STORAGE_PREFIX } from './sessionCache'

/**
 * Keep offering the stored session to the auth service after its local expiry.
 *
 * The Expo plugin attaches the stored cookie to each request, but only while the
 * cookie's LOCAL expiry is in the future. That expiry is the phone's copy of the
 * server's, and it lags (see ./sessionCache.ts): after weeks offline, or after
 * the control plane kept the session alive on the phone's behalf, the plugin
 * would send no cookie at all and the service would answer "no session" for a
 * session it still holds. With the cookie attached, the service gives the real
 * answer - it renews a live session (the reply refreshes the stored copy) and
 * removes a dead one, which is the only way a paused session ends.
 *
 * Must come AFTER expoClient in the plugin list: fetch plugins run in order, and
 * this only fills a cookie header the Expo plugin left empty. An id-token sign-in
 * is left alone on purpose - the Expo plugin sends it without a cookie so a fresh
 * sign-in never rides on an old session.
 */
type FetchPlugin = NonNullable<BetterAuthClientPlugin['fetchPlugins']>[number]

const pausedSessionFetch: FetchPlugin = {
  id: 'hearthshelf-paused-session',
  name: 'Paused session',
  async init(url, options) {
    // The Expo plugin, which runs first, always replaces headers with a plain
    // object, so reading `cookie` off it is safe.
    if (!options || (options.body as { idToken?: unknown } | undefined)?.idToken !== undefined) {
      return { url, options }
    }
    const headers = (options.headers ?? {}) as Record<string, string>
    if (headers.cookie) return { url, options }
    const stored = await readStoredSessionCookie()
    if (!stored) return { url, options }
    return {
      url,
      options: { ...options, headers: { ...headers, cookie: `${stored.name}=${stored.value}` } },
    }
  },
}

const pausedSessionPlugin = {
  id: 'hearthshelf-paused-session',
  fetchPlugins: [pausedSessionFetch],
} satisfies BetterAuthClientPlugin

export const authClient = createAuthClient({
  baseURL: AUTH_SERVICE_URL,
  plugins: [
    expoClient({
      scheme: APP_SCHEME,
      storagePrefix: STORAGE_PREFIX,
      storage: SecureStore,
    }),
    pausedSessionPlugin,
    passkeyClient(),
    twoFactorClient(),
    emailOTPClient(),
    magicLinkClient(),
    usernameClient(),
  ],
})

export const { useSession, signIn, signUp, signOut, passkey, twoFactor } = authClient
