/**
 * Open state for the More menu bubble, kept outside React so any surface can
 * request it - not just the tabs layout that renders it.
 *
 * The tabs shell intercepts its own More press directly; pushed routes (player,
 * search, item detail...) do the same through useGoToTab. Neither navigates -
 * the bubble is mounted at the app root (MoreMenuHost in app/_layout.tsx) so it
 * draws above whatever is on screen. Both paths end at the same store.
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
