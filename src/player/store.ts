/**
 * Player state shared by the phone UI, the persistent <Video> host, and the
 * Android Auto / CarPlay car screens.
 *
 * react-native-video is a COMPONENT, not an imperative service, so the engine is
 * a mounted <Video> driven by this state (see PlayerHost.tsx). Everything else -
 * the home screen reads here and calls the commands. (The car surface is a
 * native MediaLibraryService with its own player, so it doesn't use this store.)
 *
 * Plain subscribe/snapshot store so it's usable from React (useSyncExternalStore)
 * and from non-React car callbacks alike, with no extra dependency.
 */

/** A chapter mark within the now-playing item (seconds, absolute in the book). */
export interface ChapterMark {
  title: string
  start: number
  end: number
}

export interface NowPlaying {
  itemId: string
  /** ABS play-session id (for progress sync / close). */
  sessionId: string
  title: string
  author: string
  artworkUrl?: string
  /** Token-bearing absolute stream URL fed to <Video>. */
  url: string
  duration: number
  /** Where to start playback (seconds) - ABS resume position. */
  startPosition: number
  /** Chapter marks for in-book navigation; empty for single-file books. */
  chapters: ChapterMark[]
}

/**
 * Sleep timer. `duration`/`clock` count down in real seconds (`remainingSec`
 * ticks off `reportPosition` while playing); `clock` also carries the absolute
 * epoch-ms deadline so the UI can show "stops at 10:30 PM" without recomputing
 * it every tick. `endOfChapter` stops at a specific chapter boundary. null = off.
 */
export type SleepTimer =
  | null
  | { kind: 'duration'; remainingSec: number }
  | { kind: 'clock'; remainingSec: number; atMs: number }
  | { kind: 'endOfChapter'; chapterIndex: number; at: 'start' | 'end' }

/** How a sleep timer behaves once it fires. Mirrors the WebApp's settings store
 *  (sleepRewindSec/chapterBarrier/sleepFade/sleepFadeLen) - in-memory only here,
 *  no persistence yet (small enough to default fresh each app launch). */
export interface SleepBehavior {
  /** Seconds to rewind on stop, 0 = resume exactly where it stopped. */
  rewindSec: number
  /** When rewinding, don't cross back over the current chapter's start. */
  chapterBarrier: boolean
  /** Ramp volume to 0 over the last `fadeLen` seconds before stopping. */
  fade: boolean
  fadeLen: number
}

export interface PlayerState {
  nowPlaying: NowPlaying | null
  isPlaying: boolean
  /** Current position in seconds (driven by <Video> onProgress). */
  position: number
  /** A seek request the <Video> host should honor once, then clear. */
  seekTo: number | null
  /** Active sleep timer, or null. */
  sleepTimer: SleepTimer
  sleepBehavior: SleepBehavior
  /** Playback speed multiplier fed to <Video rate> (1 = normal). */
  rate: number
  /** Output volume fed to <Video volume>, 0-1. Ramped down by the sleep fade. */
  volume: number
}

let state: PlayerState = {
  nowPlaying: null,
  isPlaying: false,
  position: 0,
  seekTo: null,
  sleepTimer: null,
  sleepBehavior: { rewindSec: 30, chapterBarrier: true, fade: true, fadeLen: 20 },
  rate: 1,
  volume: 1,
}

const listeners = new Set<() => void>()

export function getState(): PlayerState {
  return state
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function set(patch: Partial<PlayerState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

// ---- commands (called from phone UI and car callbacks) ----

export function loadTrack(track: NowPlaying): void {
  set({
    nowPlaying: track,
    isPlaying: true,
    position: track.startPosition,
    seekTo: null,
  })
}

export function setPlaying(isPlaying: boolean): void {
  if (state.nowPlaying) set({ isPlaying })
}

export function togglePlay(): void {
  if (state.nowPlaying) set({ isPlaying: !state.isPlaying })
}

export function requestSeek(seconds: number): void {
  if (state.nowPlaying) set({ seekTo: Math.max(0, seconds) })
}

export function jumpBy(delta: number): void {
  if (!state.nowPlaying) return
  requestSeek(state.position + delta)
}

// ---- chapter navigation ----

/** The chapter containing `position`, or null if the item has no chapters. */
export function currentChapter(): ChapterMark | null {
  const chapters = state.nowPlaying?.chapters
  if (!chapters || chapters.length === 0) return null
  const pos = state.position
  return chapters.find((c) => pos >= c.start && pos < c.end) ?? chapters[chapters.length - 1]
}

/** Seek to the start of the next/previous chapter (no-op without chapters). */
export function skipChapter(direction: 1 | -1): void {
  const chapters = state.nowPlaying?.chapters
  if (!chapters || chapters.length === 0) return
  const idx = chapters.findIndex((c) => state.position >= c.start && state.position < c.end)
  const cur = idx >= 0 ? idx : chapters.length - 1
  // Going back near the start of a chapter (>3s in) restarts it instead of skipping.
  if (direction === -1 && state.position - chapters[cur].start > 3) {
    requestSeek(chapters[cur].start)
    return
  }
  const next = Math.min(Math.max(cur + direction, 0), chapters.length - 1)
  requestSeek(chapters[next].start)
}

export function seekToChapter(chapter: ChapterMark): void {
  requestSeek(chapter.start)
}

// ---- playback rate ----

/** Set the playback speed (clamped 0.5x-3.0x). Persists across the session. */
export function setRate(rate: number): void {
  const clamped = Math.max(0.5, Math.min(3, rate))
  if (state.rate !== clamped) set({ rate: clamped })
}

// ---- sleep timer ----

export function setSleepTimer(timer: SleepTimer): void {
  set({ sleepTimer: timer })
}

export function cancelSleepTimer(): void {
  if (state.sleepTimer) set({ sleepTimer: null, volume: 1 })
}

export function setSleepBehavior(patch: Partial<SleepBehavior>): void {
  set({ sleepBehavior: { ...state.sleepBehavior, ...patch } })
}

/** Add minutes to a live duration/clock countdown ("+5 min" while sleeping). */
export function addSleepMinutes(mins: number): void {
  const timer = state.sleepTimer
  if (!timer || timer.kind === 'endOfChapter') return
  set({ sleepTimer: { ...timer, remainingSec: timer.remainingSec + mins * 60 } })
}

/**
 * The stop sequence when a sleep timer fires: optionally rewind (clamped to the
 * current chapter's start when chapterBarrier is on), pause, and restore full
 * volume so the next play isn't left faded down from a previous sleep.
 */
function fireStop(position: number): void {
  const { rewindSec, chapterBarrier } = state.sleepBehavior
  let target = position
  if (rewindSec > 0) {
    target = Math.max(0, position - rewindSec)
    if (chapterBarrier) {
      const ch = currentChapterAt(position)
      if (ch) target = Math.max(ch.start, target)
    }
  }
  set({ position: target, sleepTimer: null, isPlaying: false, volume: 1 })
  if (target !== position) requestSeek(target)
}

/** Called by the <Video> host on each progress tick. */
export function reportPosition(position: number): void {
  const prev = state.position
  if (prev === position) return

  // Drive the sleep timer off the playback clock so it only counts while audio
  // is actually advancing (pausing the book pauses the timer for free).
  const timer = state.sleepTimer
  if (timer && state.isPlaying) {
    if (timer.kind === 'duration' || timer.kind === 'clock') {
      const elapsed = Math.max(0, position - prev)
      const remaining = timer.remainingSec - elapsed
      if (remaining <= 0) {
        fireStop(position)
        return
      }
      const { fade, fadeLen } = state.sleepBehavior
      const volume = fade && fadeLen > 0 ? Math.max(0, Math.min(1, remaining / fadeLen)) : state.volume
      set({ position, sleepTimer: { ...timer, remainingSec: remaining }, volume })
      return
    }
    if (timer.kind === 'endOfChapter') {
      const chapters = state.nowPlaying?.chapters ?? []
      const target = chapters[timer.chapterIndex]
      if (target) {
        const stopAt = timer.at === 'start' ? target.start : target.end
        if (position >= stopAt) {
          fireStop(position)
          return
        }
      }
    }
  }

  set({ position })
}

/** Internal: chapter containing an arbitrary position (used by the sleep tick). */
function currentChapterAt(position: number): ChapterMark | null {
  const chapters = state.nowPlaying?.chapters
  if (!chapters || chapters.length === 0) return null
  return chapters.find((c) => position >= c.start && position < c.end) ?? null
}

/** Called by the host once it has applied a seek. */
export function clearSeek(): void {
  if (state.seekTo !== null) set({ seekTo: null })
}

export function clearTrack(): void {
  set({
    nowPlaying: null,
    isPlaying: false,
    position: 0,
    seekTo: null,
    sleepTimer: null,
    rate: 1,
    volume: 1,
  })
}
