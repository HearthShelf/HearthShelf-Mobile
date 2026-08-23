/**
 * Keeps the pop watcher's club-book stubs fresh, and refreshes club/notes state
 * on foreground - the club counterpart to queueSync.ts. Plain start/stop
 * functions (no hook convention in this app), called from ConnectionProvider on
 * connect and torn down on sign-out.
 *
 * What it does:
 *  - Resolves whether the currently-playing book is a club's current or queued
 *    read-ahead book. If so, fetches that book's locked stubs and feeds them to
 *    notePops.setPopStubs so the watcher can fire pops (works screen-off during
 *    playback via the foreground service).
 *  - Polls on the house 15s cadence, but ONLY while the playing book is a club
 *    book (or a notes/club surface is open) - no timer otherwise, matching the
 *    design doc's "otherwise pull on focus" rule.
 *  - Pulls on AppState 'active' (foreground), like queueSync.
 */
import { AppState, type AppStateStatus } from 'react-native'
import type { HSClubMember, HSNote, HSNoteStub } from '@hearthshelf/core'
import { getState as getPlayerState, subscribe as subscribePlayer } from './store'
import { setPopStubs, clearPopStubs, startNotePops, stopNotePops } from './notePops'
import { getClub, getClubs } from '@/api/clubs'
import { getNotes } from '@/api/notes'

const POLL_MS = 15_000

let started = false
// Whether the app is foregrounded. The 15s poll only runs while it is - see
// ensurePolling(). Assumed true at startup (we start in the foreground).
let foreground = true
let pollTimer: ReturnType<typeof setInterval> | null = null
let appStateSub: { remove: () => void } | null = null
let unsubPlayer: (() => void) | null = null
// The club whose current book is the playing item (or '' when none).
let activeClubId = ''
let activeItemId = ''
let resolveGeneration = 0

// Subscribers (e.g. the player's artwork club strip) notified when the playing
// book's club changes. Kept tiny - the useSyncExternalStore convention the app
// uses elsewhere.
const clubListeners = new Set<() => void>()
function emitClub(): void {
  clubListeners.forEach((l) => l())
}

export interface ActiveClub {
  id: string
  name: string
  memberCount: number
  members: HSClubMember[]
  notes: HSNote[]
  locked: HSNoteStub[]
  unreadCount: number
}

// getActiveClub() is read via useSyncExternalStore, which requires a STABLE
// reference between calls when nothing changed - a fresh object literal every
// call reads as "changed" on every render and infinite-loops the player
// screen. Cache it and only rebuild on a real setActiveClub() change.
let activeClub: ActiveClub | null = null
let activeClubSignature = ''

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

function setActiveClub(next: ActiveClub | null): void {
  // Club detail refreshes on a 15s cadence. Keep the external-store snapshot
  // stable when the server returned the same data or React will treat every
  // poll as a fresh state change.
  const signature = next ? JSON.stringify(next) : ''
  if (signature === activeClubSignature) return
  activeClubSignature = signature
  activeClubId = next?.id ?? ''
  activeClub = next
  emitClub()
}
// A caller (open club/notes surface) can force polling on even when the playing
// book isn't a club book. Kept as a count so nested opens balance out.
let surfaceOpen = 0

async function resolveActiveClub(): Promise<void> {
  const generation = ++resolveGeneration
  const itemId = getPlayerState().nowPlaying?.itemId ?? ''
  if (!itemId) {
    setActiveClub(null)
    activeItemId = ''
    clearPopStubs()
    return
  }
  // Prefer a club whose current book is playing, then accept an Up next book:
  // members are allowed to read ahead and the live player should keep its club
  // context when one of those books is promoted from the carousel.
  const res = await getClubs(itemId)
  if (generation !== resolveGeneration) return
  const club =
    res.mine.find((c) => c.currentBook?.libraryItemId === itemId) ??
    res.mine.find((c) => c.queuedItemIds.includes(itemId))
  if (!club) {
    setActiveClub(null)
    // Remember the resolved non-club item too, otherwise every position tick
    // retries the same lookup until another book starts.
    activeItemId = itemId
    clearPopStubs()
    return
  }
  activeItemId = itemId
  const position = getPlayerState().position

  // Publish the summary immediately when the playing club changes. On routine
  // polls, retain the last useful detail until the fresh request completes.
  if (activeClub?.id !== club.id) {
    setActiveClub({
      id: club.id,
      name: club.name,
      memberCount: club.memberCount,
      members: [],
      notes: [],
      locked: [],
      unreadCount: 0,
    })
  }

  // The club detail already contains the progress race and the gated note set,
  // so it is the single source for both the artwork strip and the pop watcher.
  const detail = await getClub(club.id, { bookId: itemId, position })
  if (generation !== resolveGeneration) return
  if (detail) {
    setActiveClub({
      id: detail.club.id,
      name: detail.club.name,
      memberCount: detail.club.memberCount,
      members: detail.members,
      notes: detail.notes.notes,
      locked: detail.notes.locked,
      unreadCount: detail.unreadCount,
    })
    setPopStubs(club.id, itemId, detail.notes.locked)
    return
  }

  // Older servers or a transient detail failure still get the existing locked
  // note behavior. Preserve cached members instead of flashing an empty race.
  const notes = await getNotes({ libraryItemId: itemId, clubId: club.id, position })
  if (generation !== resolveGeneration) return
  if (notes.enabled) {
    const previous = activeClub?.id === club.id ? activeClub : null
    setActiveClub({
      id: club.id,
      name: club.name,
      memberCount: club.memberCount,
      members: previous?.members ?? [],
      notes: notes.notes,
      locked: notes.locked,
      unreadCount: previous?.unreadCount ?? 0,
    })
    setPopStubs(club.id, itemId, notes.locked)
  }
}

async function pull(): Promise<void> {
  try {
    await resolveActiveClub()
  } catch {
    // Backend unreachable - keep whatever stubs we last had.
  }
}

/** Refresh the playing club after a player-local mutation such as a new note. */
export function refreshActiveClub(): void {
  void pull().then(ensurePolling)
}

// Poll only while there's a reason to (a club book playing, or an open surface)
// AND the app is in the foreground. A 15s poll is for keeping a visible surface
// fresh; in the background nobody is looking at it, and it kept running for as
// long as a club book stayed loaded - paused, pocketed, overnight. Backgrounding
// suspends it and the 'active' handler pulls once and restarts it, so the user
// still sees current data the moment they look.
function ensurePolling(): void {
  const shouldPoll = (activeClubId !== '' || surfaceOpen > 0) && foreground
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
  if (next === 'active') {
    foreground = true
    void pull().then(ensurePolling)
    return
  }
  // 'background' / 'inactive': stop the poll. ('inactive' is a brief iOS
  // transition - app switcher, incoming call - and stopping there too is fine
  // since coming back always fires 'active' and pulls.)
  foreground = false
  ensurePolling()
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
  // Invalidate any request that was already in flight at sign-out.
  resolveGeneration++
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  unsubPlayer?.()
  appStateSub?.remove()
  unsubPlayer = null
  appStateSub = null
  setActiveClub(null)
  activeItemId = ''
  surfaceOpen = 0
  stopNotePops()
}
