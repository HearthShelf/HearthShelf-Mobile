/**
 * Note-pop watcher. Subscribes to the player position (the same 1s store tick the
 * sleep timer rides in player/store.ts) and, as playback crosses a club note's
 * timestamp, fires a toast with the note's author + body. Works screen-off during
 * playback because the Media3 foreground service keeps JS + the store tick alive
 * (no notification library involved).
 *
 * The stubs it watches are the CURRENT club book's locked stubs, fed in by
 * clubSync.ts (which polls the club). Crossing detection is core's detectNotePops:
 * a normal crossing pops each newly-passed note; a seek condenses into one
 * "passed N notes" toast so scrubbing doesn't flood. Seen stub ids persist in
 * AsyncStorage (device-local dedupe, capped 500 per club) so a note pops once.
 * Gated by the notePops device setting.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { HSNoteStub } from '@hearthshelf/core'
import { detectNotePops } from '@hearthshelf/core'
import { getState, subscribe } from './store'
import { getSettingsState } from '@/store/settings'
import { getNotes } from '@/api/notes'
import { showPopToast } from '@/social/popToastStore'
import { haptics } from '@/ui/haptics'

const SEEN_CAP = 500

interface WatchedBook {
  clubId: string
  itemId: string
  stubs: HSNoteStub[]
}

let watched: WatchedBook | null = null
let seenIds = new Set<string>()
let seenClubId = ''
let prevPos = 0
let started = false
let unsub: (() => void) | null = null

function seenKey(clubId: string): string {
  return `hs.notePops.seen.${clubId}`
}

async function loadSeen(clubId: string): Promise<void> {
  if (seenClubId === clubId) return
  seenClubId = clubId
  seenIds = new Set()
  try {
    const raw = await AsyncStorage.getItem(seenKey(clubId))
    if (raw) seenIds = new Set(JSON.parse(raw) as string[])
  } catch {
    // Storage unavailable - re-pop after this run is acceptable (documented).
  }
}

async function persistSeen(clubId: string): Promise<void> {
  // Keep only the most-recent SEEN_CAP ids (insertion order preserved by Set).
  let ids = [...seenIds]
  if (ids.length > SEEN_CAP) {
    ids = ids.slice(ids.length - SEEN_CAP)
    seenIds = new Set(ids)
  }
  try {
    await AsyncStorage.setItem(seenKey(clubId), JSON.stringify(ids))
  } catch {
    // best-effort
  }
}

/**
 * Point the watcher at a club's current book and its locked stubs. Called by
 * clubSync each time it pulls. Passing null clears the watch (left the book /
 * signed out). Loads that club's seen set on first sight.
 */
export function setPopStubs(clubId: string, itemId: string, stubs: HSNoteStub[]): void {
  watched = { clubId, itemId, stubs }
  void loadSeen(clubId)
}

export function clearPopStubs(): void {
  watched = null
}

async function onPop(stub: HSNoteStub): Promise<void> {
  if (!watched) return
  const { clubId, itemId } = watched
  // Fetch just this newly-unlocked note (created strictly after nothing, but
  // gated by our current position, which now includes it). The one note we want
  // is the one at this stub's timestamp; find it in the returned unlocked set.
  const res = await getNotes({
    libraryItemId: itemId,
    clubId,
    position: getState().position,
  })
  const note = res.notes.find((n) => n.id === stub.id)
  if (note) {
    haptics.mode()
    showPopToast(note.username || 'Someone', note.body, clubId)
  }
}

function onTick(): void {
  const { position, isPlaying, nowPlaying } = getState()
  const newPos = position
  const prev = prevPos
  prevPos = newPos

  if (!isPlaying) return
  if (!getSettingsState().notePops) return
  if (!watched || !nowPlaying) return
  // Only watch while playing the club's current book.
  if (nowPlaying.itemId !== watched.itemId) return

  const { pops, seeked } = detectNotePops(prev, newPos, watched.stubs, seenIds)
  if (pops.length === 0) return

  for (const s of pops) seenIds.add(s.id)
  void persistSeen(watched.clubId)

  if (seeked) {
    // A scrub crossed several notes at once - one condensed toast, no fetch flood.
    haptics.mode()
    showPopToast(
      'Book Club',
      `You passed ${pops.length} ${pops.length === 1 ? 'note' : 'notes'} while seeking.`,
      watched.clubId,
    )
    return
  }
  // Normal forward crossing: pop the earliest just-passed note (usually one).
  void onPop(pops[0])
}

/** Start the watcher (called once a session is established, from ConnectionProvider). */
export function startNotePops(): void {
  if (started) return
  started = true
  prevPos = getState().position
  unsub = subscribe(onTick)
}

/** Stop and reset the watcher (sign-out / session clear). */
export function stopNotePops(): void {
  started = false
  unsub?.()
  unsub = null
  watched = null
  seenIds = new Set()
  seenClubId = ''
  prevPos = 0
}
