/**
 * Client-only up-next queue, ported from the WebApp's queueStore.ts. ABS has no
 * cross-book session queue, so this is a plain in-memory subscribe/snapshot
 * store (same shape as player/store.ts) - SESSION ONLY, cleared on app restart.
 * A server-backed cross-device queue is planned for a later pass; don't add
 * AsyncStorage persistence here in the meantime, it would just be thrown away.
 */

export interface QueueEntry {
  libraryItemId: string
  title: string
  author: string
}

// How the up-next queue behaves when a book ends:
//  - off:      stop at the end of each book
//  - manual:   play the next book the user queued by hand
//  - auto:     rebuild up-next from the smart rules
//  - playlist: follow a chosen ABS playlist in order
export type QueueMode = 'off' | 'manual' | 'auto' | 'playlist'

// Ordered, toggleable rules that drive Auto mode. Order = priority.
export type AutoRuleId = 'finish-series' | 'in-progress' | 'new-in-series'
export interface AutoRule {
  id: AutoRuleId
  on: boolean
}

export interface QueueState {
  items: QueueEntry[]
  mode: QueueMode
  playlistId: string | null
  autoRules: AutoRule[]
}

let state: QueueState = {
  items: [],
  mode: 'off',
  playlistId: null,
  autoRules: [
    { id: 'finish-series', on: true },
    { id: 'in-progress', on: true },
    { id: 'new-in-series', on: false },
  ],
}

const listeners = new Set<() => void>()

export function getQueueState(): QueueState {
  return state
}

export function subscribeQueue(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function set(patch: Partial<QueueState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function addToQueue(entry: QueueEntry): void {
  if (state.items.some((i) => i.libraryItemId === entry.libraryItemId)) return
  set({ items: [...state.items, entry] })
}

export function removeFromQueue(libraryItemId: string): void {
  set({ items: state.items.filter((i) => i.libraryItemId !== libraryItemId) })
}

export function reorderQueue(from: number, to: number): void {
  const next = state.items.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  set({ items: next })
}

export function clearQueue(): void {
  set({ items: [] })
}

/** Pop and return the next queued entry, or null when empty. */
export function nextInQueue(): QueueEntry | null {
  const [head, ...rest] = state.items
  if (!head) return null
  set({ items: rest })
  return head
}

export function setQueueMode(mode: QueueMode): void {
  set({ mode })
}

export function setQueuePlaylistId(playlistId: string | null): void {
  set({ playlistId })
}

export function toggleAutoRule(id: AutoRuleId): void {
  set({ autoRules: state.autoRules.map((r) => (r.id === id ? { ...r, on: !r.on } : r)) })
}
