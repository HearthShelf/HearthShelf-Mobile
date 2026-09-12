/**
 * The connected ABS user's own id, cached in memory so social surfaces (notes,
 * clubs) can tell "my note" from someone else's and gate spoilers against my own
 * position. Populated from getMe() responses (the /api/me call the progress store
 * already makes on load), so no extra request. Plain module singleton like
 * session.ts - readable from React and non-React code alike.
 *
 * Screens that render the signed-in user's own profile photo need this id (the
 * avatar store keys by ABS user id, not the account id), and they can mount
 * before /api/me resolves - so the id is also subscribable, letting those
 * screens swap the initials fallback for the real photo the moment it lands.
 */
let currentUserId = ''

const listeners = new Set<() => void>()

/** Record the current user's ABS id (called wherever /api/me resolves). */
export function setMeId(id: string): void {
  if (!id || id === currentUserId) return
  currentUserId = id
  for (const fn of listeners) fn()
}

/** The connected user's ABS id, or '' before the first /api/me completes. */
export function getMeId(): string {
  return currentUserId
}

export function clearMeId(): void {
  if (!currentUserId) return
  currentUserId = ''
  for (const fn of listeners) fn()
}

/** Subscribe to id changes, for useSyncExternalStore. */
export function subscribeMeId(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
