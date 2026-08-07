/**
 * Open state for the More menu bubble, kept outside React so any surface can
 * request it - not just the tabs layout that renders it.
 *
 * The tabs shell intercepts its own More press directly. Pushed routes (player,
 * search, item detail...) render their own AppTabBar and navigate by route name,
 * so their More press lands on app/(tabs)/more.tsx, which asks to open the menu
 * and bounces into the tabs shell. Both paths end at the same store.
 */
type Listener = () => void

let open = false
const listeners = new Set<Listener>()

function emit() {
  for (const l of listeners) l()
}

export function subscribeMoreMenu(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getMoreMenuOpen(): boolean {
  return open
}

export function setMoreMenuOpen(next: boolean): void {
  if (open === next) return
  open = next
  emit()
}

export function toggleMoreMenu(): void {
  setMoreMenuOpen(!open)
}
