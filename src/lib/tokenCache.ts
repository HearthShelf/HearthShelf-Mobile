/**
 * Clerk token cache backed by expo-secure-store, so the Clerk session survives
 * app restarts (Clerk's recommended native pattern).
 */
import * as SecureStore from 'expo-secure-store'
import AsyncStorage from '@react-native-async-storage/async-storage'
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

/**
 * Storage backing Clerk's `__experimental_resourceCache`. Clerk persists its
 * environment + client resource SNAPSHOTS here (non-secret JSON blobs) and, on a
 * cold start with no network, loads from this cache instead of blocking on the
 * Clerk API - so `isLoaded` resolves offline. It also arms Clerk's own
 * FAPI-retry loop, which re-hydrates the real resources once the network returns
 * (this is what lets a reconnect actually succeed instead of stranding us with an
 * unloaded Clerk until a force-close). Backed by AsyncStorage, not SecureStore:
 * these are non-secret and the client snapshot can exceed SecureStore's size cap.
 */
export const clerkResourceCache = () => ({
  get: (key: string) => AsyncStorage.getItem(key),
  set: (key: string, value: string) => AsyncStorage.setItem(key, value),
})

/** True if a Clerk session is cached on this device (was signed in before). */
export async function hasCachedClerkSession(): Promise<boolean> {
  try {
    const jwt = await SecureStore.getItemAsync(CLERK_SESSION_JWT_KEY)
    return !!jwt
  } catch {
    return false
  }
}
