/**
 * "Where was I?" rewind on resume.
 *
 * A phone call, a nav prompt, or just putting the book down drops you back
 * mid-sentence. Every mature audiobook player rewinds a little on resume, scaled
 * to how long you were away: a couple of seconds after a quick interruption, a
 * bigger step after an overnight pause.
 *
 * This is deliberately JS-only. Media3 (Android) and AVAudioSession (iOS) handle
 * audio focus internally and surface a duck-pause as an ordinary
 * isPlaying=false, so a transient interruption and a manual pause arrive here
 * through the same door - which is exactly what we want, since both should
 * rewind.
 *
 * Two things this must NOT do:
 *   - Rewind twice for one resume. The sleep timer already rewinds on stop
 *     (store.fireStop), so a resume that follows a sleep-stop is suppressed.
 *   - Fight the server. playback.ts's resume path compares the server's
 *     position against ours; after a rewind our position is legitimately BEHIND
 *     the server's, which looks identical to "another device advanced the book".
 *     See noteRewind() / consumeRewindAmount() - playback.ts widens its
 *     server-ahead threshold by whatever we just rewound.
 */
import { getSettingsState } from '@/store/settings'

/** Below this, a pause is a fumble (missed tap, transport double-press) and a
 *  rewind would be more jarring than helpful. */
const ACTIVATION_DELAY_SEC = 10

/** Paused-duration thresholds -> how far to rewind, longest first. */
const STEPS: { pausedAtLeastSec: number; rewindSec: number }[] = [
  { pausedAtLeastSec: 3600, rewindSec: 20 },
  { pausedAtLeastSec: 60, rewindSec: 10 },
  { pausedAtLeastSec: ACTIVATION_DELAY_SEC, rewindSec: 3 },
]

/** ms epoch when playback last stopped, or null when playing / already consumed. */
let pausedAt: number | null = null
/** Set when something else already moved the position for this resume (a sleep
 *  timer rewind, an explicit seek), so we don't stack a second rewind on top. */
let suppressed = false
/** How much the last resume rewound, for playback.ts's server-ahead check. */
let lastRewindSec = 0
/** How long the pause consumed by the last resume lasted (ms), for the
 *  cross-device resume check. 0 when there was no pending pause. */
let lastPausedForMs = 0

/** How far back a pause of `pausedMs` should jump. 0 for a fumble-length pause. */
function rewindFor(pausedMs: number): number {
  const secs = pausedMs / 1000
  for (const s of STEPS) if (secs >= s.pausedAtLeastSec) return s.rewindSec
  return 0
}

/** Playback stopped: start the clock. */
export function notePaused(at: number = Date.now()): void {
  pausedAt = at
}

/**
 * Something already moved the position for the upcoming resume - a sleep-timer
 * rewind, or the user seeking while paused. Skip the auto-rewind so we don't
 * stack two jumps, and treat the intentional seek as the spot they meant.
 */
export function suppressNextRewind(): void {
  suppressed = true
}

/**
 * Resuming: how many seconds to rewind, or 0 for none. Consumes the pending
 * pause either way, so a second call for the same resume returns 0.
 *
 * `enabled` is read here rather than at the call site so the setting can flip
 * mid-pause and still take effect on the next resume.
 */
export function consumeRewindOnResume(): number {
  const at = pausedAt
  const wasSuppressed = suppressed
  pausedAt = null
  suppressed = false
  lastRewindSec = 0
  // Recorded even when the rewind itself is suppressed or switched off: the
  // cross-device check cares only about how long we sat paused.
  lastPausedForMs = at === null ? 0 : Math.max(0, Date.now() - at)

  if (at === null || wasSuppressed) return 0
  if (!getSettingsState().autoRewind) return 0

  const rewind = rewindFor(Date.now() - at)
  lastRewindSec = rewind
  return rewind
}

/**
 * How much the most recent resume rewound. playback.ts widens its "did another
 * device move ahead of us?" threshold by this, so our own rewind can't be read
 * as a remote advance and immediately undone.
 */
export function lastRewindAmount(): number {
  return lastRewindSec
}

/**
 * How long the pause consumed by the most recent resume lasted (ms), or 0 when
 * there was none. Read alongside lastRewindAmount() by the cross-device resume
 * check, which only looks at the server after a pause long enough to have been a
 * hand-off to another device.
 */
export function lastPausedDuration(): number {
  return lastPausedForMs
}

/** Forget any pending pause - a new book, or playback stopping entirely. */
export function resetAutoRewind(): void {
  pausedAt = null
  suppressed = false
  lastRewindSec = 0
  lastPausedForMs = 0
}
