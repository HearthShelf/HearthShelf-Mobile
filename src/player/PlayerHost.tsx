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
  jumpBy,
  togglePlay,
  setCarActive,
  mirrorCarTrack,
  setRate,
  skipChapter,
  currentChapter,
} from './store'
import { coverUrl, createBookmark } from '@/api/abs'
import { playItemById, syncProgress } from './playback'
import { advanceQueueOnEnd } from './advance'
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
        if (!getState().carActive) syncProgress(e.position)
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
      // Native transport (lock screen / car) routes back through the store so it
      // stays the source of truth.
      emitter.addListener('onTogglePlay', () => togglePlay()),
      emitter.addListener('onJump', (e: { delta: number }) => jumpBy(e.delta)),
      // Book ended: advance to the head of the (server-owned) up-next queue.
      emitter.addListener('onEnded', () => {
        void advanceQueueOnEnd().catch(() => {})
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
        setCarActive(e.active)
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
            artworkUrl: coverUrl(e.itemId),
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
        skipChapter(e.direction >= 0 ? 1 : -1)
      }),
      emitter.addListener('onCarBookmark', () => {
        const s = getState()
        if (!s.nowPlaying) return
        const ch = currentChapter()
        const title = ch?.title || 'Bookmark'
        void createBookmark(s.nowPlaying.itemId, s.position, title)
          .then(() => showToast('Bookmark saved'))
          .catch(() => showToast('Could not save bookmark'))
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
        }
        return
      }

      // A car-mirrored track (no stream URL / session) can linger in the store
      // after the car hands back. Don't try to load an empty URL into the phone
      // player - leave it stood down until the user taps play (which re-opens a
      // real session via playItemById).
      if (!np.url) return

      // (Re)load when the track changes.
      const key = `${np.itemId}:${np.sessionId}`
      if (key !== loadedKey.current) {
        loadedKey.current = key
        lastPlaying.current = null
        lastRate.current = null
        lastVolume.current = null
        Native.load(
          np.url,
          np.startPosition,
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
        if (s.isPlaying) Native.play()
        else Native.pause()
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

    sync()
    return subscribe(sync)
  }, [])

  // The audio lives entirely in the native service; the only thing rendered is
  // the shake-to-extend confirmation toast (over every screen).
  return <Toast message={toast.message} />
}

// Re-exported so the notification/remote control handlers (registered by the
// host) can drive the same store the car uses.
export { togglePlay, jumpBy }
