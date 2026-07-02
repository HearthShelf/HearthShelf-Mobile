/**
 * Bridge ABS playback <-> the player store.
 *
 * playItem(): create an ABS play session, then load the stream + metadata into
 * the store (the <Video> host picks it up and plays). Both the phone UI and the
 * car screens call playItemById().
 */
import { startPlay, mediaUrl, coverUrl, closeSession, syncSession } from '@/api/abs'
import { loadTrack, getState, type NowPlaying } from './store'
import { localSourceFor, applyAutoDownloads } from './downloads'
import { getQueueState } from './queue'

interface ActiveSession {
  sessionId: string
  duration: number
  lastSyncedTime: number
}

let active: ActiveSession | null = null

/** Start playback for an ABS library item id. Title/author fall back to the
 *  play-session's display fields, so the car can play an item with only its id.
 *  Downloaded books play from local files, so they still work fully offline. */
export async function playItemById(itemId: string): Promise<void> {
  const local = localSourceFor(itemId)
  if (local) {
    try {
      await playFromDownload(itemId)
      return
    } catch {
      // Local files unexpectedly unusable - fall through to streaming.
    }
  }
  const session = await startPlay(itemId)
  const track = session.audioTracks[0]
  if (!track) throw new Error('no_audio_track')

  // Close any prior ABS session first.
  if (active) await safeClose()

  const np: NowPlaying = {
    itemId,
    sessionId: session.id,
    title: session.displayTitle,
    author: session.displayAuthor ?? '',
    artworkUrl: coverUrl(itemId),
    url: mediaUrl(track.contentUrl),
    duration: session.duration,
    startPosition: session.currentTime > 0 ? session.currentTime : 0,
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
    duration: session.duration,
    lastSyncedTime: session.currentTime,
  }

  // Auto-download the book you just started (and prefetch the queue), per prefs.
  applyAutoDownloads({
    nowPlaying: { itemId, title: np.title, author: np.author },
    queue: getQueueState().items,
  })
}

/**
 * Play a downloaded book from local files, no server session. Uses the first
 * track's local file (the player host plays a single URL, matching how
 * streaming already feeds audioTracks[0]). Progress isn't synced to the server
 * while offline; `active` stays null so syncProgress() no-ops until the book is
 * next opened online.
 */
async function playFromDownload(itemId: string): Promise<void> {
  const local = localSourceFor(itemId)
  if (!local) throw new Error('not_downloaded')
  const first = local.tracks[0]
  if (!first) throw new Error('no_local_track')

  if (active) await safeClose()

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
}

/**
 * Push current position to ABS. Called on every progress tick (throttled to
 * ~15s of new listening) and, with `force`, when playback stops/pauses so the
 * server reflects where you actually stopped - otherwise falling asleep leaves
 * the last <15s (and the true stop point) unsynced, and "recent listens" lags.
 */
export async function syncProgress(currentTime: number, force = false): Promise<void> {
  if (!active) return
  const delta = Math.max(0, Math.round(currentTime - active.lastSyncedTime))
  if (!force && delta < 15) return
  active.lastSyncedTime = currentTime
  try {
    await syncSession(active.sessionId, {
      currentTime: Math.round(currentTime),
      timeListened: delta,
      duration: active.duration,
    })
  } catch {
    // car connectivity blips are expected; next tick retries
  }
}

async function safeClose(): Promise<void> {
  if (!active) return
  const { sessionId, duration } = active
  const pos = getState().position
  active = null
  try {
    await closeSession(sessionId, {
      currentTime: Math.round(pos),
      timeListened: 0,
      duration,
    })
  } catch {
    // ignore
  }
}

export async function stopPlayback(): Promise<void> {
  await safeClose()
}
