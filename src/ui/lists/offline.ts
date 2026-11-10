/**
 * Offline wording and guards shared by the collection and playlist screens.
 *
 * Every list lives on the server, so nothing here can change one without a
 * connection. These keep the screens honest about that: an action tapped while
 * offline says so at once instead of waiting out a request that cannot work,
 * and a failed write names the likely reason instead of a vague "could not".
 */
import { ABSRequestError } from '@/api/abs'
import { isOfflineMode } from '@/player/syncState'
import { showToast } from '@/ui/Toast'

export const OFFLINE_CHANGE_MESSAGE = "You're offline. Changing lists needs a connection."

/** Run `fn` only when online; offline, say why nothing happened. */
export function whenOnline(fn: () => void): () => void {
  return () => {
    if (isOfflineMode()) {
      showToast(OFFLINE_CHANGE_MESSAGE)
      return
    }
    fn()
  }
}

/**
 * The message for a list write that failed. A request that never got an answer
 * (no HTTP status) is a connection problem, which is worth saying plainly; a
 * server refusal keeps the caller's own wording.
 */
export function listWriteFailMessage(e: unknown, fallback: string): string {
  if (isOfflineMode()) return OFFLINE_CHANGE_MESSAGE
  if (e instanceof ABSRequestError) {
    if (e.status === 403) return 'Your account on this server is not allowed to do that.'
    return fallback
  }
  return "Couldn't reach your server. Check your connection and try again."
}
