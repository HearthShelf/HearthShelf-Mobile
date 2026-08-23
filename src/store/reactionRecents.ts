/**
 * Recently-used reaction emoji, newest first.
 *
 * Purely local and never synced: which emoji you reach for is a personal habit,
 * not something the club needs to agree on, and syncing it would spend a
 * settings key plus a round trip on a preference nobody else can observe.
 *
 * Feeds the quick-pick row - core's quickReactions() pins the three originals
 * and fills the remaining slots from this list, so the row adapts to whoever is
 * holding the phone without any of it reaching the server.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { rememberReaction } from '@hearthshelf/core'

const STORE_KEY = 'hs.reactionRecents.v1'

let recents: string[] = []
let hydrated = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

export function subscribeReactionRecents(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Snapshot for useSyncExternalStore. Stable between writes so the hook does
 *  not re-render on every subscriber notification. */
export function getReactionRecents(): string[] {
  return recents
}

/** Load the saved list. Safe to call more than once; only the first read wins,
 *  so a late hydrate cannot clobber a reaction made while it was in flight. */
export async function hydrateReactionRecents(): Promise<void> {
  if (hydrated) return
  hydrated = true
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY)
    if (!raw) return
    const saved = JSON.parse(raw)
    if (!Array.isArray(saved)) return
    // Merge rather than replace: a reaction used before hydrate finished is
    // already in `recents` and is the NEWER signal, so it stays in front.
    const merged = [...recents]
    for (const kind of saved) {
      if (typeof kind === 'string' && !merged.includes(kind)) merged.push(kind)
    }
    recents = merged.slice(0, 12)
    emit()
  } catch {
    // A corrupt list just means an empty quick row - never worth failing over.
  }
}

/** Fold a just-used reaction in. Pinned kinds are ignored by core, so tapping
 *  the thumbs up never displaces a genuinely-recent emoji from the row. */
export function noteReactionUsed(kind: string): void {
  const next = rememberReaction(recents, kind)
  if (next === recents) return
  recents = next
  emit()
  void AsyncStorage.setItem(STORE_KEY, JSON.stringify(recents)).catch(() => {})
}
