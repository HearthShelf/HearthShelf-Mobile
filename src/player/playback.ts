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
import {
  startPlay,
  mediaUrl,
  coverUrl,
  closeSession,
  syncSession,
  getItemDetail,
  ABSRequestError,
} from '@/api/abs'
import { getSession } from '@/api/session'
import type { ABSMediaProgress } from '@hearthshelf/core'
import {
  progressFor,
  progressHydrated,
  recordLocalProgress,
  serverProgressUpdatedAt,
  isFinished,
  markFinished,
  refreshProgress,
} from '@/store/progress'
import { endOfListenVerdict } from './completion'
import {
  loadTrack,
  getState,
  attachSessionId,
  updateChapters,
  type NowPlaying,
  type ChapterMark,
} from './store'
import { localSourceFor, applyAutoDownloads, refreshDownloadMetadata } from './downloads'
import {
  recordLocalSession,
  setStreamingPending,
  reduceStreamingPending,
  clearStreamingPending,
} from './pendingProgress'
import { breadcrumb } from '@/lib/crashLog'
import { getQueueState } from './queue'
import { armRecomputeCooldown, cancelRecomputeCooldown } from './recompute'
import {
  syncStateStartSession,
  syncStateTick,
  syncStateSynced,
  syncStatePending,
  syncStateFailed,
  syncStateClear,
  isOfflineMode,
  subscribeSeeked,
  setLiveSession,
} from './syncState'

interface ActiveSession {
  sessionId: string
  itemId: string
  duration: number
  /** Display title, carried so the durable streaming buffer can replay this
   *  session as a proper local session if the app dies mid-listen. */
  title: string
  /** ms epoch this session started (for the live Recent Listens row). */
  startedAt: number
  /** When the CURRENT ABS session id was opened. Differs from startedAt after a
   *  404 reopen; tracing-only, so segment length is measurable without
   *  disturbing the listen's true start date. */
  segmentOpenedAt?: number
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
  /** Position the session opened at. Kept so a session that never moved and never
   *  accrued time can be recognised as carrying no information (see bankOffline). */
  startPosition: number
  /** Real listened-time (seconds) accrued this session. */
  timeListening: number
  startedAt: number
}

let active: ActiveSession | null = null

/**
 * Set (or clear) the active session, keeping the shared live-session registry in
 * step.
 *
 * Every assignment to `active` goes through here. The registry is what stops the
 * background flush task from closing the session the user is listening on (see
 * syncState.setLiveSession), and a single missed clear would resurrect that bug
 * in a way no type checks - so the two are mutated together in one place rather
 * than at each of the five call sites.
 */
function setActiveSession(next: ActiveSession | null): void {
  active = next
  setLiveSession(next ? next.sessionId : null)
}
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

/** How far into a book a FINISHED book's saved position has to sit before we
 *  treat it as a leftover end-of-book marker rather than a real re-listen spot.
 *  A book you listened to the end of parks its position in the last few percent
 *  (ABS marks finished at the end, and our own removeDownloadOnFinish path fires
 *  from there too), so anything past this line is "you're done", not "you're
 *  here". 90% is deliberately loose: it comfortably covers credits/outro tracks
 *  and books ABS marked finished a little short of the true end, while a genuine
 *  re-listen has to get 90% of the way through again before it stops resuming -
 *  and at that point restarting costs the listener almost nothing. */
const FINISHED_RELISTEN_MAX_PROGRESS = 0.9

/**
 * Where a book should start, given its saved media progress. Returns 0 for "start
 * at the beginning".
 *
 * Unfinished books simply resume at their saved spot. Finished books are the
 * subtle case, and both play paths must agree on it - hence one helper.
 * recordLocalProgress() keeps writing position for a finished book (so an offline
 * re-listen has somewhere to resume FROM) while deliberately leaving isFinished
 * true, so isFinished alone can no longer mean "ignore the saved position". But
 * we still can't resume every finished book: a book you just finished has its
 * position parked at the end, and tapping it should start it over, not drop you
 * in the credits. So decide on how far through the saved position sits - early or
 * mid-book on a finished book means the listener already restarted it and is
 * genuinely partway through a re-listen.
 *
 * Duration is the denominator and offline rows can be sparse, so fall back to the
 * server-supplied `progress` fraction when duration is missing/0, and refuse to
 * resume a finished book when neither is usable (starting over is the safe wrong
 * answer; landing at the credits is the bad one).
 */
function resumePositionFor(saved: ABSMediaProgress | undefined): number {
  if (!saved || !(saved.currentTime > 0)) return 0
  if (!saved.isFinished) return saved.currentTime
  // A finished book reads as progress 1 in our own store regardless of where the
  // re-listen sits, so derive the fraction from currentTime/duration first and
  // only fall back to `progress` when there's no usable duration.
  const fraction =
    saved.duration > 0
      ? saved.currentTime / saved.duration
      : saved.progress > 0 && saved.progress < 1
        ? saved.progress
        : null
  if (fraction === null) return 0
  return fraction < FINISHED_RELISTEN_MAX_PROGRESS ? saved.currentTime : 0
}

/** How far apart (seconds) the local and server positions must be before the
 *  freshness comparison is worth making. Inside this the two are effectively the
 *  same spot and the server's value is kept, so ordinary rounding between a tick
 *  and its sync can never nudge the resume point. */
const LOCAL_RESUME_MIN_DELTA = 5

/** How stale (ms) a local write may be and still be trusted over the server. A
 *  local row older than this belongs to some earlier sitting - by then the server
 *  is the better authority, whatever the timestamps say. Generous enough to cover
 *  a kill mid-listen plus the time it takes the listener to reopen the app. */
const LOCAL_RESUME_MAX_AGE_MS = 12 * 60 * 60 * 1000

/**
 * Decide where to actually resume, given the position the play-session came back
 * with.
 *
 * There are THREE candidate positions at this moment, from three different
 * sources, and none of them is reliably authoritative on its own:
 *
 *  1. `sessionTime` - the play-session's own currentTime, from POST /items/:id/play.
 *  2. The MEDIA PROGRESS row from /api/me (progressFor + serverProgressUpdatedAt),
 *     which every device writes to and which carries ABS's own `lastUpdate` stamp.
 *  3. Our LOCAL row, written by recordLocalProgress on each playback tick and
 *     stamped with a local clock.
 *
 * Two distinct failure modes made all three necessary:
 *
 * KILL-BEFORE-SYNC (candidate 3 wins). Syncs are throttled to
 * SYNC_LISTENED_THRESHOLD of real listened-time, and a seek accrues none at all.
 * Kill the app inside that window - which Android does freely once the screen is
 * off, while the media service keeps playing - and both server-side values are
 * stale by everything heard since the last push.
 *
 * STALE SESSION POSITION (candidate 2 wins). Observed: listened to ch.41 in the
 * car (WebApp), opened the phone, hit play, and resumed at ch.38 - the spot the
 * phone had died at earlier, while /api/me's progress row correctly held ch.41.
 * So a session opened by this device can come back carrying a position older than
 * the media-progress row, and it is not safe to assume the session reflects the
 * most recent listening.
 *
 * The precise server-side mechanism is NOT confirmed - ABS keys sessions on
 * (userId, deviceId) and its reaper runs on a long horizon, so this device's
 * abandoned session is still present, but whether startPlay resumes it or opens a
 * fresh one seeded from stale state has not been verified against ABS's source.
 * The reconciliation below is correct either way, because it only relies on the
 * observation: when the session and the progress row disagree, the row is the one
 * every device writes and is the better authority.
 *
 * So: never trust the session position by itself. Take whichever of the three was
 * WRITTEN most recently. Ordering by timestamp rather than by magnitude is what
 * keeps a legitimate backwards move (a re-listen, a rewind on another device)
 * from being undone by a max().
 *
 * The session has no timestamp of its own, so it is treated as the floor: it wins
 * only when neither stamped candidate beats it. That is the right default,
 * because a genuinely fresh session's position is also reflected in the media
 * progress row it was opened from.
 */
function resolveResumePosition(itemId: string, sessionTime: number): number {
  const saved = progressFor(itemId)
  if (!saved || !(saved.currentTime > 0)) return sessionTime

  const savedAt = saved.lastUpdate
  if (!savedAt) return sessionTime
  // Too close to matter: keep the session's value so ordinary rounding between a
  // tick and its sync can never nudge the resume point.
  if (Math.abs(saved.currentTime - sessionTime) < LOCAL_RESUME_MIN_DELTA) return sessionTime

  // Is the stored row a local write or the server's own? serverUpdatedAt holds
  // ABS's stamp as of the last /api/me refresh; recordLocalProgress restamps
  // `lastUpdate` with a local clock on every tick. When the row's stamp is newer
  // than the server's, a local tick wrote it last.
  const serverAt = serverProgressUpdatedAt(itemId)
  const isLocalWrite = !serverAt || savedAt > serverAt

  if (isLocalWrite) {
    // Kill-before-sync: only trust a local row recent enough to belong to the
    // sitting we're resuming. An older one is some earlier listen, and by then
    // the server (or another device) is the better authority.
    if (Date.now() - savedAt > LOCAL_RESUME_MAX_AGE_MS) return sessionTime
    breadcrumb(
      'resume',
      `local ${Math.round(saved.currentTime)}s over session ${Math.round(sessionTime)}s`,
    )
    return saved.currentTime
  }

  // Server-written row, disagreeing with the session it was fetched alongside.
  //
  // Both come from ABS, so one of them is a ghost. The media-progress row is the
  // one every device writes on every sync, and it is the value ABS itself shows
  // on tiles and hands to the WebApp; a session is per-device state that can sit
  // untouched for as long as the reaper allows. When the two disagree, the row is
  // the better authority - it is where the LISTENER actually is, whereas the
  // session is only where THIS DEVICE last was.
  //
  // Deliberately not gated on which is further along: the car moving forward and
  // a re-listen moving backward must both win over a stale phone session.
  breadcrumb(
    'resume',
    `server progress ${Math.round(saved.currentTime)}s over stale session ${Math.round(sessionTime)}s`,
  )
  return saved.currentTime
}

/**
 * Never resume BEHIND the playhead our own native player is already sitting on.
 *
 * The audio lives in a foreground media service that outlives the JS runtime and
 * keeps playing with the screen off. Reloading the same book mints a new session
 * id, which makes PlayerHost re-issue Native.load(url, startPosition) - and that
 * seeks the running service to whatever position JS just reconstructed. So a
 * re-resolve while the service is still playing does not merely display a stale
 * spot, it drags the audio back to it.
 *
 * Every server-side candidate is a reconstruction; the live playhead is the one
 * value that was actually observed. When the store already holds THIS book with a
 * position meaningfully ahead, keep it.
 *
 * Scoped deliberately:
 *  - same itemId only, so switching books is untouched;
 *  - not while the car owns playback (the store is mirroring the car there, and
 *    the handoff paths set the position on purpose);
 *  - ahead only, by more than LOCAL_RESUME_MIN_DELTA, so a genuine backwards move
 *    resolved from the server (a re-listen, a rewind elsewhere) still wins and
 *    ordinary rounding never nudges the resume point.
 *
 * This does not help when the JS runtime restarted - the store is empty there and
 * the position has to come off disk, which is what keepFresherLocalPositions() in
 * the progress store protects.
 */
function preferLivePlayhead(itemId: string, startAt: number): number {
  const s = getState()
  if (s.carActive) return startAt
  if (s.nowPlaying?.itemId !== itemId) return startAt
  const live = s.position
  if (!(live > 0) || live - startAt <= LOCAL_RESUME_MIN_DELTA) return startAt
  breadcrumb('resume', `live playhead ${Math.round(live)}s over resolved ${Math.round(startAt)}s`)
  return live
}

/**
 * Coerce raw chapter data from the server (or a local download) into well-typed
 * ChapterMark[]. ABS's response is only type-asserted, not validated, so a
 * mid-restart/stale response with a null/missing title would otherwise flow
 * straight into <Text> children and trip "Text strings must be rendered within
 * a <Text> component". Logs a breadcrumb when a title needed coercing, so a
 * future occurrence is a clean signal instead of a wall of duplicate RN warnings.
 */
function sanitizeChapters(raw: { title?: unknown; start: number; end: number }[]): ChapterMark[] {
  return raw.map((c, i) => {
    if (typeof c.title === 'string') return { title: c.title, start: c.start, end: c.end }
    breadcrumb('chapters', `bad title at index ${i}: ${JSON.stringify(c.title)}`)
    return { title: '', start: c.start, end: c.end }
  })
}

/** Start playback for an ABS library item id. Title/author fall back to the
 *  play-session's display fields, so the car can play an item with only its id.
 *  Downloaded books play from local files (data-saving), and still report
 *  listening: online via a real ABS session, offline via a replayed local one. */
/**
 * Load a book and start playing it. Pass `autoPlay = false` to load it paused
 * (the Now Playing tab uses this to drop you into the real player on your last
 * book without starting audio on tab open).
 */
export async function playItemById(
  itemId: string,
  autoPlay = true,
  opts: { armRecompute?: boolean; resumeAt?: number } = {},
): Promise<void> {
  // Every resume path below reads the progress store to decide where to land, and
  // that store is hydrated from disk by an unawaited read started at mount. After
  // an unclean death the listener taps play seconds after launch - on the player
  // screen the app reopened on - so that tap can beat the read. Losing the race
  // made progressFor() answer from an empty store, and a resume resolved against
  // a cold-reload session (currentTime legitimately 0) landed at 0s; the first
  // tick then synced that 0 over the real server position, persisting the reset.
  // Awaiting here costs nothing once hydrated (a settled promise) and only ever
  // delays the very first tap after launch.
  await progressHydrated()

  const local = localSourceFor(itemId)
  const resumeAt =
    typeof opts.resumeAt === 'number' && Number.isFinite(opts.resumeAt)
      ? Math.max(0, opts.resumeAt)
      : undefined
  // A session object surviving into offline mode does NOT mean the server is
  // reachable - entering offline mode keeps the last session around. Ask the
  // connection layer, or a resume tap in offline mode tries the dead server first
  // and only plays once that request gives up.
  const online = !!getSession() && !isOfflineMode()

  // Loading the player WITHOUT starting audio must not open an ABS session.
  //
  // The Now Playing tab calls this with autoPlay=false purely to render the
  // player on your last book; the car handback does too, passing `resumeAt`
  // because it knows a newer position than the saved row. Opening a real
  // play session there made the server record a listen for every cold start that
  // landed on the tab: rows reading "0:00 listened", and - because the session
  // opens at whatever position was resolved and closes at the real one - rows
  // that appear to travel between two unrelated chapters. Those are the phantom
  // entries in Recent Listens.
  //
  // A session is what REPORTS listening, so it belongs to the act of listening.
  // Deferred to the first play (see ensureSessionForPlayback), which every
  // transport path already funnels through.
  if (!autoPlay) {
    await loadPreview(itemId, local, online, resumeAt)
    return
  }

  // Starting a new book is a recompute trigger, but we defer it: arm a play-
  // cooldown so an accidental tap (or the settling just-finished book at an
  // auto-advance) doesn't immediately reshuffle up-next. The book-end advance
  // passes armRecompute:false so it never recomputes in the ambiguous window;
  // it just plays the queue head it already holds. Cancel any prior cooldown
  // first - switching books abandons the previous book's pending recompute.
  cancelRecomputeCooldown()
  if (opts.armRecompute !== false) armRecomputeCooldown(itemId)

  // Downloaded + offline: no server reachable, so play locally and accrue a
  // local session to replay on reconnect.
  if (local && !online) {
    await playFromDownloadOffline(itemId, autoPlay, resumeAt)
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
      await playFromDownloadOffline(itemId, autoPlay, resumeAt)
      return
    }
    throw e
  }

  const track = session.audioTracks[0]
  if (!track && !local) throw new Error('no_audio_track')

  // Close any prior ABS session first.
  if (active) await safeClose(true)
  // An offline session being replaced by a real one has its accrued time on disk
  // already (every tick banks it), but bank once more so the row carries the true
  // position at handoff rather than the position at the last tick.
  if (offline) bankOffline(offline, getState().position)
  offline = null
  lastTickTime = null

  // An explicit position is an instruction (for example, a timestamped club
  // comment), so it wins over every saved/session position. Otherwise the play-
  // session's currentTime is only a STARTING POINT: it can be 0 on a freshly-
  // opened session even when media progress is well into the book (a cold
  // reload), and it can be stale when this device left a session behind and
  // listening continued elsewhere. resolveResumePosition reconciles it against
  // the media-progress row and our own local writes.
  const sessionSaid = session.currentTime > 0 ? session.currentTime : 0
  let startAt = resumeAt ?? sessionSaid
  if (resumeAt === undefined) {
    if (startAt === 0) startAt = resumePositionFor(progressFor(itemId))
    else startAt = resolveResumePosition(itemId, startAt)
  }
  const resolved = startAt
  if (resumeAt === undefined) startAt = preferLivePlayhead(itemId, startAt)
  // Where a resume actually landed, and which input won. The reset reports are
  // ultimately "this number was too small", so record the candidates that
  // produced it.
  breadcrumb(
    'resume',
    `start @${Math.round(startAt)}s (session said ${Math.round(sessionSaid)}s, resolved ${Math.round(resolved)}s, saved ${Math.round(progressFor(itemId)?.currentTime ?? 0)}s)`,
  )
  // A resume to 0 on a book the store has never seen is the exact shape of the
  // reset reports, and it is indistinguishable in the log above from a genuine
  // first listen. Name it explicitly: if this crumb appears in a future report,
  // the hydration gate did not cover the path that produced it, and the store was
  // still empty at resume. A real first listen has no server-side history either,
  // so the session's own duration is what separates "new book" from "lost row".
  if (startAt === 0 && !progressFor(itemId) && session.duration > 0) {
    breadcrumb('resume', `landed @0s with NO stored progress row for ${itemId.slice(0, 8)}`)
  }
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
    chapters: sanitizeChapters(session.chapters ?? []),
  }
  loadTrack(np, autoPlay)
  breadcrumb(
    'play',
    `${itemId} online @${Math.round(startAt)}s (session ${session.currentTime > 0 ? 'had' : 'no'} pos, ${local ? 'local file' : 'stream'})`,
  )

  const opened: ActiveSession = {
    sessionId: session.id,
    itemId,
    duration: session.duration,
    title: np.title,
    startedAt: startedNow(),
    lastSyncedTime: startAt,
    pendingListened: 0,
    totalListened: 0,
  }
  setActiveSession(opened)
  syncStateStartSession(itemId, opened.startedAt, startAt)

  // The session carried live chapters, so the player is already correct - but the
  // downloaded copy on disk is still the snapshot taken at download time. Re-sync
  // it now so the next OFFLINE listen (and the browse screens) match what was
  // just shown, instead of reverting to the stale titles.
  if (local) void refreshOpenBookMetadata(itemId)

  // Auto-download the book you just started (and prefetch the queue), per prefs.
  applyAutoDownloads({
    nowPlaying: { itemId, title: np.title, author: np.author },
    queue: getQueueState().items,
  })
}

/**
 * Load a book into the player PAUSED, without opening an ABS session.
 *
 * This is the "show me the player on my last book" path (the Now Playing tab).
 * No audio plays, so there is nothing to report, so no session should exist -
 * see the note in playItemById. The session is opened later by
 * ensureSessionForPlayback() when the listener actually presses play.
 *
 * The resume position comes from the same media-progress row a session would
 * have been opened from, so where the player lands is unchanged. A downloaded
 * book uses its local files; otherwise we fetch the stream URL from the item
 * detail (a read-only call that records nothing).
 *
 * `resumeAt` overrides that saved row for callers that already KNOW where the
 * listener is and whose knowledge is newer than the server's. The car handback
 * is the case that matters: the car has been playing for minutes while the
 * phone's media-progress row sat frozen at the handoff point, so resolving from
 * the row rewinds the listener by however long the drive lasted. Seeking after
 * the load cannot fix that - the seek races the fresh track's own load and, when
 * it loses, leaves a pendingSeek that swallows every position tick until it
 * times out (HS-MOBILEAPP-A: loaded at 33871s when the car had reached 34157s,
 * then a 2-hour stretch of held ticks ending in "seek never landed").
 *
 * Falls back to the offline path when the book is downloaded and the server is
 * unreachable, matching playItemById.
 */
async function loadPreview(
  itemId: string,
  local: ReturnType<typeof localSourceFor>,
  online: boolean,
  resumeAt?: number,
): Promise<void> {
  // Close whatever was live: loading a different book into the player ends the
  // previous listen, exactly as the session-opening path does.
  if (active) await safeClose(true)
  if (offline) bankOffline(offline, getState().position)
  offline = null
  lastTickTime = null

  const startAt = resumeAt ?? resumePositionFor(progressFor(itemId))

  if (local) {
    const first = local.tracks[0]
    if (!first) throw new Error('no_local_track')
    loadTrack(
      {
        itemId,
        sessionId: '',
        title: local.title,
        author: local.author,
        artworkUrl: local.coverUri ?? coverUrl(itemId),
        url: first.uri,
        duration: local.duration,
        startPosition: startAt,
        chapters: sanitizeChapters(local.chapters),
      },
      false,
    )
    breadcrumb('play', `${itemId} preview (local) @${Math.round(startAt)}s`)
    // Loaded from the frozen download snapshot; correct it in place if the
    // server has since changed the chapters. No-ops offline.
    void refreshOpenBookMetadata(itemId)
    return
  }

  if (!online) throw new Error('not_downloaded')

  // Not downloaded: we need a stream URL and chapters, which a session would
  // normally have carried. getItemDetail is a plain read - it creates no session
  // and records no listening, and it carries the chapters itself.
  const detail = await getItemDetail(itemId)
  const files = detail.media?.audioFiles ?? []
  const file = files[0]
  if (!file) throw new Error('no_audio_track')
  // The detail response omits a top-level duration; the audio files sum to it.
  const duration = files.reduce((t, f) => t + (f.duration || 0), 0)
  loadTrack(
    {
      itemId,
      sessionId: '',
      title: detail.media?.metadata?.title ?? '',
      author: detail.media?.metadata?.authorName ?? '',
      artworkUrl: coverUrl(itemId),
      url: mediaUrl(`/api/items/${itemId}/file/${file.ino}`),
      duration,
      startPosition: startAt,
      chapters: sanitizeChapters(detail.media?.chapters ?? []),
    },
    false,
  )
  breadcrumb('play', `${itemId} preview (stream) @${Math.round(startAt)}s`)
}

/**
 * Open the ABS session for a book already loaded in the player, if it doesn't
 * have one yet.
 *
 * Pairs with loadPreview: the player can hold a book with sessionId '' (loaded
 * but never played). The first actual play opens the session so listening is
 * reported from that moment - which is the only moment it means anything.
 *
 * Resumes from the LIVE playhead rather than re-resolving a position, so opening
 * the session cannot move the audio. Returns false when no session could be
 * opened (offline / server error); the caller keeps playing locally either way -
 * failing to report a listen must never stop playback.
 */
export async function ensureSessionForPlayback(): Promise<boolean> {
  const s = getState()
  const np = s.nowPlaying
  if (!np || np.sessionId || active || offline) return false
  if (s.carActive) return false
  if (!getSession() || isOfflineMode()) return false

  let session
  try {
    session = await startPlay(np.itemId)
  } catch {
    return false
  }

  const pos = getState().position
  const opened: ActiveSession = {
    sessionId: session.id,
    itemId: np.itemId,
    duration: session.duration || np.duration,
    title: np.title,
    startedAt: startedNow(),
    lastSyncedTime: pos,
    pendingListened: 0,
    totalListened: 0,
  }
  setActiveSession(opened)
  lastTickTime = null
  // Stamp the session onto the loaded track WITHOUT touching position: the audio
  // is already playing and PlayerHost keys its native load on itemId:sessionId,
  // so this must not look like a new track to load.
  attachSessionId(session.id)
  syncStateStartSession(np.itemId, opened.startedAt, pos)
  breadcrumb('play', `${np.itemId} session opened on play @${Math.round(pos)}s`)
  return true
}

/**
 * Play a downloaded book from local files with no reachable server. Accrues a
 * local-only session (real listened-time + position) that flushPendingProgress()
 * replays to ABS via /api/session/local once we reconnect, so a fully-offline
 * listen still lands in recent listens and stats with the right listened-time.
 */
async function playFromDownloadOffline(
  itemId: string,
  autoPlay = true,
  resumeAt?: number,
): Promise<void> {
  const local = localSourceFor(itemId)
  if (!local) throw new Error('not_downloaded')
  const first = local.tracks[0]
  if (!first) throw new Error('no_local_track')

  if (active) await safeClose(true)
  lastTickTime = null

  // Re-entry for the SAME book continues the SAME banked session instead of
  // minting a new id.
  //
  // The ledger is keyed by session id (see pendingProgress.ts), which is what
  // stops a second listen from overwriting the first. That keying assumes one id
  // per LISTEN, but nothing guaranteed one CALL per listen: a native start
  // failure (BackgroundServiceStartNotAllowedException) had the load retried over
  // and over, and every retry minted `play_local_${itemId}_${Date.now()}`. Result
  // was one sitting shattered into six Recent Listens rows seconds apart, each
  // with a couple of seconds listened and a position slightly BEHIND the last
  // (each retry re-resumed from the saved spot while the previous fragment had
  // already banked a little further on).
  //
  // How we tell re-entry from a genuinely new listen, without persisting anything:
  // `offline` is module-level in-memory state. It is non-null only while a live
  // offline listen is in progress, and it is cleared by stopPlayback() (which
  // snapshots the final position first) and by switching to a real online session.
  // A relaunch starts the module fresh, so it is null there too. So "offline is
  // non-null AND names this same itemId" is exactly "we are still inside one
  // sitting" - every path that ends a listen has already nulled it, and every
  // path that starts a later one begins from null. A different itemId falls
  // through to a brand-new session, which is what keeps the old overwrite bug
  // fixed.
  const resumed = offline && offline.itemId === itemId ? offline : null

  // Resume from the persisted media-progress spot. Offline there's no ABS session
  // to carry currentTime, so the disk-hydrated progress store (hs.progress.v1) is
  // the only source of "where was I". Without this a downloaded book started
  // offline always began at 0 - and worse, the first progress tick synced that 0
  // back over the real saved position through recordLocalProgress, wiping it.
  // resumePositionFor() also decides whether a FINISHED book's saved spot is a
  // real re-listen position or just an end-of-book leftover.
  //
  // On a re-entry, prefer the position the live session already holds. It is at or
  // ahead of the saved spot (it is what recordLocalProgress has been writing), and
  // deferring to it means a retry can't drag the listener backwards - which is the
  // backwards-hopping positions seen in the shattered rows.
  const startAt =
    resumeAt ?? (resumed ? resumed.currentTime : resumePositionFor(progressFor(itemId)))

  const np: NowPlaying = {
    itemId,
    sessionId: '',
    title: local.title,
    author: local.author,
    artworkUrl: local.coverUri ?? coverUrl(itemId),
    url: first.uri,
    duration: local.duration,
    startPosition: startAt,
    chapters: sanitizeChapters(local.chapters),
  }
  loadTrack(np, autoPlay)
  breadcrumb('play', `${itemId} offline @${Math.round(startAt)}s (${resumed ? 're-entry' : 'new'})`)
  setActiveSession(null)
  if (resumed) {
    // Keep localId/startedAt/timeListening exactly as they were: the id keeps the
    // ledger writing to the one row, startedAt keeps the listen dated to when it
    // actually began, and timeListening carries the seconds already accrued (a
    // reset here would silently discard them, since the next recordLocalSession
    // overwrites that row wholesale).
    resumed.title = local.title
    resumed.duration = local.duration
    resumed.currentTime = startAt
    offline = resumed
  } else {
    const startedAt = startedNow()
    offline = {
      localId: `play_local_${itemId}_${startedAt}`,
      itemId,
      title: local.title,
      duration: local.duration,
      currentTime: startAt,
      startPosition: startAt,
      timeListening: 0,
      startedAt,
    }
  }
  syncStateStartSession(itemId, offline.startedAt, startAt)
  // Offline downloaded book: it's banked locally, not on the server yet.
  syncStateFailed()

  // No refresh here: this branch runs only when no server is reachable, so
  // there is nothing to refresh against. The online paths handle it.
}

/**
 * Re-read a downloaded book's metadata while it is open, and push corrected
 * chapters into the live player.
 *
 * Fire-and-forget by design: playback has already started, so a slow or failed
 * request costs nothing. Runs only when a server is actually reachable.
 */
async function refreshOpenBookMetadata(itemId: string): Promise<void> {
  if (!getSession() || isOfflineMode()) return
  try {
    const changed = await refreshDownloadMetadata(itemId)
    if (!changed) return
    const fresh = localSourceFor(itemId)
    if (fresh) updateChapters(itemId, sanitizeChapters(fresh.chapters))
  } catch {
    // Cached copy stands; the startup sweep will try again.
  }
}

/** Wall-clock ms; isolated so the one Date.now() call is easy to reason about. */
function startedNow(): number {
  return Date.now()
}

/**
 * Bank the live offline session, unless the record would carry no information at
 * all: zero listened-time AND no movement off the position it started at.
 *
 * Such a record is not merely useless, it is harmful. It shows up in Recent
 * Listens as a "0:00 listened" row (the fragments in the shattered-session bug
 * were mostly these), and ABS rejects zero-duration sessions - which sends the
 * whole flush down pendingProgress's slow one-at-a-time path until the record is
 * quarantined, holding a ledger slot the whole time.
 *
 * The test is deliberately AND, not OR: a listen with real position movement but
 * under a second of accrued time is a legitimate session (Math.round takes its
 * timeListening to 0, but ABS still gets the moved position), so movement alone
 * is enough to bank. Only the truly inert case is dropped.
 */
function bankOffline(o: OfflineSession, currentTime: number): void {
  if (o.timeListening < 1 && Math.round(currentTime) === Math.round(o.startPosition)) return
  recordLocalSession(offlineSnapshot(o, currentTime))
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
    bankOffline(offline, currentTime)
    // Advance the shared (persisted) progress store too, so the book's position
    // and progress bar are correct across a cold offline start - the local
    // session alone doesn't feed the progress store the screens read.
    recordLocalProgress(offline.itemId, currentTime, offline.duration)
    syncStateTick(currentTime, offline.timeListening)
    return
  }

  if (!active) {
    // No ABS session, but a book IS loaded: either it was loaded paused and the
    // session hasn't opened yet (ensureSessionForPlayback is in flight), or the
    // open failed. Position still has to be recorded - it is what resume reads,
    // and dropping these ticks would silently lose a listen. Listened-time is not
    // accrued here; only a session can report that.
    const np = getState().nowPlaying
    if (np?.itemId && !getState().carActive) {
      recordLocalProgress(np.itemId, currentTime, np.duration)
    }
    return
  }

  active.pendingListened += listened
  active.totalListened += listened
  // Keep the live "Now" row current every tick (no status change).
  syncStateTick(currentTime, active.totalListened)
  // Mirror the outstanding time to disk BEFORE any sync attempt. The live
  // session is still what reports listening; this is the safety net that turns a
  // kill mid-stream into a one-tick loss instead of a whole sync window.
  bankStreaming(active, currentTime)
  // Persist the POSITION locally every tick, exactly as the offline branch does.
  // bankStreaming above banks listened-TIME, which pendingProgress replays as
  // accrued time - it is never read as a resume position. So without this an
  // online session kept position only in RAM and on the server, and the server
  // only learns it when the sync threshold below is crossed. A process death in
  // between (Android killing the app while the screen is off, with the media
  // service still playing) lost everything since the last sync: the reported bug
  // was a skip to a new chapter followed by a lock, where the seek accrued no
  // listened-time, never crossed the threshold, and resumed at the pre-skip spot.
  recordLocalProgress(active.itemId, currentTime, active.duration)

  // Sync on `force` (pause/stop/book-switch) ALWAYS - even a few seconds of
  // listening should land - or once enough real listened-time has accrued.
  if (!force && active.pendingListened < SYNC_LISTENED_THRESHOLD) return
  // A forced sync still pushes with zero accrued time when a seek left the
  // server's position stale (pause right after a skip) - otherwise the stop point
  // the listener chose never lands.
  if (active.pendingListened <= 0 && !(force && seekDirty)) return

  seekDirty = false
  await pushListened(active, currentTime)
}

/** Position moved by a seek/skip that the server hasn't been told about yet. */
let seekDirty = false
/** Timer that pushes a settled seek. Rearmed by each seek, so a scrub drag sends
 *  one request at the end instead of one per frame. */
let seekPushTimer: ReturnType<typeof setTimeout> | null = null
/** How long the playhead must sit still after a seek before the new spot is
 *  pushed - long enough to coalesce a drag, short enough to beat a screen-off
 *  kill. */
const SEEK_SETTLE_MS = 3000

// Remember every seek as an unsynced position change, and push it once the
// playhead settles.
//
// This is driven by a TIMER rather than by progress ticks, because the cases that
// most need it produce no ticks at all: seeking while paused, and seeking then
// immediately locking the phone. A tick-driven check would also never fire for a
// backwards seek (the playhead has to pass the target to "settle", which it never
// does going back). The timer fires regardless of whether audio is advancing.
//
// The store fires this through syncState (the leaf module both sides already
// import) rather than calling here directly, which would cycle - playback
// imports store.
subscribeSeeked(() => {
  if (!active) return
  seekDirty = true
  if (seekPushTimer) clearTimeout(seekPushTimer)
  seekPushTimer = setTimeout(() => {
    seekPushTimer = null
    // Re-check: the book may have been switched, stopped, or already synced by a
    // threshold push in the meantime.
    if (!active || !seekDirty) return
    seekDirty = false
    void pushListened(active, getState().position).catch(() => {})
  }, SEEK_SETTLE_MS)
})

/** Write the active session's outstanding listened-time to the durable streaming
 *  buffer. Absolute (not a delta), so a dropped call can't drift the buffer. */
function bankStreaming(a: ActiveSession, currentTime: number): void {
  setStreamingPending(a.itemId, {
    seconds: a.pendingListened,
    currentTime,
    duration: a.duration,
    title: a.title,
    startedAt: a.startedAt,
    // Carried so a relaunch can close this session if this run dies before
    // safeClose() runs - see StreamingEntry.sessionId.
    sessionId: a.sessionId,
  })
}

/** POST the active session's accrued listened-time + position. Marks pending only
 *  if it fails (red on network loss), synced on success - a normal background push
 *  doesn't visibly change the green icon. */
async function pushListened(a: ActiveSession, currentTime: number): Promise<boolean> {
  const timeListened = Math.round(a.pendingListened)
  a.pendingListened = 0
  a.lastSyncedTime = currentTime
  // Whatever prompted this push, it carries the current position - so any seek
  // debt is settled and a pending settle-timer has nothing left to send.
  seekDirty = false
  try {
    await syncSession(a.sessionId, {
      currentTime: Math.round(currentTime),
      timeListened,
      duration: a.duration,
    })
    // Confirmed on the server: drop exactly what landed from the safety buffer.
    // Subtracting (not clearing) keeps time accrued during the in-flight request.
    reduceStreamingPending(a.itemId, timeListened)
    syncStateSynced(startedNow())
    return true
  } catch (e) {
    // A 404 means the session is gone from ABS's in-memory store (server
    // restarted or it expired) - retrying the same id can never succeed, so
    // reopen a fresh session and re-push against it instead of looping forever.
    if (e instanceof ABSRequestError && e.status === 404) {
      // Session fragmentation trace: each 404 here ends one ABS session and
      // opens another, which is what splits a night's listen into segments.
      // Logs how long the dead session lasted so a regular cadence (token TTL,
      // proxy idle timeout, ABS expiry) is visible as a repeating interval.
      breadcrumb(
        'session',
        `404 on sync, reopening after ${Math.round((Date.now() - (a.segmentOpenedAt ?? a.startedAt)) / 1000)}s @${Math.round(currentTime)}s, ${timeListened}s unsynced`,
      )
      return reopenAndResync(a, currentTime, timeListened)
    }
    // Connectivity blip: roll the unsynced time back so the next tick retries it,
    // and show red - we couldn't reach the server.
    a.pendingListened += timeListened
    breadcrumb(
      'sync',
      `push failed @${Math.round(currentTime)}s, ${timeListened}s unsynced (${e instanceof ABSRequestError ? `http ${e.status}` : 'network'})`,
    )
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
      reduceStreamingPending(a.itemId, timeListened)
      return true
    }
    breadcrumb('session', `reopened as ${session.id.slice(0, 8)} @${Math.round(currentTime)}s`)
    a.sessionId = session.id
    // The live-session registry must follow the reopen, or the background flush
    // task would treat the NEW session as an orphan and close it too.
    if (a === active) setLiveSession(session.id)
    // NOT startedAt: that dates the listen (bankStreaming replays it as the
    // session date after a relaunch). Segment timing gets its own field.
    a.segmentOpenedAt = startedNow()
    await syncSession(session.id, {
      currentTime: Math.round(currentTime),
      timeListened,
      duration: a.duration,
    })
    reduceStreamingPending(a.itemId, timeListened)
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

/**
 * Hand the book off to the car's own ABS session. The car opens a fresh play
 * session and resumes from whatever `currentTime` the SERVER holds, so the phone
 * must land its true position before it stands down - otherwise the car starts
 * from the last 15s-threshold sync and replays what you already heard.
 *
 * Closing (not just syncing) matters just as much: `carActive` gates off both
 * phone sync paths, so a session left open here is orphaned. A later close would
 * POST its stale `currentTime` on top of the car's newer position, throwing the
 * listener back to where they were when the car last connected.
 *
 * Offline sessions bank locally on their own, so only the live session needs
 * this. No-op when nothing is playing.
 */
export async function handOffToCar(): Promise<void> {
  if (offline || !active) return
  await safeClose()
}

/**
 * Mark a book finished when the listener moved on from inside the end buffer.
 *
 * Runs after the session close so the server already holds the true final
 * position; this only promotes the row to finished. Failures are swallowed - the
 * launch sweep re-evaluates the same row later, so a dead network costs nothing
 * but a delay. Never awaited by the close path: nothing downstream depends on
 * the verdict, and a slow write must not hold up loading the next book.
 */
async function completeIfDone(
  itemId: string,
  position: number,
  duration: number,
  chapters?: { start: number; end: number }[],
): Promise<void> {
  if (isFinished(itemId)) return
  const v = endOfListenVerdict({ currentTime: position, duration, chapters })
  if (!v.isFinished) return
  breadcrumb('finish', `${itemId} auto-finished on leave (${v.reason})`)
  await markFinished(itemId, true, duration).catch(() => {})
}

/**
 * Close the live ABS session.
 *
 * `judgeFinish` asks whether this close also ENDS the listen for good - moving
 * on to another book, or stopping. Those are the moments a listener has decided
 * they are done, so a position inside the finish buffer (or past the trailing
 * credits) should complete the book rather than leave it at 99%.
 *
 * It is opt-in because not every close is a goodbye: handOffToCar() closes the
 * session while playback CONTINUES in the car, and finishing the book there
 * would end a listen that is still going.
 */
async function safeClose(judgeFinish = false): Promise<void> {
  if (!active) return
  const { sessionId, itemId, duration, pendingListened } = active
  const pos = getState().position
  // Read chapters before setActiveSession(null) - the verdict wants the live
  // book's marks, and a later caller may have already loaded the next book.
  const chapters =
    getState().nowPlaying?.itemId === itemId ? getState().nowPlaying?.chapters : undefined
  setActiveSession(null)
  lastTickTime = null
  // The close below carries the final position, so a queued settle-push would be
  // both redundant and aimed at a session that no longer exists.
  if (seekPushTimer) {
    clearTimeout(seekPushTimer)
    seekPushTimer = null
  }
  seekDirty = false
  try {
    await closeSession(sessionId, {
      currentTime: Math.round(pos),
      // Bank any listened-time not yet synced so closing doesn't lose it.
      timeListened: Math.round(pendingListened),
      duration,
    })
    // The close banked everything outstanding, so the safety buffer is spent.
    clearStreamingPending(itemId)
    if (pendingListened > 0) syncStateSynced(startedNow())
    if (judgeFinish) void completeIfDone(itemId, pos, duration, chapters)
  } catch {
    // Close failed - leave the buffer alone so the next launch replays the time.
    if (pendingListened > 0) syncStateFailed()
  }
}

export async function stopPlayback(): Promise<void> {
  if (offline) {
    // Persist the final offline position + listened-time before forgetting which
    // book was playing, so stopping lands the true end point for later replay.
    bankOffline(offline, getState().position)
    offline = null
    lastTickTime = null
  }
  await safeClose(true)
  syncStateClear()
}

/**
 * Pick up where another device left off, when resuming a book that was already
 * loaded here.
 *
 * playItemById reconciles three position candidates every time a book is LOADED
 * (see resolveResumePosition). But the common cross-device pattern never passes
 * through a load: the book stays loaded on the phone while the listener pauses,
 * listens elsewhere (the car, the web app, another phone), and comes back to hit
 * play on the still-open player. Nothing re-loads, so nothing re-resolves, and
 * playback resumes at the stale spot this device paused at - then the first sync
 * writes that stale position back over the newer one.
 *
 * So before a resume is allowed to start audio, re-read the server's media
 * progress row for this book and jump there when it has genuinely moved. That
 * row is the one every device writes on every sync, which is what makes it the
 * right authority for "where is the LISTENER" as opposed to "where was this
 * device".
 *
 * Deliberately narrow, because it can move the playhead under someone:
 *  - only after a pause long enough to have been a real hand-off (see
 *    CROSS_DEVICE_MIN_PAUSE_MS), so ordinary pause/resume is never touched;
 *  - only when the gap is bigger than a rounding difference between a tick and
 *    its sync (CROSS_DEVICE_MIN_GAP_SEC), WIDENED by whatever auto-rewind just
 *    stepped back, so our own rewind can't read as a remote advance and get
 *    undone the instant it lands;
 *  - never while the car owns playback, and never offline (no fresher truth to
 *    be had, and the local position is the best answer);
 *  - never for a finished book, whose row sits parked at the end.
 *
 * Direction is not considered: a re-listen or a rewind on another device moves
 * the row BACKWARDS, and picking that up is just as correct as picking up an
 * advance.
 *
 * Also rotates this device's play session when it does jump. ABS only auto-closes
 * a session for the same device, so the session we opened here is stale once the
 * book has moved on elsewhere; syncing the new spot onto it would be reporting a
 * listen we did not do. Closing at the OLD position and opening a fresh one makes
 * the resume a clean new stint, which is what it is.
 */

/** How long the player must have sat paused before a resume is treated as a
 *  possible device hand-off rather than a normal continue. Matches the WebApp's
 *  pre-resume check. */
const CROSS_DEVICE_MIN_PAUSE_MS = 5 * 60_000
/** How far the server must have moved before the jump is worth making. Above
 *  ordinary tick/sync rounding, below anything a listener would notice losing. */
const CROSS_DEVICE_MIN_GAP_SEC = 30

/**
 * Re-check the server's resume point for the loaded book. Returns the position to
 * jump to, or null to resume where we are.
 *
 * `pausedForMs` is how long playback sat paused; `rewoundSec` is the auto-rewind
 * this same resume just applied (0 when none).
 */
export async function resumePointFromOtherDevices(
  pausedForMs: number,
  rewoundSec: number,
): Promise<number | null> {
  if (pausedForMs < CROSS_DEVICE_MIN_PAUSE_MS) return null
  const st = getState()
  const np = st.nowPlaying
  if (!np || st.carActive) return null
  if (!getSession() || isOfflineMode()) return null

  try {
    await refreshProgress()
  } catch {
    // Unreachable: resume from the local position, exactly as before.
    return null
  }

  const saved = progressFor(np.itemId)
  if (!saved || saved.isFinished || !(saved.currentTime > 0)) return null

  // Our own auto-rewind legitimately put us BEHIND the server. Widening by it
  // keeps that from looking like another device moving ahead.
  const threshold = CROSS_DEVICE_MIN_GAP_SEC + Math.max(0, rewoundSec)
  const here = getState().position
  if (Math.abs(saved.currentTime - here) <= threshold) return null

  breadcrumb(
    'resume',
    `elsewhere ${Math.round(saved.currentTime)}s over local ${Math.round(here)}s after ${Math.round(pausedForMs / 1000)}s paused`,
  )
  await rotateSessionForCrossDeviceResume(np.itemId, here)
  return saved.currentTime
}

/**
 * The book moved on elsewhere while this device sat paused, and the listener is
 * resuming here. Close our now-stale session at the position it actually
 * reached, then open a fresh one for the new stint. Best-effort: a failure here
 * must never block the jump, since resuming at the right spot matters more than
 * the session bookkeeping.
 */
async function rotateSessionForCrossDeviceResume(itemId: string, closeAt: number): Promise<void> {
  const a = active
  if (!a || a.itemId !== itemId) return
  try {
    await safeClose()
    const session = await startPlay(itemId)
    // A fresh stint, so it dates from now and carries no unsynced backlog -
    // safeClose already banked whatever `a` was holding.
    setActiveSession({
      ...a,
      sessionId: session.id,
      startedAt: startedNow(),
      segmentOpenedAt: startedNow(),
      lastSyncedTime: closeAt,
      pendingListened: 0,
    })
    attachSessionId(session.id)
    breadcrumb('session', `rotated to ${session.id.slice(0, 8)} for cross-device resume`)
  } catch {
    breadcrumb('session', 'cross-device session rotate failed; keeping current session')
  }
}
