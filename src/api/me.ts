/**
 * The connected ABS user's own id, cached in memory so social surfaces (notes,
 * clubs) can tell "my note" from someone else's and gate spoilers against my own
 * position. Populated from getMe() responses (the /api/me call the progress store
 * already makes on load), so no extra request. Plain module singleton like
 * session.ts - readable from React and non-React code alike.
 */
let currentUserId = ''

/** Record the current user's ABS id (called wherever /api/me resolves). */
export function setMeId(id: string): void {
  if (id) currentUserId = id
}

/** The connected user's ABS id, or '' before the first /api/me completes. */
export function getMeId(): string {
  return currentUserId
}

export function clearMeId(): void {
  currentUserId = ''
}
