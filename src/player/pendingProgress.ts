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
import { ABSRequestError, syncLocalSession, syncLocalSessions, type LocalSession } from '@/api/abs'
import { getSession } from '@/api/session'
import { breadcrumb } from '@/lib/crashLog'
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
    let dropped = 0
    for (const s of oldest) {
      if (s.id !== session.id && byId.delete(s.id)) {
        dropped++
        forgetFailures(s.id)
      }
    }
    // Destroying banked offline listening with nothing on screen to show it was
    // the original bug this store was re-keyed to fix (see the module header), and
    // the ceiling reintroduces that shape. Nothing can be surfaced in the UI from
    // here, so at minimum leave a trail: if this crumb ever appears in a crash
    // report, real listening was thrown away and the cap needs revisiting.
    if (dropped > 0) {
      breadcrumb('pending', `evicted ${dropped} banked session(s) at cap ${MAX_PENDING}`)
    }
  }
  emit(byId)
  persist()
}

/** How many times ABS may REJECT one session before we stop replaying it.
 *
 *  A record ABS refuses (duration 0, a library item that's since been deleted) is
 *  never going to be accepted, and every flush that includes it used to fail the
 *  whole batch, so one poison session blocked every other banked listen forever -
 *  and held a slot while the cap evicted good ones. Retry a couple of times in case
 *  the rejection was transient (mid-scan library, a 5xx), then drop it. */
const MAX_SEND_FAILURES = 3

/** Rejection counts keyed by session id. Deliberately NOT persisted: a relaunch
 *  retrying a bad record a few more times is harmless and costs nothing, whereas
 *  writing counters to disk would mean a schema migration on the stored payload. */
const sendFailures = new Map<string, number>()

function forgetFailures(sessionId: string): void {
  sendFailures.delete(sessionId)
}

/**
 * Replay every pending session to ABS, clearing each on success and keeping it on
 * failure (so a partial network blip retries next time). No-op when there's no
 * session (still offline) or nothing pending. Safe to call repeatedly.
 *
 * Two failure modes, handled differently:
 *  - UNREACHABLE (plain Error, no status): the network went away mid-flush. Keep
 *    everything and retry on the next reconnect/background pass.
 *  - REJECTED (ABSRequestError): the server was reached and said no, so the
 *    PAYLOAD is at fault, not the link. /local-all is all-or-nothing, so resend
 *    one at a time: the good sessions land and only the genuinely-bad records stay
 *    behind, quarantined after MAX_SEND_FAILURES rather than blocking forever.
 *
 * Returns true when there was nothing to send OR everything sent, false when a
 * send was attempted and failed - so a manual retry (the sync sheet) can tell the
 * user whether their banked offline listens reached the server.
 */
export async function flushPendingProgress(): Promise<boolean> {
  if (!getSession()) return false
  const items = [...state.byId.values()]
  if (!items.length) return true

  /** Sessions ABS accepted (or permanently refused) and that can leave the store. */
  const settled: LocalSession[] = []
  let allSent = true

  try {
    await syncLocalSessions(items)
    settled.push(...items)
  } catch (err) {
    if (!(err instanceof ABSRequestError)) {
      // Couldn't reach the server. Leave everything pending untouched.
      return false
    }
    // Server reached and it refused the batch. Reaching it at all still proves it
    // is up, and the per-session pass below needs that recorded even if every
    // record turns out to be bad.
    notifyServerReached()
    allSent = false

    for (const item of items) {
      try {
        await syncLocalSession(item)
        settled.push(item)
        forgetFailures(item.id)
      } catch (single) {
        if (!(single instanceof ABSRequestError)) {
          // Network dropped partway through the one-at-a-time pass. Stop here and
          // let the next flush retry whatever is left; the ones already accepted
          // are cleared below.
          break
        }
        const failures = (sendFailures.get(item.id) ?? 0) + 1
        if (failures >= MAX_SEND_FAILURES) {
          // Give up on this record. Dropping it is the lesser evil: it can never
          // sync, and keeping it means it consumes a slot and forces every future
          // flush down this slow one-at-a-time path.
          breadcrumb(
            'pending',
            `quarantined session ${item.id} after ${failures} rejections (status ${single.status})`,
          )
          settled.push(item)
          forgetFailures(item.id)
        } else {
          sendFailures.set(item.id, failures)
        }
      }
    }
  }

  if (allSent) {
    // Reaching ABS is proof the server is up: let a stale offline connection phase
    // recover even when there's no live session driving syncStateSynced.
    notifyServerReached()
  }

  // Clear the sessions that are done with, but only if they haven't been written
  // again since (a live offline listen keeps updating its own record while the
  // flush is in flight).
  const byId = new Map(state.byId)
  for (const sent of settled) {
    const cur = byId.get(sent.id)
    if (cur && cur.updatedAt <= sent.updatedAt) {
      byId.delete(sent.id)
      forgetFailures(sent.id)
    }
  }
  emit(byId)
  persist()
  return allSent
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
