/**
 * Release subscriptions store. The server owns the durable list (/hs/subscriptions,
 * keyed by ABS user id) so it follows the user across devices; this is the fast
 * in-memory copy every screen reads via useSyncExternalStore - the Home countdown
 * banner, the series screen's follow buttons, and the Notifications settings list.
 * Same subscribe/snapshot shape as queue.ts.
 *
 * Optimistic writes: subscribe/unsubscribe update the store immediately, then
 * reconcile with the server response (or roll back on failure).
 */
import type { HSSubscription, HSSubscriptionCreate } from '@hearthshelf/core'
import {
  getSubscriptions,
  createSubscription,
  deleteSubscription as apiDelete,
} from '@/api/subscriptions'

interface SubscriptionsState {
  subscriptions: HSSubscription[]
  loaded: boolean
}

let state: SubscriptionsState = { subscriptions: [], loaded: false }
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
    const subscriptions = await getSubscriptions()
    set({ subscriptions, loaded: true })
  } catch {
    // Keep whatever we have; mark loaded so the UI stops showing a spinner.
    set({ loaded: true })
  }
}

export function clearSubscriptions(): void {
  state = { subscriptions: [], loaded: false }
  listeners.forEach((l) => l())
}

/** Is the user already following this book (by asin) or series (by seriesAsin)? */
export function isSubscribed(opts: { asin?: string; seriesAsin?: string; kind: 'book' | 'series' }): boolean {
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

/** Follow a book or series. Optimistic; reconciles with the server. */
export async function subscribe(create: HSSubscriptionCreate): Promise<void> {
  const id = localId()
  const optimistic: HSSubscription = {
    ...create,
    id,
    available: false,
    availableAt: null,
    createdAt: Date.now(),
  }
  set({ subscriptions: [optimistic, ...state.subscriptions] })
  try {
    const saved = await createSubscription({ ...create, id })
    // Replace the optimistic row with the server's canonical one.
    set({
      subscriptions: state.subscriptions.map((s) => (s.id === id ? saved : s)),
    })
  } catch {
    // Roll back on failure.
    set({ subscriptions: state.subscriptions.filter((s) => s.id !== id) })
    throw new Error('subscribe_failed')
  }
}

/** Unfollow by subscription id. Optimistic; restores on failure. */
export async function unsubscribe(id: string): Promise<void> {
  const prev = state.subscriptions
  set({ subscriptions: prev.filter((s) => s.id !== id) })
  try {
    await apiDelete(id)
  } catch {
    set({ subscriptions: prev })
    throw new Error('unsubscribe_failed')
  }
}
