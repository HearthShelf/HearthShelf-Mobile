/**
 * Up-next queue. `items`/`playlistId` persist server-side (see queueSync.ts,
 * /hs/queue) so they follow the user across devices; this is the fast
 * in-memory write-through cache - same subscribe/snapshot shape as
 * player/store.ts, no AsyncStorage here (the server pull replaces it on load).
 *
 * Queue MODE and auto-rules are NOT here - they're preferences and live in
 * src/store/settings.ts / /hs/settings, same as the WebApp.
 */
import type { QueueEntry, QueueMode, AutoRuleId } from '@hearthshelf/core'
import { getSettingsState } from '@/store/settings'

export type { QueueEntry } from '@hearthshelf/core'

/** Shared copy for the queue mode picker - used by both QueueSheet (player) and
 *  the My Settings Queue section, so the two surfaces never drift. */
export const QUEUE_MODES: { v: QueueMode; label: string }[] = [
  { v: 'off', label: 'Off' },
  { v: 'manual', label: 'Manual' },
  { v: 'auto', label: 'Auto' },
  { v: 'playlist', label: 'Playlist' },
]
export const QUEUE_MODE_SUB: Record<QueueMode, string> = {
  off: 'Playback stops when this book ends.',
  manual: 'Your hand-picked order - drag to arrange.',
  auto: "Filled automatically from what you're listening to.",
  playlist: 'Playing in order from a saved list.',
}
export const AUTO_RULE_COPY: Record<AutoRuleId, { label: string; desc: string }> = {
  'finish-series': {
    label: 'Finish the current series',
    desc: "Queue the next book whenever you're part-way through a series.",
  },
  'in-progress': {
    label: 'Anything in progress',
    desc: "Pull in other titles you've already started but set down.",
  },
  'new-in-series': {
    label: 'New books in series you started',
    desc: "Add fresh releases from a series you haven't finished yet.",
  },
  'book-club': {
    label: 'Books your clubs are reading',
    desc: 'Queue the current pick from each of your book clubs.',
  },
  manual: {
    label: 'Books you queued by hand',
    desc: 'Play the books you added to your queue, after your Auto picks.',
  },
}

export interface QueueState {
  // The ACTIVE up-next list the player pops from. Rebuilt server-side in
  // Auto/Playlist mode; mirrors `manual` in Manual mode.
  items: QueueEntry[]
  // The DURABLE hand-queued list. add/remove/reorder edit this; it drives Manual
  // mode and, in Auto mode, feeds the server-side 'manual' rule so a hand-picked
  // queue survives every Auto rebuild. Synced via /hs/queue alongside items.
  manual: QueueEntry[]
  playlistId: string | null
  // Bumped on every items/manual/playlistId mutation; the conflict key /hs/queue
  // uses to decide whether a write is newer than what's stored. See queueSync.ts.
  updatedAt: number
}

let state: QueueState = {
  items: [],
  manual: [],
  playlistId: null,
  updatedAt: 0,
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

// True when Manual mode is active - the active `items` list then mirrors the
// durable `manual` list so an edit shows up in the player immediately.
function manualMode(): boolean {
  return getSettingsState().queueMode === 'manual'
}

export function addToQueue(entry: QueueEntry): void {
  if (state.manual.some((i) => i.libraryItemId === entry.libraryItemId)) return
  const manual = [...state.manual, entry]
  set({ manual, items: manualMode() ? manual : state.items, updatedAt: Date.now() })
}

export function removeFromQueue(libraryItemId: string): void {
  const manual = state.manual.filter((i) => i.libraryItemId !== libraryItemId)
  const items = manualMode() ? manual : state.items.filter((i) => i.libraryItemId !== libraryItemId)
  set({ manual, items, updatedAt: Date.now() })
}

export function reorderQueue(from: number, to: number): void {
  const manual = state.manual.slice()
  const [moved] = manual.splice(from, 1)
  manual.splice(to, 0, moved)
  set({ manual, items: manualMode() ? manual : state.items, updatedAt: Date.now() })
}

export function clearQueue(): void {
  set({ manual: [], items: manualMode() ? [] : state.items, updatedAt: Date.now() })
}

// Replace the durable manual list (bulk set / whole-list reorder).
export function setManual(manual: QueueEntry[]): void {
  set({ manual, items: manualMode() ? manual : state.items, updatedAt: Date.now() })
}

// Replace the whole active items list (used when Auto rebuilds it, or a server
// sync pull adopts a remote queue). bump=false skips the updatedAt stamp, for
// pulls that shouldn't be echoed straight back to the server as a write.
export function setQueueItems(items: QueueEntry[], bump = true): void {
  set({ items, updatedAt: bump ? Date.now() : state.updatedAt })
}

// Replace the durable manual list from a server pull. bump=false as above.
export function setQueueManual(manual: QueueEntry[], bump = true): void {
  set({ manual, updatedAt: bump ? Date.now() : state.updatedAt })
}

/** Pop and return the next queued entry, or null when empty. */
export function nextInQueue(): QueueEntry | null {
  const [head, ...rest] = state.items
  if (!head) return null
  set({ items: rest, manual: manualMode() ? rest : state.manual, updatedAt: Date.now() })
  return head
}

export function setQueuePlaylistId(playlistId: string | null, bump = true): void {
  set({ playlistId, updatedAt: bump ? Date.now() : state.updatedAt })
}
