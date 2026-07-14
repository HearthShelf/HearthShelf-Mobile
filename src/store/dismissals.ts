/**
 * Auto-source dismissals store: the in-memory cache of the user's "not right
 * now" hidden series/books, synced from /hs/dismissals. Every Home shelf and the
 * queue filter against this. Same subscribe/snapshot shape as player/queue.ts.
 *
 * Writes are optimistic (update local first, then the server), and since a
 * dismissal changes the server-computed Auto queue, callers should re-pull the
 * queue after a write - see hydrateAfterDismissChange wiring in the Home screen.
 */
import type { Dismissals } from '@hearthshelf/core'
import * as api from '@/api/dismissals'
import { requestQueueRecompute } from '@/player/queueSync'

let state: Dismissals = { seriesIds: [], itemIds: [] }
const listeners = new Set<() => void>()

// Best-effort id -> display label cache so the Settings "Hidden from shelves"
// list can show titles/series names, not raw ids. Populated when the user
// dismisses something (we know the label then). An id with no cached label
// falls back to the id in the UI. Not synced - purely a local convenience.
const labels = new Map<string, string>()

export function labelFor(entityId: string): string | undefined {
  return labels.get(entityId)
}

export function getDismissalsState(): Dismissals {
  return state
}

export function subscribeDismissals(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function set(next: Dismissals): void {
  state = next
  listeners.forEach((l) => l())
}

export function isSeriesDismissed(seriesId: string): boolean {
  return state.seriesIds.includes(seriesId)
}

export function isItemDismissed(itemId: string): boolean {
  return state.itemIds.includes(itemId)
}

/** Pull the server's dismissal list and adopt it. Best-effort. */
export async function hydrateDismissals(): Promise<void> {
  try {
    set(await api.getDismissals())
  } catch {
    // Backend unreachable - keep the current cache.
  }
}

/** Clear on sign-out. */
export function resetDismissals(): void {
  set({ seriesIds: [], itemIds: [] })
}

/**
 * Dismiss a series/book: update the cache optimistically, then persist. On
 * failure, roll back. Returns a promise that resolves when the server confirms
 * (so the caller can re-pull the queue afterward).
 */
export async function dismiss(
  kind: 'series' | 'item',
  entityId: string,
  label?: string,
): Promise<void> {
  const key = kind === 'series' ? 'seriesIds' : 'itemIds'
  if (label) labels.set(entityId, label)
  if (state[key].includes(entityId)) return
  const prev = state
  set({ ...state, [key]: [...state[key], entityId] })
  try {
    set(await api.addDismissal(kind, entityId))
    // Dismissing hides this series/book from every Auto rule, so rebuild the
    // queue now instead of waiting for the next play-cooldown / nightly job.
    requestQueueRecompute()
  } catch {
    set(prev) // roll back the optimistic add
    throw new Error('dismiss_failed')
  }
}

/** Restore a previously dismissed series/book (optimistic, with rollback). */
export async function restore(kind: 'series' | 'item', entityId: string): Promise<void> {
  const key = kind === 'series' ? 'seriesIds' : 'itemIds'
  if (!state[key].includes(entityId)) return
  const prev = state
  set({ ...state, [key]: state[key].filter((id) => id !== entityId) })
  try {
    set(await api.removeDismissal(kind, entityId))
    // Restoring makes the series/book eligible for Auto rules again - rebuild.
    requestQueueRecompute()
  } catch {
    set(prev)
    throw new Error('restore_failed')
  }
}
