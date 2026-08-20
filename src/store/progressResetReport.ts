/**
 * Telemetry for the silent progress reset.
 *
 * Why this file exists: losing your spot in a book is SILENT. Nothing throws -
 * a refresh replaces the progress row with the server's, the position moves
 * backwards, and the listener finds out later when they open the book. Sentry
 * cannot see it, so the only signal has been someone writing it up in chat, or
 * a feedback report filed while the breadcrumb ring still held the window.
 *
 * That has been enough to know the bug exists and not enough to fix it: it does
 * not reproduce on demand, and the moment it happens is exactly when nobody is
 * looking at the phone. So the drop reports itself.
 *
 * ONLY THE DROP IS AN EVENT. refreshProgress declining to keep a local row is
 * usually correct - the server genuinely knows better for every book the user
 * is not currently listening to. Reporting the ordinary case would file a
 * permanent issue describing normal behaviour, which is the mistake the car
 * telemetry documents (see player/carHandbackReport.ts). Only a BACKWARDS move
 * large enough to be felt is worth an event; everything else stays a breadcrumb.
 */
import * as Sentry from '@sentry/react-native'

/** How far backwards the position must move to count as a felt loss. Below this
 *  the two sides are effectively the same spot (ordinary rounding between a tick
 *  and its sync), and an event would be noise. */
const REPORT_MIN_DROP_SEC = 120

/** One event per book per run. The refresh loop runs on every foreground and
 *  every pull-to-refresh, so an unfixed drop would otherwise file the same
 *  finding dozens of times in a session and bury the first one.
 *
 *  Not cleared on sign-out: it is keyed by library item, the set is tiny, and a
 *  second account on the same device drops the same book at most one event
 *  short. Not worth a hook in two sign-out paths. */
const reported = new Set<string>()

export interface ProgressDropDetail {
  itemId: string
  /** Where the local (device) row had the listener. */
  localSec: number
  /** Where the server row put them - the position about to win. */
  serverSec: number
  /** ms epoch stamps that drove the decision. */
  localUpdatedAt: number
  serverUpdatedAt: number
  /** Which guard branch let it through, so the fix has a target. */
  branch: 'server_newer' | 'local_too_old'
}

/**
 * Report a local position being discarded in favour of an older server spot.
 *
 * Deliberately takes the numbers rather than reading the store: the caller is
 * mid-refresh and holds both rows already, and telemetry must not re-enter the
 * store it is observing.
 */
export function reportProgressDrop(d: ProgressDropDetail): void {
  const drop = d.localSec - d.serverSec
  if (!(drop >= REPORT_MIN_DROP_SEC)) return
  if (reported.has(d.itemId)) return
  reported.add(d.itemId)
  try {
    Sentry.captureMessage('local listening position dropped for an older server row', {
      level: 'error',
      tags: {
        area: 'progress_reset',
        progress_drop_branch: d.branch,
      },
      extra: {
        itemId: d.itemId,
        droppedSeconds: Math.round(drop),
        localSec: Math.round(d.localSec),
        serverSec: Math.round(d.serverSec),
        // The stamp gap is the crux: the guard keys on it, so its sign and size
        // say whether a sync landed after the last local tick (the suspected
        // path) or the local row simply aged out.
        stampGapMs: d.serverUpdatedAt - d.localUpdatedAt,
        localUpdatedAt: new Date(d.localUpdatedAt).toISOString(),
        serverUpdatedAt: d.serverUpdatedAt
          ? new Date(d.serverUpdatedAt).toISOString()
          : 'none',
      },
    })
  } catch {
    // Telemetry must never break a refresh.
  }
}
