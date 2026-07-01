/**
 * Immersive (Car Mode) flag for the full player. Lives outside the React tree so
 * both the player surface and the bottom-tab navigator can read it: entering
 * immersive hides the player chrome AND the navigator's tab bar, which the player
 * itself can't reach (the tab bar is owned by (tabs)/_layout, not the player).
 *
 * Plain subscribe/snapshot store for useSyncExternalStore, matching player/store.
 */
let immersive = false
const listeners = new Set<() => void>()

export function getImmersive(): boolean {
  return immersive
}

export function subscribeImmersive(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function setImmersive(next: boolean): void {
  if (immersive === next) return
  immersive = next
  listeners.forEach((l) => l())
}
