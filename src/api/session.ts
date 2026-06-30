/**
 * Active ABS session: the connected server's origin + the per-user ABS token.
 *
 * Kept as a plain module singleton (not React state) on purpose: the Android
 * Auto / CarPlay screens (autoplay.tsx) run OUTSIDE the React tree and need to
 * read these to build stream and cover URLs. We mirror them into
 * expo-secure-store so the headless car service can rehydrate if the OS spins it
 * up cold (e.g. the user opens Android Auto before the phone app).
 */
import * as SecureStore from 'expo-secure-store'

interface AbsSession {
  serverUrl: string
  token: string
}

let current: AbsSession | null = null

const KEY = 'hs.abs.session'
const LAST_SERVER_KEY = 'hs.lastServerId'

/** Remember which linked server the user last connected to (multi-server). */
export async function setLastServerId(serverId: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(LAST_SERVER_KEY, serverId)
  } catch {
    // non-fatal; we just fall back to the first server next launch
  }
}

export async function getLastServerId(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(LAST_SERVER_KEY)
  } catch {
    return null
  }
}

/** Forget the remembered server so the next connect shows the picker. */
export async function clearLastServerId(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(LAST_SERVER_KEY)
  } catch {
    // non-fatal
  }
}

export function getSession(): AbsSession | null {
  return current
}

export async function setSession(session: AbsSession): Promise<void> {
  current = session
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(session))
  } catch {
    // non-fatal; in-memory copy still works for this run
  }
}

export async function clearSession(): Promise<void> {
  current = null
  try {
    await SecureStore.deleteItemAsync(KEY)
  } catch {
    // ignore
  }
}

/** Rehydrate from secure store (used by the headless playback service). */
export async function hydrateSession(): Promise<AbsSession | null> {
  if (current) return current
  try {
    const raw = await SecureStore.getItemAsync(KEY)
    if (raw) current = JSON.parse(raw) as AbsSession
  } catch {
    // ignore
  }
  return current
}
