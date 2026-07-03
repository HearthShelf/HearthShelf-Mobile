/**
 * Clerk token cache backed by expo-secure-store, so the Clerk session survives
 * app restarts (Clerk's recommended native pattern).
 */
import * as SecureStore from 'expo-secure-store'
import type { TokenCache } from '@clerk/expo'

export const tokenCache: TokenCache = {
  async getToken(key: string) {
    try {
      return await SecureStore.getItemAsync(key)
    } catch {
      return null
    }
  },
  async saveToken(key: string, value: string) {
    try {
      await SecureStore.setItemAsync(key, value)
    } catch {
      // best-effort; a failed cache write just means re-auth next launch
    }
  },
}

// Clerk-expo persists the session JWT here (the same key our tokenCache above
// writes). Its presence means "this device was signed in", which we use to let a
// user into offline mode when Clerk can't confirm the session with no network
// (isLoaded never resolves offline, so we can't wait on it forever).
const CLERK_SESSION_JWT_KEY = '__clerk_client_jwt'

/** True if a Clerk session is cached on this device (was signed in before). */
export async function hasCachedClerkSession(): Promise<boolean> {
  try {
    const jwt = await SecureStore.getItemAsync(CLERK_SESSION_JWT_KEY)
    return !!jwt
  } catch {
    return false
  }
}
