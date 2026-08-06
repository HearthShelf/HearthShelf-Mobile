/**
 * Diagnostic snapshot attached to a user-submitted feedback report.
 *
 * Why this exists: a feedback report used to arrive as prose and nothing else.
 * The progress-reset bug (HS-MOBILEAPP-P/Q) was a good example of the cost - the
 * reports described a skip, a lock, and a reset, but carried no player state, so
 * "was the position ever synced", "did the process die", and "was this a fresh
 * launch" all had to be inferred from an app_start_time that happened to be in
 * the device context. The listener has already done the hard part by noticing and
 * writing it up; the app should attach what it knows.
 *
 * Two things ship with each report:
 *   - a PLAYER SNAPSHOT: what was playing, where, and whether it had reached the
 *     server. This is the state that explains most playback complaints.
 *   - the BREADCRUMB TRAIL from crashLog's ring buffer, which is already being
 *     written continuously for crash reporting and costs nothing extra to read.
 *
 * Everything here is best-effort: a diagnostic that throws must never stop a
 * report from sending, so every accessor is individually guarded and the whole
 * thing degrades to a partial snapshot rather than failing.
 *
 * Privacy: this carries book titles and positions - the same information already
 * visible in the user's own library and in ABS's listening history. It carries no
 * tokens, no server URLs, and no account credentials.
 */
import * as Sentry from '@sentry/react-native'
import { getState } from '@/player/store'
import { getSyncState } from '@/player/syncState'
import { getProgressState } from '@/store/progress'
import { isDownloaded } from '@/player/downloads'
import {
  readBreadcrumbs,
  didPriorRunEndUncleanly,
  priorRunStart,
  currentRunAgeSeconds,
} from '@/lib/crashLog'

/** Cap on breadcrumbs attached to one report. The ring holds ~120; Sentry's own
 *  breadcrumb list is capped around 100, so sending the whole ring is fine and
 *  this is only a backstop against a future larger ring. */
const MAX_ATTACHED_CRUMBS = 100

/** Rounded to whole seconds throughout: sub-second precision says nothing about a
 *  playback bug and makes the report harder to read. */
function sec(n: number | undefined | null): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null
}

/**
 * What the player was doing when the listener hit send. Shaped to answer the
 * questions a playback report actually raises: what was loaded, where was the
 * playhead, had that position reached the server, and how long ago.
 */
export interface PlayerSnapshot {
  itemId: string | null
  title: string | null
  /** Live playhead (seconds) per the store. */
  position: number | null
  /** The position this book resumed at, so a reset is visible as a gap. */
  startPosition: number | null
  duration: number | null
  isPlaying: boolean
  buffering: boolean
  /** True while a car surface owns playback (its own session, different sync). */
  carActive: boolean
  /** ABS play-session id, or null when playing a local-only offline session. */
  sessionId: string | null
  /** 'idle' | 'synced' | 'pending' | 'failed' - see syncState.ts. */
  syncStatus: string
  /** Seconds since the last successful sync, or null if never. */
  secondsSinceSync: number | null
  /** The position we have persisted locally for this book, and how stale it is.
   *  A local value AHEAD of the server is the fingerprint of a kill-before-sync. */
  localPosition: number | null
  localAgeSeconds: number | null
  downloaded: boolean
}

function playerSnapshot(): PlayerSnapshot {
  const s = getState()
  const np = s.nowPlaying
  const sync = getSyncState()
  const saved = np?.itemId ? getProgressState().byId.get(np.itemId) : undefined
  const now = Date.now()
  return {
    itemId: np?.itemId ?? null,
    title: np?.title ?? null,
    position: sec(s.position),
    startPosition: sec(np?.startPosition),
    duration: sec(np?.duration),
    isPlaying: s.isPlaying,
    buffering: s.buffering,
    carActive: s.carActive,
    sessionId: np?.sessionId || null,
    syncStatus: sync.status,
    secondsSinceSync: sync.lastSyncedAt ? Math.round((now - sync.lastSyncedAt) / 1000) : null,
    localPosition: sec(saved?.currentTime),
    localAgeSeconds: saved?.lastUpdate ? Math.round((now - saved.lastUpdate) / 1000) : null,
    downloaded: np?.itemId ? isDownloaded(np.itemId) : false,
  }
}

/**
 * Attach diagnostics to the current Sentry scope, then return a one-line summary
 * for the report body.
 *
 * Called immediately before captureFeedback so the scope carries this context on
 * the event. Uses a synchronous scope mutation rather than withScope so the
 * caller's captureFeedback (which reads the current scope) picks it up.
 *
 * Never throws.
 */
export function attachFeedbackDiagnostics(): void {
  try {
    const snap = playerSnapshot()
    Sentry.setContext('player', snap as unknown as Record<string, unknown>)

    // Tags are the searchable/filterable fields - these are the ones worth
    // slicing a set of reports by ("show me every report where sync was failing").
    Sentry.setTag('player_sync', snap.syncStatus)
    Sentry.setTag('player_playing', String(snap.isPlaying))
    Sentry.setTag('player_car', String(snap.carActive))
    Sentry.setTag('player_downloaded', String(snap.downloaded))
    Sentry.setTag('player_active', String(snap.itemId !== null))

    // A local position meaningfully ahead of where this book resumed is the
    // signature of the progress-reset family: it means the app came back at an
    // older spot than the one we had on disk. Tagged so those reports can be
    // found directly instead of read one at a time.
    if (snap.position !== null && snap.startPosition !== null) {
      Sentry.setTag('player_moved_since_load', String(snap.position !== snap.startPosition))
    }

    attachLaunchContext()
    attachBreadcrumbs()
  } catch {
    // Diagnostics must never block a report.
  }
}

/**
 * How this run started, and how the last one ended.
 *
 * This is the single most useful field for the "progress reset / app reloaded"
 * family of reports. Those describe a symptom (the splash screen appeared, the
 * position went backwards) whose cause is upstream: the OS killed the process
 * while the screen was off, so the app cold-started and resumed from the last
 * position that had reached the server. Without this flag that has to be inferred
 * from app_start_time; with it, the report says so directly.
 */
function attachLaunchContext(): void {
  const unclean = didPriorRunEndUncleanly()
  const startedAt = priorRunStart()
  Sentry.setTag('prior_run_unclean', String(unclean))
  Sentry.setContext('launch', {
    priorRunEndedUncleanly: unclean,
    priorRunStartedAt: startedAt ? new Date(startedAt).toISOString() : null,
    /** Seconds this JS runtime has been alive. A small number on a report about
     *  losing progress means the app restarted just before the listener noticed.
     *
     *  Sourced from crashLog, which is evaluated at startup. It used to be a
     *  module-local Date.now() in THIS file - but this module is only reachable
     *  from the feedback screen, an expo-router route that is not evaluated until
     *  the listener navigates to it. So the field reported "seconds since the
     *  feedback tab was opened", which reads exactly like a fresh restart on every
     *  report and is worthless precisely where it was meant to help. */
    currentRunAgeSeconds: currentRunAgeSeconds(),
  })
}

/**
 * Replay the on-disk breadcrumb ring onto the Sentry scope.
 *
 * crashLog already writes these continuously for native-abort reporting, so the
 * trail leading up to whatever the listener is describing is usually already on
 * disk - including breadcrumbs from BEFORE the current JS runtime if the last run
 * died (which is exactly the case in a relaunch-after-kill report).
 */
function attachBreadcrumbs(): void {
  try {
    const crumbs = readBreadcrumbs()
    if (!crumbs.length) return
    for (const c of crumbs.slice(-MAX_ATTACHED_CRUMBS)) {
      Sentry.addBreadcrumb({
        category: `hs.${c.tag}`,
        message: c.repeats && c.repeats > 1 ? `${c.msg} (x${c.repeats})` : c.msg,
        level: c.tag === 'fatal' || c.tag === 'error' ? 'error' : 'info',
        timestamp: c.t / 1000,
      })
    }
  } catch {
    // ignore
  }
}
