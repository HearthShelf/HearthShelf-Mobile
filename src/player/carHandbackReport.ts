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
