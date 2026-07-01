/**
 * Bridge ABS playback <-> the player store.
 *
 * playItem(): create an ABS play session, then load the stream + metadata into
 * the store (the <Video> host picks it up and plays). Both the phone UI and the
 * car screens call playItemById().
 */
import {
  startPlay,
  mediaUrl,
  coverUrl,
  closeSession,
  syncSession,
} from '@/api/abs'
import {
  loadTrack,
  getState,
  type NowPlaying,
} from './store'

interface ActiveSession {
  sessionId: string
  duration: number
  lastSyncedTime: number
}

let active: ActiveSession | null = null

/** Start playback for an ABS library item id. Title/author fall back to the
 *  play-session's display fields, so the car can play an item with only its id. */
export async function playItemById(itemId: string): Promise<void> {
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
