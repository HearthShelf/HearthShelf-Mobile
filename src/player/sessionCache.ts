/**
 * Local cache of the server's recent listening sessions, so Recent Listens has
 * history to show with no network.
 *
 * The two Recent Listens sheets read the session list straight from ABS
 * (/api/me/listening-sessions). Offline that call just fails, so the sheet showed
 * nothing but whatever was still banked locally - a book you'd listened to for
 * hours looked like it had never been played, which is exactly when a listener
 * most wants to see that their listening is accounted for.
 *
 * Scoped to DOWNLOADED books: those are the ones you can still play (and keep
 * generating sessions for) with the server down, and it keeps the payload small.
 *
 * Plain subscribe-free snapshot store (the sheets fetch on open), persisted to
 * AsyncStorage and hydrated at launch like the other offline stores.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { ABSListeningSession } from '@hearthshelf/core'
import { getRecentSessions } from '@/api/abs'
import { getDownloadsState } from './downloads'

const STORE_KEY = 'hs.sessionCache.v1'

/** Per-book ceiling. The sheets show a short history, not an archive. */
const MAX_PER_ITEM = 25

let byItem = new Map<string, ABSListeningSession[]>()

/** Load the cached sessions from disk (call once at app start, before any sheet
 *  can open). */
export async function hydrateSessionCache(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { items?: ABSListeningSession[] }
    const next = new Map<string, ABSListeningSession[]>()
    for (const s of parsed.items ?? []) {
      if (!s || typeof s.libraryItemId !== 'string') continue
      const list = next.get(s.libraryItemId) ?? []
      list.push(s)
      next.set(s.libraryItemId, list)
    }
    for (const list of next.values()) list.sort((a, b) => b.updatedAt - a.updatedAt)
    byItem = next
  } catch {
    // A bad payload just means no offline history; the next online fetch refills.
  }
}

function persist(): void {
  const items: ABSListeningSession[] = []
  for (const list of byItem.values()) items.push(...list)
  void AsyncStorage.setItem(STORE_KEY, JSON.stringify({ items })).catch(() => {})
}

/** The cached sessions for one book, newest first. */
export function cachedSessionsFor(itemId: string): ABSListeningSession[] {
  return byItem.get(itemId) ?? []
}

/**
 * Take a fresh server session list and keep the rows belonging to downloaded
 * books. Replaces (rather than merges) each downloaded book's cache, so a session
 * deleted or edited on the server doesn't live on here forever.
 */
export function cacheSessions(all: ABSListeningSession[]): void {
  const downloaded = new Set(
    [...getDownloadsState().byId.values()].filter((e) => e.status === 'done').map((e) => e.itemId),
  )
  if (!downloaded.size) return
  const next = new Map(byItem)
  const seen = new Set<string>()
  for (const s of all) {
    if (!s?.libraryItemId || !downloaded.has(s.libraryItemId)) continue
    if (!seen.has(s.libraryItemId)) {
      seen.add(s.libraryItemId)
      next.set(s.libraryItemId, [])
    }
    next.get(s.libraryItemId)!.push(s)
  }
  for (const id of seen) {
    const list = next.get(id) ?? []
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    next.set(id, list.slice(0, MAX_PER_ITEM))
  }
  // Drop books that are no longer downloaded - their history isn't reachable
  // offline anyway, and the cache shouldn't outlive the download.
  for (const id of [...next.keys()]) if (!downloaded.has(id)) next.delete(id)
  byItem = next
  persist()
}

/**
 * One book's recent sessions for the Recent Listens sheets: the server's list
 * when we can reach it (refreshing the cache on the way through), the last known
 * list when we can't.
 */
export async function recentSessionsFor(itemId: string): Promise<ABSListeningSession[]> {
  try {
    const all = await getRecentSessions()
    cacheSessions(all)
    return all.filter((s) => s.libraryItemId === itemId)
  } catch {
    return cachedSessionsFor(itemId)
  }
}

/**
 * Refresh the whole cache in the background. Called on connect so a device that
 * was online at ANY point has history for its downloads - waiting until the user
 * happens to open the sheet while connected would leave the common case (open the
 * app, go offline, look for your listens) empty.
 */
export async function refreshSessionCache(): Promise<void> {
  try {
    cacheSessions(await getRecentSessions())
  } catch {
    // Offline or the server said no; the cache keeps whatever it had.
  }
}
