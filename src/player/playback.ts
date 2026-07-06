/**
 * Bridge ABS playback <-> the player store.
 *
 * playItemById(): open an ABS play session (when online), then load the audio +
 * metadata into the store (PlayerHost picks it up and plays). Both the phone UI
 * and the car screens call playItemById().
 *
 * Downloaded books play from their local files to save data - but when we're
 * online we STILL open a server session and sync listening time, so recent
 * listens and stats work exactly as they do for streaming. Only when the server
 * is unreachable do we fall back to a local-only session that's replayed to ABS
 * (via /api/session/local) once we reconnect.
 */
import { startPlay, mediaUrl, coverUrl, closeSession, syncSession, ABSRequestError } from '@/api/abs'
import { getSession } from '@/api/session'
import { loadTrack, getState, type NowPlaying } from './store'
import { localSourceFor, applyAutoDownloads } from './downloads'
import { recordLocalSession } from './pendingProgress'
import { getQueueState } from './queue'
import {
  syncStateStartSession,
  syncStateTick,
  syncStateSynced,
  syncStatePending,
  syncStateFailed,
  syncStateClear,
} from './syncState'

interface ActiveSession {
  sessionId: string
  itemId: string
  duration: number
  /** ms epoch this session started (for the live Recent Listens row). */
  startedAt: number
  /** Book position (seconds) at the last successful server sync. */
  lastSyncedTime: number
  /** Real listened-time (seconds) accrued since the last server sync. Grows
   *  from actual playback between ticks, so seeks/skips never count. */
  pendingListened: number
  /** Total real listened-time (seconds) this session - synced + pending. Only
   *  for display (the live "Now" row); ABS gets deltas via timeListened. */
  totalListened: number
}

// A local-only session for a downloaded book playing while the server is
// unreachable. Accrues real listened-time to replay to ABS on reconnect.
interface OfflineSession {
  localId: string
  itemId: string
  title: string
  duration: number
  currentTime: number
  /** Real listened-time (seconds) accrued this session. */
  timeListening: number
  startedAt: number
}

let active: ActiveSession | null = null
let offline: OfflineSession | null = null
// The book position reported by the previous progress tick, used to derive real
// listened-time (the gap between ticks while playing). Reset on load/seek.
let lastTickTime: number | null = null

/** The largest believable gap (seconds) between two progress ticks that counts
 *  as real listening. Ticks arrive ~1s apart; a bigger jump is a seek, a chapter
 *  skip, or the app being backgrounded - none of which is listened time. */
const MAX_TICK_GAP = 10
/** Sync to the server once this much real listened-time has accrued. */
const SYNC_LISTENED_THRESHOLD = 15

/** Start playback for an ABS library item id. Title/author fall back to the
 *  play-session's display fields, so the car can play an item with only its id.
 *  Downloaded books play from local files (data-saving), and still report
 *  listening: online via a real ABS session, offline via a replayed local one. */
export async function playItemById(itemId: string): Promise<void> {
  const local = localSourceFor(itemId)
  const online = !!getSession()

  // Downloaded + offline: no server reachable, so play locally and accrue a
  // local session to replay on reconnect.
  if (local && !online) {
    await playFromDownloadOffline(itemId)
    return
  }

  // Online (streaming OR downloaded): open a real ABS session so listening is
  // recorded. Downloaded books swap in the local file URL to save data.
  let session
  try {
    session = await startPlay(itemId)
  } catch (e) {
    // Server unreachable mid-attempt: fall back to a local-only session if the
    // book is downloaded, otherwise surface the error.
    if (local) {
      await playFromDownloadOffline(itemId)
      return
    }
    throw e
  }

  const track = session.audioTracks[0]
  if (!track && !local) throw new Error('no_audio_track')

  // Close any prior ABS session first.
  if (active) await safeClose()
  offline = null
  lastTickTime = null

  const startAt = session.currentTime > 0 ? session.currentTime : 0
  const np: NowPlaying = {
    itemId,
    sessionId: session.id,
    title: session.displayTitle || local?.title || '',
    author: session.displayAuthor ?? local?.author ?? '',
    artworkUrl: local?.coverUri ?? coverUrl(itemId),
    // Downloaded: play the local file (no streaming data). Otherwise stream.
    url: local?.tracks[0]?.uri ?? mediaUrl(track!.contentUrl),
    duration: session.duration,
    startPosition: startAt,
    // The play-session already carries chapters - no extra detail fetch needed.
    chapters: (session.chapters ?? []).map((c) => ({
      title: c.title,
      start: c.start,
      end: c.end,
    })),
  }
  loadTrack(np)

  active = {
    sessionId: session.id,
    itemId,
    duration: session.duration,
    startedAt: startedNow(),
    lastSyncedTime: startAt,
    pendingListened: 0,
    totalListened: 0,
  }
  syncStateStartSession(itemId, active.startedAt, startAt)

  // Auto-download the book you just started (and prefetch the queue), per prefs.
  applyAutoDownloads({
    nowPlaying: { itemId, title: np.title, author: np.author },
    queue: getQueueState().items,
  })
}

/**
 * Play a downloaded book from local files with no reachable server. Accrues a
 * local-only session (real listened-time + position) that flushPendingProgress()
 * replays to ABS via /api/session/local once we reconnect, so a fully-offline
 * listen still lands in recent listens and stats with the right listened-time.
 */
async function playFromDownloadOffline(itemId: string): Promise<void> {
  const local = localSourceFor(itemId)
  if (!local) throw new Error('not_downloaded')
  const first = local.tracks[0]
  if (!first) throw new Error('no_local_track')

  if (active) await safeClose()
  lastTickTime = null

  const np: NowPlaying = {
    itemId,
    sessionId: '',
    title: local.title,
    author: local.author,
    artworkUrl: local.coverUri ?? coverUrl(itemId),
    url: first.uri,
    duration: local.duration,
    startPosition: 0,
    chapters: local.chapters.map((c) => ({ title: c.title, start: c.start, end: c.end })),
  }
  loadTrack(np)
  active = null
  const startedAt = startedNow()
  offline = {
    localId: `play_local_${itemId}_${startedAt}`,
    itemId,
    title: local.title,
    duration: local.duration,
    currentTime: 0,
    timeListening: 0,
    startedAt,
  }
  syncStateStartSession(itemId, startedAt, 0)
  // Offline downloaded book: it's banked locally, not on the server yet.
  syncStateFailed()
}

/** Wall-clock ms; isolated so the one Date.now() call is easy to reason about. */
function startedNow(): number {
  return Date.now()
}

/** Snapshot the live offline session into the persisted LocalSession shape ABS
 *  ingests (via /api/session/local-all). */
function offlineSnapshot(o: OfflineSession, currentTime: number): import('@/api/abs').LocalSession {
  return {
    id: o.localId,
    libraryItemId: o.itemId,
    mediaType: 'book',
    displayTitle: o.title,
    duration: o.duration,
    currentTime: Math.round(currentTime),
    timeListening: Math.round(o.timeListening),
    startedAt: o.startedAt,
    updatedAt: startedNow(),
  }
}

/**
 * Real listened-time (seconds) advanced since the previous tick. The gap between
 * consecutive progress ticks IS listened time while playing; a jump bigger than
 * MAX_TICK_GAP (a seek, chapter skip, or a background gap) is not, and a
 * backwards move (rewind) is not. Returns 0 for those.
 */
function tickListened(currentTime: number): number {
  const prev = lastTickTime
  lastTickTime = currentTime
  if (prev === null) return 0
  const gap = currentTime - prev
  if (gap <= 0 || gap > MAX_TICK_GAP) return 0
  return gap
}

/**
 * Fold the current progress tick into whichever session is active. Syncs to the
 * server once enough real listened-time has accrued, and on `force` (pause/stop)
 * so the server reflects the true stop point and recent listens stays fresh.
 */
export async function syncProgress(currentTime: number, force = false): Promise<void> {
  const listened = tickListened(currentTime)

  if (offline) {
    // Offline downloaded book: accrue locally; the record is flushed as a proper
    // ABS session on reconnect. Stays red (banked, not on the server).
    offline.currentTime = currentTime
    offline.timeListening += listened
    recordLocalSession(offlineSnapshot(offline, currentTime))
    syncStateTick(currentTime, offline.timeListening)
    return
  }

  if (!active) return

  active.pendingListened += listened
  active.totalListened += listened
  // Keep the live "Now" row current every tick (no status change).
  syncStateTick(currentTime, active.totalListened)

  // Sync on `force` (pause/stop/book-switch) ALWAYS - even a few seconds of
  // listening should land - or once enough real listened-time has accrued.
  if (!force && active.pendingListened < SYNC_LISTENED_THRESHOLD) return
  if (active.pendingListened <= 0) return

  await pushListened(active, currentTime)
}

/** POST the active session's accrued listened-time + position. Marks pending only
 *  if it fails (red on network loss), synced on success - a normal background push
 *  doesn't visibly change the green icon. */
async function pushListened(a: ActiveSession, currentTime: number): Promise<boolean> {
  const timeListened = Math.round(a.pendingListened)
  a.pendingListened = 0
  a.lastSyncedTime = currentTime
  try {
    await syncSession(a.sessionId, {
      currentTime: Math.round(currentTime),
      timeListened,
      duration: a.duration,
    })
    syncStateSynced(startedNow())
    return true
  } catch (e) {
    // A 404 means the session is gone from ABS's in-memory store (server
    // restarted or it expired) - retrying the same id can never succeed, so
    // reopen a fresh session and re-push against it instead of looping forever.
    if (e instanceof ABSRequestError && e.status === 404) {
      return reopenAndResync(a, currentTime, timeListened)
    }
    // Connectivity blip: roll the unsynced time back so the next tick retries it,
    // and show red - we couldn't reach the server.
    a.pendingListened += timeListened
    syncStateFailed()
    return false
  }
}

/** The active session died server-side (404). Open a new ABS session for the same
 *  book and sync the delta we were mid-flight with onto it, so no listened-time is
 *  lost. If reopening fails (server truly unreachable), re-bank the delta and go
 *  red so a later tick retries. Guards against a stale close: only adopt the new
 *  session if `a` is still the active one. */
async function reopenAndResync(
  a: ActiveSession,
  currentTime: number,
  timeListened: number,
): Promise<boolean> {
  try {
    const session = await startPlay(a.itemId)
    // Playback moved on (book switched / stopped) while we were reopening: don't
    // clobber the newer session. Bank onto the fresh id via a fire-and-forget
    // sync so the time still lands.
    if (a !== active) {
      await syncSession(session.id, {
        currentTime: Math.round(currentTime),
        timeListened,
        duration: a.duration,
      })
      return true
    }
    a.sessionId = session.id
    await syncSession(session.id, {
      currentTime: Math.round(currentTime),
      timeListened,
      duration: a.duration,
    })
    syncStateSynced(startedNow())
    return true
  } catch {
    a.pendingListened += timeListened
    syncStateFailed()
    return false
  }
}

/** Push the current position (and any accrued listened-time) to the server right
 *  now - the header sync icon's tap. Unlike a normal tick this ALWAYS sends,
 *  even with zero new listened-time, so a seek-while-paused lands the new spot on
 *  the server (handy for jumping to a chapter our app knows about from elsewhere).
 *  No-op offline (banked locally already) or when idle.
 *
 *  Returns true when the push reached the server, false when it couldn't (offline
 *  / failed) or there was nothing playing to sync. The sync sheet uses this to
 *  show the listener real feedback instead of a silent tap. */
export async function forceSyncNow(): Promise<boolean> {
  if (offline) return false
  if (!active) return false
  // Always send, even with zero new listened-time, so a seek-while-paused lands
  // the new position on the server.
  return pushListened(active, getState().position)
}

async function safeClose(): Promise<void> {
  if (!active) return
  const { sessionId, duration, pendingListened } = active
  const pos = getState().position
  active = null
  lastTickTime = null
  try {
    await closeSession(sessionId, {
      currentTime: Math.round(pos),
      // Bank any listened-time not yet synced so closing doesn't lose it.
      timeListened: Math.round(pendingListened),
      duration,
    })
    if (pendingListened > 0) syncStateSynced(startedNow())
  } catch {
    if (pendingListened > 0) syncStateFailed()
  }
}

export async function stopPlayback(): Promise<void> {
  if (offline) {
    // Persist the final offline position + listened-time before forgetting which
    // book was playing, so stopping lands the true end point for later replay.
    recordLocalSession(offlineSnapshot(offline, getState().position))
    offline = null
    lastTickTime = null
  }
  await safeClose()
  syncStateClear()
}
