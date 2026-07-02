/**
 * Global note-pop toast state. The pop watcher (src/player/notePops.ts) runs
 * outside the React tree (it's driven by the player store, alive screen-off via
 * the foreground service), so it can't own a per-screen useToast. This is a
 * plain subscribe/snapshot store the app mounts one <PopToast> against, matching
 * the store pattern used across the app (player/store.ts, store/settings.ts).
 */
export interface PopToastState {
  /** Author display name of the popped note. */
  author: string
  /** The note body (truncated for the toast by the renderer). */
  body: string
  /** Club to deep-link into when the toast is tapped. */
  clubId: string
  /** Bumps on each show so an identical repeat pop still re-triggers the toast. */
  nonce: number
}

let state: PopToastState | null = null
const listeners = new Set<() => void>()

export function getPopToast(): PopToastState | null {
  return state
}

export function subscribePopToast(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Show a note pop. Called by the watcher; the mounted <PopToast> renders it. */
export function showPopToast(author: string, body: string, clubId: string): void {
  state = { author, body, clubId, nonce: (state?.nonce ?? 0) + 1 }
  listeners.forEach((l) => l())
}

export function clearPopToast(): void {
  state = null
  listeners.forEach((l) => l())
}
