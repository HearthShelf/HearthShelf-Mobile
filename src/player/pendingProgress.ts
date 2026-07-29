/**
 * Playback sessions recorded while the server was unreachable, waiting to reach
 * ABS.
 *
 * A downloaded book played offline (playback.ts, `offline` set) accrues a local
 * session here - real listened-time plus the final position. On reconnect
 * (connectivity watcher / background task) flush() POSTs them to ABS's
 * /api/session/local-all, which ingests each as a real playback session, so an
 * hour listened offline shows up in recent listens and stats with the right
 * listened-time and date - not just a moved progress bar.
 *
 * KEYED BY SESSION ID, not by book. It used to be keyed by libraryItemId, which
 * silently destroyed offline listening on a long outage: every new listen of the
 * same book minted a new session id but wrote to the same slot, so starting a
 * second listen REPLACED the first. An hour banked in the morning became a
 * one-minute session in the evening - the position survived (progress.ts is a
 * separate store), but the listening time and its place in the session history
 * were gone, with nothing on screen to suggest anything had been lost.
 *
 * Persisted to AsyncStorage so an offline listen survives the app being killed
 * and still syncs the next time the network returns.
 *
 * This module ALSO holds the streaming safety buffer (see the second half): the
 * durable mirror of an online session's not-yet-synced listened-time, which is
 * what makes a kill mid-stream lose one tick instead of a whole sync window.
 *
 * Plain subscribe/snapshot store (same shape as the other stores).
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { syncLocalSessions, type LocalSession } from '@/api/abs'
import { getSession } from '@/api/session'
import { notifyServerReached } from './syncState'

export interface PendingSessionState {
  /** Keyed by SESSION id (not book id) - one book can have many banked listens. */
  byId: ReadonlyMap<string, LocalSession>
}

const STORE_KEY = 'hs.pendingSessions.v1'

/** Ceiling on banked sessions, oldest dropped first. A multi-day outage with
 *  aggressive listening is still only a few dozen; this exists so a pathological
 *  case can't grow the payload without bound. */
const MAX_PENDING = 500

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

/** Every banked listen of one book, newest first. Recent Listens renders these
 *  as unsynced rows, so a week of offline listening reads as a week of listens. */
export function pendingSessionsFor(itemId: string): LocalSession[] {
  return [...state.byId.values()]
    .filter((s) => s.libraryItemId === itemId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Distinct books with something banked (for the sync sheet's "what's waiting"). */
export function pendingBooks(): { libraryItemId: string; displayTitle: string }[] {
  const byBook = new Map<string, string>()
  for (const s of state.byId.values()) {
    if (!byBook.has(s.libraryItemId)) byBook.set(s.libraryItemId, s.displayTitle)
  }
  return [...byBook.entries()].map(([libraryItemId, displayTitle]) => ({
    libraryItemId,
    displayTitle,
  }))
}

/** Load persisted pending sessions on app start. */
export async function hydratePendingProgress(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { items?: LocalSession[] }
    const byId = new Map<string, LocalSession>()
    for (const s of parsed.items ?? []) {
      if (!s || typeof s.libraryItemId !== 'string') continue
      // Re-key on the session id. Payloads written by the book-keyed version are
      // read back unchanged - every record already carried its own id, there was
      // just only ever one of them per book.
      byId.set(s.id || s.libraryItemId, s)
    }
    emit(byId)
  } catch {
    // start empty on a bad payload
  }
}

/**
 * Record (or update) one offline session. Keyed by the SESSION id, so ticks
 * within a listen update that listen in place while a LATER listen of the same
 * book lands beside it instead of overwriting it.
 */
export function recordLocalSession(session: LocalSession): void {
  if (!session.libraryItemId || !session.id) return
  const byId = new Map(state.byId)
  byId.set(session.id, session)
  // Drop the oldest if we somehow blow past the ceiling. Never touches the
  // session being written.
  if (byId.size > MAX_PENDING) {
    const oldest = [...byId.values()]
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, byId.size - MAX_PENDING)
    for (const s of oldest) if (s.id !== session.id) byId.delete(s.id)
  }
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
  // Reaching ABS is proof the server is up: let a stale offline connection phase
  // recover even when there's no live session driving syncStateSynced.
  notifyServerReached()

  // All ingested in one call - clear the sessions we just sent, but only if they
  // haven't been written again since (a live offline listen keeps updating its
  // own record while the flush is in flight).
  const byId = new Map(state.byId)
  for (const sent of items) {
    const cur = byId.get(sent.id)
    if (cur && cur.updatedAt <= sent.updatedAt) byId.delete(sent.id)
  }
  emit(byId)
  persist()
  return true
}

// ---------------------------------------------------------------------------
// Streaming safety buffer
// ---------------------------------------------------------------------------

/**
 * Durable mirror of an ONLINE session's not-yet-synced listened-time.
 *
 * The live ABS session is still what reports listening; this is only a safety
 * net. playback.ts accrues listened-time in memory and pushes it to the server
 * every SYNC_LISTENED_THRESHOLD seconds (or on pause/stop). A swipe-away, an OS
 * memory kill, or a crash in between takes that in-memory time with it - and if
 * syncs have been failing, the rolled-back time can be far more than one
 * threshold window.
 *
 * So: every tick writes the outstanding amount here, every confirmed sync
 * subtracts what landed, and whatever survives to the next launch is migrated
 * into the pending-session ledger above and replayed like any offline listen.
 * Worst case loss is one tick.
 *
 * Keyed by libraryItemId. Values are seconds, always >= 0.
 */
const STREAMING_KEY = 'hs.streamingPending.v1'

interface StreamingEntry {
  /** Outstanding listened-time (seconds) not yet confirmed by a server sync. */
  seconds: number
  /** Book position (seconds) at the last tick - the replayed session's stop point. */
  currentTime: number
  duration: number
  title: string
  /** ms epoch the live session started, so a replay lands on the right day. */
  startedAt: number
}

let streaming = new Map<string, StreamingEntry>()

function persistStreaming(): void {
  const items = [...streaming.entries()].map(([libraryItemId, e]) => ({ libraryItemId, ...e }))
  void AsyncStorage.setItem(STREAMING_KEY, JSON.stringify({ items })).catch(() => {})
}

/** Load the streaming buffer from disk. Call before migrateOrphanStreaming(). */
export async function hydrateStreamingBuffer(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STREAMING_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { items?: (StreamingEntry & { libraryItemId: string })[] }
    const next = new Map<string, StreamingEntry>()
    for (const it of parsed.items ?? []) {
      if (!it || typeof it.libraryItemId !== 'string') continue
      const { libraryItemId, ...entry } = it
      if (entry.seconds > 0) next.set(libraryItemId, entry)
    }
    streaming = next
  } catch {
    // start empty on a bad payload
  }
}

/**
 * Record the outstanding (unsynced) listened-time for a live streaming session.
 * Called every tick with the CURRENT outstanding total, not a delta - playback.ts
 * already tracks the running figure, and an absolute write means a dropped call
 * can't drift the buffer.
 */
export function setStreamingPending(
  libraryItemId: string,
  entry: {
    seconds: number
    currentTime: number
    duration: number
    title: string
    startedAt: number
  },
): void {
  if (!libraryItemId) return
  if (entry.seconds <= 0) {
    if (streaming.delete(libraryItemId)) persistStreaming()
    return
  }
  streaming.set(libraryItemId, { ...entry })
  persistStreaming()
}

/**
 * Subtract listened-time a server sync just confirmed. Subtracts rather than
 * clearing so time accrued while the request was in flight survives - clearing
 * outright would drop it.
 */
export function reduceStreamingPending(libraryItemId: string, seconds: number): void {
  if (!libraryItemId || seconds <= 0) return
  const cur = streaming.get(libraryItemId)
  if (!cur) return
  const next = cur.seconds - seconds
  if (next > 0) streaming.set(libraryItemId, { ...cur, seconds: next })
  else streaming.delete(libraryItemId)
  persistStreaming()
}

/** Drop a book's buffer outright - the session closed cleanly and banked its time. */
export function clearStreamingPending(libraryItemId: string): void {
  if (streaming.delete(libraryItemId)) persistStreaming()
}

/**
 * A non-empty buffer at startup means a stream died before its last span synced.
 * Fold each survivor into the pending-session ledger so the normal flush replays
 * it as a real ABS session.
 *
 * MUST run at launch before playback opens any new session, otherwise a fresh
 * session's writes race the migration.
 */
export async function migrateOrphanStreaming(): Promise<void> {
  if (!streaming.size) return
  const orphans = [...streaming.entries()]
  streaming = new Map()
  persistStreaming()

  const now = Date.now()
  for (const [libraryItemId, e] of orphans) {
    if (e.seconds <= 0) continue
    recordLocalSession({
      id: `play_orphan_${libraryItemId}_${e.startedAt}`,
      libraryItemId,
      mediaType: 'book',
      displayTitle: e.title,
      duration: e.duration,
      currentTime: Math.round(e.currentTime),
      timeListening: Math.round(e.seconds),
      startedAt: e.startedAt,
      // The listen ended when the app died; we only know it was before now.
      updatedAt: now,
    })
  }
}
