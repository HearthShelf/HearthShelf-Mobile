/**
 * Observable sync status for the player - drives the header status icon and the
 * live "Now" row in Recent Listens, so the listener can see whether their
 * listening has reached the server.
 *
 * Three meaningful states (plus idle), chosen to avoid flicker - the icon does
 * NOT blink on every background sync:
 *  - 'synced'  (green):  server reachable and everything is on the server.
 *  - 'pending' (orange): we have listening/position not yet on the server, but the
 *                        server IS reachable (a scrub-while-paused, or listened-time
 *                        mid-sync). Resolves to green when the sync lands.
 *  - 'failed'  (red):    a sync attempt failed / server unreachable. Can't send.
 *                        Resolves to orange (catching up) then green on reconnect.
 *  - 'idle':             nothing playing.
 *
 * There is deliberately no visible "syncing" state: a quick background POST while
 * everything is otherwise synced stays green.
 *
 * playback.ts drives this. Plain subscribe/snapshot store (same shape as the other
 * player stores).
 */

export type SyncStatus = 'idle' | 'synced' | 'pending' | 'failed'

/** The session currently playing, for the live Recent Listens row. */
export interface LiveSession {
  itemId: string
  /** ms epoch the session started. */
  startedAt: number
  /** Book position (seconds) this session began at. */
  startTime: number
  /** Book position (seconds) right now. */
  currentTime: number
  /** Real listened-time (seconds) accrued this session so far (synced + pending). */
  timeListening: number
}

export interface SyncState {
  status: SyncStatus
  /** ms epoch of the last successful sync, or null. */
  lastSyncedAt: number | null
  /** The live session, or null when nothing is playing. */
  live: LiveSession | null
}

let state: SyncState = { status: 'idle', lastSyncedAt: null, live: null }
const listeners = new Set<() => void>()

// Notified whenever a sync actually reaches the server. A successful sync is
// proof the server is reachable, which the connection layer can't always learn
// on its own: its recovery paths are edge-triggered (a NetInfo network edge, an
// AppState foreground, a Clerk sign-in flip), and a merely SLOW connection never
// produces an edge. So a connect that lost the startup race could sit at
// phase:'offline' indefinitely while playback synced fine - showing a red icon
// on a working connection. ConnectionProvider subscribes to this to re-attempt
// the connect the moment we have evidence the server is up.
const reachedListeners = new Set<() => void>()

/** Subscribe to "a sync just reached the server". Returns an unsubscribe fn. */
export function subscribeServerReached(fn: () => void): () => void {
  reachedListeners.add(fn)
  return () => {
    reachedListeners.delete(fn)
  }
}

/** Announce that a request reached the server. Fired by syncStateSynced and by a
 *  successful pending-session flush (which has no live session to mark synced). */
export function notifyServerReached(): void {
  reachedListeners.forEach((l) => l())
}

function set(patch: Partial<SyncState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function getSyncState(): SyncState {
  return state
}

export function subscribeSyncState(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Start (or restart) the live session for a book (starts green - fresh session,
 *  nothing to sync yet). */
export function syncStateStartSession(itemId: string, startedAt: number, currentTime: number): void {
  set({
    status: 'synced',
    live: { itemId, startedAt, startTime: currentTime, currentTime, timeListening: 0 },
  })
}

/** Update the live session's position + accrued listened-time as it plays (no
 *  status change - a normal tick doesn't flip the icon). */
export function syncStateTick(currentTime: number, timeListening: number): void {
  if (!state.live) return
  set({ live: { ...state.live, currentTime, timeListening } })
}

/** Everything accrued so far is now on the server. Green. Also announces that the
 *  server is reachable, so a stale offline connection phase can recover. */
export function syncStateSynced(atMs: number): void {
  set({ status: 'synced', lastSyncedAt: atMs })
  notifyServerReached()
}

/** We have listening/position not yet on the server, but the server is reachable.
 *  Orange. Never downgrades a 'failed' (red) state - that's a stronger signal. */
export function syncStatePending(): void {
  if (state.status === 'failed') return
  set({ status: 'pending' })
}

/** A sync attempt failed / the server is unreachable. Red. */
export function syncStateFailed(): void {
  set({ status: 'failed' })
}

/** The listener moved the playhead (seek/skip), so the server's position is now
 *  stale even though no new listened-time accrued: go orange (pending) and move
 *  the live row's position so the icon can push the new spot. */
export function syncStateSeeked(currentTime: number): void {
  if (state.status === 'idle') return
  set({
    status: state.status === 'failed' ? 'failed' : 'pending',
    live: state.live ? { ...state.live, currentTime } : state.live,
  })
}

/** Nothing playing. */
export function syncStateClear(): void {
  set({ status: 'idle', live: null })
}
