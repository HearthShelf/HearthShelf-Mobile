/**
 * Book lengths for the up-next queue header ("12 Books - 3d 04h 12m").
 *
 * QueueEntry carries no duration (it is title/author/id only, and the server
 * builds it that way), so the length of each queued book is resolved here from
 * whatever the device already knows, falling back to one item read per book we
 * have never seen:
 *
 *   1. progress store  - set for anything started or finished
 *   2. offline catalog - set for downloaded books and series skeletons
 *   3. GET /api/items/:id - summed audio files (the detail read omits the flat
 *      media.duration that the list read carries)
 *
 * Fetched lengths are memoized for the session: a book's runtime does not
 * change, so one read per book is enough however often the tray is opened. A
 * book whose length cannot be resolved (offline, or a failed read) is recorded
 * as unknown, which the header reports rather than silently undercounting.
 */
import { getItemDetail } from '@/api/abs'
import { getCatalogState } from './offlineCatalog'
import { isOfflineMode } from './syncState'
import { progressFor } from '@/store/progress'

/** Resolved seconds per item id. 0 means "known to be unresolvable". */
const cache = new Map<string, number>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
// Bumped whenever a fetch lands, so useSyncExternalStore re-reads the totals.
let version = 0

function emit(): void {
  version++
  listeners.forEach((l) => l())
}

export function subscribeQueueDurations(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function queueDurationsVersion(): number {
  return version
}

/** Seconds for a book from local state only - no network. */
function localDuration(itemId: string): number | undefined {
  const progress = progressFor(itemId)
  if (progress?.duration) return progress.duration
  const cataloged = getCatalogState().byId.get(itemId)
  if (cataloged?.duration) return cataloged.duration
  return undefined
}

async function fetchDuration(itemId: string): Promise<void> {
  try {
    const detail = await getItemDetail(itemId)
    const seconds = (detail.media?.audioFiles ?? []).reduce((sum, f) => sum + (f.duration || 0), 0)
    cache.set(itemId, seconds)
  } catch {
    // Unreachable or unreadable - record it so we don't retry in a loop, and so
    // the header can say the total is partial.
    cache.set(itemId, 0)
  } finally {
    inFlight.delete(itemId)
    emit()
  }
}

/** Kick off reads for any queued book whose length we don't know yet. Safe to
 *  call on every render: known books and in-flight reads are skipped, and
 *  nothing is fetched while offline. */
export function ensureQueueDurations(itemIds: string[]): void {
  if (isOfflineMode()) return
  for (const id of itemIds) {
    if (cache.has(id) || inFlight.has(id)) continue
    const local = localDuration(id)
    if (local !== undefined) {
      cache.set(id, local)
      continue
    }
    inFlight.set(id, fetchDuration(id))
  }
}

export interface QueueLength {
  /** Books in the list. */
  books: number
  /** Summed seconds of the books whose length we know. */
  seconds: number
  /** True when at least one book's length is still missing, so `seconds` is a
   *  floor rather than the real total. */
  partial: boolean
}

export function queueLength(itemIds: string[]): QueueLength {
  let seconds = 0
  let partial = false
  for (const id of itemIds) {
    const known = cache.get(id) ?? localDuration(id)
    if (known) seconds += known
    else partial = true
  }
  return { books: itemIds.length, seconds, partial }
}

/** "3d 04h 12m" / "14h 17m" / "42m" - days only once there are any, and the
 *  hours zero-padded after a day so the line keeps a steady width. */
export function formatQueueLength(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0)
    return `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  return `${minutes}m`
}

/** The whole header line: "12 Books - 3d 04h 12m". While a book's length is
 *  still unknown the total is a floor, so it reads "12 Books - 3d 04h+" rather
 *  than claiming a number that is about to grow. */
export function queueLengthLabel(length: QueueLength): string {
  const books = `${length.books} ${length.books === 1 ? 'Book' : 'Books'}`
  if (length.seconds <= 0) return books
  return `${books} - ${formatQueueLength(length.seconds)}${length.partial ? '+' : ''}`
}
