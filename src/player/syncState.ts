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

// Notified when the listener moves the playhead. playback.ts subscribes so it can
// remember an unsynced position change; the seek itself originates in store.ts,
// which must not import playback (playback already imports store, and the cycle
// would be real). syncState is the leaf both already depend on, so the signal
// routes through here - the same shape as subscribeServerReached above.
const seekListeners = new Set<(target: number) => void>()

/** Subscribe to "the listener seeked". Returns an unsubscribe fn. */
export function subscribeSeeked(fn: (target: number) => void): () => void {
  seekListeners.add(fn)
  return () => {
    seekListeners.delete(fn)
  }
}

/** Announce that a request reached the server. Fired by syncStateSynced and by a
 *  successful pending-session flush (which has no live session to mark synced). */
export function notifyServerReached(): void {
  reachedListeners.forEach((l) => l())
}

// Mirrors ConnectionProvider's phase:'offline' for the non-React modules
// (playback, the ABS client) that can't read context. Those paths used to infer
// connectivity from "is there a session object", but entering offline mode keeps
// the stale session around - so they'd treat a known-dead server as online and
// try it first, stalling every action until the request timed out. This lets them
// skip straight to the local path.
let offlineMode = false

/** True when the connection layer has declared offline mode. */
export function isOfflineMode(): boolean {
  return offlineMode
}

/** Set by ConnectionProvider as it enters/leaves offline mode. */
export function setOfflineMode(v: boolean): void {
  offlineMode = v
}

/**
 * The ABS session id playback is currently listening on, or null.
 *
 * Lives here, in the leaf module both sides already import, because
 * pendingProgress must be able to ask "is this session still alive?" while
 * playback imports pendingProgress - a direct import back would cycle. Same
 * reason subscribeSeeked lives here.
 *
 * Why anything needs to ask: every progress tick banks the LIVE session into the
 * streaming buffer (playback.bankStreaming), so that buffer is not a graveyard -
 * it holds the currently-playing session too. migrateOrphanStreaming drains the
 * whole buffer and closes each entry's session server-side, which is correct at
 * launch (nothing is playing yet) and catastrophic from the 15-minute background
 * flush task: it closed the session the user was actively listening on, the next
 * sync 404'd, and reopenAndResync started a new one - chopping one night's listen
 * into 15-minute segments (HS-MOBILEAPP-5).
 */
let liveSessionId: string | null = null

/** True when `id` is the session playback is listening on right now. */
export function isLiveSession(id: string | undefined | null): boolean {
  return !!id && id === liveSessionId
}

/** Set by playback as it opens/adopts/closes an ABS session. */
export function setLiveSession(id: string | null): void {
  liveSessionId = id
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
export function syncStateStartSession(
  itemId: string,
  startedAt: number,
  currentTime: number,
): void {
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
  // Tell playback the position moved with no listened-time behind it, so it can
  // push the new spot instead of waiting for a listened-time threshold that a
  // seek alone will never cross.
  seekListeners.forEach((l) => l(currentTime))
}

/** Nothing playing. */
export function syncStateClear(): void {
  set({ status: 'idle', live: null })
}
