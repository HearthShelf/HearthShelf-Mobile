/**
 * Debug-only force-show for the boot splash. Diagnostics flips this on so the
 * hearth splash can be inspected on demand (it normally flashes by in a second
 * at cold boot). While forced, a tap anywhere on the splash dismisses it.
 *
 * A tiny subscribe/snapshot store (the app's convention) read by an overlay
 * mounted once at the root layout.
 */
let forced = false
const listeners = new Set<() => void>()

export function getSplashDebug(): boolean {
  return forced
}

export function subscribeSplashDebug(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Force the splash overlay on (Diagnostics "Show boot splash"). */
export function forceSplash(): void {
  if (forced) return
  forced = true
  listeners.forEach((l) => l())
}

/** Dismiss the forced splash (a tap on it, or leaving the overlay). */
export function dismissForcedSplash(): void {
  if (!forced) return
  forced = false
  listeners.forEach((l) => l())
}
