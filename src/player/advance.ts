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
import { markFinished } from '@/store/progress'
import { getState, setPlaying, skipChapter } from './store'
import { nextInQueue, getQueueState } from './queue'
import { playItemById } from './playback'
import { cancelRecomputeCooldown } from './recompute'

let advancing = false

/**
 * Chapter skip for the phone transport and the CarPlay now-playing buttons.
 * Wraps the store's pure verdict so "next chapter while already in the last
 * chapter" finishes the book instead of clamping (which would seek BACKWARDS to
 * that chapter's start, and push the rewind to the server as a real position).
 *
 * Android Auto does not come through here - its custom command runs natively in
 * HearthShelfAutoService, which finishes the book itself so it still works when
 * JS isn't attached. Keep the two in step.
 */
export function skipChapterOrFinish(direction: 1 | -1): void {
  if (skipChapter(direction) === 'finish') void finishBook().catch(() => {})
}

/**
 * Finish the current book on purpose, then advance exactly as a natural end
 * would. Used by next-chapter from inside the last chapter: there is nothing
 * further to skip to, so the intent is "I'm done with this book".
 *
 * Deliberately does NOT seek to the end and wait for the engine's end-of-media
 * event. Both engines only emit onEnded from a real playback-reached-the-end
 * signal (Android STATE_ENDED, iOS AVPlayerItemDidPlayToEndTime), which a bare
 * seek - especially while paused - is not guaranteed to produce. Marking
 * finished directly is the same outcome without depending on that.
 */
export async function finishBook(): Promise<void> {
  const np = getState().nowPlaying
  if (!np) return
  // Stop first: the book is over, so nothing should keep playing the tail while
  // the finish write and the queue advance settle.
  setPlaying(false)
  // Optimistic + rolled back on failure inside the progress store, so a dead
  // network still flips the UI and reconciles later.
  await markFinished(np.itemId, true, np.duration).catch(() => {})
  await advanceQueueOnEnd()
}

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
