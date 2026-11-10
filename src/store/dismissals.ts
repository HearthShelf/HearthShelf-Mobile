/**
 * Auto-source dismissals store: the in-memory cache of the user's "not right
 * now" hidden series/books, synced from /hs/dismissals. Every Home shelf and the
 * queue filter against this. Same subscribe/snapshot shape as player/queue.ts.
 *
 * Writes are optimistic (update local first, then the server), and since a
 * dismissal changes the server-computed Auto queue, callers should re-pull the
 * queue after a write - see hydrateAfterDismissChange wiring in the Home screen.
 *
 * Offline (or when the write can't reach the server) a dismiss/restore is queued
 * in player/pendingActions and kept on screen; both are set add/remove, so a
 * replay is harmless. Every server list adopted here is overlaid with those
 * queued choices so a refresh can't undo them before they sync.
 */
import type { Dismissals } from '@hearthshelf/core'
import * as api from '@/api/dismissals'
import { requestQueueRecompute } from '@/player/queueSync'
import {
  cancelPendingAction,
  dismissKey,
  enqueueAction,
  isTransportFailure,
  overlayDismissals,
  shouldQueueNow,
  type WriteOutcome,
} from '@/player/pendingActions'

// 'series' and 'item' are ABS ids. 'roster' is an AUDIBLE ASIN: a series-roster
// book the user never expects to own (an ebook-only side story, a print
// edition), which has no ABS item id because it is not in the library. Ignoring
// one drops it from the missing list, the series completion denominator,
// Upcoming, and the Home countdown.
export type DismissKind = 'series' | 'item' | 'roster'

const BUCKET = {
  series: 'seriesIds',
  item: 'itemIds',
  roster: 'rosterAsins',
} as const

let state: Dismissals = { seriesIds: [], itemIds: [], rosterAsins: [] }
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

/** Is this Audible roster book ignored? ASIN casing varies across Audible
 *  responses, so compare case-insensitively. */
export function isRosterIgnored(asin: string): boolean {
  const want = asin.toLowerCase()
  return (state.rosterAsins ?? []).some((a) => a.toLowerCase() === want)
}

export function isItemDismissed(itemId: string): boolean {
  return state.itemIds.includes(itemId)
}

/** Pull the server's dismissal list and adopt it. Best-effort. */
export async function hydrateDismissals(): Promise<void> {
  try {
    set(overlayDismissals(await api.getDismissals()))
  } catch {
    // Backend unreachable - keep the current cache.
  }
}

/** Clear on sign-out. */
export function resetDismissals(): void {
  set({ seriesIds: [], itemIds: [], rosterAsins: [] })
}

/** Send one dismiss/restore, or queue it. Rolls back only when the server
 *  answered and refused. */
async function write(
  kind: DismissKind,
  entityId: string,
  dismissed: boolean,
  prev: Dismissals,
): Promise<WriteOutcome> {
  const queue = (): WriteOutcome => {
    enqueueAction({ type: 'dismiss', kind, entityId, dismissed, at: Date.now() })
    return 'queued'
  }
  if (shouldQueueNow()) return queue()
  try {
    const fresh = dismissed
      ? await api.addDismissal(kind, entityId)
      : await api.removeDismissal(kind, entityId)
    cancelPendingAction(dismissKey(kind, entityId))
    set(overlayDismissals(fresh))
    // Dismissing hides this series/book from every Auto rule (restoring makes it
    // eligible again), so rebuild the queue now instead of waiting for the next
    // play-cooldown / nightly job.
    requestQueueRecompute()
    return 'synced'
  } catch (e) {
    // A timed-out write may already have landed; adding/removing the same entry
    // again is harmless, so keep it on screen and send it later.
    if (isTransportFailure(e)) return queue()
    set(prev) // roll back the optimistic change
    throw new Error(dismissed ? 'dismiss_failed' : 'restore_failed')
  }
}

/**
 * Dismiss a series/book: update the cache optimistically, then persist. Resolves
 * 'queued' when it was saved to sync later; rejects (after rolling back) only
 * when the server refused it.
 */
export async function dismiss(
  kind: DismissKind,
  entityId: string,
  label?: string,
): Promise<WriteOutcome> {
  const key = BUCKET[kind]
  if (label) labels.set(entityId, label)
  if ((state[key] ?? []).includes(entityId)) return 'synced'
  const prev = state
  set({ ...state, [key]: [...(state[key] ?? []), entityId] })
  return write(kind, entityId, true, prev)
}

/** Restore a previously dismissed series/book (optimistic; queued offline). */
export async function restore(kind: DismissKind, entityId: string): Promise<WriteOutcome> {
  const key = BUCKET[kind]
  if (!(state[key] ?? []).includes(entityId)) return 'synced'
  const prev = state
  set({ ...state, [key]: (state[key] ?? []).filter((id) => id !== entityId) })
  return write(kind, entityId, false, prev)
}
