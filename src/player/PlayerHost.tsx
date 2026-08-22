/**
 * The persistent audio engine bridge. Instead of rendering a react-native-video
 * <Video>, this drives a native Media3 ExoPlayer (HearthShelfPlayerService) that
 * owns the phone MediaSession - so WE control the lock-screen / Android Auto
 * chapter-relative progress and the custom circular skip icons, which rn-video
 * could not do.
 *
 * The JS store stays the single source of truth: this component pushes store
 * changes down to the native player (load/play/pause/seek/rate/volume) and feeds
 * native progress/state events back into the store (reportPosition + syncProgress,
 * setPlaying) - the exact same store calls the old <Video> onProgress made, so no
 * player-UI screen changes.
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import {
  AppState,
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native'
import {
  getState,
  subscribe,
  reportPosition,
  clearSeek,
  setPlaying,
  setBuffering,
  jumpBy,
  togglePlay,
  setCarActive,
  leaveCar,
  mirrorCarTrack,
  setRate,
  currentChapter,
  setDeadTransportReporter,
} from './store'
import { breadcrumb } from '@/lib/crashLog'
import {
  reportCarHandbackFailure,
  reportDeadTransport,
  reportPlaybackLost,
} from './carHandbackReport'
import { coverUrl } from '@/api/abs'
import { addBookmarkPending } from './pendingBookmarks'
import { localCoverFor } from './downloads'
import { handOffToCar, playItemById, syncProgress, ensureSessionForPlayback } from './playback'
import { getMemoryStats, loadAutoCarBook, syncAutoCarState } from './autoBridge'
import { advanceQueueOnEnd, skipChapterOrFinish } from './advance'
import { useShakeToExtend } from './shakeToExtend'
import { useSleepBeep } from './sleepBeep'
import { Toast, useToast, showToast } from '@/ui/Toast'

// Native module (added in HearthShelfAutoModule / HearthShelfPlayerService).
// Typed loosely - it's a thin old-arch bridge.
interface HSPlayer {
  load(
    url: string,
    startSec: number,
    title: string,
    author: string,
    artworkUri: string,
    chaptersJson: string,
    autoPlay: boolean,
  ): void
  play(): void
  pause(): void
  seekTo(sec: number): void
  setRate(rate: number): void
  setVolume(volume: number): void
  stop(): void
  /** Stops the phone player specifically - stop() follows car ownership. */
  stopPhonePlayer(): void
}
const Native = NativeModules.HearthShelfAuto as HSPlayer | undefined

/** How long to wait after a reclaim recovery before judging whether audio
 *  actually resumed. A reclaimed service has to be recreated and the track
 *  re-buffered from scratch, so this is deliberately generous - a false "did not
 *  recover" would be worse than a late report. */
const RECLAIM_CONFIRM_MS = 6000

/** How long a reclaim recovery is allowed to keep retrying before we stop
 *  re-arming it. See the RECLAIM_MAX_ATTEMPTS comment. */
const RECLAIM_WINDOW_MS = 30_000

/** How many reclaim recoveries may run inside RECLAIM_WINDOW_MS.
 *
 *  A reclaim recovery re-runs sync(), and sync() can call Native.play() again -
 *  so if the play lands somewhere that has no player to act on, native answers
 *  with another onPlaybackLost and the two bounce off each other with nothing
 *  in between to slow them down. That is not hypothetical: a field report
 *  (HS-MOBILEAPP-1N) carried `native lost the track; reloading from store
 *  (x4562)` in its breadcrumb tail, logged over seconds, with the audio dead
 *  the whole time and the phone spinning in a hot loop.
 *
 *  A genuine reclaim is a rare, isolated event - the OS reclaimed the service
 *  once and we put it back. Several within seconds means the recovery itself is
 *  not landing, and repeating it a thousand more times will not change that. So
 *  the recovery is allowed a few honest retries and then stands down, leaving
 *  the failure to be reported once rather than burning the battery. */
const RECLAIM_MAX_ATTEMPTS = 3

/** How far the position must move before we count it as real playback rather
 *  than the tail of a tick that was already in flight. */
const RECLAIM_PROGRESS_EPSILON_SEC = 2

/** How late the reclaim probe may run and still be trusted to judge recovery.
 *
 *  Android suspends JS timers for a backgrounded app, so an armed probe can
 *  fire long after its delay - see the note where the verdict is computed. */
const RECLAIM_PROBE_MAX_LATE_MS = 60_000

/** How long the store may claim to be playing with no onProgress before the
 *  watchdog calls it a stall.
 *
 *  Progress ticks arrive about once a second while audio runs, so this is many
 *  missed ticks rather than a narrow race. It is deliberately generous: a false
 *  positive reloads the track under a listener who was fine, which is worse than
 *  noticing a real stall a few seconds later. */
const STALL_AFTER_MS = 20_000

/** How often the watchdog checks. Coarse on purpose - this runs for the whole
 *  time a book is playing, and the thing it watches for is measured in tens of
 *  seconds. */
const STALL_CHECK_MS = 5000

/**
 * Hand the store's current book to the car player.
 *
 * The car connects with an EMPTY player and only JS knows which book the listener
 * is on and where they are in it, so every route that discovers the car has
 * nothing to play funnels here: the takeover edge, a play/load that native
 * bounced back as onCarNeedsBook, and a book switched on the phone mid-drive.
 *
 * `held` is what we believe the car holds, so a book already there isn't pushed
 * again. It is set from onCarLoaded (the car's own answer) and optimistically
 * here, since the load is asynchronous and several of these routes can fire
 * within a few hundred ms of each other.
 */
function handBookToCar(held: MutableRefObject<string | null>): void {
  const s = getState()
  const np = s.nowPlaying
  if (!np?.itemId || held.current === np.itemId) return
  held.current = np.itemId
  breadcrumb('car', `hand ${np.itemId} to the car @${Math.round(s.position)}s`)
  loadAutoCarBook(np.itemId, s.position)
}

export function PlayerHost() {
  // Track what we last pushed so store ticks don't re-issue identical commands.
  const loadedKey = useRef<string | null>(null)
  const lastPlaying = useRef<boolean | null>(null)
  const lastRate = useRef<number | null>(null)
  const lastVolume = useRef<number | null>(null)
  // Timestamp (ms) until which onState events are treated as seek transients and
  // ignored, so a skip doesn't bounce the play/pause intent.
  const seekingUntil = useRef(0)
  // The store->native reconciler, published so native event handlers (which live
  // in an earlier effect) can re-run it without waiting for a store change.
  const syncNative = useRef<(() => void) | null>(null)
  // Which book loadedKey last referred to. Distinguishes "reloading the book that
  // is already playing" (resume at the live playhead) from "switching books"
  // (resume at the new track's own start position).
  const loadedItem = useRef<string | null>(null)
  // Pending "did the reclaim recovery actually produce audio" check.
  const reclaimProbe = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Timestamp (ms) until which onState isPlaying=false is treated as the dying
  // player's stop echo and ignored (see the onPlaybackLost handler).
  const reclaimIgnorePauseUntil = useRef(0)
  // Reclaim recovery attempts inside the current window, and when that window
  // opened. Together these stop a reclaim/play bounce from spinning forever
  // (see RECLAIM_MAX_ATTEMPTS).
  const reclaimAttempts = useRef(0)
  const reclaimWindowStart = useRef(0)
  // When onProgress last arrived. 0 means "nothing yet this run"; the watchdog
  // seeds it on the play edge so a book that never produces a single tick still
  // trips the stall check.
  const lastProgressAt = useRef(0)
  // The book we believe the CAR player holds (see handBookToCar). null means the
  // car has nothing loaded, which is how it always connects.
  const carBook = useRef<string | null>(null)

  // Shake-to-extend the sleep timer. Mounted here (the one persistent host) so
  // it can fire a confirmation toast in component context.
  const toast = useToast()
  useShakeToExtend(
    (mins) => toast.show(`+${mins} min added`),
    (reason) =>
      toast.show(
        reason === 'disabled'
          ? 'Too many shakes - sleep timer ended'
          : 'Shake to extend paused - too many shakes in a row',
      ),
  )

  // Warning beeps before the sleep timer ends. Pushes prefs to the native service
  // on Android; plays the cue from JS via expo-audio on iOS.
  useSleepBeep()

  // Android 13+ needs runtime POST_NOTIFICATIONS or the media notification never
  // shows. Ask once on mount (no-op below API 33 / on iOS).
  useEffect(() => {
    if (Platform.OS !== 'android' || Platform.Version < 33) return
    void PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(
      () => {},
    )
  }, [])

  // Let the store report transport taps it can't act on (see setDeadTransportReporter).
  useEffect(() => {
    setDeadTransportReporter(reportDeadTransport)
  }, [])

  // The recovery run when the native player is no longer producing audio.
  //
  // `cause` says how we found out:
  //   'native' - the service told us (a transport command hit a reclaimed
  //              service, or ExoPlayer raised a recoverable source error).
  //   'stall'  - nobody told us. The progress watchdog below noticed that the
  //              store says playing while onProgress has gone silent.
  //
  // One implementation shared by the native listener (registered once, on mount)
  // and the watchdog effect - which means ONE attempt cap. Two independent
  // recovery paths racing the same player is exactly the bounce that
  // RECLAIM_MAX_ATTEMPTS exists to stop.
  //
  // Stable identity (empty deps): it reads live state via getState() and refs
  // rather than closing over render values, so the mount-once listener effect
  // can capture it safely.
  const recoverLostPlayback = useCallback((cause: 'native' | 'stall') => {
    const now = Date.now()
    // Open a fresh window if the last reclaim is old enough that this one is
    // a genuinely new incident rather than the same bounce continuing.
    if (now - reclaimWindowStart.current > RECLAIM_WINDOW_MS) {
      reclaimWindowStart.current = now
      reclaimAttempts.current = 0
    }
    reclaimAttempts.current += 1
    if (reclaimAttempts.current > RECLAIM_MAX_ATTEMPTS) {
      // Stand down rather than re-arm into the same bounce. Drop the playing
      // intent so the UI stops claiming it is playing over silence, and so
      // sync() has no play edge left to re-issue - that intent is what native
      // keeps answering with onPlaybackLost.
      breadcrumb(
        'player',
        `${cause === 'stall' ? 'playback stalled' : 'native lost the track'} ${reclaimAttempts.current}x; giving up on reload`,
      )
      lastPlaying.current = false
      setPlaying(false)
      showToast('Playback stopped. Tap play to start again.')
      return
    }
    const s = getState()
    // While the car owns playback there is no phone player to rebuild: the
    // sync() below stands the phone down and forwards transport to the car
    // instead, so "reload from store" cannot reach the thing that was lost.
    // Re-arming here just re-issues play() at a player that answers with
    // another onPlaybackLost - the bounce this guard exists to stop. The
    // car has its own empty-player recovery (onCarNeedsBook).
    if (s.carActive) {
      breadcrumb(
        'player',
        `${cause === 'stall' ? 'playback stalled' : 'native lost the track'} while the car owns playback; ignoring`,
      )
      return
    }
    breadcrumb(
      'player',
      `${cause === 'stall' ? 'playback stalled (no progress while playing)' : 'native lost the track'}; reloading from store`,
    )
    loadedKey.current = null
    lastPlaying.current = null
    // While the reload buffers, ignore paused states from the old player's
    // teardown so they can't cancel the re-armed play intent (see onState).
    // Same span as the probe: a genuine failure still reports after it.
    reclaimIgnorePauseUntil.current = now + RECLAIM_CONFIRM_MS
    // Re-run the store->native effect now rather than waiting for the next
    // store change; without a nudge, a stable store would leave it unloaded.
    syncNative.current?.()

    // Report the outcome, not just the event.
    //
    // The reclaim is expected; what we cannot see from in here is whether the
    // reload actually produced audio. A memory-pressure reclaim is not
    // reproducible in Metro, so the field is the only place this fix gets
    // tested - and a user staring at a still-dead play button generates no
    // event of any kind unless we make one.
    //
    // Confirmation is "did a real playing state arrive after the reload":
    // onState fires from the engine, so receiving isPlaying=true means audio
    // genuinely started, not merely that we re-issued the command. The window
    // is generous because a reclaimed service must be recreated and the track
    // re-buffered from scratch.
    //
    // Both outcomes are breadcrumbed; only a FAILED recovery raises a Sentry
    // event (see reportPlaybackLost).
    if (reclaimProbe.current) clearTimeout(reclaimProbe.current)
    const wantedPlaying = s.isPlaying
    const probeArmedAt = now
    const positionAtLoss = s.position
    reclaimProbe.current = setTimeout(() => {
      reclaimProbe.current = null
      const after = getState()
      // Android FREEZES JS timers while the app is backgrounded, so this
      // callback does not reliably run RECLAIM_CONFIRM_MS after it was armed -
      // it runs whenever the runtime is next scheduled, which can be half an
      // hour later. By then the store describes some unrelated later moment
      // (the listener finished and paused, or moved on), and judging the
      // recovery on it reports a failure that never happened. A real field
      // event did exactly that: playingAfter=false, yet the position had
      // advanced 1798s between loss and report - thirty minutes of audio that
      // demonstrably played, inside a "6 second" window (HS-MOBILEAPP-2).
      //
      // Position movement is the ground truth here, and it is the ONE signal
      // that cannot lie: only onProgress advances it, and onProgress only fires
      // when the engine is actually decoding. So treat any real advance as
      // proof the reload took, whatever the current isPlaying says.
      const advanced = after.position - positionAtLoss > RECLAIM_PROGRESS_EPSILON_SEC
      const lateBy = Date.now() - probeArmedAt
      if (lateBy > RECLAIM_PROBE_MAX_LATE_MS && !advanced) {
        // Ran far too late AND has no movement to judge on - the store has
        // moved on and there is nothing trustworthy left to measure. Say so
        // rather than guessing; a wrong "did not recover" trains us to ignore
        // the very signal this probe exists to provide.
        breadcrumb(
          'player',
          `reclaim probe ran ${Math.round(lateBy / 1000)}s late with no movement; verdict withheld`,
        )
        return
      }
      // Only judge it a failure when the user actually wanted audio. If they
      // hit play and we are still not playing, the reload did not take.
      const recovered = !wantedPlaying || after.isPlaying || advanced
      reportPlaybackLost(recovered, {
        cause,
        itemId: s.nowPlaying?.itemId ?? null,
        wantedPlaying,
        playingAfter: after.isPlaying,
        positionAtLoss: Math.round(positionAtLoss),
        positionAfter: Math.round(after.position),
        // How long the probe actually took to run. Anything far above
        // RECLAIM_CONFIRM_MS means the runtime was suspended in between, which
        // changes how much the other fields are worth trusting.
        probeLateBySec: Math.round(lateBy / 1000),
        // A file:// source rules out an expired stream token as the cause of
        // a failed reload, which is the first thing to suspect otherwise.
        localSource: !!s.nowPlaying?.url?.startsWith('file://'),
      })
    }, RECLAIM_CONFIRM_MS)
  }, [])

  // ---- native -> store: progress / state / ended ----
  useEffect(() => {
    if (!Native) return
    const emitter = new NativeEventEmitter(NativeModules.HearthShelfAuto)
    const subs = [
      emitter.addListener('onProgress', (e: { position: number }) => {
        // Liveness stamp for the stall watchdog: this listener is the ONLY thing
        // that advances the store's position, so its silence is exactly what a
        // stalled engine looks like from JS.
        lastProgressAt.current = Date.now()
        reportPosition(e.position)
        // While the car owns playback it does its own ABS progress sync (with its
        // own session). Running JS sync too would double-post to two sessions, so
        // only drive the on-screen position here.
        //
        // Sync the position the STORE settled on, not the raw tick: reportPosition
        // drops ticks that still describe the pre-seek spot while a seek is in
        // flight, and pushing the raw value here would send that stale position to
        // ABS (and accrue listened-time for a stretch that was skipped past)
        // exactly when the store had just refused it.
        if (!getState().carActive) syncProgress(getState().position)
      }),
      emitter.addListener('onState', (e: { isPlaying: boolean }) => {
        // Ignore the brief play/pause ExoPlayer emits while it re-buffers a
        // JS-initiated seek (the native seekToSec preserves playWhenReady, so the
        // engine keeps playing; this just stops the transient from flipping our
        // intent and echoing a pause back). Genuine external transport (lock
        // screen) still comes through once the seek window closes.
        if (Date.now() < seekingUntil.current) return
        // A reclaim reload is in flight: the reclaimed player's teardown surfaces
        // as an ordinary isPlaying=false, and adopting it would overwrite the
        // play intent the reload was issued with - the store flips to paused, the
        // probe below then judges the recovery failed, and the user is left
        // tapping play a second time ("reload did not take", HS-MOBILEAPP-2/4).
        // Hold false states until the window closes; a true state is the real
        // recovery confirmation and ends the window itself.
        if (!e.isPlaying && Date.now() < reclaimIgnorePauseUntil.current) return
        if (e.isPlaying) reclaimIgnorePauseUntil.current = 0
        // Keep our "last pushed" marker in step so the store update below doesn't
        // make sync() re-issue the very command native just reported.
        lastPlaying.current = e.isPlaying
        setPlaying(e.isPlaying)
        // On pause/stop (incl. the sleep timer stopping playback), flush a final
        // sync so the server has the real stop point and Recent listens is fresh.
        // The car does its own final sync on pause, so skip it while car-active.
        if (!e.isPlaying && !getState().carActive) void syncProgress(getState().position, true)
      }),
      // Real engine rebuffer state (ExoPlayer STATE_BUFFERING / AVPlayer
      // waitingToPlayAtSpecifiedRate) - drives the ring around the play button.
      emitter.addListener('onBuffering', (e: { buffering: boolean }) => {
        setBuffering(e.buffering)
      }),
      // Native transport (lock screen / car) routes back through the store so it
      // stays the source of truth.
      emitter.addListener('onTogglePlay', () => togglePlay()),
      emitter.addListener('onJump', (e: { delta: number }) => jumpBy(e.delta)),
      // Book ended: advance to the head of the (server-owned) up-next queue.
      emitter.addListener('onEnded', () => {
        void advanceQueueOnEnd().catch(() => {})
      }),
      // We asked the native service to play, but it no longer holds the track -
      // the OS reclaimed it under memory pressure while the app sat backgrounded.
      //
      // Nothing throws in that situation: the module's play() lands on a null
      // instance (or an ExoPlayer with no media items) and returns silently. JS
      // meanwhile still believes the book is loaded, because loadedKey is keyed on
      // itemId:url and neither changed - so sync() never reloads and every
      // subsequent tap is swallowed too. That is the "paused, then clicked play,
      // doesn't play or load to play" report (HS-MOBILEAPP-Y).
      //
      // Recovery is to forget what we think is loaded and let sync() rebuild the
      // track from the store, at the position the store already holds. Clearing
      // lastPlaying too means the isPlaying we still have set will be re-pushed as
      // a fresh play edge once the reload completes, so the user's tap is honored
      // rather than needing a second one.
      emitter.addListener('onPlaybackLost', () => recoverLostPlayback('native')),
      // Native playback failed (expired stream token, network stall, unplayable
      // format). Drop the optimistic playing state so the UI stops showing
      // "playing" over silence, and surface the reason. Sync the lastPlaying
      // marker so the store->native effect doesn't immediately re-issue play().
      emitter.addListener('onError', (e: { message: string }) => {
        lastPlaying.current = false
        setPlaying(false)
        showToast(e.message || 'Playback failed')
      }),
      // Android Auto took over (or handed back) playback. While active the phone
      // player stands down and transport routes to the car (native side); the
      // store still mirrors car position/state so the phone UI stays in sync.
      emitter.addListener('onCarActive', (e: { active: boolean }) => {
        if (!e.active) {
          // ---- The car handed playback back (USB unplug / Auto closed). ----
          //
          // This edge used to be flag-only, which stranded playback: the car
          // mirrors its book with url:'' and isPlaying:true, so after the car
          // vanished the phone player stayed stood down (sync() bails on the
          // empty url) while the UI still showed PLAYING. Transport taps only
          // flipped the store boolean, so pause/play did nothing and the only
          // recovery was plugging back in.
          //
          // leaveCar() drops the stale playing intent and tells us whether the
          // loaded track is a car mirror that needs a real url/session. If it
          // is, re-resolve through playItemById - the one place that owns
          // session, resume position and offline/downloaded resolution - at the
          // live mirrored position, loaded PAUSED. Paused is deliberate: the
          // audio already stopped when the car went away, so resuming on its own
          // would start a book playing at someone who just unplugged and walked
          // off. The play button now maps to a real loaded player.
          const resume = leaveCar()
          // Whatever the car held went away with it; the next takeover starts from
          // an empty player and has to be handed a book again.
          carBook.current = null
          breadcrumb(
            'car',
            `handback${resume ? ` re-resolve ${resume.itemId} @${Math.round(resume.position)}s` : ' (phone track already loaded)'}`,
          )
          // The mirrored track's position is the only record of where the car
          // got to; hand it to the LOAD so the track resolves there rather than
          // at the server's last synced spot.
          //
          // This used to seek after the load instead, which lost twice over: the
          // track still loaded at the stale saved position (the phone's
          // media-progress row froze at the handoff, so it was behind by the
          // whole drive), and the seek then raced that fresh load. When the seek
          // lost the race it left a pendingSeek that swallowed every position
          // tick until it timed out - a listener re-loaded two hours behind with
          // a scrubber that would not move (HS-MOBILEAPP-A).
          if (resume && Platform.OS === 'android') {
            void playItemById(resume.itemId, false, { resumeAt: resume.position }).catch((err) => {
              breadcrumb('car', `handback re-resolve failed: ${err?.message ?? 'unknown'}`)
              reportCarHandbackFailure(resume.itemId, err)
              showToast('Tap play to resume on your phone')
            })
          }
          return
        }
        // Set the flag FIRST so the phone player stands down (stops issuing
        // load/play below) before we touch the car.
        setCarActive(e.active)
        if (Platform.OS !== 'android') return

        // The car connects with an EMPTY player - without a book loaded, Android
        // Auto auto-plays the browse tree's first item (the up-next queue head)
        // instead of resuming what the phone was playing. So on takeover:
        //   1. Flush + close the phone's ABS session, so its stale currentTime
        //      can't later overwrite the car, and its listened-time lands.
        //   2. Hand the car the current book + the phone's LIVE position, so it
        //      resumes exactly where the phone was (not the server's last sync).
        // handOffToCar() awaits a network close; carActive is already true, so the
        // now-gated progress ticks won't re-open a session or move `position`
        // across the await - the book and spot handed over after it are the same
        // ones we would have captured before.
        //
        // Nothing loaded at this instant is NOT the end of it: on a launch into an
        // already-connected car there is no book yet, and the old edge-only handoff
        // simply gave up, leaving the car empty for the rest of the drive (every
        // later tap then hit an empty player - HS-MOBILEAPP-19). handBookToCar is
        // re-run from onCarNeedsBook and from the sync below, so the book still
        // reaches the car whenever the listener picks one.
        void handOffToCar()
          .catch(() => {})
          .finally(() => handBookToCar(carBook))
      }),
      // Native bounced a transport command back: the car owns playback but its
      // player is empty, so there was nothing for that command to act on. Answer
      // with the book the store holds (see handBookToCar / emitCarNeedsBook).
      // Native answered syncCarState with "no car is attached".
      //
      // Only meaningful when JS currently believes otherwise. carActive can get
      // stuck true: swapping from USB Android Auto to Bluetooth earbuds can route
      // audio away without gearhead's controller disconnecting, so onDisconnected
      // never fires. The phone player then stays stood down forever - pause taps
      // forward to a car that isn't there (the UI flips to paused while audio
      // keeps running), the "playing in car" banner sticks, and the reclaim
      // recovery suppresses itself with "native lost the track while the car owns
      // playback" (HS-MOBILEAPP-W/X).
      //
      // Deliberately NOT routed through the onCarActive(false) handback: that
      // means "the car handed back", and pauses + re-resolves the track. Here the
      // audio never stopped and nothing about the book changed - only our belief
      // was wrong. So just clear the flag and let sync() resume driving the phone
      // player, which is where the audio already is.
      emitter.addListener('onCarAbsent', () => {
        if (!getState().carActive) return
        breadcrumb('car', 'no car attached but carActive was set; clearing stale car ownership')
        carBook.current = null
        setCarActive(false)
        // The phone player has been stood down while this was wrong, so its
        // loaded-track markers describe a player that is no longer driving. Drop
        // them and let sync() rebuild from the store at the live position.
        loadedKey.current = null
        lastPlaying.current = null
        syncNative.current?.()
      }),
      emitter.addListener('onCarNeedsBook', () => {
        breadcrumb('car', 'car player is empty; handing it the loaded book')
        // This event is native telling us the car's player is EMPTY, so whatever
        // we believed it was holding is wrong. Clearing first matters: handoff
        // sets `carBook` optimistically, and a load that never completed (a
        // second push arriving mid-load is dropped by the service's own guard,
        // with no failure event) would otherwise leave the belief stuck on a
        // book the car doesn't have - and handBookToCar would then no-op
        // forever, leaving a permanently dead play button that only tapping the
        // book on the car screen could clear.
        carBook.current = null
        handBookToCar(carBook)
      }),
      // The handover didn't take (couldn't resolve the book - no session, no
      // network, not downloaded). Forget that we handed it over so the next tap
      // tries again, and say so rather than leaving a dead play button.
      emitter.addListener('onCarLoadFailed', () => {
        breadcrumb('car', `car could not load ${carBook.current ?? 'the book'}`)
        carBook.current = null
        showToast("Couldn't start that book in the car")
      }),
      // The car loaded a book: mirror it into the store so the phone UI shows the
      // same cover/title/chapters and its scrubber tracks the car.
      emitter.addListener(
        'onCarLoaded',
        (e: {
          itemId: string
          title: string
          author: string
          artworkUri: string
          duration: number
          position: number
          chapters: string
        }) => {
          let chapters: { title: string; start: number; end: number }[] = []
          try {
            chapters = JSON.parse(e.chapters || '[]')
          } catch {
            chapters = []
          }
          // The car's own answer to "what are you holding", so the pushes below
          // stop once it has the book.
          carBook.current = e.itemId
          mirrorCarTrack({
            itemId: e.itemId,
            sessionId: '',
            title: e.title,
            author: e.author,
            // Prefer the downloaded cover: the server URL renders nothing when
            // the car loaded this book with no network.
            artworkUrl: localCoverFor(e.itemId) ?? coverUrl(e.itemId),
            url: '',
            duration: e.duration,
            startPosition: e.position,
            chapters,
          })
        },
      ),
      // ---- CarPlay (iOS): the car and phone share ONE native AVPlayer, so
      // instead of a separate car player + mirror (Android's model), a CarPlay
      // browse tap routes UP to JS here. playItemById() is the single place that
      // owns the ABS session, resume position, offline/downloaded resolution, and
      // the store - so a book started from the car behaves exactly like one
      // started from the phone (right resume, no progress reset, offline files,
      // local cover art), and the store holds the correct now-playing book.
      emitter.addListener('onCarPlayRequest', (e: { itemId: string }) => {
        void playItemById(e.itemId).catch((err) => {
          showToast(
            err?.message === 'not_downloaded'
              ? 'This book is not downloaded'
              : 'Could not play this book',
          )
        })
      }),
      // CarPlay now-playing buttons (speed / chapter / bookmark) route through the
      // same store commands the phone player uses, so behavior is identical.
      emitter.addListener('onCarRateCycle', () => {
        const presets = [1, 1.25, 1.5, 1.75, 2, 0.75]
        const cur = getState().rate
        const next = presets.find((p) => p > cur + 0.001) ?? presets[0]
        setRate(next)
      }),
      emitter.addListener('onCarChapter', (e: { direction: number }) => {
        skipChapterOrFinish(e.direction >= 0 ? 1 : -1)
      }),
      emitter.addListener('onCarBookmark', () => {
        const s = getState()
        if (!s.nowPlaying) return
        const ch = currentChapter()
        const title = ch?.title || 'Bookmark'
        // Write-ahead through the pending store: bookmarking in the car is the
        // likeliest place to be out of signal, and this never throws - an
        // unconfirmed bookmark is banked and flushed on reconnect, not lost.
        void addBookmarkPending(s.nowPlaying.itemId, s.position, title).then((confirmed) =>
          showToast(confirmed ? 'Bookmark saved' : 'Bookmark saved (will sync)'),
        )
      }),
    ]

    // Ask native who owns playback right now.
    //
    // Every listener above is edge-driven, and this runtime may have started
    // AFTER the edges fired: the car service outlives the JS runtime, so an app
    // launched (or relaunched after a kill) into a connected car would otherwise
    // never learn the car is there, and would drive the phone player behind its
    // back - audio the car knew nothing about, with the phone UI showing an empty
    // player over it (HS-MOBILEAPP-18). Answered through onCarActive/onCarLoaded,
    // so it lands in the same handling as a live connect; a no-op when no car is
    // attached. Registered listeners first, or the reply has nowhere to land.
    syncAutoCarState()

    // One probe at mount loses a race the user can actually hit: the car service
    // runs in its own process, and on a cold launch into an already-connected
    // car it may not have bound (so `carPlayer` is still null) by the time this
    // host mounts. The connect edge that would have told us fired while there
    // was no JS runtime to receive it, so nothing else ever corrects it - the
    // phone drives its own player behind the car's back for the whole session.
    // Re-ask whenever the app comes forward, which is exactly when the user is
    // about to press play. Silent when no car is attached, so this is free.
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') syncAutoCarState()
      // Breadcrumb heap + thread count on every foreground/background edge.
      //
      // An OOM stack cannot say what filled the heap - HS-MOBILEAPP-1C died in a
      // React Fabric mount with no app frames at all, and HS-MOBILEAPP-1K was
      // only diagnosable because its thread was coincidentally named
      // `pool-12252-thread-1`. A trail of these turns the next one into a
      // reading: a climbing thread count across backgrounding is the fingerprint
      // of the service-recreation leak (fixed in 3e10bb3), while heap climbing on
      // its own points somewhere else entirely.
      //
      // These edges are the right sampling points - a leak driven by service
      // recreation shows up precisely when the app leaves and returns - and cost
      // nothing in between. The crumb ring collapses identical repeats, so a
      // stable app barely marks it.
      void getMemoryStats()
        .then((m) => {
          if (!m) return
          breadcrumb(
            'mem',
            `${next} heap ${Math.round(m.usedMb)}/${Math.round(m.limitMb)}MB threads ${m.threads}`,
          )
        })
        .catch(() => {})
    })

    return () => {
      subs.forEach((s) => s.remove())
      appState.remove()
      // Drop a pending reclaim check: firing it after teardown would read a store
      // that no host is driving and report a false "did not recover".
      if (reclaimProbe.current) {
        clearTimeout(reclaimProbe.current)
        reclaimProbe.current = null
      }
    }
  }, [])

  // ---- stall watchdog ----
  //
  // Every path into onPlaybackLost needs something to announce itself: a
  // transport command landing on a reclaimed service, or ExoPlayer raising a
  // recoverable error. A player that simply goes QUIET - still nominally
  // playing, no error, no progress - trips none of them. Nothing detected it,
  // nothing recovered, and nothing reported, so it only ever reached us as user
  // feedback (HS-MOBILEAPP-M: 1017 seconds backgrounded with playing=true while
  // the position advanced 11 seconds).
  //
  // This closes that gap from the JS side, with no native change: onProgress is
  // the sole driver of the store's position, so "the store says playing and
  // onProgress has gone silent" IS the stall, observed rather than announced.
  // Recovery routes through the same shared handler - and therefore the same
  // attempt cap - as a native-reported loss.
  useEffect(() => {
    const id = setInterval(() => {
      const s = getState()
      // Only meaningful while the phone player is supposed to be producing audio.
      // The car runs its own player and the phone stands down, emitting nothing -
      // silence there is correct, not a stall.
      if (!s.isPlaying || s.carActive || !s.nowPlaying) return
      // A genuine rebuffer already explains the silence, and the engine reports
      // it. Waiting it out is right; reloading mid-rebuffer would be the false
      // positive that costs a listener their audio.
      if (s.buffering) return
      const last = lastProgressAt.current
      if (!last) {
        // Playing but not a single tick yet: start the clock here rather than
        // firing immediately, so a slow first buffer is not read as a stall.
        lastProgressAt.current = Date.now()
        return
      }
      if (Date.now() - last < STALL_AFTER_MS) return
      // Reset before recovering: the reload re-arms playback and its first tick
      // restamps this, but if recovery stands down (attempt cap) we must not
      // re-fire on the same stale stamp every tick.
      lastProgressAt.current = Date.now()
      recoverLostPlayback('stall')
    }, STALL_CHECK_MS)
    return () => clearInterval(id)
  }, [recoverLostPlayback])

  // ---- store -> native: load / play / pause / seek / rate / volume ----
  useEffect(() => {
    const sync = () => {
      if (!Native) return
      const s = getState()
      const np = s.nowPlaying

      // Car owns playback: the native module routes play/pause/seek/rate to the
      // car player, so we must NOT also load/drive the phone service (that would
      // double up the audio). The store is being mirrored from the car; just
      // stand down. When the car hands back (carActive false), the block below
      // (re)loads the phone player from the current store on the next tick.
      if (s.carActive) {
        if (loadedKey.current !== null) {
          // Specifically the phone player: a plain stop() follows car ownership
          // and would pause the car we are handing over TO.
          Native.stopPhonePlayer()
          loadedKey.current = null
          loadedItem.current = null
        }
        // A book the car isn't holding can't be played by forwarding transport at
        // it - the commands land on an empty player and nothing happens. Hand it
        // over instead, which loads AND starts it (loadBookIntoCar prepares with
        // playWhenReady). Gated on isPlaying so merely opening Now Playing while
        // driving can't swap the book out from under the car; only an actual
        // intent to play does.
        if (s.isPlaying && np?.itemId && carBook.current !== np.itemId) {
          lastPlaying.current = true
          handBookToCar(carBook)
          return
        }
        // Still forward transport intent - the module dispatches it to the car.
        if (s.seekTo !== null) {
          Native.seekTo(s.seekTo)
          clearSeek()
        }
        if (s.isPlaying !== lastPlaying.current) {
          lastPlaying.current = s.isPlaying
          if (s.isPlaying) Native.play()
          else Native.pause()
        }
        if (s.rate !== lastRate.current) {
          lastRate.current = s.rate
          Native.setRate(s.rate)
        }
        return
      }

      if (!np) {
        if (loadedKey.current !== null) {
          Native.stop()
          loadedKey.current = null
          loadedItem.current = null
        }
        return
      }

      // A car-mirrored track (no stream URL / session) can linger in the store
      // after the car hands back. Don't try to load an empty URL into the phone
      // player - leave it stood down until the user taps play (which re-opens a
      // real session via playItemById).
      if (!np.url) return

      // (Re)load when the track changes.
      //
      // Keyed on the book and its AUDIO SOURCE, deliberately NOT on the session
      // id. A session id can change while the same audio keeps playing - a 404
      // reopen, or the session being opened at first play rather than at load -
      // and keying on it made each of those look like a new track, re-issuing
      // Native.load(url, startPosition) and yanking live audio back to the
      // position the track was loaded at. The url covers the cases that do
      // require a reload (a different book, or the same book switching between
      // stream and local file).
      const key = `${np.itemId}:${np.url}`
      if (key !== loadedKey.current) {
        loadedKey.current = key
        lastPlaying.current = null
        lastRate.current = null
        lastVolume.current = null
        // Reload at the LIVE position, not the one the track was loaded at.
        //
        // np.startPosition is where this track was first resolved to; s.position is
        // where the listener actually is (progress ticks keep it current). For a
        // genuinely new track the two are equal, so this is a no-op there. They
        // diverge only when we are REloading a book that has been playing - the
        // reclaim recovery above - and there, using startPosition would throw away
        // everything listened since load and rewind the audio, which is the same
        // class of bug as HS-MOBILEAPP-Q. Guarded on itemId so a book switch (where
        // s.position still holds the OUTGOING book's time until the store settles)
        // always uses the incoming track's own start.
        const resumeAt =
          s.position > np.startPosition && loadedItem.current === np.itemId
            ? s.position
            : np.startPosition
        loadedItem.current = np.itemId
        Native.load(
          np.url,
          resumeAt,
          np.title,
          np.author,
          np.artworkUrl ?? '',
          JSON.stringify(np.chapters ?? []),
          s.isPlaying,
        )
      }

      if (s.seekTo !== null) {
        Native.seekTo(s.seekTo)
        clearSeek()
        // Open a window where the onState handler treats native play/pause as a
        // seek transient and corrects it back to our intent (see above).
        seekingUntil.current = Date.now() + 1500
      }
      if (s.isPlaying !== lastPlaying.current) {
        lastPlaying.current = s.isPlaying
        if (s.isPlaying) {
          Native.play()
          // A book loaded paused (the Now Playing tab) has no ABS session yet -
          // opening one at load made the server record a listen for a book
          // nobody played. This is the moment it becomes a real listen, so open
          // it now. Fire-and-forget: it never blocks or moves the audio, and a
          // failure just means this stretch reports late, not that playback stops.
          void ensureSessionForPlayback().catch(() => {})
        } else Native.pause()
      }
      if (s.rate !== lastRate.current) {
        lastRate.current = s.rate
        Native.setRate(s.rate)
      }
      if (s.volume !== lastVolume.current) {
        lastVolume.current = s.volume
        Native.setVolume(s.volume)
      }
    }

    syncNative.current = sync
    sync()
    const unsubscribe = subscribe(sync)
    return () => {
      syncNative.current = null
      unsubscribe()
    }
  }, [])

  // The audio lives entirely in the native service; the only thing rendered is
  // the shake-to-extend confirmation toast (over every screen).
  return <Toast message={toast.message} />
}

// Re-exported so the notification/remote control handlers (registered by the
// host) can drive the same store the car uses.
export { togglePlay, jumpBy }
