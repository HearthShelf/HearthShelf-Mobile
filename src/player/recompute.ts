/**
 * Play-cooldown that defers the Auto-queue recompute after you start a book.
 *
 * Why a cooldown: recompute is trigger-based now, and "started a new book" is a
 * trigger - but firing it the instant a book starts is wrong. At a book-end
 * auto-advance the just-finished book is still settling, and an accidental tap
 * (play, then back out) shouldn't reshuffle up-next. So on an explicit play we
 * wait until the book has actually been listened to for a bit, THEN recompute.
 *
 * The clock is PLAYBACK time, not wall-clock: we accumulate forward position
 * deltas from the store's ~1s tick (the same signal the sleep timer uses), so
 * pausing or locking the phone pauses the countdown for free. If you switch
 * books, or the book ends, before the threshold, the pending recompute is
 * cancelled - only a book you actually stayed on recomputes.
 *
 * Best-effort: if the app is backgrounded/killed mid-cooldown the timer is lost
 * and no recompute fires, which is safe - the stored queue still has the
 * now-playing book at its head and a valid tail. The nightly job is the
 * guaranteed backstop.
 */
import { getState, subscribe } from './store'
import { recomputeServerQueue } from '@/api/queue'
import { getSession } from '@/api/session'
import { getSettingsState } from '@/store/settings'
import { setQueueItems, setQueueManual, setQueuePlaylistId } from './queue'

// Seconds of real playback before the recompute fires. Deliberately a couple of
// minutes: long enough to filter accidental taps, short enough that up-next
// isn't visibly stale for long after a legit book change.
const COOLDOWN_SECONDS = 120

let itemId: string | null = null
let accumulated = 0
let lastPosition = 0
let unsub: (() => void) | null = null

function clearTimer(): void {
  itemId = null
  accumulated = 0
  lastPosition = 0
  if (unsub) {
    unsub()
    unsub = null
  }
}

/** Cancel any pending play-cooldown (new play starting, or the book ended). */
export function cancelRecomputeCooldown(): void {
  clearTimer()
}

async function fire(forItemId: string): Promise<void> {
  clearTimer()
  if (!getSession()) return
  if (getSettingsState().queueMode !== 'auto') return
  try {
    const server = await recomputeServerQueue(forItemId)
    // Adopt the fresh queue without re-pushing it (bump=false), same as a pull.
    setQueueItems(server.items, false)
    setQueueManual(server.manual, false)
    setQueuePlaylistId(server.playlistId, false)
  } catch {
    // Best-effort; the local queue stays usable and the nightly job backstops.
  }
}

function onTick(): void {
  if (!itemId) return
  const s = getState()
  // Still the same book? A switch cancels via arm() below, but guard anyway.
  if (s.nowPlaying?.itemId !== itemId) {
    clearTimer()
    return
  }
  const pos = s.position
  if (s.isPlaying) {
    const delta = pos - lastPosition
    // Only count small forward steps as playback; a seek (large jump) or rewind
    // (negative) doesn't accrue listened time.
    if (delta > 0 && delta < 5) accumulated += delta
  }
  lastPosition = pos
  if (accumulated >= COOLDOWN_SECONDS) {
    const forItemId = itemId
    void fire(forItemId)
  }
}

/**
 * Start (or restart) the cooldown for a freshly-started book. Called only for
 * explicit plays - NOT the book-end auto-advance, which passes through without
 * arming so it never recomputes in the ambiguous just-finished window.
 */
export function armRecomputeCooldown(forItemId: string): void {
  clearTimer()
  // Only Auto mode has a computed queue to rebuild.
  if (getSettingsState().queueMode !== 'auto') return
  if (!getSession()) return
  itemId = forItemId
  accumulated = 0
  lastPosition = getState().position
  unsub = subscribe(onTick)
}
