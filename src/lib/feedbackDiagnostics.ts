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
 * The trail rides as a FILE ATTACHMENT, not as Sentry breadcrumbs. It was sent
 * with Sentry.addBreadcrumb first, and those never arrived: every feedback event
 * we have landed with its contexts and tags intact and zero breadcrumbs, including
 * one sent expressly to carry a crash trail. Feedback events are their own item
 * type and the scope's breadcrumbs do not ride along with them. Attachments do
 * (that is how the screenshot gets there), so the trail goes that way, with a
 * short tail duplicated into a context so the Sentry UI shows something useful
 * without downloading the file.
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
  readPriorRunBreadcrumbs,
  didPriorRunEndUncleanly,
  priorRunStart,
  currentRunAgeSeconds,
} from '@/lib/crashLog'

/** Cap on crumbs written into the attached log, per run. The ring holds ~120, so
 *  this sends all of it and is only a backstop against a future larger ring. */
const MAX_ATTACHED_CRUMBS = 100

/** How many of the most recent crumbs are duplicated into the `recent_log`
 *  context, so
 *  the Sentry UI shows the tail inline. Small on purpose - the full trail is in
 *  the attachment, and a context is not the place for kilobytes of log. */
const CONTEXT_TAIL_CRUMBS = 20

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
  /** The armed sleep timer, or null. Captured because a sleep timer is the one
   *  thing that STOPS playback without any failure to report: an "it stopped"
   *  report otherwise arrives with a perfectly healthy trail and nothing to
   *  distinguish a bug from the timer doing its job (HS-MOBILEAPP-28). */
  sleepTimer: string | null
  /** Seconds of playback left on that timer, for the countdown kinds. */
  sleepRemainingSec: number | null
}

/**
 * The same snapshot, for a crash/error event rather than a feedback report.
 *
 * The feedback diagnostics used to write onto the GLOBAL Sentry scope with
 * nothing ever clearing it, so once a listener sent one report, every later
 * crash in that run inherited the frozen snapshot and read as though it had
 * happened at the moment of the report. Two events nearly three hours apart
 * (HS-MOBILEAPP-1A and -1C) arrived carrying a byte-identical player block and
 * the same currentRunAgeSeconds, which made an unrelated error look like part
 * of the crashing session - and during triage that coincidence was briefly
 * taken as proof the two shared a root cause.
 *
 * Sampling live in beforeSend keeps the CONTEXTS honest. The tags and the
 * recent_log context are not re-sampled there, so those are no longer written
 * to the global scope at all - see withFeedbackScope.
 *
 * Never throws - a diagnostic must not be able to drop a crash report.
 */
export function livePlayerContext(): {
  player: Record<string, unknown>
  launch: Record<string, unknown>
} | null {
  try {
    return {
      player: playerSnapshot() as unknown as Record<string, unknown>,
      launch: {
        priorRunEndedUncleanly: didPriorRunEndUncleanly(),
        currentRunAgeSeconds: currentRunAgeSeconds(),
      },
    }
  } catch {
    return null
  }
}

/**
 * The current run's breadcrumb tail, for `beforeSend` to attach to events that
 * are NOT feedback reports.
 *
 * `recent_log` used to be written only by the feedback path, so a self-reported
 * telemetry event (a progress drop, a playback loss) arrived with player and
 * launch contexts but no trail - and the trail is where the cause is. Diagnosing
 * HS-MOBILEAPP-15 meant reasoning backwards from two timestamps because the
 * ~11 minutes of breadcrumbs leading into it were never attached.
 *
 * Deliberately the in-memory ring only, NOT buildTrail(): this runs inside
 * beforeSend on every event, and buildTrail reads the on-disk ring plus the
 * prior run's. The live ring is what describes the event being sent; feedback
 * reports still get the fuller disk-backed trail through their own path.
 */
export function liveLogContext(): { tail: string; totalLines: number } | null {
  try {
    const crumbs = readBreadcrumbs()
    if (!crumbs.length) return null
    const lines = crumbs.map(crumbLine)
    return {
      tail: lines.slice(-CONTEXT_TAIL_CRUMBS).join('\n'),
      totalLines: lines.length,
    }
  } catch {
    return null
  }
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
    sleepTimer: s.sleepTimer ? s.sleepTimer.kind : null,
    sleepRemainingSec:
      s.sleepTimer && s.sleepTimer.kind !== 'endOfChapter'
        ? Math.round(s.sleepTimer.remainingSec)
        : null,
    secondsSinceSync: sync.lastSyncedAt ? Math.round((now - sync.lastSyncedAt) / 1000) : null,
    localPosition: sec(saved?.currentTime),
    localAgeSeconds: saved?.lastUpdate ? Math.round((now - saved.lastUpdate) / 1000) : null,
    downloaded: np?.itemId ? isDownloaded(np.itemId) : false,
  }
}

/** What a feedback report carries beyond its prose: searchable tags, and the
 *  breadcrumb trail as text for the caller to send as a file attachment (see the
 *  note at the top of this file about why it can't ride as breadcrumbs). */
export interface FeedbackDiagnostics {
  tags: Record<string, string>
  log: string | null
}

/**
 * Build the diagnostics for a feedback report.
 *
 * RETURNS the tags rather than writing them to the global scope. Callers should
 * go through withFeedbackScope, which also confines the contexts to a temporary
 * scope. That distinction is the whole point of this shape.
 *
 * This used to write everything onto the global scope, where nothing ever
 * cleared it. Sentry keeps that scope for the life of the run, so every crash
 * AFTER a listener sent one report inherited its tags and its recent_log - a
 * frozen snapshot of an unrelated moment, presented as if it described the
 * crash. beforeSend (app/_layout.tsx) re-samples the player/launch CONTEXTS to
 * keep those honest, but it does not touch tags or recent_log, so the leak
 * survived there.
 *
 * The cost was real: HS-MOBILEAPP-1A and -1C were the only two non-feedback
 * events in the project carrying player_sync/player_car/prior_run_unclean, both
 * inherited from a single report, and during triage that shared fingerprint was
 * briefly read as proof the two crashes had one root cause.
 *
 * Tags now ride on the feedback event itself (captureFeedback takes a `tags`
 * field), so they describe that report and nothing else.
 *
 * Never throws - diagnostics must never block a report.
 */
export function buildFeedbackDiagnostics(): FeedbackDiagnostics {
  try {
    const snap = playerSnapshot()

    // Tags are the searchable/filterable fields - these are the ones worth
    // slicing a set of reports by ("show me every report where sync was failing").
    const tags: Record<string, string> = {
      player_sync: snap.syncStatus,
      player_playing: String(snap.isPlaying),
      player_car: String(snap.carActive),
      player_downloaded: String(snap.downloaded),
      player_active: String(snap.itemId !== null),
      // Searchable, so "did a sleep timer stop it?" is one query rather than
      // opening each report.
      player_sleep: snap.sleepTimer ?? 'off',
      prior_run_unclean: String(didPriorRunEndUncleanly()),
    }

    // A local position meaningfully ahead of where this book resumed is the
    // signature of the progress-reset family: it means the app came back at an
    // older spot than the one we had on disk. Tagged so those reports can be
    // found directly instead of read one at a time.
    if (snap.position !== null && snap.startPosition !== null) {
      tags.player_moved_since_load = String(snap.position !== snap.startPosition)
    }

    return { tags, log: buildTrail() }
  } catch {
    return { tags: {}, log: null }
  }
}

/**
 * Set the player/launch contexts on whichever scope is active.
 *
 * captureFeedback has no `contexts` field, so unlike the tags these can only
 * reach the event through a scope. Call it inside a Sentry.withScope callback
 * (see withFeedbackScope) so the values are discarded when that scope closes
 * rather than persisting for the rest of the run.
 *
 * Never throws.
 */
function setDiagnosticContexts(
  scope: Sentry.Scope,
  snap: PlayerSnapshot,
  log: string | null,
): void {
  try {
    scope.setContext('player', snap as unknown as Record<string, unknown>)
    scope.setContext('launch', {
      priorRunEndedUncleanly: didPriorRunEndUncleanly(),
      priorRunStartedAt: priorRunStart() ? new Date(priorRunStart() as number).toISOString() : null,
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
    if (log) {
      scope.setContext('recent_log', {
        tail: log.split('\n').slice(-CONTEXT_TAIL_CRUMBS).join('\n'),
        totalLines: log.split('\n').length,
      })
    }
  } catch {
    // A context that fails to attach must not stop the report.
  }
}

/**
 * Run `send` with the feedback diagnostics applied to a temporary scope.
 *
 * The scope is popped when this returns, so the player/launch/recent_log
 * contexts describe this report only and cannot bleed onto a later crash. The
 * tags are handed to `send` instead, to go on the event itself.
 *
 * Returns void deliberately: the RN SDK's withScope is typed `T | undefined`
 * (it swallows a throwing callback), so a passthrough return value would be
 * silently optional. `send` is called for its capture side effect, and the
 * caller's own try/catch owns the failure path.
 */
export function withFeedbackScope(send: (diag: FeedbackDiagnostics) => void): void {
  let snap: PlayerSnapshot | null = null
  try {
    snap = playerSnapshot()
  } catch {
    snap = null
  }
  const diag = buildFeedbackDiagnostics()
  Sentry.withScope((scope) => {
    if (snap) setDiagnosticContexts(scope, snap, diag.log)
    send(diag)
  })
}

/** One crumb as a log line: "00:36:21.412 play  b58... online @68789s (x3)". */
function crumbLine(c: { t: number; tag: string; msg: string; repeats?: number }): string {
  const clock = new Date(c.t).toISOString().slice(11, 23)
  const repeats = c.repeats && c.repeats > 1 ? ` (x${c.repeats})` : ''
  return `${clock} ${c.tag.padEnd(8)} ${c.msg}${repeats}`
}

/**
 * Build the on-disk breadcrumb ring into the attachable log.
 *
 * Returns the text only - the caller puts the tail into a scoped `recent_log`
 * context (see setDiagnosticContexts). This used to set that context itself, on
 * the global scope, which is how a stale log tail ended up riding along on every
 * later crash in the run.
 *
 * crashLog already writes these continuously for native-abort reporting, so the
 * trail leading up to whatever the listener is describing is usually already on
 * disk - including breadcrumbs from BEFORE the current JS runtime if the last run
 * died (which is exactly the case in a relaunch-after-kill report).
 *
 * The PRIOR run's trail comes first, when that run died. The reports that matter
 * most are written seconds after a crash ("tapped back a few times, forward a few
 * times, crashed" - HS-MOBILEAPP-12), and those are sent from a fresh run whose
 * own ring holds only post-relaunch noise; the evidence lives in the run that
 * died. Kept under its own heading so the two runs are never read as one
 * continuous trail.
 */
function buildTrail(): string | null {
  try {
    const lines: string[] = []
    const prior = readPriorRunBreadcrumbs()
    if (prior.length) {
      lines.push('--- previous run (ended uncleanly) ---')
      for (const c of prior.slice(-MAX_ATTACHED_CRUMBS)) lines.push(crumbLine(c))
      lines.push('--- end of previous run ---', '')
    }

    const crumbs = readBreadcrumbs()
    if (crumbs.length) {
      lines.push('--- current run ---')
      for (const c of crumbs.slice(-MAX_ATTACHED_CRUMBS)) lines.push(crumbLine(c))
    }
    if (!lines.length) return null
    return lines.join('\n')
  } catch {
    return null
  }
}
