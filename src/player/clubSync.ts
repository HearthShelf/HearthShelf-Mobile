/**
 * Keeps the pop watcher's club-book stubs fresh, and refreshes club/notes state
 * on foreground - the club counterpart to queueSync.ts. Plain start/stop
 * functions (no hook convention in this app), called from ConnectionProvider on
 * connect and torn down on sign-out.
 *
 * What it does:
 *  - Resolves whether the currently-playing book is a club's current book that
 *    the user is in. If so, fetches that book's locked stubs and feeds them to
 *    notePops.setPopStubs so the watcher can fire pops (works screen-off during
 *    playback via the foreground service).
 *  - Polls on the house 15s cadence, but ONLY while the playing book is a club
 *    book (or a notes/club surface is open) - no timer otherwise, matching the
 *    design doc's "otherwise pull on focus" rule.
 *  - Pulls on AppState 'active' (foreground), like queueSync.
 */
import { AppState, type AppStateStatus } from 'react-native'
import { getState as getPlayerState, subscribe as subscribePlayer } from './store'
import { setPopStubs, clearPopStubs, startNotePops, stopNotePops } from './notePops'
import { getClubs } from '@/api/clubs'
import { getNotes } from '@/api/notes'

const POLL_MS = 15_000

let started = false
let pollTimer: ReturnType<typeof setInterval> | null = null
let appStateSub: { remove: () => void } | null = null
let unsubPlayer: (() => void) | null = null
// The club whose current book is the playing item (or '' when none).
let activeClubId = ''
let activeClubName = ''
let activeItemId = ''

// Subscribers (e.g. the player's open-club button) notified when the playing
// book's club changes. Kept tiny - the useSyncExternalStore convention the app
// uses elsewhere.
const clubListeners = new Set<() => void>()
function emitClub(): void {
  clubListeners.forEach((l) => l())
}

export interface ActiveClub {
  id: string
  name: string
}

// getActiveClub() is read via useSyncExternalStore, which requires a STABLE
// reference between calls when nothing changed - a fresh object literal every
// call reads as "changed" on every render and infinite-loops the player
// screen. Cache it and only rebuild on a real setActiveClub() change.
let activeClub: ActiveClub | null = null

/** The club whose current book is the now-playing item, or null. Reactive via
 *  subscribeActiveClub. */
export function getActiveClub(): ActiveClub | null {
  return activeClub
}

export function subscribeActiveClub(fn: () => void): () => void {
  clubListeners.add(fn)
  return () => {
    clubListeners.delete(fn)
  }
}

function setActiveClub(id: string, name: string): void {
  if (id === activeClubId && name === activeClubName) return
  activeClubId = id
  activeClubName = name
  activeClub = id ? { id, name } : null
  emitClub()
}
// A caller (open club/notes surface) can force polling on even when the playing
// book isn't a club book. Kept as a count so nested opens balance out.
let surfaceOpen = 0

async function resolveActiveClub(): Promise<void> {
  const itemId = getPlayerState().nowPlaying?.itemId ?? ''
  if (!itemId) {
    setActiveClub('', '')
    activeItemId = ''
    clearPopStubs()
    return
  }
  // Find a club the user is in whose CURRENT book is the playing item.
  const res = await getClubs(itemId)
  const club = res.mine.find((c) => c.currentBook?.libraryItemId === itemId)
  if (!club) {
    setActiveClub('', '')
    activeItemId = ''
    clearPopStubs()
    return
  }
  setActiveClub(club.id, club.name)
  activeItemId = itemId
  // Pull this book's locked stubs at the reader's position and feed the watcher.
  const notes = await getNotes({
    libraryItemId: itemId,
    clubId: club.id,
    position: getPlayerState().position,
  })
  setPopStubs(club.id, itemId, notes.locked)
}

async function pull(): Promise<void> {
  try {
    await resolveActiveClub()
  } catch {
    // Backend unreachable - keep whatever stubs we last had.
  }
}

// Poll only while there's a reason to (a club book playing, or an open surface).
function ensurePolling(): void {
  const shouldPoll = activeClubId !== '' || surfaceOpen > 0
  if (shouldPoll && !pollTimer) {
    pollTimer = setInterval(() => void pull(), POLL_MS)
  } else if (!shouldPoll && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function onPlayerChange(): void {
  const itemId = getPlayerState().nowPlaying?.itemId ?? ''
  // Re-resolve when the playing item changes (new book may/may not be a club book).
  if (itemId !== activeItemId) {
    void pull().then(ensurePolling)
  }
}

function onAppStateChange(next: AppStateStatus): void {
  if (next === 'active') void pull().then(ensurePolling)
}

/**
 * Called by an open club room / notes sheet to force the 15s poll on while it's
 * visible (freshness for that surface), even if the playing book isn't a club
 * book. Returns a cleanup to call when the surface closes.
 */
export function holdClubPolling(): () => void {
  surfaceOpen++
  ensurePolling()
  return () => {
    surfaceOpen = Math.max(0, surfaceOpen - 1)
    ensurePolling()
  }
}

/** Call once a session is established (after setSession), from the connect flow. */
export function startClubSync(): void {
  if (started) return
  started = true
  startNotePops()
  void pull().then(ensurePolling)
  unsubPlayer = subscribePlayer(onPlayerChange)
  appStateSub = AppState.addEventListener('change', onAppStateChange)
}

/** Call on sign-out / session clear. */
export function stopClubSync(): void {
  started = false
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  unsubPlayer?.()
  appStateSub?.remove()
  unsubPlayer = null
  appStateSub = null
  setActiveClub('', '')
  activeItemId = ''
  surfaceOpen = 0
  stopNotePops()
}
