/**
 * Playback sessions recorded while the server was unreachable, waiting to reach
 * ABS.
 *
 * A downloaded book played offline (playback.ts, `offline` set) accrues a local
 * session here - real listened-time plus the final position - keyed by the book.
 * The newest record per item wins; a session only grows within one listen. On
 * reconnect (connectivity watcher / background task) flush() POSTs them to ABS's
 * /api/session/local-all, which ingests each as a real playback session, so an
 * hour listened offline shows up in recent listens and stats with the right
 * listened-time and date - not just a moved progress bar.
 *
 * Persisted to AsyncStorage so an offline listen survives the app being killed
 * and still syncs the next time the network returns.
 *
 * Plain subscribe/snapshot store (same shape as the other stores).
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { syncLocalSessions, type LocalSession } from '@/api/abs'
import { getSession } from '@/api/session'

export interface PendingSessionState {
  byId: ReadonlyMap<string, LocalSession>
}

const STORE_KEY = 'hs.pendingSessions.v1'

/** Name of the OS background task that flushes this store. Lives here (not in
 *  connectivity.ts) so the headless task module can reference it without pulling
 *  NetInfo into the cold-wake bundle. */
export const BACKGROUND_FLUSH_TASK = 'hs-flush-pending-progress'

let state: PendingSessionState = { byId: new Map() }
const listeners = new Set<() => void>()

function emit(byId: Map<string, LocalSession>): void {
  state = { byId }
  listeners.forEach((l) => l())
}

function persist(): void {
  const items = [...state.byId.values()]
  void AsyncStorage.setItem(STORE_KEY, JSON.stringify({ items })).catch(() => {})
}

export function getPendingSessionState(): PendingSessionState {
  return state
}

export function subscribePendingSessions(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function pendingCount(): number {
  return state.byId.size
}

/** Load persisted pending sessions on app start. */
export async function hydratePendingProgress(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { items?: LocalSession[] }
    const byId = new Map<string, LocalSession>()
    for (const s of parsed.items ?? []) {
      if (s && typeof s.libraryItemId === 'string') byId.set(s.libraryItemId, s)
    }
    emit(byId)
  } catch {
    // start empty on a bad payload
  }
}

/**
 * Record (or update) the offline session for a book. Keyed by libraryItemId so a
 * single offline listen accumulates into one session record - the latest tick's
 * position and listened-time overwrite the earlier one.
 */
export function recordLocalSession(session: LocalSession): void {
  if (!session.libraryItemId) return
  const byId = new Map(state.byId)
  byId.set(session.libraryItemId, session)
  emit(byId)
  persist()
}

/**
 * Replay every pending session to ABS, clearing each on success and keeping it on
 * failure (so a partial network blip retries next time). No-op when there's no
 * session (still offline) or nothing pending. Safe to call repeatedly.
 *
 * Returns true when there was nothing to send OR everything sent, false when a
 * send was attempted and failed - so a manual retry (the sync sheet) can tell the
 * user whether their banked offline listens reached the server.
 */
export async function flushPendingProgress(): Promise<boolean> {
  if (!getSession()) return false
  const items = [...state.byId.values()]
  if (!items.length) return true

  try {
    await syncLocalSessions(items)
  } catch {
    // Leave everything pending; the next reconnect/background pass retries.
    return false
  }

  // All ingested in one call - clear the ids we just sent (guarding against any
  // that were re-recorded meanwhile, though offline playback can't run once a
  // server session exists).
  const sentIds = new Set(items.map((s) => s.libraryItemId))
  const byId = new Map(state.byId)
  for (const id of sentIds) {
    const cur = byId.get(id)
    if (cur && cur.updatedAt <= (items.find((s) => s.libraryItemId === id)?.updatedAt ?? 0)) {
      byId.delete(id)
    }
  }
  emit(byId)
  persist()
  return true
}
