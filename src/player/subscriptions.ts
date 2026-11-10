/**
 * Release subscriptions store. The server owns the durable list (/hs/subscriptions,
 * keyed by ABS user id) so it follows the user across devices; this is the fast
 * in-memory copy every screen reads via useSyncExternalStore - the Home countdown
 * banner, the series screen's follow buttons, and the Notifications settings list.
 * Same subscribe/snapshot shape as queue.ts.
 *
 * Optimistic writes: subscribe/unsubscribe update the store immediately, then
 * reconcile with the server response (or roll back on failure).
 *
 * Offline, or when the write can't reach the server, the follow/unfollow is
 * queued in pendingActions instead. Both are safe to send twice: a follow
 * carries our own id and the server upserts by it, and deleting an id twice is a
 * no-op. Refreshed lists are overlaid with the queued choices until they sync.
 */
import type { HSSubscription, HSSubscriptionCreate } from '@hearthshelf/core'
import {
  getSubscriptions,
  createSubscription,
  deleteSubscription as apiDelete,
} from '@/api/subscriptions'
import {
  cancelPendingAction,
  enqueueAction,
  followKey,
  isTransportFailure,
  overlaySubscriptions,
  pendingFor,
  shouldQueueNow,
  type WriteOutcome,
} from './pendingActions'

interface SubscriptionsState {
  subscriptions: HSSubscription[]
  loaded: boolean
  /** The last refresh never got an answer, so an empty list may not be the
   *  real one. */
  failed: boolean
}

let state: SubscriptionsState = { subscriptions: [], loaded: false, failed: false }
const listeners = new Set<() => void>()

export function getSubscriptionsState(): SubscriptionsState {
  return state
}

export function subscribeSubscriptions(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function set(patch: Partial<SubscriptionsState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

/** Pull the server list into the store. Safe to call on every foreground. */
export async function refreshSubscriptions(): Promise<void> {
  try {
    const subscriptions = overlaySubscriptions(await getSubscriptions())
    set({ subscriptions, loaded: true, failed: false })
  } catch {
    // Keep whatever we have; mark loaded so the UI stops showing a spinner.
    set({ loaded: true, failed: true })
  }
}

export function clearSubscriptions(): void {
  state = { subscriptions: [], loaded: false, failed: false }
  listeners.forEach((l) => l())
}

/** Is the user already following this book (by asin) or series (by seriesAsin)? */
export function isSubscribed(opts: {
  asin?: string
  seriesAsin?: string
  kind: 'book' | 'series'
}): boolean {
  return state.subscriptions.some((s) =>
    opts.kind === 'series'
      ? s.kind === 'series' && s.seriesAsin === opts.seriesAsin
      : s.kind === 'book' && s.asin === opts.asin,
  )
}

export function findSubscription(opts: {
  asin?: string
  seriesAsin?: string
  kind: 'book' | 'series'
}): HSSubscription | undefined {
  return state.subscriptions.find((s) =>
    opts.kind === 'series'
      ? s.kind === 'series' && s.seriesAsin === opts.seriesAsin
      : s.kind === 'book' && s.asin === opts.asin,
  )
}

// Local id for the optimistic row; the server echoes it back.
function localId(): string {
  return `sub_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** Follow a book or series. Optimistic; reconciles with the server, or is queued
 *  to sync later ('queued'). Rejects (after rolling back) only when the server
 *  refused it. */
export async function subscribe(create: HSSubscriptionCreate): Promise<WriteOutcome> {
  // Re-following something unfollowed while offline: the server never heard
  // about the unfollow, so cancelling it and putting the old row back is the
  // whole job - sending a new follow would leave two.
  const queuedUnfollow = pendingFor(followKey(create))
  if (queuedUnfollow?.type === 'unfollow') {
    cancelPendingAction(followKey(create))
    set({ subscriptions: [queuedUnfollow.sub, ...state.subscriptions] })
    return 'synced'
  }
  const id = localId()
  const optimistic: HSSubscription = {
    ...create,
    id,
    available: false,
    availableAt: null,
    createdAt: Date.now(),
  }
  set({ subscriptions: [optimistic, ...state.subscriptions] })
  const queue = (): WriteOutcome => {
    enqueueAction({ type: 'follow', sub: optimistic, at: Date.now() })
    return 'queued'
  }
  if (shouldQueueNow()) return queue()
  try {
    const saved = await createSubscription({ ...create, id })
    cancelPendingAction(followKey(create))
    // Replace the optimistic row with the server's canonical one.
    set({
      subscriptions: state.subscriptions.map((s) => (s.id === id ? saved : s)),
    })
    return 'synced'
  } catch (e) {
    // A timed-out create may have landed; resending with the same id upserts
    // the same row, so it is safe to try again later.
    if (isTransportFailure(e)) return queue()
    set({ subscriptions: state.subscriptions.filter((s) => s.id !== id) })
    throw new Error('subscribe_failed')
  }
}

/** Unfollow by subscription id. Optimistic; queued offline ('queued'); restores
 *  only when the server refused it. */
export async function unsubscribe(id: string): Promise<WriteOutcome> {
  const prev = state.subscriptions
  const sub = prev.find((s) => s.id === id)
  set({ subscriptions: prev.filter((s) => s.id !== id) })
  if (sub) {
    // Unfollowing a follow that never reached the server: drop the queued
    // follow and there is nothing to send.
    const queued = pendingFor(followKey(sub))
    if (queued?.type === 'follow' && queued.sub.id === id) {
      cancelPendingAction(followKey(sub))
      return 'synced'
    }
  }
  const queue = (): WriteOutcome => {
    if (sub) enqueueAction({ type: 'unfollow', sub, at: Date.now() })
    return 'queued'
  }
  if (sub && shouldQueueNow()) return queue()
  try {
    await apiDelete(id)
    if (sub) cancelPendingAction(followKey(sub))
    return 'synced'
  } catch (e) {
    if (sub && isTransportFailure(e)) return queue()
    set({ subscriptions: prev })
    throw new Error('unsubscribe_failed')
  }
}
