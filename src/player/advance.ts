/**
 * End-of-book advance. When the current book finishes, play the head of the
 * up-next queue. The server owns the queue (see server/lib/computeQueue.js): in
 * Auto mode it's freshly computed on GET, so we pull the latest before taking
 * the head rather than trusting a possibly-stale local cache. Off mode stops.
 *
 * Called from PlayerHost's onEnded native event (phone + car services emit it).
 */
import { getSettingsState } from '@/store/settings'
import { getServerQueue } from '@/api/queue'
import { getSession } from '@/api/session'
import { setQueueItems, setQueueManual, nextInQueue, getQueueState } from './queue'
import { playItemById } from './playback'

let advancing = false

export async function advanceQueueOnEnd(): Promise<void> {
  // Off: playback stops at the end of the book (nothing to advance to).
  if (getSettingsState().queueMode === 'off') return
  // Re-entrancy guard: STATE_ENDED can fire more than once around the boundary.
  if (advancing) return
  advancing = true
  try {
    // Pull the server's current queue so Auto mode advances to a fresh head.
    // Best-effort: offline or a failed pull falls back to the local cache.
    if (getSession()) {
      try {
        const server = await getServerQueue()
        setQueueItems(server.items, false)
        setQueueManual(server.manual, false)
      } catch {
        // keep local queue
      }
    }
    if (getQueueState().items.length === 0) return
    const next = nextInQueue()
    if (!next) return
    await playItemById(next.libraryItemId)
  } finally {
    advancing = false
  }
}
