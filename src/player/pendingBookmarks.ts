/**
 * Bookmarks written while the server was unreachable (or while a write was in
 * flight when the app died), waiting to reach ABS.
 *
 * ABS bookmarks have no id - they're keyed by (libraryItemId, time), and the
 * only read is the whole-list `/api/me` payload. So a bookmark that isn't on the
 * server simply doesn't exist as far as a refresh is concerned: without a local
 * record, an offline bookmark vanishes the moment the list refetches.
 *
 * Write-ahead is the whole point of this store. A create is recorded here BEFORE
 * the network call and cleared only once the server confirms. A kill in between
 * therefore leaves the bookmark recoverable instead of orphaned. Deletes get the
 * same treatment in reverse (a tombstone), or an offline delete reappears on the
 * next refresh.
 *
 * Consumers merge these over the server list (see useBookmarks) so an offline
 * bookmark is visible immediately.
 *
 * Plain subscribe/snapshot store (same shape as the other stores).
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { ABSBookmark } from '@hearthshelf/core'
import { createBookmark, deleteBookmark } from '@/api/abs'
import { getSession } from '@/api/session'

/** A create that hasn't been confirmed by the server yet. */
export interface PendingBookmark {
  libraryItemId: string
  /** Whole seconds - ABS rounds, and the key must match what the server stores. */
  time: number
  title: string
  createdAt: number
}

/** A delete that hasn't been confirmed by the server yet. */
export interface PendingDelete {
  libraryItemId: string
  time: number
}

export interface PendingBookmarkState {
  creates: readonly PendingBookmark[]
  deletes: readonly PendingDelete[]
}

const STORE_KEY = 'hs.pendingBookmarks.v1'

let state: PendingBookmarkState = { creates: [], deletes: [] }
const listeners = new Set<() => void>()

/** Identity for a bookmark: ABS keys by item + whole-second time, so we must too. */
function keyOf(libraryItemId: string, time: number): string {
  return `${libraryItemId}::${Math.round(time)}`
}

function emit(next: PendingBookmarkState): void {
  state = next
  listeners.forEach((l) => l())
  void AsyncStorage.setItem(STORE_KEY, JSON.stringify(next)).catch(() => {})
}

export function getPendingBookmarkState(): PendingBookmarkState {
  return state
}

export function subscribePendingBookmarks(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Load persisted pending bookmarks on app start. */
export async function hydratePendingBookmarks(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<PendingBookmarkState>
    const creates = (parsed.creates ?? []).filter(
      (b): b is PendingBookmark => !!b && typeof b.libraryItemId === 'string',
    )
    const deletes = (parsed.deletes ?? []).filter(
      (d): d is PendingDelete => !!d && typeof d.libraryItemId === 'string',
    )
    state = { creates, deletes }
    listeners.forEach((l) => l())
  } catch {
    // start empty on a bad payload
  }
}

/**
 * Merge pending local state over the server's bookmark list for one item:
 * unconfirmed creates are added, tombstoned deletes are removed. This is what
 * makes an offline bookmark visible right away and keeps an offline delete from
 * reappearing on the next refresh.
 */
export function mergeBookmarks(
  serverList: readonly ABSBookmark[],
  libraryItemId: string,
): ABSBookmark[] {
  const deleted = new Set(
    state.deletes
      .filter((d) => d.libraryItemId === libraryItemId)
      .map((d) => keyOf(d.libraryItemId, d.time)),
  )
  const merged = new Map<string, ABSBookmark>()
  for (const b of serverList) {
    if (b.libraryItemId !== libraryItemId) continue
    const k = keyOf(b.libraryItemId, b.time)
    if (deleted.has(k)) continue
    merged.set(k, b)
  }
  for (const p of state.creates) {
    if (p.libraryItemId !== libraryItemId) continue
    const k = keyOf(p.libraryItemId, p.time)
    // A create the user then deleted offline must not resurrect.
    if (deleted.has(k)) continue
    merged.set(k, {
      libraryItemId: p.libraryItemId,
      title: p.title,
      time: p.time,
      createdAt: p.createdAt,
    })
  }
  return [...merged.values()].sort((a, b) => a.time - b.time)
}

/**
 * Save a bookmark, write-ahead. Records it locally FIRST, then attempts the
 * server create and clears the record on success. Returns true when the server
 * confirmed, false when it's banked locally for a later flush.
 *
 * Never throws: a failed write is a pending write, not an error the caller has
 * to handle.
 */
export async function addBookmarkPending(
  libraryItemId: string,
  time: number,
  title: string,
): Promise<boolean> {
  const t = Math.round(time)
  const k = keyOf(libraryItemId, t)
  const entry: PendingBookmark = { libraryItemId, time: t, title, createdAt: Date.now() }

  // Write-ahead: persist before the network call so a kill mid-push can't orphan
  // the bookmark. Also drops any tombstone for this exact spot - re-adding a
  // bookmark the user deleted offline is a create, not a no-op.
  emit({
    creates: [...state.creates.filter((c) => keyOf(c.libraryItemId, c.time) !== k), entry],
    deletes: state.deletes.filter((d) => keyOf(d.libraryItemId, d.time) !== k),
  })

  if (!getSession()) return false
  try {
    await createBookmark(libraryItemId, t, title)
  } catch {
    return false
  }
  emit({
    creates: state.creates.filter((c) => keyOf(c.libraryItemId, c.time) !== k),
    deletes: state.deletes,
  })
  return true
}

/**
 * Delete a bookmark, write-ahead. Tombstones it locally first so an offline
 * delete sticks across a refresh, then attempts the server delete.
 *
 * Never throws. Returns true when the server confirmed.
 */
export async function removeBookmarkPending(libraryItemId: string, time: number): Promise<boolean> {
  const t = Math.round(time)
  const k = keyOf(libraryItemId, t)

  // Deleting a bookmark that never reached the server just drops the pending
  // create - there's nothing on the server to tombstone.
  const wasUnconfirmed = state.creates.some((c) => keyOf(c.libraryItemId, c.time) === k)
  const creates = state.creates.filter((c) => keyOf(c.libraryItemId, c.time) !== k)
  if (wasUnconfirmed) {
    emit({ creates, deletes: state.deletes })
    return true
  }

  emit({
    creates,
    deletes: [
      ...state.deletes.filter((d) => keyOf(d.libraryItemId, d.time) !== k),
      { libraryItemId, time: t },
    ],
  })

  if (!getSession()) return false
  try {
    await deleteBookmark(libraryItemId, t)
  } catch {
    return false
  }
  emit({
    creates: state.creates,
    deletes: state.deletes.filter((d) => keyOf(d.libraryItemId, d.time) !== k),
  })
  return true
}

/**
 * Move a bookmark to a new time (and/or retitle it), write-ahead.
 *
 * ABS keys bookmarks by (item, time) with no id, so a move IS a delete plus a
 * create. Doing that as two separate calls would leave a window where the old
 * one is gone and the new one isn't recorded yet - a kill in there loses the
 * bookmark outright. So both sides of the move land in ONE atomic state write
 * before any network call, and the flush replays whatever survives.
 *
 * Never throws. Returns true when the server confirmed both halves.
 */
export async function moveBookmarkPending(
  libraryItemId: string,
  fromTime: number,
  toTime: number,
  title: string,
): Promise<boolean> {
  const from = Math.round(fromTime)
  const to = Math.round(toTime)
  const fromKey = keyOf(libraryItemId, from)
  const toKey = keyOf(libraryItemId, to)

  // A move that doesn't move is just a retitle; still a create over the same key.
  const sameSpot = from === to
  // Was the ORIGINAL only ever local? Then there's nothing on the server to
  // tombstone - dropping its pending create is the whole delete.
  const originUnconfirmed = state.creates.some((c) => keyOf(c.libraryItemId, c.time) === fromKey)

  const creates = [
    ...state.creates.filter(
      (c) => keyOf(c.libraryItemId, c.time) !== fromKey && keyOf(c.libraryItemId, c.time) !== toKey,
    ),
    { libraryItemId, time: to, title, createdAt: Date.now() },
  ]
  const deletes = [
    ...state.deletes.filter(
      (d) => keyOf(d.libraryItemId, d.time) !== fromKey && keyOf(d.libraryItemId, d.time) !== toKey,
    ),
    // Tombstone the old spot only if the server might actually have it.
    ...(sameSpot || originUnconfirmed ? [] : [{ libraryItemId, time: from }]),
  ]
  emit({ creates, deletes })

  if (!getSession()) return false

  let ok = true
  if (!sameSpot && !originUnconfirmed) {
    try {
      await deleteBookmark(libraryItemId, from)
      emit({
        creates: state.creates,
        deletes: state.deletes.filter((d) => keyOf(d.libraryItemId, d.time) !== fromKey),
      })
    } catch {
      ok = false
    }
  }
  try {
    await createBookmark(libraryItemId, to, title)
    emit({
      creates: state.creates.filter((c) => keyOf(c.libraryItemId, c.time) !== toKey),
      deletes: state.deletes,
    })
  } catch {
    ok = false
  }
  return ok
}

/**
 * Replay every pending bookmark write to ABS, clearing each on success and
 * keeping it on failure. No-op with no session (still offline) or nothing
 * pending. Safe to call repeatedly.
 *
 * Returns true when there was nothing to send OR everything sent.
 */
export async function flushPendingBookmarks(): Promise<boolean> {
  if (!getSession()) return false
  const creates = [...state.creates]
  const deletes = [...state.deletes]
  if (!creates.length && !deletes.length) return true

  const doneCreates = new Set<string>()
  const doneDeletes = new Set<string>()

  for (const c of creates) {
    try {
      await createBookmark(c.libraryItemId, c.time, c.title)
      doneCreates.add(keyOf(c.libraryItemId, c.time))
    } catch {
      // leave pending; the next reconnect retries
    }
  }
  for (const d of deletes) {
    try {
      await deleteBookmark(d.libraryItemId, d.time)
      doneDeletes.add(keyOf(d.libraryItemId, d.time))
    } catch {
      // leave pending
    }
  }

  emit({
    creates: state.creates.filter((c) => !doneCreates.has(keyOf(c.libraryItemId, c.time))),
    deletes: state.deletes.filter((d) => !doneDeletes.has(keyOf(d.libraryItemId, d.time))),
  })
  return doneCreates.size === creates.length && doneDeletes.size === deletes.length
}
