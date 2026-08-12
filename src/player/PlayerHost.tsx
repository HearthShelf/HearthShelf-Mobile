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
import { useEffect, useRef } from 'react'
import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native'
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
  requestSeek,
  currentChapter,
  setDeadTransportReporter,
} from './store'
import { breadcrumb } from '@/lib/crashLog'
import { reportCarHandbackFailure, reportDeadTransport } from './carHandbackReport'
import { coverUrl } from '@/api/abs'
import { addBookmarkPending } from './pendingBookmarks'
import { localCoverFor } from './downloads'
import { handOffToCar, playItemById, syncProgress, ensureSessionForPlayback } from './playback'
import { loadAutoCarBook } from './autoBridge'
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
}
const Native = NativeModules.HearthShelfAuto as HSPlayer | undefined

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

  // ---- native -> store: progress / state / ended ----
  useEffect(() => {
    if (!Native) return
    const emitter = new NativeEventEmitter(NativeModules.HearthShelfAuto)
    const subs = [
      emitter.addListener('onProgress', (e: { position: number }) => {
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
      emitter.addListener('onPlaybackLost', () => {
        breadcrumb('player', 'native lost the track; reloading from store')
        loadedKey.current = null
        lastPlaying.current = null
        // Re-run the store->native effect now rather than waiting for the next
        // store change; without a nudge, a stable store would leave it unloaded.
        syncNative.current?.()
      }),
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
          breadcrumb(
            'car',
            `handback${resume ? ` re-resolve ${resume.itemId} @${Math.round(resume.position)}s` : ' (phone track already loaded)'}`,
          )
          // The mirrored track's position is the only record of where the car
          // got to; seed it so the reload resumes there rather than at the
          // server's last synced spot.
          if (resume && Platform.OS === 'android') {
            void playItemById(resume.itemId, false)
              .then(() => requestSeek(resume.position))
              .catch((err) => {
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
        // across the await.
        const np = getState().nowPlaying
        const pos = getState().position
        void handOffToCar()
          .catch(() => {})
          .finally(() => {
            if (np?.itemId) loadAutoCarBook(np.itemId, pos)
          })
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
    return () => subs.forEach((s) => s.remove())
  }, [])

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
          Native.stop()
          loadedKey.current = null
          loadedItem.current = null
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
