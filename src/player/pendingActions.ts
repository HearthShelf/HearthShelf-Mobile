/**
 * Library actions taken while the server was unreachable, waiting to reach it.
 *
 * Same idea as pendingProgress / pendingBookmarks: the screen changes right away,
 * the intent is saved on the phone, and it is sent once the connection is back
 * (NetInfo online edge, a request reaching the server, the app returning to the
 * foreground, and the OS background flush task).
 *
 * Only actions that are safe to send twice live here. Each entry describes the
 * END STATE the listener chose ("this book is finished"), never a step ("toggle
 * finished"), so replaying one after a request that may already have landed
 * changes nothing. Repeats on the same target collapse: only the last choice per
 * target is kept, so finish-then-undo offline sends one write, not two.
 *
 * | Action                         | Queued? | Why                                                    |
 * | ------------------------------ | ------- | ------------------------------------------------------ |
 * | Mark finished / not finished   | yes     | PATCH isFinished is a set; tap time kept as finishedAt  |
 * | Reset progress                 | yes*    | DELETE of the row; dropped if newer progress exists    |
 * | Hide / unhide (series, book)   | yes     | POST/DELETE /hs/dismissals are set add/remove          |
 * | Ignore / unignore roster book  | yes     | same dismissals set                                    |
 * | Follow                         | yes     | POST /hs/subscriptions upserts by our client id        |
 * | Unfollow                       | yes     | DELETE by id; deleting twice is harmless               |
 * | Rating (set / clear)           | yes     | PUT /hs/ratings sets the value                         |
 * | Book request (ReadMeABook)     | no      | creates a request; refused offline, timeout warns      |
 * | Clubs, lists, notes, invites   | no      | creates things; no client id the server de-dupes on    |
 * | Edit / delete a listen         | no      | history is server-only and can't be refreshed offline  |
 * | Finished count correction      | no      | an absolute count can clobber the nightly recount      |
 *
 * (*) A reset is checked again right before it is sent: if the book has local
 * progress newer than the reset, or the server row was written after it (another
 * device listened on), the reset is dropped instead of wiping newer listening.
 *
 * Writes that time out ONLINE (the request may have reached the server) are
 * treated the same way for every queued action - they are safe to retry. The
 * non-idempotent actions above are never queued and never retried automatically.
 *
 * Executors call the api modules directly (never the stores), so a replay can't
 * re-enter this queue. Stores import this module for their overlays; this module
 * reaches the stores only through dynamic imports after a flush, which keeps the
 * import graph acyclic.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState } from 'react-native'
import type { Dismissals, HSSubscription } from '@hearthshelf/core'
import { ABSRequestError, setItemFinished, resetItemProgress } from '@/api/abs'
import { addDismissal, removeDismissal } from '@/api/dismissals'
import { createSubscription, deleteSubscription } from '@/api/subscriptions'
import { setRating } from '@/api/ratings'
import { getSession } from '@/api/session'
import { ConnectionError } from '@/api/connectionError'
import { breadcrumb } from '@/lib/crashLog'
import { isOfflineMode, subscribeServerReached } from './syncState'

export type DismissTarget = 'series' | 'item' | 'roster'

export type PendingAction =
  | { type: 'finish'; itemId: string; finished: boolean; finishedAt?: number; at: number }
  | { type: 'reset'; itemId: string; at: number }
  | {
      type: 'dismiss'
      kind: DismissTarget
      entityId: string
      dismissed: boolean
      at: number
    }
  | { type: 'follow'; sub: HSSubscription; at: number }
  | { type: 'unfollow'; sub: HSSubscription; at: number }
  | { type: 'rating'; itemKey: string; rating: number | null; at: number }

/** What a write did: reached the server, or was saved to send later. */
export type WriteOutcome = 'synced' | 'queued'

/** The toast for a queued write. One wording everywhere. */
export const QUEUED_MESSAGE = "Saved - this will sync when you're back online"

const STORE_KEY = 'hs.pendingActions.v1'

/** Rejections (the server answered and said no) allowed per target before the
 *  entry is dropped. Same reasoning as pendingProgress: a record the server will
 *  never accept must not sit in the queue forever. */
const MAX_REJECTIONS = 3

/** Stop a burst of "server reached" signals from flushing over and over. */
const REACHED_FLUSH_COOLDOWN_MS = 30_000

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export function finishKey(itemId: string): string {
  return `finish:${itemId}`
}

export function resetKey(itemId: string): string {
  return `reset:${itemId}`
}

export function dismissKey(kind: DismissTarget, entityId: string): string {
  // Roster ASIN casing varies across Audible responses (see store/dismissals).
  return `dismiss:${kind}:${kind === 'roster' ? entityId.toLowerCase() : entityId}`
}

/** One key per followed thing, so follow and unfollow of it collapse. */
export function followKey(sub: Pick<HSSubscription, 'kind' | 'asin' | 'seriesAsin'>): string {
  const target = sub.kind === 'series' ? sub.seriesAsin : sub.asin
  return `follow:${sub.kind}:${(target ?? '').toLowerCase()}`
}

export function ratingKey(itemKey: string): string {
  return `rating:${itemKey}`
}

function keyOf(a: PendingAction): string {
  switch (a.type) {
    case 'finish':
      return finishKey(a.itemId)
    case 'reset':
      return resetKey(a.itemId)
    case 'dismiss':
      return dismissKey(a.kind, a.entityId)
    case 'follow':
    case 'unfollow':
      return followKey(a.sub)
    case 'rating':
      return ratingKey(a.itemKey)
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Insertion-ordered, so a flush replays in the order the listener acted. */
let entries = new Map<string, PendingAction>()
const listeners = new Set<() => void>()
const rejections = new Map<string, number>()

function emit(next: Map<string, PendingAction>): void {
  entries = next
  listeners.forEach((l) => l())
  void AsyncStorage.setItem(STORE_KEY, JSON.stringify({ items: [...next.values()] })).catch(
    () => {},
  )
}

export function subscribePendingActions(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function pendingActions(): PendingAction[] {
  return [...entries.values()]
}

export function pendingActionCount(): number {
  return entries.size
}

export function pendingFor(key: string): PendingAction | undefined {
  return entries.get(key)
}

let hydration: Promise<void> | null = null

/** Load the saved queue. Runs once on first import; safe to await repeatedly. */
export function hydratePendingActions(): Promise<void> {
  if (!hydration) {
    hydration = (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORE_KEY)
        if (!raw) return
        const parsed = JSON.parse(raw) as { items?: PendingAction[] }
        const next = new Map<string, PendingAction>()
        for (const a of parsed.items ?? []) {
          if (!a || typeof a.type !== 'string' || typeof a.at !== 'number') continue
          next.set(keyOf(a), a)
        }
        // Anything queued during this run before the disk read finished is newer.
        for (const [k, a] of entries) {
          next.delete(k)
          next.set(k, a)
        }
        entries = next
        listeners.forEach((l) => l())
      } catch {
        // start empty on a bad payload
      }
    })()
  }
  return hydration
}

/**
 * Save an action to send later, replacing any earlier choice for the same target.
 * A reset also drops a queued finish/unfinish for that book: deleting the
 * progress row clears its finished flag, so the older write would be undone
 * anyway (a finish chosen AFTER the reset is kept and replays after it).
 */
export function enqueueAction(action: PendingAction): void {
  const key = keyOf(action)
  const next = new Map(entries)
  next.delete(key) // re-insert at the end: it is now the newest choice
  if (action.type === 'reset') next.delete(finishKey(action.itemId))
  next.set(key, action)
  rejections.delete(key)
  emit(next)
}

/** Remove a queued action (a newer write reached the server, or the listener
 *  undid a queued choice). Returns what was removed. */
export function cancelPendingAction(key: string): PendingAction | undefined {
  const cur = entries.get(key)
  if (!cur) return undefined
  const next = new Map(entries)
  next.delete(key)
  rejections.delete(key)
  emit(next)
  return cur
}

/** Forget everything (account change). */
export async function clearPendingActions(): Promise<void> {
  rejections.clear()
  entries = new Map()
  listeners.forEach((l) => l())
  await AsyncStorage.removeItem(STORE_KEY).catch(() => {})
}

// ---------------------------------------------------------------------------
// When to queue
// ---------------------------------------------------------------------------

/** Known offline: don't spend a request timeout before saving the choice. */
export function shouldQueueNow(): boolean {
  return !getSession() || isOfflineMode()
}

/**
 * Did this write fail because the server could not be reached (or did not answer
 * in time)? Only these are queued. A server that answered "no" is a real failure:
 * the caller rolls back and says so.
 */
export function isTransportFailure(e: unknown): boolean {
  if (e instanceof ABSRequestError) return false
  if (e instanceof ConnectionError) return e.status == null
  if (e instanceof TypeError) return true
  if (e instanceof Error) {
    return e.message.startsWith('abs_request_unreachable') || e.message === 'not_connected'
  }
  return false
}

// ---------------------------------------------------------------------------
// Overlays: keep queued choices on screen when a refresh brings back server data
// ---------------------------------------------------------------------------

export function overlayDismissals(server: Dismissals): Dismissals {
  let out = server
  for (const a of entries.values()) {
    if (a.type !== 'dismiss') continue
    const bucket = a.kind === 'series' ? 'seriesIds' : a.kind === 'item' ? 'itemIds' : 'rosterAsins'
    const list = out[bucket] ?? []
    const same = (id: string) =>
      a.kind === 'roster' ? id.toLowerCase() === a.entityId.toLowerCase() : id === a.entityId
    const has = list.some(same)
    if (a.dismissed && !has) out = { ...out, [bucket]: [...list, a.entityId] }
    else if (!a.dismissed && has) out = { ...out, [bucket]: list.filter((id) => !same(id)) }
  }
  return out
}

export function overlaySubscriptions(server: HSSubscription[]): HSSubscription[] {
  let out = server
  for (const a of entries.values()) {
    if (a.type === 'follow') {
      if (!out.some((s) => s.id === a.sub.id)) out = [a.sub, ...out]
    } else if (a.type === 'unfollow') {
      if (out.some((s) => s.id === a.sub.id)) out = out.filter((s) => s.id !== a.sub.id)
    }
  }
  return out
}

/** Queued rating for one book, or undefined when nothing is waiting. */
export function pendingRatingFor(itemKey: string): number | null | undefined {
  const a = entries.get(ratingKey(itemKey))
  return a?.type === 'rating' ? a.rating : undefined
}

/**
 * Save a rating, or queue it when the server can't be reached. Lives here (not
 * in api/ratings) so the api module stays a leaf this queue can call.
 */
export async function saveRating(itemKey: string, rating: number | null): Promise<WriteOutcome> {
  const action: PendingAction = { type: 'rating', itemKey, rating, at: Date.now() }
  if (shouldQueueNow()) {
    enqueueAction(action)
    return 'queued'
  }
  try {
    await setRating(itemKey, rating)
    cancelPendingAction(ratingKey(itemKey))
    return 'synced'
  } catch (e) {
    if (!isTransportFailure(e)) throw e
    enqueueAction(action)
    return 'queued'
  }
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

/** Result of one send: done (remove it), retry later, or the link is down. */
type SendResult = 'done' | 'rejected' | 'unreachable'

async function send(a: PendingAction): Promise<SendResult> {
  try {
    switch (a.type) {
      case 'finish':
        await setItemFinished(a.itemId, a.finished, a.finished ? a.finishedAt : undefined)
        return 'done'
      case 'reset': {
        if (await resetIsStale(a)) {
          breadcrumb('pending', `dropped queued reset of ${a.itemId}: newer progress exists`)
          return 'done'
        }
        await resetItemProgress(a.itemId)
        return 'done'
      }
      case 'dismiss':
        if (a.dismissed) await addDismissal(a.kind, a.entityId)
        else await removeDismissal(a.kind, a.entityId)
        return 'done'
      case 'follow':
        // Upserts by a.sub.id server-side, so a resend after a request that
        // already landed just rewrites the same row.
        await createSubscription(a.sub)
        return 'done'
      case 'unfollow':
        await deleteSubscription(a.sub.id)
        return 'done'
      case 'rating':
        await setRating(a.itemKey, a.rating)
        return 'done'
    }
  } catch (e) {
    return isTransportFailure(e) ? 'unreachable' : 'rejected'
  }
}

/**
 * A reset must not wipe listening that happened after it. Checked against the
 * freshest rows we have: a local row written after the reset (offline listening
 * of the book since), or a server row stamped after it (another device).
 */
async function resetIsStale(a: { itemId: string; at: number }): Promise<boolean> {
  const progress = await import('@/store/progress')
  // Pull the server's current stamps first; best-effort, a failure just means we
  // decide on what we last saw.
  await progress.refreshProgress().catch(() => {})
  const local = progress.progressFor(a.itemId)
  if (local && typeof local.lastUpdate === 'number' && local.lastUpdate > a.at) return true
  const serverAt = progress.serverProgressUpdatedAt(a.itemId)
  return typeof serverAt === 'number' && serverAt > a.at
}

let flushing: Promise<boolean> | null = null

/**
 * Send every queued action, oldest first. Stops at the first unreachable send
 * (the link is down - no point timing out on the rest). Returns true when the
 * queue is empty afterwards. Safe to call repeatedly; concurrent calls share one
 * run.
 */
export function flushPendingActions(): Promise<boolean> {
  if (!flushing) {
    flushing = runFlush().finally(() => {
      flushing = null
    })
  }
  return flushing
}

async function runFlush(): Promise<boolean> {
  await hydratePendingActions()
  if (!entries.size) return true
  if (!getSession()) return false

  const touched = new Set<PendingAction['type']>()
  for (const a of [...entries.values()]) {
    const key = keyOf(a)
    // A newer choice replaced this one while we were sending earlier entries.
    if (entries.get(key) !== a) continue
    const result = await send(a)
    if (result === 'unreachable') {
      scheduleRetry()
      return false
    }
    if (result === 'rejected') {
      const n = (rejections.get(key) ?? 0) + 1
      if (n < MAX_REJECTIONS) {
        rejections.set(key, n)
        continue
      }
      breadcrumb('pending', `dropped queued ${a.type} after ${n} rejections`)
    }
    touched.add(a.type)
    // Only remove it if it wasn't replaced while the request was in flight.
    if (entries.get(key) === a) {
      const next = new Map(entries)
      next.delete(key)
      rejections.delete(key)
      emit(next)
    }
  }
  retries = 0
  void refreshAfterFlush(touched)
  return entries.size === 0
}

/** The NetInfo edge fires before the reconnect finishes, so the first try often
 *  lands while the server is still out of reach. Retry a few times, spaced out;
 *  never while offline mode is on (flushIfReachable bails), so a phone that
 *  stays offline spends nothing. */
const RETRY_DELAYS_MS = [15_000, 60_000, 300_000]
let retries = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

function scheduleRetry(): void {
  if (retryTimer || retries >= RETRY_DELAYS_MS.length) return
  const delay = RETRY_DELAYS_MS[retries++]
  retryTimer = setTimeout(() => {
    retryTimer = null
    flushIfReachable()
  }, delay)
}

/** Re-read the server lists the flushed actions changed. Dynamic imports keep
 *  the stores (which import this module) out of the static graph. */
async function refreshAfterFlush(types: Set<PendingAction['type']>): Promise<void> {
  try {
    if (types.has('finish') || types.has('reset')) {
      const progress = await import('@/store/progress')
      void progress.refreshProgress().catch(() => {})
    }
    if (types.has('dismiss')) {
      const dismissals = await import('@/store/dismissals')
      void dismissals.hydrateDismissals()
    }
    if (types.has('follow') || types.has('unfollow')) {
      const subs = await import('./subscriptions')
      void subs.refreshSubscriptions()
    }
    if (types.has('finish') || types.has('reset') || types.has('dismiss')) {
      const { requestQueueRecompute } = await import('./queueSync')
      requestQueueRecompute()
    }
  } catch {
    // The next normal refresh picks it up.
  }
}

// ---------------------------------------------------------------------------
// Triggers this module owns: server reached, app foreground. The NetInfo edge
// and the background task call flushPendingActions from connectivity.ts and
// backgroundFlushTask.ts.
// ---------------------------------------------------------------------------

let lastReachedFlush = 0

function flushIfReachable(): void {
  if (!entries.size || shouldQueueNow()) return
  void flushPendingActions()
}

subscribeServerReached(() => {
  const now = Date.now()
  if (now - lastReachedFlush < REACHED_FLUSH_COOLDOWN_MS) return
  lastReachedFlush = now
  flushIfReachable()
})

AppState.addEventListener('change', (s) => {
  if (s === 'active') {
    retries = 0
    flushIfReachable()
  }
})

void hydratePendingActions()
