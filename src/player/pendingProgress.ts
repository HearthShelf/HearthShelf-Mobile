/**
 * Progress written while offline, waiting to reach the server.
 *
 * When a downloaded book plays with no server session (playback.ts, `active`
 * null), each position tick lands here instead of being dropped. The newest
 * position per item wins - we only need where the listener actually got to, not
 * every intermediate tick. On reconnect (connectivity watcher / background task)
 * flush() PATCHes each item's final position to ABS and clears it.
 *
 * Persisted to AsyncStorage so a position survives the app being killed offline
 * and still syncs the next time the network returns.
 *
 * Plain subscribe/snapshot store (same shape as the other stores).
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { putItemProgress } from '@/api/abs'
import { getSession } from '@/api/session'

export interface PendingProgress {
  itemId: string
  currentTime: number
  duration: number
  /** When this position was recorded (ms epoch), for newest-wins on flush. */
  atMs: number
}

export interface PendingProgressState {
  byId: ReadonlyMap<string, PendingProgress>
}

const STORE_KEY = 'hs.pendingProgress.v1'

/** Name of the OS background task that flushes this store. Lives here (not in
 *  connectivity.ts) so the headless task module can reference it without pulling
 *  NetInfo into the cold-wake bundle. */
export const BACKGROUND_FLUSH_TASK = 'hs-flush-pending-progress'

let state: PendingProgressState = { byId: new Map() }
const listeners = new Set<() => void>()

function emit(byId: Map<string, PendingProgress>): void {
  state = { byId }
  listeners.forEach((l) => l())
}

function persist(): void {
  const items = [...state.byId.values()]
  void AsyncStorage.setItem(STORE_KEY, JSON.stringify({ items })).catch(() => {})
}

export function getPendingProgressState(): PendingProgressState {
  return state
}

export function subscribePendingProgress(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function pendingCount(): number {
  return state.byId.size
}

/** Load persisted pending positions on app start. */
export async function hydratePendingProgress(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { items?: PendingProgress[] }
    const byId = new Map<string, PendingProgress>()
    for (const p of parsed.items ?? []) {
      if (p && typeof p.itemId === 'string') byId.set(p.itemId, p)
    }
    emit(byId)
  } catch {
    // start empty on a bad payload
  }
}

/**
 * Record where the listener is in an item, to sync when the server is reachable.
 * Newest position per item wins; a later record for the same item overwrites the
 * earlier one (progress only moves forward within a session).
 */
export function recordProgress(itemId: string, currentTime: number, duration: number): void {
  if (!itemId) return
  const byId = new Map(state.byId)
  byId.set(itemId, { itemId, currentTime, duration, atMs: Date.now() })
  emit(byId)
  persist()
}

/**
 * Push every pending position to ABS, clearing each on success and keeping it on
 * failure (so a partial network blip retries next time). No-op when there's no
 * session (still offline) or nothing pending. Safe to call repeatedly.
 */
export async function flushPendingProgress(): Promise<void> {
  if (!getSession()) return
  const items = [...state.byId.values()]
  if (!items.length) return

  const synced: string[] = []
  for (const p of items) {
    try {
      const progress = p.duration > 0 ? Math.min(1, p.currentTime / p.duration) : 0
      await putItemProgress(p.itemId, {
        currentTime: Math.round(p.currentTime),
        duration: p.duration,
        progress,
      })
      synced.push(p.itemId)
    } catch {
      // Leave it pending; the next reconnect/background pass retries.
    }
  }

  if (synced.length) {
    const byId = new Map(state.byId)
    for (const id of synced) byId.delete(id)
    emit(byId)
    persist()
  }
}
