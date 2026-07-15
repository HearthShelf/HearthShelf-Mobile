/**
 * Tiny event bus for "re-tapped the active tab". AppTabBar emits on the active
 * tab's name when it's pressed while already focused; each tab root subscribes
 * for its own name and scrolls its list to the top. Keeps AppTabBar
 * presentational (it doesn't need refs to any scroll view).
 */
type Fn = () => void

const subs: Record<string, Set<Fn>> = {}

/** Subscribe a tab root's scroll-to-top handler. Returns an unsubscribe fn. */
export function onTabReselect(tab: string, fn: Fn): () => void {
  ;(subs[tab] ??= new Set()).add(fn)
  return () => {
    subs[tab]?.delete(fn)
  }
}

/** Fire every handler registered for a tab (called on re-tap of the active tab). */
export function emitTabReselect(tab: string): void {
  subs[tab]?.forEach((f) => f())
}
