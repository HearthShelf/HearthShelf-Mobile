/**
 * End-of-book advance. When the current book finishes, play the head of the
 * up-next queue we already hold - deterministic, and crucially NOT a recompute.
 *
 * Recompute is deferred to the next book's play-cooldown (see recompute.ts). If
 * we instead re-pulled/recomputed here, the rebuild would run in the instant the
 * finished book is still settling: the server's "current item" heuristic would
 * skip the just-finished book and jump to a stale in-progress one, dropping the
 * next book in the series - the exact "book ended and it jumped past my series"
 * bug. So we just play items[0]; the new book's cooldown recomputes once it's
 * genuinely playing (and stamps it as the current item).
 *
 * Called from PlayerHost's onEnded native event (phone + car services emit it).
 */
import { getSettingsState } from '@/store/settings'
import { nextInQueue, getQueueState } from './queue'
import { playItemById } from './playback'
import { cancelRecomputeCooldown } from './recompute'

let advancing = false

export async function advanceQueueOnEnd(): Promise<void> {
  // Off: playback stops at the end of the book (nothing to advance to).
  if (getSettingsState().queueMode === 'off') return
  // Re-entrancy guard: STATE_ENDED can fire more than once around the boundary.
  if (advancing) return
  advancing = true
  try {
    // The finished book's play-cooldown (if it was still pending) is moot now -
    // cancel it so it can't fire against the just-finished book.
    cancelRecomputeCooldown()
    if (getQueueState().items.length === 0) return
    const next = nextInQueue()
    if (!next) return
    // armRecompute:false - advancing must not recompute in the ambiguous window;
    // the new book's own cooldown handles that once it's actually playing.
    await playItemById(next.libraryItemId, true, { armRecompute: false })
  } finally {
    advancing = false
  }
}
