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
import { syncStateSeeked, syncStateLeftCar } from './syncState'
// crashLog imports only expo-file-system, so this stays a leaf dependency and
// cannot cycle back into the player.
import { breadcrumb } from '@/lib/crashLog'
import {
  notePaused,
  suppressNextRewind,
  consumeRewindOnResume,
  resetAutoRewind,
} from './autoRewind'

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
  /** True while the native engine wants to play but is stalled waiting on data
   *  (a genuine rebuffer, reported by ExoPlayer/AVPlayer - not a heuristic). */
  buffering: boolean
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
  buffering: false,
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

/**
 * Snapshot of "is a book loaded", for consumers that only care about presence.
 *
 * `getState()` returns a NEW object on every `set()`, and `set()` runs on every
 * ~1Hz position tick while audio plays. So every
 * `useSyncExternalStore(subscribe, getState)` consumer re-renders once a second
 * during playback, whether or not it reads `position` - and most do not. That
 * included useContentInset, which 54 screens call, so nearly the whole app was
 * re-rendering at 1Hz while a book played (HS-MOBILEAPP-13).
 *
 * useSyncExternalStore bails out when the snapshot is REFERENTIALLY equal to the
 * last one, so returning a stable primitive here collapses those ticks to zero
 * renders until the book actually changes. Must return a primitive (or a cached
 * object) - a fresh object literal would defeat the very check it relies on.
 */
export function getHasTrack(): boolean {
  return state.nowPlaying !== null
}

/** The loaded book's id, or null. Stable across position ticks (see
 *  getHasTrack), so consumers keyed on "which book" don't re-render at 1Hz. */
export function getTrackId(): string | null {
  return state.nowPlaying?.itemId ?? null
}

function set(patch: Partial<PlayerState>): void {
  const leftCar = state.carActive && patch.carActive === false
  state = { ...state, ...patch }
  // Release the sync indicator the moment car ownership ends, wherever that
  // happens. Both exits (leaveCar on the disconnect edge, and the onCarAbsent
  // reconcile that catches a stuck flag) funnel through here, so hooking the
  // FLAG rather than either call site means no future exit path can forget it
  // and strand the icon on 'car' - which would be the same class of bug as the
  // stuck carActive it was added to describe.
  if (leftCar) syncStateLeftCar()
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
  // A new book resumes at its own saved spot - a pause left over from the
  // previous book must not rewind it.
  resetAutoRewind()
  // Any seek we were waiting on belonged to the outgoing track; holding ticks
  // against its target would suppress the new book's progress.
  pendingSeek = null
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
  if (autoPlay) {
    expireStaleSleepTimer()
    maybeAutoArmSleep()
  }
}

/**
 * Stamp an ABS session id onto the already-loaded track.
 *
 * Used when the session is opened at first play rather than at load (see
 * playback.ensureSessionForPlayback). The book, its URL and its position are all
 * unchanged - only the id it reports under.
 *
 * Safe to publish normally: PlayerHost keys its native (re)load on the book and
 * its audio URL, not the session id, so stamping an id never re-loads the track
 * or moves the playhead.
 */
export function attachSessionId(sessionId: string): void {
  const np = state.nowPlaying
  if (!np || np.sessionId === sessionId) return
  set({ nowPlaying: { ...np, sessionId } })
}

export function setPlaying(isPlaying: boolean): void {
  if (!state.nowPlaying) return
  // A transient audio-focus duck (call, nav prompt) reaches us as an ordinary
  // pause, which is what we want: both should rewind a little on resume.
  if (!isPlaying) notePaused()
  set({ isPlaying })
  if (isPlaying) {
    expireStaleSleepTimer()
    applyAutoRewind()
    maybeAutoArmSleep()
  }
}

/**
 * Step back a few seconds on resume, scaled to how long we were paused. No-op
 * when the pause was too short to matter, the setting is off, or something else
 * already moved the position for this resume (see autoRewind.ts).
 *
 * Clamped at 0 and, like the sleep-timer rewind, kept inside the current chapter
 * so resuming can't drop you into the previous one.
 */
function applyAutoRewind(): void {
  const rewind = consumeRewindOnResume()
  if (rewind <= 0) return
  const from = state.position
  let target = Math.max(0, from - rewind)
  const ch = currentChapterAt(from)
  if (ch) target = Math.max(ch.start, target)
  if (target === from) return
  requestSeek(target)
}

/** Native rebuffer signal (see PlayerState.buffering). */
export function setBuffering(buffering: boolean): void {
  if (state.buffering !== buffering) set({ buffering })
}

/** Enter/leave car-owned playback. On enter, the phone player stands down (the
 *  PlayerHost sync stops issuing load/play to the phone service); on leave, the
 *  phone player resumes ownership of whatever's loaded.
 *
 *  NOTE: leaving the car is NOT just this flag - a car-mirrored track has no
 *  stream URL, so the phone player cannot resume it as-is. Use leaveCar() for
 *  the disconnect edge; this stays for the enter edge and for tests. */
export function setCarActive(active: boolean): void {
  if (state.carActive !== active) set({ carActive: active })
}

/**
 * The car handed playback back (USB unplugged / Auto closed).
 *
 * The car mirrors its book into the store with `url: ''` (mirrorCarTrack) - the
 * phone player can't play that, so PlayerHost's sync bails on the empty url and
 * the phone player stays stood down. If we ALSO left `isPlaying: true` (which
 * mirrorCarTrack sets, and which nothing clears when the car vanishes mid-play),
 * the UI showed a pause button over silence and every transport tap just flipped
 * a boolean that sync() never acted on - dead buttons until you reconnected.
 *
 * So on the way out we drop the optimistic playing state and report whether the
 * mirrored track needs re-resolving. The caller (PlayerHost) re-opens a real
 * session via playItemById, which is the single place that owns url/session/
 * resume resolution - we deliberately don't duplicate any of that here.
 *
 * Returns the item that needs re-resolving, or null when the loaded track is
 * already a real phone track (nothing to do - sync() resumes it normally).
 */
export function leaveCar(): { itemId: string; position: number } | null {
  const np = state.nowPlaying
  const needsResolve = !!np && !np.url
  // Always drop the mirrored "playing" intent: audio stopped when the car went
  // away, so anything else leaves the UI lying. Resuming is an explicit act.
  set({ carActive: false, isPlaying: false })
  if (!needsResolve || !np) return null
  return { itemId: np.itemId, position: state.position }
}

/**
 * Mirror the book the car just loaded into the store so the phone UI shows the
 * same cover/title/chapters and its scrubber tracks the car. Unlike loadTrack,
 * this does NOT seed a seek or open a session - the car owns playback and its
 * own ABS session; the phone player stays stood down (carActive).
 */
export function mirrorCarTrack(track: NowPlaying): void {
  // The car owns the playhead now; its mirrored positions must not be held
  // against a phone-side seek target.
  pendingSeek = null
  // The car is about to drive position ticks with isPlaying set, which is what
  // counts a duration timer down - so a leftover timer from a previous listening
  // session would fire minutes into the drive. Judge it before the ticks start.
  expireStaleSleepTimer()
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
    // A track with no url is a car mirror, not something the phone can play.
    // Toggling here would flip the button glyph while the host's sync() bails on
    // the empty url - the "play button doesn't reflect what's happening" bug.
    // Report it instead of silently lying: the handback should have re-resolved
    // this track, so reaching here means the re-arm did not take.
    if (!state.nowPlaying.url && !state.carActive) {
      onDeadTransport?.('togglePlay', `no url for ${state.nowPlaying.itemId}`)
      return
    }
    haptics.transport()
    const nowPlaying = !state.isPlaying
    if (!nowPlaying) notePaused()
    set({ isPlaying: nowPlaying })
    if (nowPlaying) {
      expireStaleSleepTimer()
      applyAutoRewind()
      maybeAutoArmSleep()
    }
  }
}

/** Reporter for transport commands that can't be acted on. Injected (rather than
 *  imported) to keep this leaf store free of a dependency back into the player
 *  bridge; PlayerHost wires it on mount. */
let onDeadTransport: ((source: string, detail: string) => void) | null = null
export function setDeadTransportReporter(fn: (source: string, detail: string) => void): void {
  onDeadTransport = fn
}

/**
 * How close a native tick must be to the seek target before we accept that the
 * seek landed. Generous enough to cover the engine reporting a moment of audio
 * past the target, tight enough that a pre-seek tick never passes.
 */
const SEEK_SETTLE_TOLERANCE_SEC = 2
/** Ceiling on how long ticks are held, so a seek that never lands can't freeze
 *  the position readout. Matches PlayerHost's own 1.5s seek transient window,
 *  plus headroom for an unbuffered region. */
const SEEK_SETTLE_TIMEOUT_MS = 4000
/** The seek we are waiting for the engine to land (see reportPosition). */
let pendingSeek: { target: number; until: number } | null = null

export function requestSeek(seconds: number): void {
  if (!state.nowPlaying) return
  const target = Math.max(0, seconds)
  // Seeking while paused picks the spot deliberately - resuming must start
  // exactly there, not a few seconds earlier. (applyAutoRewind calls this too,
  // but only after consuming the pending pause, so it can't suppress itself.)
  if (!state.isPlaying) suppressNextRewind()
  // Optimistically move `position` so the UI (scrubber, time labels, chapter)
  // updates instantly - even while paused, where the native progress callback
  // won't fire to confirm the seek for a while. The host still applies seekTo.
  set({ seekTo: target, position: target })
  // Hold native progress ticks until the engine reports back near this target,
  // so an in-flight seek can't be rolled back by a tick describing the old spot
  // (and a rapid second skip measures from where the first one put us).
  pendingSeek = { target, until: Date.now() + SEEK_SETTLE_TIMEOUT_MS }
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

/**
 * Seek to the start of the next/previous chapter (no-op without chapters).
 *
 * Returns 'finish' when next-chapter is used from inside the LAST chapter:
 * there is nowhere further to skip, so the book is done. The store can't
 * complete a book itself (that needs the progress store + queue advance, which
 * both import from here), so the caller routes that verdict to finishBook().
 * Clamping to the last chapter instead would seek BACKWARDS to its start - a
 * rewind of the whole final chapter, which then gets pushed to the server as a
 * real position via requestSeek's sync-dirty marking.
 */
export function skipChapter(direction: 1 | -1): 'seeked' | 'finish' | 'none' {
  const chapters = state.nowPlaying?.chapters
  if (!chapters || chapters.length === 0) return 'none'
  haptics.transport()
  const idx = chapters.findIndex((c) => state.position >= c.start && state.position < c.end)
  const cur = idx >= 0 ? idx : chapters.length - 1
  // Going back near the start of a chapter (>3s in) restarts it instead of skipping.
  if (direction === -1 && state.position - chapters[cur].start > 3) {
    requestSeek(chapters[cur].start)
    return 'seeked'
  }
  if (direction === 1 && cur >= chapters.length - 1) return 'finish'
  const next = Math.min(Math.max(cur + direction, 0), chapters.length - 1)
  requestSeek(chapters[next].start)
  return 'seeked'
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

// Speed the hold-to-fast-forward gesture returns to. Held here rather than in the
// player screen so an unmount mid-hold (rotation, navigation, a car handback that
// swaps the surface) can't strand playback at the boosted speed.
let rateBeforeBoost: number | null = null

/** Bump the speed by `by` for as long as the artwork is held. Idempotent: a
 *  second call while already boosted does nothing, so repeated gesture events
 *  can't stack the boost or lose the original speed. */
export function beginRateBoost(by = 1): void {
  if (rateBeforeBoost !== null) return
  rateBeforeBoost = state.rate
  haptics.transport()
  set({ rate: Math.max(0.5, Math.min(3, state.rate + by)) })
}

/** Restore the speed captured by `beginRateBoost`. Safe to call when no boost is
 *  active, so gesture cancel and end paths can both call it unconditionally. */
export function endRateBoost(): void {
  if (rateBeforeBoost === null) return
  const restore = rateBeforeBoost
  rateBeforeBoost = null
  if (state.rate !== restore) set({ rate: restore })
}

/** True while the hold-to-fast-forward boost is applied (for the player's badge). */
export function isRateBoosted(): boolean {
  return rateBeforeBoost !== null
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
 * A sleep timer belongs to ONE listening session. It only counts down while
 * audio plays, so a timer armed one evening and never finished (playback paused,
 * phone pocketed, app left backgrounded) survives in this long-lived runtime and
 * is still armed the NEXT time play starts - which can be the next day. The
 * leftover then counts down its last few minutes and fires mid-listen: rewinding
 * by rewindSec and pausing what looks like a perfectly healthy player. A field
 * report hit exactly this in the car - a timer armed the previous night fired
 * minutes into a drive 17 hours later (HS-MOBILEAPP-5).
 *
 * So a timer that has neither ticked nor been touched for this long is stale and
 * is discarded on the next play edge. maybeAutoArmSleep still runs after the
 * discard, so inside quiet hours a fresh auto timer arms for the new session.
 */
const STALE_SLEEP_TIMER_MS = 60 * 60 * 1000

/** ms epoch when the sleep timer last showed signs of life: armed, extended, or
 *  counted down a tick. Meaningless while sleepTimer is null. */
let sleepTimerTouchedAt = 0

/** Note that the live timer is current (see STALE_SLEEP_TIMER_MS). */
function touchSleepTimer(): void {
  sleepTimerTouchedAt = Date.now()
}

/** Drop a timer left over from a previous listening session (see
 *  STALE_SLEEP_TIMER_MS). Called from the play edges before auto-arm runs. */
function expireStaleSleepTimer(): void {
  if (!state.sleepTimer) return
  if (Date.now() - sleepTimerTouchedAt < STALE_SLEEP_TIMER_MS) return
  breadcrumb('player', 'discarding a stale sleep timer from a previous listening session')
  set({ sleepTimer: null, volume: 1 })
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
  touchSleepTimer()
  set({ sleepTimer: { kind: 'duration', remainingSec: totalSec, totalSec } })
}

export function setSleepTimer(timer: SleepTimer): void {
  if (timer) haptics.mode()
  consecutiveShakeExtends = 0
  // A manual sleep action means the user is engaged; clear any shake suppression.
  autoSleepSuppressed = false
  touchSleepTimer()
  set({ sleepTimer: retargetNearBoundary(timer) })
}

/**
 * Push an end-of-chapter target forward when its boundary is nearly on top of
 * us, so the timer can't stop playback within seconds of being armed.
 *
 * The arming UI only guarantees the boundary is in the FUTURE, which is true of
 * one two seconds away too. That case is easy to hit rather than exotic: it is
 * exactly where a sleep-rewind leaves you when you resume, so re-arming
 * end-of-chapter after a sleep would immediately sleep again at the same
 * boundary. Auto-sleep arms through here too and has no UI to reason about it.
 *
 * Judged on how much is left to HEAR, not on whether we slept here before - a
 * long sleep-rewind can leave a genuine stretch of chapter to listen to, and
 * that should still stop at this boundary rather than run on into the next
 * chapter.
 */
function retargetNearBoundary(timer: SleepTimer): SleepTimer {
  if (timer?.kind !== 'endOfChapter') return timer
  const chapters = state.nowPlaying?.chapters ?? []
  const boundaryOf = (i: number) => (timer.at === 'start' ? chapters[i]?.start : chapters[i]?.end)
  let idx = timer.chapterIndex
  while (
    idx + 1 < chapters.length &&
    boundaryOf(idx) !== undefined &&
    boundaryOf(idx)! - state.position < MIN_CHAPTER_REMAINING_SEC
  ) {
    idx += 1
  }
  return idx === timer.chapterIndex ? timer : { ...timer, chapterIndex: idx }
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

/** An end-of-chapter target with less than this left to play is skipped in
 *  favor of the next boundary (see retargetNearBoundary). */
const MIN_CHAPTER_REMAINING_SEC = 60

/** Stop this far BEFORE an end-of-chapter boundary.
 *
 *  On the LAST chapter that boundary is the end of the book, so firing exactly
 *  on it is a race against the engine's own end-of-media signal - and losing
 *  that race means onEnded -> finishBook() marks the book finished and starts
 *  the next one instead of sleeping. Position ticks are ~1Hz, so the engine
 *  wins often. Stopping a couple of seconds early takes the race away entirely.
 *
 *  Only applied to 'end' boundaries: a 'start' boundary is mid-book and has no
 *  completion to race, and shaving it would stop before the chapter it names. */
export const CHAPTER_END_GUARD_SEC = 2.5

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

  touchSleepTimer()
  const add = mins * 60
  const uncappedRemaining = timer.remainingSec + add
  const remainingSec = Math.min(uncappedRemaining, MAX_SLEEP_TOTAL_SEC)
  const totalSec = Math.max(timer.totalSec, remainingSec)
  set({
    sleepTimer:
      timer.kind === 'clock'
        ? {
            ...timer,
            remainingSec,
            totalSec,
            atMs: timer.atMs + (remainingSec - timer.remainingSec) * 1000,
          }
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
  // The sleep timer just rewound; don't let the resume stack a second jump on
  // top. (Start the pause clock either way so a later manual resume still knows
  // how long the book sat.)
  notePaused()
  if (target !== position) suppressNextRewind()
  set({ position: target, sleepTimer: null, isPlaying: false, volume: 1 })
  if (target !== position) requestSeek(target)
}

/** Called by the <Video> host on each progress tick. */
export function reportPosition(position: number): void {
  // Drop ticks that are still describing where we WERE while a seek is in
  // flight.
  //
  // requestSeek optimistically moves `position` to the target so the UI responds
  // instantly, but the native engine keeps emitting progress from the old spot
  // until it actually lands the seek. Those ticks used to overwrite `position`
  // straight back to the pre-seek value - and because jumpBy computes its target
  // as `state.position + delta`, a second skip tap arriving in that window
  // measured from the STALE position and landed almost where the first one did.
  // That is the "skipping has a lag and seems like it loses a button push"
  // report (HS-MOBILEAPP-Z): the tap was never lost, it was applied to a
  // position that had been rolled back underneath it.
  //
  // Held only until the engine reports a position near the target (or the window
  // lapses), so a genuine post-seek tick is never discarded.
  if (pendingSeek !== null) {
    if (Math.abs(position - pendingSeek.target) <= SEEK_SETTLE_TOLERANCE_SEC) {
      pendingSeek = null
    } else if (Date.now() < pendingSeek.until) {
      return
    } else {
      // The seek never landed (engine rejected it, or the track reloaded under
      // us). Let the engine's truth win rather than freezing the UI forever.
      //
      // Breadcrumbed because this branch is the fingerprint of the tolerance
      // being wrong rather than of a one-off engine hiccup. If skips are reported
      // as dropping taps again, a trail full of these says the hold is releasing
      // early (widen SEEK_SETTLE_TOLERANCE_SEC); a trail without them says the
      // rollback is coming from somewhere else entirely and the hold is fine.
      // Cheap: the ring collapses consecutive identical crumbs, so even a stuck
      // seek storm costs one line.
      breadcrumb(
        'player',
        `seek to ${Math.round(pendingSeek.target)}s never landed (engine at ${Math.round(position)}s)`,
      )
      pendingSeek = null
    }
  }

  const prev = state.position
  if (prev === position) return

  // Drive the sleep timer off the playback clock so it only counts while audio
  // is actually advancing (pausing the book pauses the timer for free).
  const timer = state.sleepTimer
  if (timer && state.isPlaying) {
    touchSleepTimer()
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
        const stopAt = timer.at === 'start' ? target.start : target.end - CHAPTER_END_GUARD_SEC
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
  resetAutoRewind()
  pendingSeek = null
  set({
    nowPlaying: null,
    isPlaying: false,
    buffering: false,
    position: 0,
    seekTo: null,
    sleepTimer: null,
    rate: 1,
    volume: 1,
  })
}
