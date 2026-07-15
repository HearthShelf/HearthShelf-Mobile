/**
 * Published Home shelves: Home pushes its computed shelf list here so the
 * pushed "/shelf/[key]" See-all screen can render a shelf's full grid without
 * refetching or squeezing item lists through route params. Module-level and
 * ephemeral - rebuilt on every Home load (online or offline).
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

let shelves: PublishedShelf[] = []
const listeners = new Set<() => void>()

export function publishHomeShelves(next: PublishedShelf[]): void {
  shelves = next
  listeners.forEach((l) => l())
}

export function getHomeShelves(): PublishedShelf[] {
  return shelves
}

export function subscribeHomeShelves(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
