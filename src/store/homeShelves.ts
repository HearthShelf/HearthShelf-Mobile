/**
 * Published shelves: a screen pushes its computed shelf list here so the pushed
 * "/shelf/[key]" See-all screen can render a shelf's full grid without
 * refetching or squeezing item lists through route params. Module-level and
 * ephemeral - rebuilt on every load (online or offline).
 *
 * Two screens publish: Home and Discover. They're kept in separate buckets and
 * merged on read, because a Home reload must not drop the Discover rows the
 * user can still navigate back to (and vice versa). Within a bucket a publish
 * replaces the whole list, so a shelf that disappears from a screen stops being
 * resolvable once that screen reloads.
 */
import type { ABSLibraryItem } from '@hearthshelf/core'
import type { BookActionsSource } from '@/ui/BookActionsSheet'

export interface PublishedShelf {
  id: string
  label: string
  entities: ABSLibraryItem[]
  source?: BookActionsSource
  seriesByItemId?: Record<string, { id: string; name: string }>
}

type Origin = 'home' | 'discover'

const buckets: Record<Origin, PublishedShelf[]> = { home: [], discover: [] }
const listeners = new Set<() => void>()
// The merged view, rebuilt only on publish. useSyncExternalStore compares
// snapshots by identity, so getHomeShelves() must not allocate per call.
let merged: PublishedShelf[] = []

function publish(origin: Origin, next: PublishedShelf[]): void {
  buckets[origin] = next
  const seen = new Set<string>()
  const out: PublishedShelf[] = []
  // Home first: where both screens publish a shelf under the same id (the taste
  // engine feeds both), Home's copy is the one Home's own See-all should open.
  for (const s of [...buckets.home, ...buckets.discover]) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    out.push(s)
  }
  merged = out
  listeners.forEach((l) => l())
}

export function publishHomeShelves(next: PublishedShelf[]): void {
  publish('home', next)
}

export function publishDiscoverShelves(next: PublishedShelf[]): void {
  publish('discover', next)
}

export function getHomeShelves(): PublishedShelf[] {
  return merged
}

export function subscribeHomeShelves(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
