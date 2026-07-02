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
let activeItemId = ''
// A caller (open club/notes surface) can force polling on even when the playing
// book isn't a club book. Kept as a count so nested opens balance out.
let surfaceOpen = 0

async function resolveActiveClub(): Promise<void> {
  const itemId = getPlayerState().nowPlaying?.itemId ?? ''
  if (!itemId) {
    activeClubId = ''
    activeItemId = ''
    clearPopStubs()
    return
  }
  // Find a club the user is in whose CURRENT book is the playing item.
  const res = await getClubs(itemId)
  const club = res.mine.find((c) => c.currentBook?.libraryItemId === itemId)
  if (!club) {
    activeClubId = ''
    activeItemId = ''
    clearPopStubs()
    return
  }
  activeClubId = club.id
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
  activeClubId = ''
  activeItemId = ''
  surfaceOpen = 0
  stopNotePops()
}
