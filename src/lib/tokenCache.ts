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
