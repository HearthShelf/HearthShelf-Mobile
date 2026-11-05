/**
 * The connected ABS user's own id, cached in memory so social surfaces (notes,
 * clubs) can tell "my note" from someone else's and gate spoilers against my own
 * position. Populated from getMe() responses (the /api/me call the progress store
 * already makes on load), so no extra request. Plain module singleton like
 * session.ts - readable from React and non-React code alike.
 *
 * Screens that render the signed-in user's own profile photo need this id (the
 * avatar store keys by ABS user id, not the account id), and they can mount
 * before /api/me resolves - so the id is also subscribable, letting those
 * screens swap the initials fallback for the real photo the moment it lands.
 *
 * The account type lives here too. It decides who sees Server Admin, because the
 * app's token is a per-user ABS key, so the ABS type is what the server obeys. The
 * last known type is cached per server so the entry does not flicker at launch.
 * The server stays the authority: a stale value costs at most one 403.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

let currentUserId = ''

const listeners = new Set<() => void>()

/** Record the current user's ABS id (called wherever /api/me resolves). */
export function setMeId(id: string): void {
  if (!id || id === currentUserId) return
  currentUserId = id
  for (const fn of listeners) fn()
}

/** The connected user's ABS id, or '' before the first /api/me completes. */
export function getMeId(): string {
  return currentUserId
}

export function clearMeId(): void {
  if (!currentUserId) return
  currentUserId = ''
  for (const fn of listeners) fn()
}

/** Subscribe to id changes, for useSyncExternalStore. */
export function subscribeMeId(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const TYPES_KEY = 'hs.meTypes'

let accountType = ''
let accountTypeServerId: string | null = null
let accountTypeIsLive = false

const typeListeners = new Set<() => void>()

function notifyType(): void {
  for (const fn of typeListeners) fn()
}

async function readCachedTypes(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(TYPES_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Record the account type a live /api/me returned for this server. */
export function setMeType(serverId: string, type: string): void {
  const changed = type !== accountType || serverId !== accountTypeServerId
  accountType = type
  accountTypeServerId = serverId
  accountTypeIsLive = true
  if (changed) {
    notifyType()
    void readCachedTypes().then((types) =>
      AsyncStorage.setItem(TYPES_KEY, JSON.stringify({ ...types, [serverId]: type })).catch(
        () => {},
      ),
    )
  }
}

/** Point at a server, showing its last known type until a live answer lands.
 *  Calling it again for the same server changes nothing. */
export async function restoreMeType(serverId: string): Promise<void> {
  if (serverId === accountTypeServerId) return
  // The id is per server too. A stale one makes "is this me?" guards answer no on
  // the admin's own account, which would offer to disable it.
  clearMeId()
  accountType = ''
  accountTypeServerId = serverId
  accountTypeIsLive = false
  notifyType()
  const cached = (await readCachedTypes())[serverId]
  if (cached && serverId === accountTypeServerId && !accountTypeIsLive) {
    accountType = cached
    notifyType()
  }
}

/** The account type on the connected server, or '' while unknown. */
export function getMeType(): string {
  return accountType
}

/** True once /api/me has answered for the connected server during this run. */
export function isMeTypeLive(): boolean {
  return accountTypeIsLive
}

/** Forget every cached type. The next account on this device starts clean. */
export function clearMeType(): void {
  accountType = ''
  accountTypeServerId = null
  accountTypeIsLive = false
  notifyType()
  void AsyncStorage.removeItem(TYPES_KEY).catch(() => {})
}

/** Subscribe to type changes, for useSyncExternalStore. */
export function subscribeMeType(fn: () => void): () => void {
  typeListeners.add(fn)
  return () => typeListeners.delete(fn)
}
