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

export const authClient = createAuthClient({
  baseURL: AUTH_SERVICE_URL,
  plugins: [
    expoClient({
      scheme: APP_SCHEME,
      storagePrefix: 'hearthshelf',
      storage: SecureStore,
    }),
    passkeyClient(),
    twoFactorClient(),
    emailOTPClient(),
    magicLinkClient(),
    usernameClient(),
  ],
})

export const { useSession, signIn, signUp, signOut, passkey, twoFactor } = authClient
