/**
 * Telemetry for the Android Auto -> phone handback.
 *
 * Why this file exists: the handback failure mode is SILENT. When the car went
 * away and the phone player never re-armed, nothing threw - the UI just showed a
 * playing book over silence with dead transport buttons. Sentry had zero events
 * for it (an entire release reported no errors at all while users hit this), so
 * the only signal was someone describing it in a chat message.
 *
 * Playback stranding is not an exception, so it has to be reported deliberately.
 * These are captured as messages (not spans) because they must survive whether
 * or not the session is trace-sampled - a handback happens once per drive, so
 * the volume is tiny and losing it to sampling would defeat the purpose.
 */
import * as Sentry from '@sentry/react-native'
import { breadcrumb } from '@/lib/crashLog'

/** Shared tag so every handback event is one filter in Sentry. */
const AREA = { area: 'car_handback' } as const

/**
 * The handback re-resolve threw (session open failed, book not downloadable
 * offline, network gone with the car). The user is left on a paused player that
 * may not hold a real url, so this is the case most likely to look "stuck".
 */
export function reportCarHandbackFailure(itemId: string, err: unknown): void {
  try {
    Sentry.captureMessage('car handback failed to re-resolve phone playback', {
      level: 'error',
      tags: { ...AREA, car_handback_result: 'failed' },
      extra: {
        itemId,
        reason: err instanceof Error ? err.message : String(err),
      },
    })
  } catch {
    // Telemetry must never break the handback itself.
  }
}

/**
 * A transport command arrived that the player could not act on (no loaded
 * track). This is the fingerprint of the original bug: taps that go nowhere.
 * If this fires after the fix, the re-arm did not take and we want to know.
 *
 * `source` distinguishes a phone tap from a notification/remote button.
 */
export function reportDeadTransport(source: string, detail: string): void {
  breadcrumb('player', `dead transport (${source}): ${detail}`)
  try {
    Sentry.captureMessage('transport command with no playable track', {
      level: 'warning',
      tags: { ...AREA, car_handback_result: 'dead_transport', transport_source: source },
      extra: { detail },
    })
  } catch {
    // ignore
  }
}

/**
 * The native media service was asked to play but no longer held the track - the
 * OS reclaimed it under memory pressure (HS-MOBILEAPP-Y).
 *
 * Reported rather than merely breadcrumbed for the same reason the handback
 * events are: this failure is SILENT by nature. Nothing throws, so without a
 * deliberate event the only signal is a user noticing and writing it up - which
 * is how Y reached us, after an unknown number of listeners who just force-closed
 * the app instead. A breadcrumb alone is invisible until someone files feedback.
 *
 * ONLY THE FAILURE IS AN EVENT. A recovered reclaim is expected behaviour - the
 * OS is allowed to reclaim the service and we put it back - so it goes to the
 * breadcrumb ring, which already ships with crash and feedback reports. It was
 * briefly sent as a level:info captureMessage, which files an ISSUE: a permanent
 * unresolved row in the stream describing a success. That is the same mistake as
 * the archived traceEvent markers (HS-MOBILEAPP-D/E/F/G) - temporary "we got
 * here" telemetry routed through the issue stream, where it outlives its purpose
 * and trains everyone to ignore the queue.
 *
 * The failure IS an event, because a user is sitting in front of a dead play
 * button right now and nothing else will ever tell us.
 *
 * The recovered detail is not lost: the breadcrumb carries the same fields, and
 * any report filed after a reclaim (crash or feedback) replays the trail.
 */
export function reportPlaybackLost(recovered: boolean, detail: Record<string, unknown>): void {
  // `detail.cause` is 'native' (the service reported the loss) or 'stall' (the
  // JS watchdog inferred it from silent progress). Tagged, not just in extra, so
  // the two are separable in triage - they have different root causes even
  // though they share this recovery.
  breadcrumb(
    'player',
    `playback lost; recovered=${recovered} ${JSON.stringify(detail)}`.slice(0, 300),
  )
  if (recovered) return
  try {
    Sentry.captureMessage('native player was reclaimed and reload did not take', {
      level: 'error',
      tags: {
        area: 'playback_reclaim',
        playback_reclaim_recovered: 'false',
        playback_lost_cause: typeof detail.cause === 'string' ? detail.cause : 'native',
      },
      extra: detail,
    })
  } catch {
    // ignore
  }
}
