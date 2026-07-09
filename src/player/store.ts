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
 *
 * rate/sleepBehavior seed from src/store/settings.ts (the My Settings screen's
 * Default speed / Sleep timer rows) each time a fresh track loads, so a setting
 * changed there is what the next book starts with - matching the WebApp, where
 * Settings and the player popovers read the same store.
 */
import { getSettingsState } from '@/store/settings'
import { parseHHMM } from '@/lib/timeFormat'
import { haptics } from '@/ui/haptics'
import { syncStateSeeked } from './syncState'

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
  | { kind: 'duration'; remainingSec: number; totalSec: number }
  | { kind: 'clock'; remainingSec: number; totalSec: number; atMs: number }
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
  /** True while Android Auto owns playback: the car service is the active
   *  player, the phone player stands down, and transport routes to the car.
   *  The store still reflects position/isPlaying (mirrored from the car) so the
   *  phone UI stays in sync. */
  carActive: boolean
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
  carActive: false,
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

/**
 * Load a track into the player. Starts playing by default; pass
 * `autoPlay = false` to load it paused (used when the Now Playing tab lands you
 * in the player on your last book without starting audio unbidden).
 */
export function loadTrack(track: NowPlaying, autoPlay = true): void {
  const s = getSettingsState()
  set({
    nowPlaying: track,
    isPlaying: autoPlay,
    position: track.startPosition,
    // Seed an explicit seek to the resume point. The native load position isn't
    // honored reliably, so without this playback starts at 0 and the first
    // progress tick syncs 0 back over the real position (resetting progress).
    seekTo: track.startPosition > 0 ? track.startPosition : null,
    rate: s.defaultSpeed,
    sleepBehavior: {
      rewindSec: s.sleepRewindSec,
      chapterBarrier: s.chapterBarrier,
      fade: s.sleepFade,
      fadeLen: s.sleepFadeLen,
    },
  })
  // Only arm the sleep timer when actually starting playback.
  if (autoPlay) maybeAutoArmSleep()
}

export function setPlaying(isPlaying: boolean): void {
  if (!state.nowPlaying) return
  set({ isPlaying })
  if (isPlaying) maybeAutoArmSleep()
}

/** Enter/leave car-owned playback. On enter, the phone player stands down (the
 *  PlayerHost sync stops issuing load/play to the phone service); on leave, the
 *  phone player resumes ownership of whatever's loaded. */
export function setCarActive(active: boolean): void {
  if (state.carActive !== active) set({ carActive: active })
}

/**
 * Mirror the book the car just loaded into the store so the phone UI shows the
 * same cover/title/chapters and its scrubber tracks the car. Unlike loadTrack,
 * this does NOT seed a seek or open a session - the car owns playback and its
 * own ABS session; the phone player stays stood down (carActive).
 */
export function mirrorCarTrack(track: NowPlaying): void {
  set({
    nowPlaying: track,
    position: track.startPosition,
    isPlaying: true,
    carActive: true,
    seekTo: null,
  })
}

export function togglePlay(): void {
  if (state.nowPlaying) {
    haptics.transport()
    const nowPlaying = !state.isPlaying
    set({ isPlaying: nowPlaying })
    if (nowPlaying) maybeAutoArmSleep()
  }
}

export function requestSeek(seconds: number): void {
  if (!state.nowPlaying) return
  const target = Math.max(0, seconds)
  // Optimistically move `position` so the UI (scrubber, time labels, chapter)
  // updates instantly - even while paused, where the native progress callback
  // won't fire to confirm the seek for a while. The host still applies seekTo.
  set({ seekTo: target, position: target })
  // A seek (esp. while paused) makes the server's position stale with no new
  // listened-time: mark sync dirty so the header icon goes orange and a tap can
  // push this spot. syncState is a leaf store (no deps back into here).
  syncStateSeeked(target)
}

export function jumpBy(delta: number): void {
  if (!state.nowPlaying) return
  haptics.transport()
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
  haptics.transport()
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
  haptics.transport()
  requestSeek(chapter.start)
}

// ---- playback rate ----

/** Set the playback speed (clamped 0.5x-3.0x). Persists across the session. */
export function setRate(rate: number): void {
  const clamped = Math.max(0.5, Math.min(3, rate))
  if (state.rate !== clamped) {
    haptics.select()
    set({ rate: clamped })
  }
}

// ---- sleep timer ----

/** True when `now` falls inside the [start, end) quiet-hours window. Handles the
 *  usual overnight case where end (e.g. 06:00) is earlier in the day than start
 *  (e.g. 22:00): the window then wraps past midnight. */
function inQuietHours(now: Date, startHHMM: string, endHHMM: string): boolean {
  const cur = now.getHours() * 60 + now.getMinutes()
  const s = parseHHMM(startHHMM)
  const e = parseHHMM(endHHMM)
  const start = s.h * 60 + s.m
  const end = e.h * 60 + e.m
  if (start === end) return false
  return start < end ? cur >= start && cur < end : cur >= start || cur < end
}

/**
 * Suppress auto-sleep re-arming after "On excessive shake: disable sleep" fires.
 * A shake storm inside quiet hours (phone jostling on a walk) both cancels the
 * running timer and sets this, so play entry points don't immediately re-arm a
 * new auto timer. Cleared by any manual sleep action or by leaving and re-entering
 * quiet hours (a fresh window - typically the next night), so it only mutes the
 * rest of the current window, not auto-sleep forever.
 */
let autoSleepSuppressed = false
/** Tracks the previous quiet-hours membership so we can detect the outside->inside
 *  edge that lifts autoSleepSuppressed. */
let wasInQuietHours = false

/**
 * When "Auto sleep timer" is on and playback starts during the configured quiet
 * hours, arm a duration timer of `autoSleepDur` minutes - unless one is already
 * running (manual or a prior auto-arm) or auto-sleep was suppressed by a shake
 * storm this window. Called from the play entry points.
 */
function maybeAutoArmSleep(): void {
  if (state.sleepTimer) return
  const s = getSettingsState()
  if (!s.autoSleep) return
  const inside = inQuietHours(new Date(), s.autoSleepStart, s.autoSleepEnd)
  // Re-entering quiet hours (outside -> inside) starts a fresh window, so lift a
  // prior shake-storm suppression.
  if (inside && !wasInQuietHours) autoSleepSuppressed = false
  wasInQuietHours = inside
  if (!inside) return
  if (autoSleepSuppressed) return
  const totalSec = s.autoSleepDur * 60
  set({ sleepTimer: { kind: 'duration', remainingSec: totalSec, totalSec } })
}

export function setSleepTimer(timer: SleepTimer): void {
  if (timer) haptics.mode()
  consecutiveShakeExtends = 0
  // A manual sleep action means the user is engaged; clear any shake suppression.
  autoSleepSuppressed = false
  set({ sleepTimer: timer })
}

export function cancelSleepTimer(): void {
  consecutiveShakeExtends = 0
  autoSleepSuppressed = false
  if (state.sleepTimer) set({ sleepTimer: null, volume: 1 })
}

export function setSleepBehavior(patch: Partial<SleepBehavior>): void {
  set({ sleepBehavior: { ...state.sleepBehavior, ...patch } })
}

/** Ceiling on a duration/clock timer's total length (hours), regardless of how
 *  it got there (manual extends or shake-to-extend). Prevents a runaway timer -
 *  e.g. a phone shaking in a pocket on a long walk - from silencing playback for
 *  an absurd stretch (a real report: a night walk produced a 67-hour timer). */
const MAX_SLEEP_TOTAL_SEC = 3 * 60 * 60

/** How many shake-to-extend hits in a row (no manual timer change in between)
 *  are honored before shake-to-extend stops responding for this timer session.
 *  A person shaking themselves awake does it once or twice; a phone jostling in
 *  a pocket for an hour does it dozens of times - this tells the two apart. */
const MAX_CONSECUTIVE_SHAKE_EXTENDS = 6

let consecutiveShakeExtends = 0

export type AddSleepMinutesResult = 'ok' | 'capped' | 'shake-paused' | 'shake-disabled'

/** Add minutes to a live duration/clock countdown ("+5 min" while sleeping, or a
 *  shake-to-extend hit). Grows totalSec too so the depletion ratio stays <= 1,
 *  up to MAX_SLEEP_TOTAL_SEC. When `viaShake` is set, also enforces the
 *  consecutive-shake cutoff and resets it on any non-shake call (manual +time
 *  taps go through here too, via the player UI).
 *
 *  What happens at the cutoff is the user's "On excessive shake" choice:
 *   - 'off'     never cuts off; every shake extends (3h cap is the only backstop)
 *   - 'limit'   refuse further shakes, timer keeps running ('shake-paused')
 *   - 'disable' cancel the timer AND suppress auto-sleep re-arm this quiet-hours
 *               window, so playback isn't silenced ('shake-disabled') */
export function addSleepMinutes(mins: number, viaShake = false): AddSleepMinutesResult {
  const timer = state.sleepTimer
  if (!timer || timer.kind === 'endOfChapter') return 'ok'

  if (viaShake) {
    const mode = getSettingsState().sleepShakeExcessive
    if (mode !== 'off' && consecutiveShakeExtends >= MAX_CONSECUTIVE_SHAKE_EXTENDS) {
      if (mode === 'disable') {
        // Clearly not a deliberate wake-up shake - stop the timer and don't let
        // auto-sleep immediately re-arm; the user (or the next night's window)
        // reactivates it. cancelSleepTimer would reset the flag, so set state here.
        autoSleepSuppressed = true
        consecutiveShakeExtends = 0
        set({ sleepTimer: null, volume: 1 })
        return 'shake-disabled'
      }
      return 'shake-paused'
    }
    consecutiveShakeExtends += 1
  } else {
    consecutiveShakeExtends = 0
  }

  const add = mins * 60
  const uncappedRemaining = timer.remainingSec + add
  const remainingSec = Math.min(uncappedRemaining, MAX_SLEEP_TOTAL_SEC)
  const totalSec = Math.max(timer.totalSec, remainingSec)
  set({
    sleepTimer:
      timer.kind === 'clock'
        ? { ...timer, remainingSec, totalSec, atMs: timer.atMs + (remainingSec - timer.remainingSec) * 1000 }
        : { ...timer, remainingSec, totalSec },
  })
  return uncappedRemaining > MAX_SLEEP_TOTAL_SEC ? 'capped' : 'ok'
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
      const volume =
        fade && fadeLen > 0 ? Math.max(0, Math.min(1, remaining / fadeLen)) : state.volume
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
